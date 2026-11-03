import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuditLog } from "./audit.js";
import { AppError, ERROR_CODES, toErrorPayload } from "./errors.js";
import { clampLimit, DEFAULT_LIMITS, LIMIT_MAXIMA, resolveLimits, truncateBytes, truncateList } from "./limits.js";
import { createLogger } from "./logger.js";
import { canRead, canWrite, DEFAULT_PERMISSIONS, isRegistered } from "./permissions.js";
import { collectSecretValues, createRedactor, REDACTED } from "./redact.js";
import { fail, ok, toMcpResult } from "./response.js";

const GH = "ghp_CANARYabcdefghijklmnop1234";
const PAT = "github_pat_CANARY_abcdefghij12345";
const ENVSECRET = "CANARY-db-password-value";

describe("redact (S19)", () => {
  const r = createRedactor({ secretValues: [ENVSECRET], sensitiveFields: ["ssn"] });
  it("redacts by key name, configured fields and nested values", () => {
    const out = r.redactValue({ password: "x", apiKey: "y", Authorization: "z", ssn: "1", ok: "fine", n: { token: "t" } });
    expect(out).toEqual({ password: REDACTED, apiKey: REDACTED, Authorization: REDACTED, ssn: REDACTED, ok: "fine", n: { token: REDACTED } });
  });
  it("redacts token formats, bearer, userinfo and exact env values", () => {
    const s = r.redactString(`a ${GH} b ${PAT} Bearer abc.def-ghi123 postgres://user:pw@host/db and ${ENVSECRET}`);
    for (const bad of [GH, PAT, "abc.def-ghi123", "user:pw", ENVSECRET]) expect(s).not.toContain(bad);
    expect(s).toContain("postgres://");
  });
  it("handles cycles and strips error stacks", () => {
    const a: Record<string, unknown> = { v: 1 };
    a["self"] = a;
    expect(JSON.stringify(r.redactValue(a))).toContain("[CIRCULAR]");
    const e = r.redactValue(new Error(`boom ${GH}`)) as Record<string, unknown>;
    expect(JSON.stringify(e)).not.toContain(GH);
    expect(e).not.toHaveProperty("stack");
  });
  it("collectSecretValues reads only named env vars", () => {
    expect(collectSecretValues(["A", "B"], { A: ENVSECRET, B: undefined })).toEqual([ENVSECRET]);
  });
});

describe("logger", () => {
  afterEach(() => vi.restoreAllMocks());
  it("writes JSON lines to stderr only, never stdout, redacted", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = createLogger({ redactor: createRedactor({ secretValues: [ENVSECRET] }) });
    log.info(`hello ${ENVSECRET}`, { token: GH, note: GH });
    log.debug("hidden");
    expect(out).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(1);
    const line = String(err.mock.calls[0]?.[0]);
    expect(line.endsWith("\n")).toBe(true);
    expect(line).not.toContain(GH);
    expect(line).not.toContain(ENVSECRET);
    expect(JSON.parse(line)).toMatchObject({ level: "info" });
  });
});

describe("errors and response mapping", () => {
  it("covers all doc 04 codes with documented retryability", () => {
    expect(ERROR_CODES).toHaveLength(12);
    expect(new AppError("TIMEOUT", "t").retryable).toBe(true);
    expect(new AppError("PERMISSION_DENIED", "p").retryable).toBe(false);
    expect(new AppError("RATE_LIMITED", "r", { retryAfterSeconds: 30 }).retryAfterSeconds).toBe(30);
  });
  it("unknown errors become generic INTERNAL_ERROR without details", () => {
    const p = toErrorPayload(new Error(`secret ${GH}`));
    expect(p).toEqual({ code: "INTERNAL_ERROR", message: "An internal error occurred.", retryable: false, retryAfterSeconds: null });
  });
  it("success maps to structuredContent + JSON text, no isError", () => {
    const res = toMcpResult(ok([1, 2], { source: "test" }));
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toMatchObject({ success: true, meta: { source: "test", returnedCount: 2, truncated: false, partial: false }, warnings: [] });
    expect(JSON.parse(res.content[0]?.text ?? "")).toEqual(res.structuredContent);
  });
  it("failure sets isError and redacts both channels", () => {
    const r = createRedactor({ secretValues: [ENVSECRET] });
    const res = toMcpResult(fail(new AppError("UPSTREAM_ERROR", `bad ${ENVSECRET}`)), r);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).not.toContain(ENVSECRET);
  });
});

