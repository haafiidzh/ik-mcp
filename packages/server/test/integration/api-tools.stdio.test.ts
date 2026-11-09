import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mockProfile, startMockApi, type MockApi } from "../fixtures/mock-api.js";

/** api_* over the real server on stdio against the real mock API on loopback (P4-02). */

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const entry = path.join(pkgRoot, "src/index.ts");
const tsxBin = path.join(pkgRoot, "node_modules/.bin/tsx");
const CANARY = "tok_STDIOAPICANARY_1234567890";

let tmp: string;
let mock: MockApi;
let onCfg: string;
let offCfg: string;
let noPrivCfg: string;
let badCfg: string;
let auditPath: string;
const children: ChildProcessWithoutNullStreams[] = [];

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "dwmcp-api-")));
  mock = await startMockApi();
  auditPath = path.join(tmp, "audit.jsonl");
  const write = (name: string, cfg: unknown): string => {
    const p = path.join(tmp, name);
    writeFileSync(p, JSON.stringify(cfg));
    return p;
  };
  const server = { logLevel: "debug", auditLogPath: auditPath };
  const auth = { auth: { type: "bearer", tokenEnv: "DEVWS_T_API" } };
  onCfg = write("on.json", { server, customApis: [mockProfile(mock, auth)] });
  offCfg = write("off.json", { server, customApis: [mockProfile(mock, { enabled: false })] });
  noPrivCfg = write("nopriv.json", { server, customApis: [mockProfile(mock, { allowPrivateNetwork: false })] });
  badCfg = write("bad.json", {
    customApis: [mockProfile(mock, { endpoints: [{ name: "bad", method: "GET", path: "/x", description: "d", query: { q: { type: "string", pattern: "(a)\\1" } } }] })],
  });
});
afterAll(async () => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  await mock.close();
  rmSync(tmp, { recursive: true, force: true });
});

