/**
 * Composite-workflow core (doc 04 section 5, D20). MCP-free and deterministic:
 * no model calls, no tool registration. Workflows pass section functions that
 * call SERVICES (never raw clients); this module only schedules them.
 *
 * Guarantees:
 * - sections run concurrently; output order is the spec order, not completion order;
 * - ONE global deadline; at the deadline every unfinished section's AbortSignal is
 *   aborted and the section is reported as `error` with code TIMEOUT. Late results
 *   are discarded. The workflow itself never rejects because of a section;
 * - `disabled` / `unavailable` sources are reported without calling their function;
 * - section errors become safe payloads: AppError code kept, message scrubbed of
 *   secrets, absolute paths and control chars, bounded length; non-AppError -> generic
 *   INTERNAL_ERROR. No stacks, no causes.
 * - `meta.partial` is true when any section is not `ok` (disabled counts: the result is
 *   incomplete for the user's intent); `sectionsSummary` counts per status.
 * Size budget: sections may declare `truncated`; the total payload is fitted later by the
 * normal tool path (`fitToBudget` / `maxResponseBytes`).
 */
import { AppError, toErrorPayload, type ErrorPayload } from "../core/errors.js";
import { DEFAULT_LIMITS } from "../core/limits.js";
import { createRedactor, type Redactor } from "../core/redact.js";
import type { SourceRef } from "./source-ref.js";

export type SectionStatus = "ok" | "partial" | "unavailable" | "disabled" | "error";
export const SECTION_STATUSES: readonly SectionStatus[] = ["ok", "partial", "unavailable", "disabled", "error"];

export interface Section<T = unknown> {
  id: string;
  title: string;
  status: SectionStatus;
  source: SourceRef;
  data?: T;
  error?: ErrorPayload;
  /** Present and true when the section's own data was cut by a limit. */
  truncated?: boolean;
}

export interface SectionContext {
  /** Aborted at the global deadline or when the caller's signal aborts. */
  signal: AbortSignal;
}

/** What a section function may return: plain data, or data with flags. */
export interface SectionOutput<T = unknown> {
  data: T;
  /** Section produced usable but incomplete data (status "partial"). */
  partial?: boolean;
  truncated?: boolean;
}

const branded = new WeakSet<object>();

/** Wrap data with flags. Only outputs built here are treated as flagged (plain `{data}` objects are just data). */
export function sectionOutput<T>(data: T, flags: { partial?: boolean; truncated?: boolean } = {}): SectionOutput<T> {
  const out: SectionOutput<T> = { data, ...flags };
  branded.add(out);
  return out;
}

export type Availability =
  | { state: "enabled" }
  | { state: "disabled"; reason?: string }
  | { state: "unavailable"; reason?: string };