describe("permissions (S18)", () => {
  it("is read-only and denies by default", () => {
    expect(DEFAULT_PERMISSIONS.allowWrites).toBe(false);
    expect(canWrite(undefined, "github_create_issue", true)).toBe(false);
    expect(canWrite({}, "github_create_issue", true)).toBe(false);
  });
  it("needs allowWrites AND exact allowlist entry AND enabled pack", () => {
    const ops = ["github_create_issue", "api:p/e"];
    expect(canWrite({ allowWrites: false, writeOperations: ops }, "github_create_issue", true)).toBe(false);
    expect(canWrite({ allowWrites: true, writeOperations: [] }, "github_create_issue", true)).toBe(false);
    expect(canWrite({ allowWrites: true, writeOperations: ops }, "github_create_issue_x", true)).toBe(false);
    expect(canWrite({ allowWrites: true, writeOperations: ops }, "github_create_issue", false)).toBe(false);
    expect(canWrite({ allowWrites: true, writeOperations: ops }, "api:p/e", true)).toBe(true);
  });
  it("registration and read allowlist", () => {
    expect(isRegistered(DEFAULT_PERMISSIONS, { name: "github_create_issue", write: true, packEnabled: true })).toBe(false);
    expect(isRegistered(DEFAULT_PERMISSIONS, { name: "github_get_issue", write: false, packEnabled: true })).toBe(true);
    expect(isRegistered(DEFAULT_PERMISSIONS, { name: "github_get_issue", write: false, packEnabled: false })).toBe(false);
    expect(canRead(["a/b"], "a/b")).toBe(true);
    expect(canRead(["a/b"], "a/c")).toBe(false);
  });
});

describe("limits (S7, S17)", () => {
  it("has doc 03 defaults and merges overrides", () => {
    expect(DEFAULT_LIMITS.dbMaxRows).toBe(100);
    expect(DEFAULT_LIMITS.maxResponseBytes).toBe(200000);
    expect(resolveLimits({ dbMaxRows: 5, maxResults: -1 })).toMatchObject({ dbMaxRows: 5, maxResults: 100 });
  });
  it("includes redirect defaults and maxima never below defaults", () => {
    expect(DEFAULT_LIMITS.maxRedirectsCustomApi).toBe(0);
    expect(DEFAULT_LIMITS.maxRedirectsGithub).toBe(3);
    expect(LIMIT_MAXIMA.maxRedirectsCustomApi).toBe(0);
    for (const k of Object.keys(DEFAULT_LIMITS) as (keyof typeof DEFAULT_LIMITS)[]) {
      expect(LIMIT_MAXIMA[k]).toBeGreaterThanOrEqual(DEFAULT_LIMITS[k]);
    }
  });
  it("clamps requests to the cap", () => {
    expect(clampLimit(1000, 100)).toBe(100);
    expect(clampLimit(undefined, 100, 30)).toBe(30);
    expect(clampLimit(0, 100, 30)).toBe(30);
  });
  it("reports truncation, never silent", () => {
    expect(truncateList([1, 2, 3], 2)).toEqual({ items: [1, 2], meta: { truncated: true, limit: 2 } });
    expect(truncateList([1], 2).meta).toEqual({ truncated: false });
    const t = truncateBytes("ééé", 3);
    expect(t.text).toBe("é");
    expect(t.meta).toEqual({ truncated: true, limit: 3 });
  });
});

describe("audit", () => {
  it("appends metadata-only redacted JSONL", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    try {
      const path = join(dir, "sub", "audit.jsonl");
      const log = createAuditLog({ path, redactor: createRedactor({ secretValues: [ENVSECRET] }) });
      log.record({ tool: "db_x", integration: "database", resourceRef: `c ${ENVSECRET}`, outcome: "error", errorCode: "QUERY_REJECTED", durationMs: 3, write: false });
      const raw = readFileSync(path, "utf8");
      expect(raw).not.toContain(ENVSECRET);
      expect(JSON.parse(raw.trim())).toMatchObject({ tool: "db_x", outcome: "error", errorCode: "QUERY_REJECTED", write: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("is a no-op without a path and never throws on write failure", () => {
    const onError = vi.fn();
    createAuditLog({}).record({ tool: "t", integration: "i", outcome: "success", durationMs: 1, write: false });
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const blocker = join(dir, "file");
    writeFileSync(blocker, "x");
    createAuditLog({ path: join(blocker, "audit.jsonl"), onError }).record({ tool: "t", integration: "i", outcome: "success", durationMs: 1, write: false });
    expect(onError).toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });
});
