import type { ReadResourceResult } from "@modelcontextprotocol/server";
import { AppError, toErrorPayload } from "../core/errors.js";
import { fail, fitToBudget, type ToolResult } from "../core/response.js";
import type { ServerDeps } from "../server/register-tools.js";

export const JSON_MIME = "application/json";

/** Resource reads throw this; the SDK turns it into a JSON-RPC error (message is already safe). */
export function readError(err: unknown): Error {
  const p = toErrorPayload(err);
  return new Error(`${p.code}: ${p.message}`);
}

/** Template variable as a single string, or a safe NOT_FOUND-style error. */
export function variable(vars: Record<string, string | string[]>, key: string): string {
  const v = vars[key];
  if (typeof v !== "string" || v.length === 0 || v.length > 100) {
    throw new AppError("INVALID_INPUT", "Invalid resource URI.");
  }
  return v;
}

/**
 * Serialize a result as one JSON text content item: redacted first, then fitted to the response
 * budget (same envelope as tool results, doc 04 section 2). Failures become thrown read errors.
 */
export function toReadResult(deps: ServerDeps, uri: URL, result: ToolResult): ReadResourceResult {
  const safe = deps.redactor.redactValue(result) as ToolResult;
  const fitted = fitToBudget(safe, deps.limits.maxResponseBytes);
  if (!fitted.success) throw new Error(`${fitted.error.code}: ${fitted.error.message}`);
  return { contents: [{ uri: uri.href, mimeType: JSON_MIME, text: JSON.stringify(fitted) }] };
}

/** Run a body, auditing metadata only (no content), mapping errors to safe read errors. */
export async function runResource(
  deps: ServerDeps,
  name: string,
  integration: string,
  ref: string | undefined,
  uri: URL,
  body: () => Promise<ToolResult> | ToolResult,
): Promise<ReadResourceResult> {
  const t0 = Date.now();
  let result: ToolResult;
  try {
    result = await body();
  } catch (err) {
    deps.logger.error("resource failed", { resource: name, error: err instanceof Error ? err.message : "unknown" });
    result = fail(err);
  }
  deps.audit.record({
    tool: `resource:${name}`,
    integration,
    ...(ref !== undefined ? { resourceRef: ref } : {}),
    outcome: result.success ? "success" : "error",
    ...(!result.success ? { errorCode: result.error.code } : {}),
    durationMs: Date.now() - t0,
    write: false,
  });
  return toReadResult(deps, uri, result);
}