export interface SectionSpec<T = unknown> {
  id: string;
  title: string;
  source: SourceRef;
  /** Default enabled. disabled/unavailable sections are never run. */
  availability?: Availability;
  /** Returns data, or `sectionOutput(...)` to set partial/truncated. */
  run: (ctx: SectionContext) => Promise<T | SectionOutput<T>>;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RunSectionsOptions {
  /** Global deadline in ms; default `DEFAULT_LIMITS.workflowTimeoutMs`. */
  deadlineMs?: number;
  /** Injectable clock (ms) for elapsed time. */
  now?: () => number;
  /** Injectable timers (tests). */
  timers?: Timers;
  /** Caller cancellation; treated like the deadline. */
  signal?: AbortSignal;
  /** Extra redaction (e.g. configured secrets) applied to error messages. */
  redactor?: Redactor;
}

export interface SectionsSummary {
  total: number;
  ok: number;
  partial: number;
  unavailable: number;
  disabled: number;
  error: number;
}

export interface WorkflowResult {
  sections: Section[];
  meta: {
    partial: boolean;
    truncated: boolean;
    sectionsSummary: SectionsSummary;
    elapsedMs: number;
    deadlineMs: number;
    deadlineHit: boolean;
  };
}

const MAX_MESSAGE_CHARS = 300;
// Absolute POSIX or Windows paths with at least one separator after a segment.
// Segments use a class disjoint from the separators, so matching is linear.
const ABS_PATH_RE = /(?:[A-Za-z]:[\\/]|\/)(?:[\w.@~+-]+[\\/])+[\w.@~+-]*/g;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const defaultRedactor = createRedactor();

/** Scrub a message: secrets (redactor), absolute paths, control chars, length. */
export function scrubMessage(message: string, redactor: Redactor = defaultRedactor): string {
  let out = redactor.redactString(message.slice(0, MAX_MESSAGE_CHARS * 4));
  out = out.replace(ABS_PATH_RE, "[path]").replace(CONTROL_RE, " ");
  return out.length > MAX_MESSAGE_CHARS ? `${out.slice(0, MAX_MESSAGE_CHARS)}...` : out;
}

/** Safe error payload for a thrown value. Never contains stack, cause, secrets or absolute paths. */
export function safeErrorPayload(err: unknown, redactor?: Redactor): ErrorPayload {
  const p = toErrorPayload(err);
  return { ...p, message: scrubMessage(p.message, redactor) };
}

function timeoutPayload(cancelled: boolean): ErrorPayload {
  return safeErrorPayload(
    new AppError(
      "TIMEOUT",
      cancelled
        ? "The workflow was cancelled before this section finished."
        : "This section did not finish within the workflow deadline.",
    ),
  );
}

function isFlagged(v: unknown): v is SectionOutput {
  return typeof v === "object" && v !== null && branded.has(v);
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

type Settled = Section;

function baseSection(spec: SectionSpec): Pick<Section, "id" | "title" | "source"> {
  return { id: spec.id, title: spec.title, source: spec.source };
}

export function summarize(sections: readonly Section[]): SectionsSummary {
  const s: SectionsSummary = { total: sections.length, ok: 0, partial: 0, unavailable: 0, disabled: 0, error: 0 };
  for (const sec of sections) s[sec.status] += 1;
  return s;
}

/** Run sections concurrently under one global deadline. Never rejects. */
export async function runSections(
  specs: readonly SectionSpec[],
  options: RunSectionsOptions = {},
): Promise<WorkflowResult> {
  const deadlineMs = options.deadlineMs ?? DEFAULT_LIMITS.workflowTimeoutMs;
  const now = options.now ?? Date.now;
  const timers = options.timers ?? realTimers;
  const redactor = options.redactor;
  const started = now();

  const controller = new AbortController();
  let deadlineHit = false;
  let cancelled = false;
  let finished = false;

  const results: (Settled | undefined)[] = new Array<Settled | undefined>(specs.length).fill(undefined);
  const pending = new Set<number>();
  let wake: (() => void) | undefined;

  const onExternalAbort = (): void => {
    cancelled = true;
    finished = true; // set first: rejections caused by the abort must not overwrite TIMEOUT
    controller.abort();
    wake?.();
  };
  if (options.signal) {
    if (options.signal.aborted) onExternalAbort();
    else options.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  specs.forEach((spec, i) => {
    const availability = spec.availability ?? { state: "enabled" };
    if (availability.state !== "enabled") {
      const code = availability.state === "disabled" ? "INTEGRATION_DISABLED" : "INTEGRATION_UNAVAILABLE";
      const fallback = availability.state === "disabled" ? "This source is disabled." : "This source is unavailable.";
      results[i] = {
        ...baseSection(spec),
        status: availability.state,
        error: safeErrorPayload(new AppError(code, availability.reason ?? fallback), redactor),
      };
      return;
    }
    if (controller.signal.aborted) {
      results[i] = { ...baseSection(spec), status: "error", error: timeoutPayload(cancelled) };
      return;
    }
    pending.add(i);
    let promise: Promise<unknown>;
    try {
      promise = Promise.resolve(spec.run({ signal: controller.signal }));
    } catch (e) {
      promise = Promise.reject(e);
    }
    promise.then(
      (value) => {
        if (finished || !pending.has(i)) return; // late result: discarded
        pending.delete(i);
        const out = isFlagged(value) ? value : undefined;
        const data = out ? out.data : value;
        const sec: Section = {
          ...baseSection(spec),
          status: out?.partial ? "partial" : "ok",
          data,
        };
        if (out?.truncated) sec.truncated = true;
        results[i] = sec;
        if (pending.size === 0) wake?.();
      },
      (err: unknown) => {
        if (finished || !pending.has(i)) return;
        pending.delete(i);
        results[i] = {
          ...baseSection(spec),
          status: "error",
          error: safeErrorPayload(err, redactor),
        };
        if (pending.size === 0) wake?.();
      },
    );
  });

  if (pending.size > 0 && !controller.signal.aborted) {
    await new Promise<void>((resolve) => {
      const handle = timers.setTimeout(() => {
        deadlineHit = true;
        finished = true;
        controller.abort();
        resolve();
      }, deadlineMs);
      wake = () => {
        timers.clearTimeout(handle);
        resolve();
      };
    });
  }
  finished = true;
  options.signal?.removeEventListener("abort", onExternalAbort);
  // Sections still pending: hung or cut off.
  for (const i of pending) {
    const spec = specs[i] as SectionSpec;
    results[i] = { ...baseSection(spec), status: "error", error: timeoutPayload(cancelled && !deadlineHit) };
  }
  pending.clear();
  if (!controller.signal.aborted) controller.abort(); // release listeners of finished sections

  const sections = results.map((r, i) => {
    if (r) return r;
    const spec = specs[i] as SectionSpec;
    return { ...baseSection(spec), status: "error", error: timeoutPayload(false) } satisfies Section;
  });
  const sectionsSummary = summarize(sections);
  return {
    sections,
    meta: {
      partial: sectionsSummary.ok !== sectionsSummary.total,
      truncated: sections.some((s) => s.truncated === true),
      sectionsSummary,
      elapsedMs: Math.max(0, now() - started),
      deadlineMs,
      deadlineHit,
    },
  };
}
