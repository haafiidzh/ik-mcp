/**
 * Data-flow workflow (P5-04, doc 04 sections 5 and 6): which files mention the tables of a linked
 * database connection, or the endpoint paths of a linked custom API profile.
 *
 * Deterministic, read-only, no server-side reasoning. Authority comes only from the workspace's
 * configured links: the target is a connection or profile NAME that must be linked to the workspace.
 * Database access is catalog metadata only (the Port exposes `listTablesPage` and nothing else, so
 * table data cannot be fetched from here). API endpoints are never called. File references come from
 * the filesystem service's literal content search (blocked and ignored files never appear there).
 * Table names are data from the database: UNTRUSTED (bounded, control characters replaced, names
 * with path separators or control characters are listed but never searched). Matching is literal,
 * never a user-built regex: the service does a case-insensitive substring search, then the returned
 * line is checked for a word boundary around the name.
 */
import { AppError } from "../core/errors.js";
import { DEFAULT_LIMITS, type Limits } from "../core/limits.js";
import { fail, ok, type SuccessResult, type ToolResult } from "../core/response.js";
import type { CatalogPage, TableRef } from "../integrations/database/database.types.js";
import type { ContentHit } from "../integrations/filesystem/filesystem.service.js";
import { apiSource, databaseSource, filesystemSource } from "./source-ref.js";
import { runSections, sectionOutput, type SectionSpec } from "./workflow-core.js";

export const DATA_FLOW_TOOL = "workspace_inspect_data_flow";

/** Structurally satisfied by FilesystemService (compile-time check in the integration test). */
export interface DataFlowFsPort {
  searchContent(
    workspace: string,
    query: string,
    opts?: { path?: string; caseSensitive?: boolean; extensions?: readonly string[]; limit?: number },
  ): Promise<SuccessResult<ContentHit[]>>;
}

/** Catalog-only adapter view: a DatabaseAdapter satisfies it; there is deliberately no `query`. */
export interface DataFlowDbAdapterPort {
  listTablesPage(options?: { schema?: string }): Promise<CatalogPage<TableRef>>;
}

/** Structurally satisfied by DatabaseRegistry (enabled connections only). */
export interface DataFlowDbPort {
  names(): string[];
  get(name: unknown): Promise<DataFlowDbAdapterPort>;
}

export interface ApiEndpointMeta {
  name: string;
  method: string;
  /** Path template as configured, e.g. "/orders/{id}". */
  path: string;
  permission: "read" | "write";
  /** True for a write endpoint that is not callable under the current permissions. */
  writeGated: boolean;
}

/**
 * Endpoint metadata of an ENABLED configured profile, or undefined when the profile is disabled or
 * unknown. ApiService has no endpoint listing, so wave 2 adapts this from config + permissions.
 */
export interface DataFlowApiPort {
  listEndpoints(profile: string): readonly ApiEndpointMeta[] | undefined;
}

export interface DataFlowWorkspace {
  id: string;
  databases: readonly string[];
  apis: readonly string[];
}

export interface DataFlowDeps {
  workspaces: readonly DataFlowWorkspace[];
  /** Undefined = the filesystem pack is disabled. */
  fs?: DataFlowFsPort | undefined;
  /** Undefined = the database pack is disabled. */
  db?: DataFlowDbPort | undefined;
  /** Undefined = the custom API pack is disabled. */
  api?: DataFlowApiPort | undefined;
  limits?: Pick<Limits, "maxResults" | "workflowTimeoutMs" | "maxSnippetChars">;
  /** Test seam: clock for the search time budget. */
  now?: () => number;
}

export interface DataFlowInput {
  workspace: string;
  connection?: string | undefined;
  profile?: string | undefined;
}

/** Caps (documented in implementation-notes P5-04). */
export const MAX_TABLES_SEARCHED = 50;
export const MAX_ENDPOINTS_SEARCHED = 50;
export const MAX_FILES_PER_ENTRY = 5;
export const MAX_SNIPPETS_PER_FILE = 2;
export const MAX_SNIPPET_CHARS = 160;
export const MAX_NAME_DISPLAY = 200;
export const MAX_SEARCHABLE_NAME = 128;
/** Share of the workflow deadline the searches may use; the rest is left for assembling the result. */
export const SEARCH_BUDGET_SHARE = 0.8;

