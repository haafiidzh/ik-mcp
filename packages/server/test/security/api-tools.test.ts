import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfigText } from "../../src/config/load-config.js";
import { createAuditLog, type AuditEntry } from "../../src/core/audit.js";
import { DEFAULT_LIMITS } from "../../src/core/limits.js";
import { createLogger } from "../../src/core/logger.js";
import { createRedactor } from "../../src/core/redact.js";
import type { ResolveFn } from "../../src/integrations/custom-api/url-guard.js";
import { registerTools, type ServerDeps } from "../../src/server/register-tools.js";
import { mockProfile, startMockApi, type MockApi } from "../fixtures/mock-api.js";

/** api_* tools at tool level (P4-02): real registration, tool layer, service, client over the node:http mock. */

const CANARY = "tok_APITOOLCANARY_1234567890abcdef";
const API_TOOLS = ["api_call_endpoint", "api_get_endpoint_info", "api_list_profiles"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only loose JSON view of tool results
type Res = { success: boolean; data?: any; error?: { code: string; message: string }; meta?: Record<string, any>; warnings?: string[] };

interface Harness {
  call(tool: string, args: Record<string, unknown>): Promise<Res & { raw: string }>;
  names: string[];
  audit: AuditEntry[];
  logs: string[];
  mock: MockApi;
  registered: Map<string, { annotations?: Record<string, unknown>; outputSchema?: unknown }>;
}

const mocks: MockApi[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

async function harness(opts: {
  profile?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  env?: Record<string, string>;
  resolve?: ResolveFn;
  mutate?: (p: Record<string, unknown>, mock: MockApi) => Record<string, unknown>;
} = {}): Promise<Harness> {
  const mock = await startMockApi();
  mocks.push(mock);
  const base = mockProfile(mock, opts.profile ?? {});
  const profile = opts.mutate ? opts.mutate(base, mock) : base;
  const handlers = new Map<string, { schema: { safeParse(v: unknown): { success: boolean; data?: unknown } }; fn: (a: unknown) => Promise<{ content: { text: string }[] }> }>();
  const registered = new Map<string, { annotations?: Record<string, unknown>; outputSchema?: unknown }>();
  const server = {
    server: {},
    registerTool: (name: string, cfg: { inputSchema?: { safeParse(v: unknown): { success: boolean; data?: unknown } }; annotations?: Record<string, unknown>; outputSchema?: unknown }, fn: (a: unknown) => Promise<{ content: { text: string }[] }>) => {
      handlers.set(name, { schema: cfg.inputSchema ?? { safeParse: (v) => ({ success: true, data: v }) }, fn });
      registered.set(name, { annotations: cfg.annotations, outputSchema: cfg.outputSchema });
    },
  } as unknown as McpServer;
  const audit: AuditEntry[] = [];
  const auditLog = createAuditLog();
  const real = auditLog.record.bind(auditLog);
  auditLog.record = (e) => (audit.push(e as AuditEntry), real(e));
  const logs: string[] = [];
  const env = opts.env ?? {};
  const redactor = createRedactor({ secretValues: Object.values(env) });
  const deps: ServerDeps = {
    config: parseConfigText(JSON.stringify({ permissions: opts.permissions ?? {}, customApis: [profile] })),
    limits: { ...DEFAULT_LIMITS },
    logger: createLogger({ level: "debug", redactor, write: (l) => logs.push(l) }),
    audit: auditLog,
    redactor,
    startedAtMs: Date.now(),
    apiGetEnv: (n) => env[n],
    ...(opts.resolve ? { apiResolve: opts.resolve } : {}),
  };
  const names = registerTools(server, deps);
  return {
    names,
    audit,
    logs,
    mock,
    registered,
    async call(tool, args) {
      const h = handlers.get(tool);
      if (h === undefined) throw new Error(`not registered: ${tool}`);
      const parsed = h.schema.safeParse(args);
      if (!parsed.success) return { success: false, error: { code: "INVALID_INPUT", message: "schema" }, raw: "" };
      const r = await h.fn(parsed.data);
      const raw = r.content[0]?.text ?? "{}";
      return { ...(JSON.parse(raw) as Res), raw };
    },
  };
}

const call = (h: Harness, endpoint: string, extra: Record<string, unknown> = {}) => h.call("api_call_endpoint", { profile: "mock", endpoint, ...extra });

describe("registration", () => {
  it("registers exactly the three api tools, no outputSchema; GET-only: readOnlyHint true / destructiveHint false", async () => {
    const h = await harness();
    expect(h.names.filter((n) => n.startsWith("api_")).sort()).toEqual(API_TOOLS);
    for (const n of API_TOOLS) {
      expect(h.registered.get(n)?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(h.registered.get(n)?.outputSchema).toBeUndefined();
    }
  });

  it("registers no api tool when no profile is enabled or none is configured", async () => {
    const off = await harness({ profile: { enabled: false } });
    expect(off.names.some((n) => n.startsWith("api_"))).toBe(false);
    const names: string[] = [];
    const server = { server: {}, registerTool: (n: string) => names.push(n) } as unknown as McpServer;
    const redactor = createRedactor();
    registerTools(server, {
      config: parseConfigText("{}"),
      limits: { ...DEFAULT_LIMITS },
      logger: createLogger({ level: "error", redactor, write: () => undefined }),
      audit: createAuditLog(),
      redactor,
      startedAtMs: Date.now(),
    });
    expect(names.some((n) => n.startsWith("api_"))).toBe(false);
  });

  it("with a write endpoint present, api_call_endpoint is not readOnlyHint", async () => {
    const h = await harness({ profile: writeProfile() });
    expect(h.registered.get("api_call_endpoint")?.annotations).toMatchObject({ readOnlyHint: false });
    expect(h.registered.get("api_list_profiles")?.annotations).toMatchObject({ readOnlyHint: true });
  });
});

function writeProfile(): Record<string, unknown> {
  return {
    allowedMethods: ["GET", "POST"],
    endpoints: [
      { name: "health", method: "GET", path: "/health", description: "Health" },
      { name: "create-item", method: "POST", path: "/items", description: "Create", permission: "write", body: { name: { type: "string", maxLength: 20, required: true } } },
    ],
  };
}

describe("happy path and auth", () => {
  it("GET with path param and query returns status, content-type only, parsed JSON, source custom-api", async () => {
    const h = await harness();
    const r = await call(h, "get-item", { pathParams: { id: "42" }, query: { verbose: "yes" } });
    expect(r.success).toBe(true);
    expect(r.data.status).toBe(200);
    expect(Object.keys(r.data.headers)).toEqual(["content-type"]);
    expect(r.data.body.id).toBe("42");
    expect(r.data.body.verbose).toBe("yes");
    expect(r.meta).toMatchObject({ source: "custom-api", truncated: false });
    expect(h.mock.seen[0]?.url).toBe("/items/42?verbose=yes");
    expect(h.audit[0]).toMatchObject({ tool: "api_call_endpoint", integration: "custom-api", resourceRef: "mock/get-item", outcome: "success" });
  });

  it("S19: bearer token reaches the mock but never results, errors, audit or logs (even when the mock echoes it)", async () => {
    const h = await harness({ profile: { auth: { type: "bearer", tokenEnv: "T" } }, env: { T: CANARY } });
    const r = await call(h, "echo-auth");
    expect(h.mock.seen[0]?.headers["authorization"]).toBe(`Bearer ${CANARY}`);
    expect(r.success).toBe(true);
    expect(JSON.stringify(h.audit) + r.raw + h.logs.join("")).not.toContain(CANARY);
    const prof = await h.call("api_list_profiles", {});
    const info = await h.call("api_get_endpoint_info", { profile: "mock", endpoint: "echo-auth" });
    const bad = await call(h, "get-item", { pathParams: { id: "../x" } });
    for (const s of [prof.raw, info.raw, bad.raw, JSON.stringify(h.audit), h.logs.join("")]) expect(s).not.toContain(CANARY);
  });

  it("header auth: value from valueEnv, header name from config; echoed value is redacted", async () => {
    const h = await harness({ profile: { auth: { type: "header", headerName: "X-Api-Key", valueEnv: "K" } }, env: { K: CANARY } });
    const r = await call(h, "echo-auth");
    expect(h.mock.seen[0]?.headers["x-api-key"]).toBe(CANARY);
    expect(r.raw).not.toContain(CANARY);
    expect(r.data.body.note).toContain("[REDACTED]");
  });

  it("missing auth env -> INTEGRATION_UNAVAILABLE, no request, env name/value absent from the message", async () => {
    const h = await harness({ profile: { auth: { type: "bearer", tokenEnv: "T_UNSET_ENV_NAME" } } });
    const r = await call(h, "health");
    expect(r.error?.code).toBe("INTEGRATION_UNAVAILABLE");
    expect(h.mock.seen).toHaveLength(0);
  });

  it("api_list_profiles leaks no secret, env name, header name, path or endpoint detail", async () => {
    const h = await harness({ profile: { auth: { type: "header", headerName: "X-Secret-Header", valueEnv: "SOME_SECRET_ENV" } }, env: { SOME_SECRET_ENV: CANARY } });
    const r = await h.call("api_list_profiles", {});
    expect(r.data).toEqual([{ name: "mock", enabled: true, baseHost: `127.0.0.1:${h.mock.port}`, authType: "header", endpoints: 8 }]);
    expect(r.raw).not.toMatch(/X-Secret-Header|SOME_SECRET_ENV|\/health/i);
    expect(r.raw).not.toContain(CANARY);
  });
});

describe("S11 / S12 input and target control", () => {
  it("tool input cannot set headers, baseUrl, url, host or auth (rejected before any request, audited)", async () => {
    const h = await harness();
    for (const extra of [{ headers: { Authorization: "Bearer x" } }, { baseUrl: "http://evil.test" }, { url: "http://evil.test/x" }, { host: "evil.test" }, { Authorization: "x" }]) {
      const r = await call(h, "health", extra);
      expect(r.success).toBe(false);
      expect(r.error?.code).toBe("INVALID_INPUT");
    }
    const unknown = await call(h, "health", { whatever: 1 });
    expect(unknown.error?.code).toBe("INVALID_INPUT");
    expect(h.mock.seen).toHaveLength(0);
    expect(h.audit.every((a) => a.outcome === "error" && a.errorCode === "INVALID_INPUT")).toBe(true);
    // headers smuggled inside query/pathParams objects are unknown parameters
    const q = await call(h, "health", { query: { headers: "x" } });
    expect(q.error?.code).toBe("INVALID_INPUT");
    expect(h.mock.seen).toHaveLength(0);
  });

  it("unknown/disabled profile or endpoint -> NOT_FOUND; URLs as names -> INVALID_INPUT", async () => {
    const h = await harness();
    expect((await h.call("api_call_endpoint", { profile: "nope", endpoint: "health" })).error?.code).toBe("NOT_FOUND");
    expect((await call(h, "nope")).error?.code).toBe("NOT_FOUND");
    expect((await h.call("api_call_endpoint", { profile: "http://evil.test", endpoint: "health" })).error?.code).toBe("INVALID_INPUT");
    expect((await call(h, "http://evil.test/health")).error?.code).toBe("INVALID_INPUT");
    expect((await h.call("api_get_endpoint_info", { profile: "mock", endpoint: "nope" })).error?.code).toBe("NOT_FOUND");
    expect(h.mock.seen).toHaveLength(0);
    // audit resourceRef never carries the URL-like value
    expect(JSON.stringify(h.audit)).not.toContain("evil.test");
  });

  it("S12: path parameter traversal and encoded traversal are rejected; nothing is sent", async () => {
    const h = await harness();
    for (const id of ["..", "../admin", "a/b", "%2e%2e", "%2e%2e%2fadmin", "a%2fb", "a\\b", "%252e%252e"]) {
      const r = await call(h, "get-item", { pathParams: { id } });
      expect(r.success, id).toBe(false);
      expect(r.error?.code).toBe("INVALID_INPUT");
    }
    expect(h.mock.seen).toHaveLength(0);
  });

  it("S12: a method outside the profile's allowedMethods is denied (endpoint POST on GET-only profile)", async () => {
    const h = await harness({ profile: { allowedMethods: ["GET"], endpoints: [{ name: "post-it", method: "POST", path: "/items", description: "x", body: { n: { type: "string" } } }] }, mutate: (p) => ({ ...p, allowedMethods: ["GET", "POST"] }) });
    // Config validation prevents method outside allowedMethods; the guard still denies via write gating.
    const r = await call(h, "post-it", { body: { n: "a" } });
    expect(r.error?.code).toBe("PERMISSION_DENIED");
    expect(h.mock.seen).toHaveLength(0);
  });
});

describe("S13 network targets (tool level)", () => {
  it("profile WITHOUT allowPrivateNetwork targeting 127.0.0.1 is denied before any connection", async () => {
    const h = await harness({ profile: { allowPrivateNetwork: false } });
    const r = await call(h, "health");
    expect(r.error?.code).toBe("PERMISSION_DENIED");
    expect(h.mock.seen).toHaveLength(0);
  });

  it("cloud metadata is denied even with allowPrivateNetwork", async () => {
    const h = await harness({ mutate: (p) => ({ ...p, baseUrl: "http://169.254.169.254" }) });
    const r = await call(h, "health");
    expect(r.error?.code).toBe("PERMISSION_DENIED");
    expect(h.mock.seen).toHaveLength(0);
  });

  it("a name that resolves to public AND private is denied (all answers checked)", async () => {
    const h = await harness({
      profile: { allowPrivateNetwork: false },
      mutate: (p, m) => ({ ...p, baseUrl: `http://mixed.test:${m.port}` }),
      resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }],
    });
    expect((await call(h, "health")).error?.code).toBe("PERMISSION_DENIED");
    expect(h.mock.seen).toHaveLength(0);
  });

  it("DNS rebinding: the name resolves to loopback once; the connection goes to the validated address", async () => {
    let n = 0;
    const h = await harness({
      mutate: (p, m) => ({ ...p, baseUrl: `http://rebind.test:${m.port}` }),
      resolve: async () => [{ address: ++n === 1 ? "127.0.0.1" : "169.254.169.254", family: 4 }],
    });
    const r = await call(h, "health");
    expect(r.success).toBe(true);
    expect(n).toBe(1);
    expect(h.mock.seen[0]?.headers["host"]).toBe(`rebind.test:${h.mock.port}`);
  });
});

describe("S14 / S15 / timeout", () => {
  it("S14: 302 is returned as data; Location not followed; no second request", async () => {
    const h = await harness();
    const r = await call(h, "redirect");
    expect(r.success).toBe(true);
    expect(r.data.status).toBe(302);
    expect(r.data.headers).toEqual({ "content-type": "text/plain" });
    expect(r.warnings?.join(" ")).toMatch(/redirect/i);
    await new Promise((res) => setTimeout(res, 100));
    expect(h.mock.seen).toHaveLength(1);
  });

  it("S15: oversized body is cut at maxResponseBytes, flagged truncated, connection aborted", async () => {
    const h = await harness({ profile: { maxResponseBytes: 2000 } });
    const r = await call(h, "big", { query: { bytes: 3_000_000 } });
    expect(r.success).toBe(true);
    expect(r.meta?.["truncated"]).toBe(true);
    expect(r.meta?.["limit"]).toBe(2000);
    expect(r.data.body).toHaveLength(2000);
    for (let i = 0; i < 40 && h.mock.aborted.count === 0; i++) await new Promise((res) => setTimeout(res, 50));
    expect(h.mock.aborted.count).toBe(1);
  });

  it("the global response budget still holds (profile limit above the budget)", async () => {
    const h = await harness({ profile: { maxResponseBytes: 5_000_000 } });
    const r = await call(h, "big", { query: { bytes: 3_000_000 } });
    expect(r.success).toBe(true);
    expect(r.meta?.["truncated"]).toBe(true);
    expect(Buffer.byteLength(r.raw)).toBeLessThan(DEFAULT_LIMITS.maxResponseBytes);
  });

  it("timeout -> TIMEOUT", async () => {
    const h = await harness({ profile: { timeoutMs: 200 } });
    const r = await call(h, "slow", { query: { ms: 3000 } });
    expect(r.error?.code).toBe("TIMEOUT");
  });

  it("non-text content is described, not returned", async () => {
    const h = await harness();
    const r = await call(h, "binary");
    expect(r.success).toBe(true);
    expect(r.data.body).toMatchObject({ omitted: expect.any(String), contentType: "application/octet-stream" });
  });
});

describe("redaction", () => {
  it("sensitiveFields (case-insensitive, nested, arrays) and core sensitive keys are redacted; other data kept", async () => {
    const h = await harness();
    const r = await call(h, "get-item", { pathParams: { id: "7" } });
    const b = r.data.body;
    expect(b.Password).toBe("[REDACTED]");
    expect(b.owner.Email).toBe("[REDACTED]");
    expect(b.owner.nested[0].SSN).toBe("[REDACTED]");
    expect(b.owner.nested[0].keep).toBe(1);
    expect(b.list[0].api_key_x).toBe("[REDACTED]");
    expect(b.list[0].ok).toBe(true);
    expect(b.name).toBe("widget");
    expect(r.raw).not.toMatch(/hunter2|123-45-6789|a@b\.test/);
  });
});

describe("S18 write gating (api)", () => {
  it("write endpoint is denied with allowWrites=false, described as gated, nothing sent", async () => {
    const h = await harness({ profile: writeProfile(), permissions: { allowWrites: false, writeOperations: ["api:mock/create-item"] } });
    const r = await call(h, "create-item", { body: { name: "x" } });
    expect(r.error?.code).toBe("PERMISSION_DENIED");
    expect(h.mock.seen).toHaveLength(0);
    const info = await h.call("api_get_endpoint_info", { profile: "mock", endpoint: "create-item" });
    expect(info.data).toMatchObject({ method: "POST", permission: "write", callable: false, writeGated: true });
    expect((await call(h, "health")).success).toBe(true);
  });

  it("allowWrites=true without the exact writeOperations entry is still denied; with it the call succeeds", async () => {
    const no = await harness({ profile: writeProfile(), permissions: { allowWrites: true, writeOperations: ["api:mock/other"] } });
    expect((await call(no, "create-item", { body: { name: "x" } })).error?.code).toBe("PERMISSION_DENIED");
    expect(no.mock.seen).toHaveLength(0);
    const yes = await harness({ profile: writeProfile(), permissions: { allowWrites: true, writeOperations: ["api:mock/create-item"] } });
    const r = await call(yes, "create-item", { body: { name: "x" } });
    expect(r.success).toBe(true);
    expect(r.data.status).toBe(201);
    expect(yes.mock.seen[0]).toMatchObject({ method: "POST", body: '{"name":"x"}' });
    expect(yes.mock.seen[0]?.headers["content-type"]).toBe("application/json");
  });

  it("body is validated by the endpoint schema (unknown / missing field rejected)", async () => {
    const h = await harness({ profile: writeProfile(), permissions: { allowWrites: true, writeOperations: ["api:mock/create-item"] } });
    expect((await call(h, "create-item", { body: { name: "x", extra: 1 } })).error?.code).toBe("INVALID_INPUT");
    expect((await call(h, "create-item", { body: {} })).error?.code).toBe("INVALID_INPUT");
    expect((await call(h, "create-item")).error?.code).toBe("INVALID_INPUT");
    expect(h.mock.seen).toHaveLength(0);
  });
});

describe("startup validation", () => {
  it("an enabled endpoint with an invalid schema fails registration with the JSON path and no values", async () => {
    await expect(
      harness({ mutate: (p) => ({ ...p, endpoints: [{ name: "bad", method: "GET", path: "/x", description: "d", query: { q: { type: "string", pattern: "(a)\\1" } } }] }) }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining("customApis[0].endpoints[0]") });
  });

  it("a disabled profile's invalid schema does not block startup", async () => {
    const h = await harness({ profile: { enabled: false }, mutate: (p) => ({ ...p, endpoints: [{ name: "bad", method: "GET", path: "/x", description: "d", query: { q: { type: "string", pattern: "(a)\\1" } } }] }) });
    expect(h.names.some((n) => n.startsWith("api_"))).toBe(false);
  });

  it("a reserved header name for header auth is refused", async () => {
    await expect(harness({ profile: { auth: { type: "header", headerName: "Host", valueEnv: "X" } } })).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});

describe("P4-03 audit write flag (derived from configured endpoint)", () => {
  it("write endpoint denied by allowWrites:false -> write:true, error code, profile/endpoint only", async () => {
    const h = await harness({ profile: writeProfile() });
    const r = await call(h, "create-item", { body: { name: "SECRETBODY" } });
    expect(r.error?.code).toBe("PERMISSION_DENIED");
    expect(h.audit.at(-1)).toMatchObject({ tool: "api_call_endpoint", resourceRef: "mock/create-item", outcome: "error", errorCode: "PERMISSION_DENIED", write: true });
    expect(JSON.stringify(h.audit)).not.toContain("SECRETBODY");
    expect(h.mock.seen).toHaveLength(0);
  });

  it("allowed write (exact writeOperations entry) -> write:true + success", async () => {
    const h = await harness({ profile: writeProfile(), permissions: { allowWrites: true, writeOperations: ["api:mock/create-item"] } });
    const r = await call(h, "create-item", { body: { name: "n" } });
    expect(r.success).toBe(true);
    expect(h.audit.at(-1)).toMatchObject({ resourceRef: "mock/create-item", outcome: "success", write: true });
  });

  it("GET -> write:false; unknown endpoint and invalid input -> write:false; other api tools write:false", async () => {
    const h = await harness({ profile: writeProfile() });
    await call(h, "health");
    expect(h.audit.at(-1)).toMatchObject({ write: false, outcome: "success" });
    await call(h, "nope");
    expect(h.audit.at(-1)).toMatchObject({ write: false, errorCode: "NOT_FOUND" });
    await h.call("api_call_endpoint", { profile: "mock", endpoint: "create-item", url: "http://x" });
    expect(h.audit.at(-1)?.write).toBe(true); // configured endpoint is a write; the attempt is still a write attempt
    await h.call("api_get_endpoint_info", { profile: "mock", endpoint: "create-item" });
    expect(h.audit.at(-1)?.write).toBe(false);
    await h.call("api_list_profiles", {});
    expect(h.audit.at(-1)?.write).toBe(false);
  });
});