class Client {
  readonly out: string[] = [];
  readonly err: string[] = [];
  private nextId = 1;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<number | null>;
  constructor(cfg: string) {
    this.child = spawn(tsxBin, [entry, "--config", cfg], {
      cwd: pkgRoot,
      env: { ...process.env, DEVWORKSPACE_CONFIG: "", DEVWS_T_API: CANARY },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(this.child);
    let buf = "";
    this.child.stdout.setEncoding("utf8").on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        this.out.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    this.child.stderr.setEncoding("utf8").on("data", (d: string) => this.err.push(d));
    this.exited = new Promise((res) => this.child.on("exit", (c) => res(c)));
  }
  private async request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }) + "\n");
    for (let i = 0; i < 400; i++) {
      for (const l of this.out) {
        const m = JSON.parse(l) as Record<string, unknown>;
        if (m["id"] === id) return m;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timeout on ${method}; stderr=${this.err.join("")}`);
  }
  async init(): Promise<void> {
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }
  async tools(): Promise<{ name: string; annotations?: Record<string, unknown>; outputSchema?: unknown }[]> {
    return ((await this.request("tools/list"))["result"] as { tools: never[] }).tools;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only loose JSON view
  async call(name: string, args: Record<string, unknown>): Promise<{ res: { success: boolean; data?: any; error?: { code: string; message: string } }; text: string }> {
    const r = (await this.request("tools/call", { name, arguments: args }))["result"] as { content: { text: string }[] };
    const text = r.content[0]?.text ?? "";
    try {
      return { res: JSON.parse(text), text };
    } catch {
      return { res: { success: false, error: { code: "INVALID_INPUT", message: text } }, text };
    }
  }
  async close(): Promise<number | null> {
    this.child.stdin.end();
    return Promise.race([this.exited, new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
  }
}

const open = async (cfg: string): Promise<Client> => {
  const c = new Client(cfg);
  await c.init();
  return c;
};

describe("api_* over stdio", () => {
  it("no enabled profile: no api tool listed, packs.customApi false", async () => {
    const c = await open(offCfg);
    expect((await c.tools()).filter((t) => t.name.startsWith("api_"))).toEqual([]);
    expect(JSON.stringify((await c.call("server_get_status", {})).res.data)).toMatch(/"customApi":false/);
    await c.close();
  }, 30000);

  it("enabled profile: three read-only tools, no outputSchema; happy path with auth; S11/S13/S14/S19/S21", async () => {
    mock.seen.length = 0;
    const c = await open(onCfg);
    const tools = (await c.tools()).filter((t) => t.name.startsWith("api_"));
    expect(tools.map((t) => t.name).sort()).toEqual(["api_call_endpoint", "api_get_endpoint_info", "api_list_profiles"]);
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true });
      expect(t.outputSchema).toBeUndefined();
    }
    expect(JSON.stringify((await c.call("server_get_status", {})).res.data)).toMatch(/"customApi":true/);

    const list = await c.call("api_list_profiles", {});
    expect(list.res.data[0]).toMatchObject({ name: "mock", authType: "bearer" });

    const r = await c.call("api_call_endpoint", { profile: "mock", endpoint: "get-item", pathParams: { id: "9" }, query: { verbose: "1" } });
    expect(r.res.success).toBe(true);
    expect(r.res.data.status).toBe(200);
    expect(r.res.data.body).toMatchObject({ id: "9", Password: "[REDACTED]" });
    expect(mock.seen[0]?.headers["authorization"]).toBe(`Bearer ${CANARY}`);

    const echo = await c.call("api_call_endpoint", { profile: "mock", endpoint: "echo-auth" });
    expect(echo.text).not.toContain(CANARY);

    const hdr = await c.call("api_call_endpoint", { profile: "mock", endpoint: "health", headers: { Authorization: "Bearer evil" } });
    expect(hdr.res.error?.code).toBe("INVALID_INPUT");
    const url = await c.call("api_call_endpoint", { profile: "mock", endpoint: "health", url: "http://evil.test/" });
    expect(url.res.error?.code).toBe("INVALID_INPUT");
    expect((await c.call("api_call_endpoint", { profile: "mock", endpoint: "nope" })).res.error?.code).toBe("NOT_FOUND");
    expect((await c.call("api_call_endpoint", { profile: "mock", endpoint: "get-item", pathParams: { id: "../x" } })).res.success).toBe(false);

    const before = mock.seen.length;
    const redirect = await c.call("api_call_endpoint", { profile: "mock", endpoint: "redirect" });
    expect(redirect.res.data.status).toBe(302);
    await new Promise((res) => setTimeout(res, 150));
    expect(mock.seen.length).toBe(before + 1);

    const code = await c.close();
    expect(code).toBe(0);
    for (const l of c.out) expect((JSON.parse(l) as Record<string, unknown>)["jsonrpc"]).toBe("2.0");
    const audit = readFileSync(auditPath, "utf8");
    expect(audit).toContain("mock/get-item");
    for (const hay of [c.out.join("\n"), c.err.join(""), audit]) {
      expect(hay).not.toContain(CANARY);
      expect(hay).not.toContain("evil.test");
    }
  }, 40000);

  it("S13: profile without allowPrivateNetwork targeting loopback is denied; the mock sees zero requests", async () => {
    const before = mock.seen.length;
    const c = await open(noPrivCfg);
    const r = await c.call("api_call_endpoint", { profile: "mock", endpoint: "health" });
    expect(r.res.error?.code).toBe("PERMISSION_DENIED");
    expect(mock.seen.length).toBe(before);
    await c.close();
  }, 30000);

  it("startup fails closed on an invalid endpoint schema: exit 1, JSON path on stderr, stdout empty", async () => {
    const c = new Client(badCfg);
    const code = await c.close();
    expect(code).toBe(1);
    expect(c.out).toEqual([]);
    expect(c.err.join("")).toContain("customApis[0].endpoints[0]");
    expect(c.err.join("")).not.toContain(CANARY);
  }, 30000);
});