/** Fixed unknowns wording (tests and Claude may rely on the codes). */
export const UNKNOWN_TEXT = {
  FILESYSTEM_DISABLED: "The filesystem source is disabled; no file references were searched.",
  DATABASE_DISABLED: "The database source is disabled; tables could not be listed.",
  API_DISABLED: "The custom API source is disabled; endpoints could not be listed.",
  CATALOG_TRUNCATED: "The table catalog was truncated; some tables are not listed.",
  SEARCH_TRUNCATED: "A file search reached a limit or time budget; some references may be missing.",
  NOT_SEARCHED: "Some entries were not searched because of the search cap or the time budget.",
  NAMES_SKIPPED: "Some names were listed but not searched because they contain unsafe characters or are too long.",
  ZERO_REFERENCES: "Zero references means no match in the searched text files only; dynamic names, generated code, binary files and blocked files are not covered.",
  TARGET_FAILED: "The target metadata could not be read; no references were searched.",
} as const;
export type UnknownCode = keyof typeof UNKNOWN_TEXT;

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CONTROL_ALL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;
const TARGET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Bounded, control-free display form of untrusted text. */
export function displayText(s: string, max: number): string {
  const clean = s.replace(CONTROL_ALL_RE, "�");
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** A name may be handed to the content search only when it is short, single-line and not path-like. */
export function isSearchableName(name: string, max: number = MAX_SEARCHABLE_NAME): boolean {
  return name.length > 0 && name.length <= max && !CONTROL_RE.test(name) && !/[\\/]/.test(name) && name.trim().length > 0;
}

/**
 * Literal whole-word check (no regex built from the name): every occurrence of `name` in `text`
 * is tested for a non-word character (or an edge) on each side that starts/ends with a word char.
 * Case-insensitive.
 */
export function hasWordBoundaryMatch(text: string, name: string): boolean {
  const hay = text.toLowerCase();
  const needle = name.toLowerCase();
  if (needle.length === 0) return false;
  const first = needle.charAt(0);
  const last = needle.charAt(needle.length - 1);
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return false;
    const before = i > 0 ? hay.charAt(i - 1) : "";
    const after = hay.charAt(i + needle.length);
    const leftOk = !WORD_CHAR_RE.test(first) || before === "" || !WORD_CHAR_RE.test(before);
    const rightOk = !WORD_CHAR_RE.test(last) || after === "" || !WORD_CHAR_RE.test(after);
    if (leftOk && rightOk) return true;
    from = i + 1;
  }
}

interface FileRef {
  path: string;
  hits: number;
  snippets: { line: number; text: string }[];
}

interface EntryRefs {
  searched: boolean;
  skippedReason?: "unsafe-name" | "search-cap" | "time-budget";
  referenced: boolean | null;
  fileCount: number;
  totalHits: number;
  filesTruncated: boolean;
  files: FileRef[];
}

interface SearchState {
  searchTruncated: boolean;
  notSearched: boolean;
  namesSkipped: boolean;
  zeroRefs: boolean;
}

interface Collector {
  /** key = path + line; value keeps first snippet. */
  lines: Map<string, { path: string; line: number; text: string }>;
}

