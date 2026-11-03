import { toErrorPayload, type ErrorPayload } from "./errors.js";
import { DEFAULT_LIMITS } from "./limits.js";
import type { Redactor } from "./redact.js";

/** Result shape per doc 04 section 2 and MCP mapping per D12. */
export interface ResultMeta {
  source: string;
  partial: boolean;
  returnedCount: number;
  nextPageAvailable: boolean;
  truncated: boolean;
  limit?: number;
  [extra: string]: unknown;
}

export interface SuccessResult<T = unknown> {
  success: true;
  data: T;
  meta: ResultMeta;
  warnings: string[];
}

export interface ErrorResult {
  success: false;
  error: ErrorPayload;
}

export type ToolResult<T = unknown> = SuccessResult<T> | ErrorResult;

export function ok<T>(
  data: T,
  meta: Partial<ResultMeta> & { source: string },
  warnings: string[] = [],
): SuccessResult<T> {
  return {
    success: true,
    data,
    meta: {
      partial: false,
      returnedCount: Array.isArray(data) ? data.length : 0,
      nextPageAvailable: false,
      truncated: false,
      ...meta,
    },
    warnings,
  };
}

export function fail(err: unknown): ErrorResult {
  return { success: false, error: toErrorPayload(err) };
}

/** Plain MCP CallToolResult-compatible object (no SDK import). */
export interface McpToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

/** Bytes reserved for the JSON-RPC envelope (jsonrpc, id, result wrapper) around a tool result. */
export const ENVELOPE_RESERVE_BYTES = 512;

function buildMcp(result: ToolResult): McpToolResult {
  const out: McpToolResult = {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result as unknown as Record<string, unknown>,
  };
  if (!result.success) out.isError = true;
  return out;
}

/** Bytes put on the wire for a result: both copies (structuredContent and text item) plus the envelope reserve. */
export function wireSize(result: ToolResult): number {
  return Buffer.byteLength(JSON.stringify(buildMcp(result)), "utf8") + ENVELOPE_RESERVE_BYTES;
}

interface TreeLike {
  type?: unknown;
  children?: TreeLike[];
  [k: string]: unknown;
}

function countNodes(n: TreeLike): number {
  return (n.children ?? []).reduce((a, c) => a + 1 + countNodes(c), 0);
}

/** Keep the first `budget` descendants in depth-first order. */
function pruneTree(n: TreeLike, budget: { left: number }): TreeLike {
  const copy: TreeLike = { ...n };
  if (n.children) {
    copy.children = [];
    for (const c of n.children) {
      if (budget.left <= 0) break;
      budget.left--;
      copy.children.push(pruneTree(c, budget));
    }
  }
  return copy;
}

function treeCounts(root: TreeLike): { files: number; directories: number; symlinks: number } {
  const c = { files: 0, directories: 0, symlinks: 0 };
  const rec = (n: TreeLike): void => {
    for (const k of n.children ?? []) {
      if (k.type === "file") c.files++;
      else if (k.type === "dir") c.directories++;
      else if (k.type === "symlink") c.symlinks++;
      rec(k);
    }
  };
  rec(root);
  return c;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Enforce `maxBytes` against the TOTAL serialized size sent to the host (both copies, doc 04 section 2).
 * The payload (array entries, text `content`, tree nodes) is cut first and the result is marked
 * `truncated`/`partial` with a warning, so the sum stays within budget. Errors and payloads of an
 * unknown shape are returned unchanged. The doc 04 shape (text item equals the JSON of structuredContent)
 * is kept, which means each copy gets at most about half of the budget.
 */
export function fitToBudget<T>(result: ToolResult<T>, maxBytes: number): ToolResult<T> {
  if (!result.success || wireSize(result) <= maxBytes) return result;
  const data: unknown = result.data;
  const mark = (data2: unknown, returnedCount: number): ToolResult<T> => ({
    success: true,
    data: data2 as T,
    meta: { ...result.meta, truncated: true, partial: true, returnedCount, responseBudgetBytes: maxBytes },
    warnings: [...result.warnings, "Response was truncated to fit the maximum response size (sent twice: structured and text)."],
  });

  let total = 0;
  let build: (n: number) => ToolResult<T>;
  if (Array.isArray(data)) {
    total = data.length;
    build = (n) => mark(data.slice(0, n), n);
  } else if (isObj(data) && typeof data["content"] === "string") {
    const content = data["content"];
    total = content.length;
    build = (n) => {
      let cut = content.slice(0, n);
      const last = cut.charCodeAt(cut.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
      const lineCount = cut === "" ? 0 : cut.split("\n").length;
      const next: Record<string, unknown> = { ...data, content: cut, truncated: true };
      const lines = data["lines"];
      if (isObj(lines) && typeof lines["start"] === "number") next["lines"] = { ...lines, end: lines["start"] + lineCount - 1 };
      return mark(next, lineCount);
    };
  } else if (isObj(data) && isObj(data["root"])) {
    const root = data["root"] as TreeLike;
    total = countNodes(root);
    build = (n) => {
      const pruned = pruneTree(root, { left: n });
      const next: Record<string, unknown> = { ...data, root: pruned };
      if (isObj(data["counts"])) next["counts"] = treeCounts(pruned);
      return mark(next, n);
    };
  } else {
    return result;
  }

  let lo = 0;
  let hi = total - 1;
  let best = build(0);
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const cand = build(mid);
    if (wireSize(cand) <= maxBytes) {
      best = cand;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * Map a result to MCP: structuredContent + one JSON text item, isError on failures.
 * Redaction is applied before the size budget so nothing secret leaves via either channel
 * and the budget is measured on what is actually sent. `maxBytes` defaults to the doc 03 default.
 */
export function toMcpResult(result: ToolResult, redactor?: Redactor, maxBytes: number = DEFAULT_LIMITS.maxResponseBytes): McpToolResult {
  const safe = (redactor ? redactor.redactValue(result) : result) as ToolResult;
  return buildMcp(fitToBudget(safe, maxBytes));
}