function finishRefs(col: Collector): Pick<EntryRefs, "fileCount" | "totalHits" | "filesTruncated" | "files"> {
  const byPath = new Map<string, FileRef>();
  for (const l of col.lines.values()) {
    let f = byPath.get(l.path);
    if (f === undefined) {
      f = { path: l.path, hits: 0, snippets: [] };
      byPath.set(l.path, f);
    }
    f.hits++;
    f.snippets.push({ line: l.line, text: l.text });
  }
  const all = [...byPath.values()];
  for (const f of all) {
    f.snippets.sort((a, b) => a.line - b.line);
    f.snippets = f.snippets.slice(0, MAX_SNIPPETS_PER_FILE);
  }
  all.sort((a, b) => b.hits - a.hits || cmp(a.path, b.path));
  return {
    fileCount: all.length,
    totalHits: [...byPath.values()].reduce((n, f) => n + f.hits, 0),
    filesTruncated: all.length > MAX_FILES_PER_ENTRY,
    files: all.slice(0, MAX_FILES_PER_ENTRY),
  };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sectionErr(code: ConstructorParameters<typeof AppError>[0], message: string): AppError {
  return new AppError(code, message);
}

interface TableEntry {
  schema: string | null;
  name: string;
  kind: "table" | "view";
}

interface DbTargetData {
  kind: "database";
  connection: string;
  tableCount: number;
  listedTables: number;
  workspaceLinks: { databases: number; apis: number };
  tables: { schema: string | null; name: string; kind: "table" | "view"; nameTruncated?: boolean }[];
}

interface ApiTargetData {
  kind: "api";
  profile: string;
  endpointCount: number;
  workspaceLinks: { databases: number; apis: number };
  endpoints: { name: string; method: string; pathTemplate: string; permission: "read" | "write"; writeGated: boolean }[];
}

/** Entry to search: a display label plus the literal needles. */
interface Needle {
  text: string;
  /** Apply the word-boundary line check. */
  boundary: boolean;
}

export async function inspectDataFlow(
  deps: DataFlowDeps,
  input: DataFlowInput,
  signal?: AbortSignal,
): Promise<ToolResult> {
  try {
    return await run(deps, input, signal);
  } catch (e) {
    return fail(e instanceof AppError ? e : new AppError("INTERNAL_ERROR", "The workflow failed."));
  }
}

async function run(deps: DataFlowDeps, input: DataFlowInput, signal?: AbortSignal): Promise<ToolResult> {
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const now = deps.now ?? Date.now;

  // ---- input validation: exactly one linked target, never arbitrary names ----
  if (typeof input.workspace !== "string" || input.workspace.length === 0 || input.workspace.length > 2048) {
    throw sectionErr("INVALID_INPUT", "workspace must be the id of a configured workspace.");
  }
  const hasConn = input.connection !== undefined;
  const hasProf = input.profile !== undefined;
  if (hasConn === hasProf) throw sectionErr("INVALID_INPUT", "Provide exactly one of connection or profile.");
  const targetName = (hasConn ? input.connection : input.profile) as string;
  if (typeof targetName !== "string" || !TARGET_NAME_RE.test(targetName)) {
    throw sectionErr("INVALID_INPUT", "The target must be the name of a configured connection or profile, not a connection string, URL or path.");
  }
  const ws = deps.workspaces.find((w) => w.id === input.workspace);
  if (ws === undefined) throw sectionErr("NOT_FOUND", "Unknown workspace.");
  const linked = hasConn ? ws.databases.includes(targetName) : ws.apis.includes(targetName);
  if (!linked) {
    // Fixed text: no names of other connections or profiles.
    throw sectionErr("NOT_FOUND", `The requested ${hasConn ? "connection" : "profile"} is not linked to this workspace.`);
  }

  const workspaceLinks = { databases: ws.databases.length, apis: ws.apis.length };
  const deadlineMs = limits.workflowTimeoutMs;
  const started = now();
  const searchDeadline = started + Math.floor(deadlineMs * SEARCH_BUDGET_SHARE);
  const fsSource = filesystemSource(ws.id);
  const targetSource = hasConn ? databaseSource(targetName) : apiSource(targetName);

  // ---- target (metadata only) ----
  interface TargetOutcome {
    needles: { label: string; entry: Record<string, unknown>; needles: Needle[]; searchable: boolean }[];
    truncated: boolean;
  }

  let targetAvailability: SectionSpec["availability"];
  let dbPort: DataFlowDbPort | undefined;
  let apiPort: DataFlowApiPort | undefined;
  let unknownTargetCode: UnknownCode | undefined;
  if (hasConn) {
    dbPort = deps.db;
    if (dbPort === undefined || !dbPort.names().includes(targetName)) {
      targetAvailability = { state: "disabled", reason: UNKNOWN_TEXT.DATABASE_DISABLED };
      unknownTargetCode = "DATABASE_DISABLED";
    }
  } else {
    apiPort = deps.api;
    if (apiPort === undefined || apiPort.listEndpoints(targetName) === undefined) {
      targetAvailability = { state: "disabled", reason: UNKNOWN_TEXT.API_DISABLED };
      unknownTargetCode = "API_DISABLED";
    }
  }

  let catalogTruncated = false;
  let targetPromise: Promise<TargetOutcome> | undefined;
  let targetFailed = false;

  const loadTarget = (): Promise<{ outcome: TargetOutcome; data: DbTargetData | ApiTargetData }> => {
    return (async () => {
      if (hasConn && dbPort !== undefined) {
        const adapter = await dbPort.get(targetName);
        const page = await adapter.listTablesPage();
        const sorted: TableEntry[] = page.items
          .filter((t) => typeof t.name === "string")
          .map((t) => ({ schema: t.schema, name: t.name, kind: t.kind }))
          .sort((a, b) => cmp(a.name, b.name) || cmp(a.schema ?? "", b.schema ?? "") || cmp(a.kind, b.kind));
        const cap = limits.maxResults;
        const listed = sorted.slice(0, cap);
        catalogTruncated = page.truncated || sorted.length > cap;
        const data: DbTargetData = {
          kind: "database",
          connection: targetName,
          tableCount: sorted.length,
          listedTables: listed.length,
          workspaceLinks,
          tables: listed.map((t) => ({
            schema: t.schema === null ? null : displayText(t.schema, MAX_NAME_DISPLAY),
            name: displayText(t.name, MAX_NAME_DISPLAY),
            kind: t.kind,
            ...(t.name.length > MAX_NAME_DISPLAY || CONTROL_RE.test(t.name) ? { nameTruncated: true } : {}),
          })),
        };
        const outcome: TargetOutcome = {
          truncated: catalogTruncated,
          needles: listed.map((t) => ({
            label: displayText(t.name, MAX_NAME_DISPLAY),
            entry: { schema: t.schema === null ? null : displayText(t.schema, MAX_NAME_DISPLAY), kind: t.kind },
            searchable: isSearchableName(t.name),
            needles: [{ text: t.name, boundary: true }],
          })),
        };
        return { outcome, data };
      }
      const eps = [...(apiPort?.listEndpoints(targetName) ?? [])].sort((a, b) => cmp(a.name, b.name));
      const data: ApiTargetData = {
        kind: "api",
        profile: targetName,
        endpointCount: eps.length,
        workspaceLinks,
        endpoints: eps.map((e) => ({
          name: displayText(e.name, MAX_NAME_DISPLAY),
          method: displayText(e.method, 16),
          pathTemplate: displayText(e.path, MAX_NAME_DISPLAY),
          permission: e.permission,
          writeGated: e.writeGated,
        })),
      };
      const outcome: TargetOutcome = {
        truncated: false,
        needles: eps.map((e) => {
          const needles: Needle[] = [{ text: e.path, boundary: false }];
          const brace = e.path.indexOf("{");
          const prefix = brace >= 0 ? e.path.slice(0, brace) : "";
          if (prefix.length >= 3 && prefix !== e.path) needles.push({ text: prefix, boundary: false });
          return {
            label: displayText(e.name, MAX_NAME_DISPLAY),
            entry: { method: displayText(e.method, 16), pathTemplate: displayText(e.path, MAX_NAME_DISPLAY), permission: e.permission, writeGated: e.writeGated },
            searchable: e.path.length > 0 && e.path.length <= 200 && !CONTROL_RE.test(e.path),
            needles,
          };
        }),
      };
      return { outcome, data };
    })();
  };

  let targetData: DbTargetData | ApiTargetData | undefined;
  const target = (): Promise<TargetOutcome> => {
    targetPromise ??= loadTarget().then(
      (r) => {
        targetData = r.data;
        return r.outcome;
      },
      (e: unknown) => {
        targetFailed = true;
        throw e;
      },
    );
    return targetPromise;
  };

  // ---- references ----
  const state: SearchState = { searchTruncated: false, notSearched: false, namesSkipped: false, zeroRefs: false };
  let refsPromise: Promise<{ entries: Record<string, unknown>[]; partial: boolean }> | undefined;

  const references = (ctxSignal: AbortSignal): Promise<{ entries: Record<string, unknown>[]; partial: boolean }> => {
    refsPromise ??= (async () => {
      let t: TargetOutcome;
      try {
        t = await target();
      } catch {
        throw sectionErr("INTEGRATION_UNAVAILABLE", UNKNOWN_TEXT.TARGET_FAILED);
      }
      const fs = deps.fs;
      if (fs === undefined) throw sectionErr("INTEGRATION_DISABLED", UNKNOWN_TEXT.FILESYSTEM_DISABLED);
      const cap = hasConn ? MAX_TABLES_SEARCHED : MAX_ENDPOINTS_SEARCHED;
      const entries: Record<string, unknown>[] = [];
      let searchedCount = 0;
      for (const item of t.needles) {
        const base: Record<string, unknown> = { name: item.label, ...item.entry };
        const mk = (r: EntryRefs): Record<string, unknown> => ({ ...base, ...r });
        if (!item.searchable) {
          state.namesSkipped = true;
          entries.push(mk({ searched: false, skippedReason: "unsafe-name", referenced: null, fileCount: 0, totalHits: 0, filesTruncated: false, files: [] }));
          continue;
        }
        if (searchedCount >= cap) {
          state.notSearched = true;
          entries.push(mk({ searched: false, skippedReason: "search-cap", referenced: null, fileCount: 0, totalHits: 0, filesTruncated: false, files: [] }));
          continue;
        }
        if (ctxSignal.aborted || now() >= searchDeadline) {
          state.notSearched = true;
          entries.push(mk({ searched: false, skippedReason: "time-budget", referenced: null, fileCount: 0, totalHits: 0, filesTruncated: false, files: [] }));
          continue;
        }
        searchedCount++;
        const col: Collector = { lines: new Map() };
        let cutShort = false;
        for (const needle of item.needles) {
          let res: SuccessResult<ContentHit[]>;
          try {
            res = await fs.searchContent(ws.id, needle.text, { caseSensitive: false, limit: limits.maxResults });
          } catch (e) {
            if (e instanceof AppError && e.code === "INVALID_INPUT") {
              state.namesSkipped = true;
              continue;
            }
            throw e;
          }
          if (res.meta.truncated || res.meta.partial) cutShort = true;
          for (const h of res.data) {
            if (needle.boundary && !hasWordBoundaryMatch(h.snippet, needle.text)) continue;
            const key = `${h.relPath}\u0000${h.line}`;
            if (!col.lines.has(key)) {
              col.lines.set(key, { path: displayText(h.relPath, 300), line: h.line, text: displayText(h.snippet.trim(), Math.min(MAX_SNIPPET_CHARS, limits.maxSnippetChars)) });
            }
          }
        }
        if (cutShort) state.searchTruncated = true;
        const fin = finishRefs(col);
        if (fin.fileCount === 0) state.zeroRefs = true;
        entries.push(mk({ searched: true, referenced: fin.fileCount > 0, ...fin }));
      }
      // Order: alphabetical by name (already sorted at the source), schema then as listed.
      return { entries, partial: state.searchTruncated || state.notSearched || state.namesSkipped || t.truncated };
    })();
    return refsPromise;
  };

  // ---- unknowns ----
  const unknowns = async (ctxSignal: AbortSignal) => {
    const codes = new Set<UnknownCode>();
    if (unknownTargetCode !== undefined) codes.add(unknownTargetCode);
    if (deps.fs === undefined) codes.add("FILESYSTEM_DISABLED");
    if (unknownTargetCode === undefined) {
      try {
        await references(ctxSignal);
      } catch {
        if (targetFailed) codes.add("TARGET_FAILED");
      }
      if (catalogTruncated) codes.add("CATALOG_TRUNCATED");
      if (state.searchTruncated) codes.add("SEARCH_TRUNCATED");
      if (state.notSearched) codes.add("NOT_SEARCHED");
      if (state.namesSkipped) codes.add("NAMES_SKIPPED");
      if (state.zeroRefs) codes.add("ZERO_REFERENCES");
    }
    const order = Object.keys(UNKNOWN_TEXT) as UnknownCode[];
    const items = order.filter((c) => codes.has(c)).map((code) => ({ code, text: UNKNOWN_TEXT[code] }));
    return { count: items.length, items };
  };

  const specs: SectionSpec[] = [
    {
      id: "target",
      title: hasConn ? "Database target (catalog metadata only)" : "API target (endpoint metadata only, no calls)",
      source: targetSource,
      ...(targetAvailability !== undefined ? { availability: targetAvailability } : {}),
      run: async () => {
        const outcome = await target();
        return sectionOutput(targetData, { partial: outcome.truncated, truncated: outcome.truncated });
      },
    },
    {
      id: "references",
      title: hasConn ? "Files referencing table names" : "Files referencing endpoint paths",
      source: fsSource,
      ...(deps.fs === undefined
        ? { availability: { state: "disabled", reason: UNKNOWN_TEXT.FILESYSTEM_DISABLED } as const }
        : targetAvailability !== undefined
          ? { availability: { state: "unavailable", reason: "The target source is disabled, so no references were searched." } as const }
          : {}),
      run: async (ctx) => {
        const r = await references(ctx.signal);
        return sectionOutput({ entries: r.entries, caps: { maxEntriesSearched: hasConn ? MAX_TABLES_SEARCHED : MAX_ENDPOINTS_SEARCHED, maxFilesPerEntry: MAX_FILES_PER_ENTRY } }, { partial: r.partial, truncated: r.partial });
      },
    },
    {
      id: "unknowns",
      title: "What could not be determined",
      source: fsSource,
      run: (ctx) => unknowns(ctx.signal),
    },
  ];

  const result = await runSections(specs, { deadlineMs, now, ...(signal !== undefined ? { signal } : {}) });
  return ok(
    { sections: result.sections },
    {
      source: "workflow:inspect_data_flow",
      partial: result.meta.partial,
      truncated: result.meta.truncated,
      returnedCount: result.sections.length,
      sectionsSummary: result.meta.sectionsSummary,
      elapsedMs: result.meta.elapsedMs,
      deadlineMs: result.meta.deadlineMs,
      deadlineHit: result.meta.deadlineHit,
    },
  );
}
