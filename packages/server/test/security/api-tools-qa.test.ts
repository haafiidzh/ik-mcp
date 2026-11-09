import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mockProfile, startMockApi, type MockApi } from "../fixtures/mock-api.js";
import { classifyAddress, isAddressAllowed, prepareApiRequest, type GuardProfile } from "../../src/integrations/custom-api/url-guard.js";

/** QA-05: adversarial checks on the Custom API pack over the BUILT dist/index.js on real stdio. */

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const entry = path.join(pkgRoot, "dist/index.js");
const CANARY = "tok_QA05CANARY_abcdef123456";

let tmp: string;
let mock: MockApi;
let raw: Server;
let rawPort = 0;
let rawHits: string[] = [];
let auditPath: string;
const children: ChildProcessWithoutNullStreams[] = [];

const DEEP = "[".repeat(60000) + "]".repeat(60000);

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "dwmcp-qa05-")));
  auditPath = path.join(tmp, "audit.jsonl");
  mock = await startMockApi();
  raw = createServer((req, res) => {
    rawHits.push(`${req.method} ${req.url}`);
    const p = (req.url ?? "").split("?")[0];
    const auth = String(req.headers["authorization"] ?? "");
    if (p === "/gzip") {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      return void res.end(gzipSync(Buffer.from(JSON.stringify({ a: "x".repeat(50000) }))));
    }
    if (p === "/hugeheaders") {
      res.writeHead(200, { "content-type": "application/json", "x-big": "a".repeat(15000) });
      return void res.end("{}");
    }
    if (p === "/deep") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(DEEP);
    }
    if (p === "/badjson") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end('{"a": ' + auth);
    }
    if (p === "/endless") {
      res.writeHead(200, { "content-type": "text/plain" });
      const t = setInterval(() => res.write("y".repeat(4096)), 1);
      res.on("close", () => clearInterval(t));
      return;
    }
    if (p === "/loris") {
      res.writeHead(200, { "content-type": "text/plain" });
      const t = setInterval(() => res.write("z"), 200);
      res.on("close", () => clearInterval(t));
      return;
    }
    if (p === "/err500") {
      res.writeHead(500, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "boom", debug: auth, password: "pw1", nested: [{ Password: "pw2" }] }));
    }
    if (p === "/ctype") {
      res.writeHead(200, { "content-type": `application/x-thing; token=${auth.replace("Bearer ", "")}` });
      return void res.end("binary");
    }
    if (p === "/loc") {
      res.writeHead(301, { location: "http://169.254.169.254/latest/meta-data", "set-cookie": "s=1", "content-type": "text/plain" });
      return void res.end("moved");
    }
    if (p === "/deep2") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end("[".repeat(45000) + "]".repeat(45000));
    }
    if (p === "/b64") {
      res.writeHead(200, { "content-type": "text/plain" });
      return void res.end(`b64=${Buffer.from(auth.replace("Bearer ", "")).toString("base64")} url=${encodeURIComponent(auth.replace("Bearer ", ""))} lower=${auth.toLowerCase()}`);
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("nf " + auth);
  });
  await new Promise<void>((r) => raw.listen(0, "127.0.0.1", r));
  rawPort = (raw.address() as AddressInfo).port;
});
afterAll(async () => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  raw.closeAllConnections();
  raw.close();
  await mock.close();
  rmSync(tmp, { recursive: true, force: true });
});

class Client {
  readonly out: string[] = [];
  readonly err: string[] = [];
  private nextId = 1;
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<number | null>;
  constructor(cfg: string, env: Record<string, string> = {}) {
    this.child = spawn("node", [entry, "--config", cfg], { cwd: tmp, env: { ...process.env, DEVWORKSPACE_CONFIG: "", DEVWS_QA_TOKEN: CANARY, ...env }, stdio: ["pipe", "pipe", "pipe"] });
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
    this.exited = new Promise((res) => this.child.on("exit", (c, s) => res(c ?? (s === "SIGTERM" ? 143 : -1))));
  }
  private async request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }) + "\n");
    for (let i = 0; i < 600; i++) {
      for (const l of this.out) {
        const m = JSON.parse(l) as Record<string, unknown>;
        if (m["id"] === id) return m;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timeout ${method}; stderr=${this.err.join("")}`);
  }
  async init(): Promise<void> {
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }
  async tools(): Promise<{ name: string; annotations?: Record<string, unknown> }[]> {
    return ((await this.request("tools/list"))["result"] as { tools: never[] }).tools;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only loose JSON view
  async call(name: string, args: Record<string, unknown>): Promise<{ res: { success: boolean; data?: any; meta?: any; warnings?: string[]; error?: { code: string; message: string } }; text: string }> {
    const r = (await this.request("tools/call", { name, arguments: args }))["result"] as { content: { text: string }[] };
    const text = r.content[0]?.text ?? "";
    try {
      return { res: JSON.parse(text), text };
    } catch {
      return { res: { success: false, error: { code: "INVALID_INPUT", message: text } }, text };
    }
  }
  allOutput(): string {
    return this.out.join("\n") + this.err.join("");
  }
}
const open = async (cfg: string, env?: Record<string, string>): Promise<Client> => {
  const c = new Client(cfg, env);
  await c.init();
  return c;
};
const writeCfg = (name: string, cfg: unknown): string => {
  const p = path.join(tmp, name);
  writeFileSync(p, JSON.stringify(cfg));
  return p;
};
const server = (): Record<string, unknown> => ({ logLevel: "debug", auditLogPath: auditPath });

// ---------------------------------------------------------------------------
describe("QA-05 SSRF: profile without allowPrivateNetwork, real stdio", () => {
  const targets: Record<string, string> = {
    v4loop: `http://127.0.0.1:${0}`,
    localhost: `http://localhost:${0}`,
    v6loop: `http://[::1]:${0}`,
    ten: "http://10.1.2.3:80",
    metadata: "http://169.254.169.254",
    cgnat: "http://100.64.0.1",
    zero: "http://0.0.0.0:1",
    decimal: "http://2130706433:1",
    hex: "http://0x7f000001:1",
    octal: "http://0177.0.0.1:1",
    short: "http://127.1:1",
    mapped: "http://[::ffff:127.0.0.1]:1",
    mappedHex: "http://[::ffff:7f00:1]:1",
    mappedMeta: "http://[::ffff:169.254.169.254]",
    ula: "http://[fd00:ec2::254]",
    linklocal6: "http://[fe80::1]",
    nat64: "http://[64:ff9b::7f00:1]:1",
    sixToFour: "http://[2002:7f00:1::]:1",
    unspec6: "http://[::]:1",
  };
  it("every target is denied and the loopback mock sees zero requests", async () => {
    mock.seen.length = 0;
    const profiles = Object.entries(targets).map(([name, base]) => ({
      name,
      enabled: true,
      baseUrl: base.replace(/:0$/, `:${mock.port}`),
      auth: { type: "none" },
      allowedMethods: ["GET"],
      timeoutMs: 2000,
      endpoints: [{ name: "h", method: "GET", path: "/health", description: "h" }],
    }));
    const c = await open(writeCfg("ssrf.json", { server: server(), customApis: profiles }));
    const results: Record<string, string> = {};
    for (const p of profiles) {
      const r = await c.call("api_call_endpoint", { profile: p.name, endpoint: "h" });
      results[p.name] = r.res.success ? "ALLOWED" : (r.res.error?.code ?? "?");
    }
    const allowed = Object.entries(results).filter(([, v]) => v === "ALLOWED");
    expect(allowed).toEqual([]);
    expect(Object.values(results).every((v) => v === "PERMISSION_DENIED")).toBe(true);
    expect(mock.seen).toHaveLength(0);
    c.child.stdin.end();
  }, 60000);

  it("classification table (unit): blocked forms, public stays public", () => {
    for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "::ffff:a00:1", "100.64.0.1", "169.254.1.1", "0.0.0.0", "fc00::1", "fe80::1", "224.0.0.1", "255.255.255.255"]) {
      expect(isAddressAllowed(classifyAddress(a), false), a).toBe(false);
    }
    for (const a of ["8.8.8.8", "2606:4700:4700::1111"]) expect(isAddressAllowed(classifyAddress(a), false), a).toBe(true);
    for (const a of ["169.254.169.254", "169.254.170.2", "100.100.100.200", "fd00:ec2::254", "::ffff:169.254.169.254", "0.0.0.0", "224.0.0.1"]) {
      expect(isAddressAllowed(classifyAddress(a), true), `${a} with flag`).toBe(false);
    }
    for (const a of ["127.0.0.1", "::1", "10.0.0.1", "fc00::1"]) expect(isAddressAllowed(classifyAddress(a), true), a).toBe(true);
  });

  it("resolver injection: hostnames to private, mixed A/AAAA, rebinding answer order", async () => {
    const prof = (allow: boolean): GuardProfile => ({ name: "p", enabled: true, baseUrl: "http://api.example.test", allowPrivateNetwork: allow, allowedMethods: ["GET"], endpoints: [{ name: "e", method: "GET", path: "/x" }] });
    const run = (answers: { address: string; family: 4 | 6 }[], allow = false) =>
      prepareApiRequest({ profiles: [prof(allow)], profile: "p", endpoint: "e", resolve: async () => answers });
    await expect(run([{ address: "10.0.0.5", family: 4 }])).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(run([{ address: "93.184.216.34", family: 4 }, { address: "::1", family: 6 }])).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(run([{ address: "::1", family: 6 }, { address: "93.184.216.34", family: 4 }])).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(run([{ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }], true)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(run([])).rejects.toMatchObject({ code: "INTEGRATION_UNAVAILABLE" });
    const okp = await run([{ address: "93.184.216.34", family: 4 }]);
    expect(okp.pinnedAddress).toBe("93.184.216.34");
    // pinned lookup refuses another name and never calls DNS
    await new Promise<void>((resolve) => okp.lookup("evil.test", {}, (err) => { expect(err).toBeTruthy(); resolve(); }));
  });

  it("allowPrivateNetwork:true: loopback works, metadata IPs still denied, mock sees nothing for metadata", async () => {
    mock.seen.length = 0;
    const mk = (name: string, base: string) => ({ name, enabled: true, baseUrl: base, allowPrivateNetwork: true, auth: { type: "none" }, allowedMethods: ["GET"], timeoutMs: 2000, endpoints: [{ name: "h", method: "GET", path: "/health", description: "h" }] });
    const c = await open(writeCfg("ssrf2.json", { server: server(), customApis: [mk("loop", `http://127.0.0.1:${mock.port}`), mk("m1", "http://169.254.169.254"), mk("m2", "http://169.254.170.2"), mk("m3", "http://100.100.100.200"), mk("m4", "http://[fd00:ec2::254]"), mk("m5", "http://[::ffff:169.254.169.254]"), mk("m6", "http://2852039166")] }));
    expect((await c.call("api_call_endpoint", { profile: "loop", endpoint: "h" })).res.success).toBe(true);
    for (const n of ["m1", "m2", "m3", "m4", "m5", "m6"]) {
      const r = await c.call("api_call_endpoint", { profile: n, endpoint: "h" });
      expect(r.res.error?.code, n).toBe("PERMISSION_DENIED");
    }
    c.child.stdin.end();
  }, 60000);
});

// ---------------------------------------------------------------------------
describe("QA-05 URL building and argument injection", () => {
  it("path/query injection never leaves the endpoint; extra args rejected", async () => {
    mock.seen.length = 0;
    const cfgObj = { server: server(), customApis: [mockProfile(mock)] };
    const c = await open(writeCfg("url.json", cfgObj));
    const bad = ["../x", "..", "%2e%2e", "%2E%2e%2f", "a%2fb", "a/b", "a\\b", "a\u0000b", "a%00b", "․․", "a%252fb", "%252e%252e", "", "x".repeat(5000), "a\r\nHost: evil", "a?b=1", "a#frag", "a%3Fb"];
    const sent: string[] = [];
    for (const id of bad) {
      const r = await c.call("api_call_endpoint", { profile: "mock", endpoint: "get-item", pathParams: { id } });
      if (r.res.success) sent.push(`${JSON.stringify(id)} -> ${mock.seen.at(-1)?.url}`);
    }
    // Anything that was accepted must still be a single encoded segment under /items/
    for (const s of sent) expect(mock.seen.every((q) => /^\/items\/[^/?#]+(\?.*)?$/.test(q.url) || q.url === "/health"), s).toBe(true);
    // query smuggling
    for (const v of ["1&admin=true", "1#x", "1?y=2", "1\r\nX-Evil: 1", "1%26admin%3Dtrue"]) {
      const r = await c.call("api_call_endpoint", { profile: "mock", endpoint: "get-item", pathParams: { id: "7" }, query: { verbose: v } });
      if (r.res.success) {
        const u = new URL(mock.seen.at(-1)?.url ?? "", "http://x");
        expect([...u.searchParams.keys()]).toEqual(["verbose"]);
        expect(u.searchParams.get("verbose")).toBe(v);
      }
    }
    // duplicate / undeclared query keys, array value
    for (const q of [{ verbose: "1", admin: "1" }, { verbose: ["1", "2"] }, { "verbose&x": "1" }]) {
      expect((await c.call("api_call_endpoint", { profile: "mock", endpoint: "get-item", pathParams: { id: "7" }, query: q })).res.success).toBe(false);
    }
    // arbitrary target args
    for (const extra of [{ url: "http://evil.test/" }, { baseUrl: "http://evil.test" }, { headers: { "X-A": "b" } }, { method: "DELETE" }, { Host: "evil" }, { proxy: "x" }, { follow: true }]) {
      const r = await c.call("api_call_endpoint", { profile: "mock", endpoint: "health", ...extra });
      expect(r.res.success, JSON.stringify(extra)).toBe(false);
    }
    // prototype-pollution style keys
    const pr = await c.call("api_call_endpoint", { profile: "mock", endpoint: "get-item", pathParams: JSON.parse('{"id":"1","__proto__":{"x":1}}') });
    writeFileSync("/tmp/qa05/proto.json", JSON.stringify({ ok: pr.res.success, last: mock.seen.at(-1)?.url, text: pr.text.slice(0, 200) }));
    if (pr.res.success) expect(mock.seen.at(-1)?.url).toBe("/items/1");
    // profile / endpoint as URL or traversal
    expect((await c.call("api_call_endpoint", { profile: "http://evil.test", endpoint: "health" })).res.success).toBe(false);
    expect((await c.call("api_call_endpoint", { profile: "mock", endpoint: "../health" })).res.error?.code).toBe("NOT_FOUND");
    for (const q of mock.seen) expect(q.headers["x-evil"] ?? q.headers["x-a"]).toBeUndefined();
    expect(mock.seen.every((q) => q.headers["host"] === `127.0.0.1:${mock.port}`)).toBe(true);
    c.child.stdin.end();
  }, 90000);
});

// ---------------------------------------------------------------------------
describe("QA-05 responses: redirects, size, hostile bodies, secrets", () => {
  const rawProfile = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: "raw",
    enabled: true,
    baseUrl: `http://127.0.0.1:${rawPort}`,
    allowPrivateNetwork: true,
    auth: { type: "bearer", tokenEnv: "DEVWS_QA_TOKEN" },
    allowedMethods: ["GET"],
    timeoutMs: 2500,
    maxResponseBytes: 100000,
    sensitiveFields: ["password"],
    endpoints: ["gzip", "hugeheaders", "deep", "badjson", "endless", "loris", "err500", "ctype", "loc", "b64", "deep2", "nf"].map((n) => ({ name: n, method: "GET", path: `/${n}`, description: n })),
    ...extra,
  });
  it("hostile responses are bounded, canary never leaks anywhere", async () => {
    rawHits = [];
    const c = await open(writeCfg("raw.json", { server: server(), customApis: [rawProfile()] }));
    const call = (e: string) => c.call("api_call_endpoint", { profile: "raw", endpoint: e });
    const t0 = Date.now();
    const results: Record<string, unknown> = {};
    for (const e of ["gzip", "hugeheaders", "deep", "badjson", "endless", "loris", "err500", "ctype", "loc", "b64", "nf"]) {
      const s = Date.now();
      const r = await call(e);
      results[e] = { ms: Date.now() - s, ok: r.res.success, code: r.res.error?.code, status: r.res.data?.status, trunc: r.res.meta?.truncated, len: r.text.length, headers: r.res.data?.headers, body: JSON.stringify(r.res.data?.body ?? "").slice(0, 160) };
      expect(r.text.length, e).toBeLessThanOrEqual(200000);
      expect(r.text, e).not.toContain(CANARY);
    }
    writeFileSync("/tmp/qa05/results.json", JSON.stringify(results, null, 1));
    expect(Date.now() - t0).toBeLessThan(30000);
    const redirect = await call("loc");
    expect(redirect.res.data.status).toBe(301);
    expect(redirect.text).not.toMatch(/169\.254|set-cookie|location/i);
    expect(rawHits.filter((h) => h.includes("/loc"))).toHaveLength(2); // one per call(), never followed to a second hop
    const e500 = await call("err500");
    expect(e500.text).not.toMatch(/pw1|pw2/);
    const b64 = await call("b64");
    // Encoded echoes (percent-encoding, lower-case) are scrubbed by the P4-05 encoded variants; other encodings are recorded as it.fails in retest-qa10.test.ts.
    expect(b64.text).not.toContain(encodeURIComponent(CANARY));
    expect(b64.text).not.toContain(CANARY.toLowerCase());
    const gz = await call("gzip");
    expect(gz.res.success).toBe(true);
    expect(gz.res.data.body).toMatchObject({ omitted: expect.any(String), encoding: "gzip" }); // P4-06
    expect(rawHits.some((h) => h.includes("/gzip"))).toBe(true);
    // process still healthy
    expect((await c.call("api_list_profiles", {})).res.success).toBe(true);
    const all = c.allOutput() + (existsSync(auditPath) ? readFileSync(auditPath, "utf8") : "");
    expect(all).not.toContain(CANARY);
    c.child.stdin.end();
    expect(await Promise.race([c.exited, new Promise((r) => setTimeout(() => r("hang"), 8000))])).toBe(0);
  }, 120000);

  it("deep JSON under the byte cap does not crash or hang the server", async () => {
    const c = await open(writeCfg("deep2.json", { server: server(), customApis: [rawProfile()] }));
    const r = await c.call("api_call_endpoint", { profile: "raw", endpoint: "deep2" });
    writeFileSync("/tmp/qa05/deep2.json", JSON.stringify({ ok: r.res.success, code: r.res.error?.code, len: r.text.length, err: r.res.error?.message }));
    expect((await c.call("api_list_profiles", {})).res.success).toBe(true);
    c.child.stdin.end();
  }, 30000);

  it("F2 (P4-05): base64 re-encoding of the token echoed by the API is redacted", async () => {
    const c = await open(writeCfg("b64.json", { server: server(), customApis: [rawProfile()] }));
    const r = await c.call("api_call_endpoint", { profile: "raw", endpoint: "b64" });
    expect(r.text).not.toContain(Buffer.from(CANARY).toString("base64"));
    c.child.stdin.end();
  }, 30000);

  it("accept-encoding sent is identity", async () => {
    const seenHeaders: Record<string, unknown>[] = [];
    const s = createServer((req, res) => { seenHeaders.push(req.headers); res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as AddressInfo).port;
    const c = await open(writeCfg("ae.json", { server: server(), customApis: [rawProfile({ baseUrl: `http://127.0.0.1:${port}` })] }));
    await c.call("api_call_endpoint", { profile: "raw", endpoint: "nf" });
    expect(seenHeaders[0]?.["accept-encoding"]).toBe("identity");
    c.child.stdin.end();
    s.closeAllConnections(); s.close();
  }, 30000);

  it("auth: missing env -> INTEGRATION_UNAVAILABLE without value, zero requests; list/info never leak", async () => {
    rawHits = [];
    const c = new Client(writeCfg("noenv.json", { server: server(), customApis: [rawProfile({ auth: { type: "header", headerName: "X-Api-Key", valueEnv: "DEVWS_QA_MISSING" } })] }), {});
    await c.init();
    const r = await c.call("api_call_endpoint", { profile: "raw", endpoint: "nf" });
    expect(r.res.error?.code).toBe("INTEGRATION_UNAVAILABLE");
    expect(rawHits).toHaveLength(0);
    const l = await c.call("api_list_profiles", {});
    const i = await c.call("api_get_endpoint_info", { profile: "raw", endpoint: "nf" });
    expect(l.text + i.text).not.toMatch(/X-Api-Key|DEVWS_QA_MISSING|DEVWS_QA_TOKEN/i);
    c.child.stdin.end();
  }, 30000);

  it("disabled profile listing omits baseHost (P4-04)", async () => {
    const c = await open(writeCfg("dis.json", { server: server(), customApis: [rawProfile(), rawProfile({ name: "off", enabled: false, baseUrl: "https://internal.corp.example:8443/v1" })] }));
    const l = await c.call("api_list_profiles", {});
    expect(l.text).not.toContain("internal.corp.example");
    expect(l.text).toContain('"name":"off"');
    c.child.stdin.end();
  }, 30000);
});

// ---------------------------------------------------------------------------
describe("QA-05 writes (S18) and startup (S21)", () => {
  const postProfile = (): Record<string, unknown> =>
    mockProfile(mock, { allowedMethods: ["GET", "POST", "PUT", "DELETE"], endpoints: [
      { name: "create", method: "POST", path: "/items", description: "c", body: { name: { type: "string", maxLength: 10 } } },
      { name: "wput", method: "PUT", path: "/items/{id}", description: "p", pathParams: { id: { type: "string", maxLength: 5 } }, body: { name: { type: "string" } } },
      { name: "wdel", method: "DELETE", path: "/items/{id}", description: "d", pathParams: { id: { type: "string", maxLength: 5 } } },
      { name: "health", method: "GET", path: "/health", description: "h", permission: "write" },
    ] });
  it("allowWrites:false: denied before any connection; info marks writeGated", async () => {
    mock.seen.length = 0;
    const c = await open(writeCfg("w0.json", { server: server(), customApis: [postProfile()] }));
    for (const [e, extra] of [["create", { body: { name: "n" } }], ["wput", { pathParams: { id: "1" }, body: { name: "n" } }], ["wdel", { pathParams: { id: "1" } }], ["health", {}]] as const) {
      const r = await c.call("api_call_endpoint", { profile: "mock", endpoint: e, ...extra });
      expect(r.res.error?.code, e).toBe("PERMISSION_DENIED");
    }
    expect(mock.seen).toHaveLength(0);
    expect((await c.call("api_get_endpoint_info", { profile: "mock", endpoint: "create" })).res.data.writeGated).toBe(true);
    const t = (await c.tools()).find((x) => x.name === "api_call_endpoint");
    writeFileSync("/tmp/qa05/annot.json", JSON.stringify(t));
    c.child.stdin.end();
  }, 30000);
  it("allowWrites:true without exact writeOperations: still denied; wildcard-ish entries do not match", async () => {
    mock.seen.length = 0;
    for (const ops of [[], ["api:mock/*"], ["api:mock"], ["api:mock/creat"], ["API:MOCK/CREATE"], ["*"]]) {
      const c = await open(writeCfg("w1.json", { server: server(), permissions: { allowWrites: true, writeOperations: ops }, customApis: [postProfile()] }));
      const r = await c.call("api_call_endpoint", { profile: "mock", endpoint: "create", body: { name: "n" } });
      expect(r.res.error?.code, JSON.stringify(ops)).toBe("PERMISSION_DENIED");
      c.child.stdin.end();
    }
    expect(mock.seen).toHaveLength(0);
  }, 90000);
  it("allowWrites:true + exact entry: only that endpoint goes through; audit write flag recorded", async () => {
    mock.seen.length = 0;
    const c = await open(writeCfg("w2.json", { server: server(), permissions: { allowWrites: true, writeOperations: ["api:mock/create"] }, customApis: [postProfile()] }));
    const ok = await c.call("api_call_endpoint", { profile: "mock", endpoint: "create", body: { name: "n" } });
    expect(ok.res.success).toBe(true);
    expect(mock.seen.map((s) => s.method)).toEqual(["POST"]);
    expect((await c.call("api_call_endpoint", { profile: "mock", endpoint: "wdel", pathParams: { id: "1" } })).res.error?.code).toBe("PERMISSION_DENIED");
    expect((await c.call("api_call_endpoint", { profile: "mock", endpoint: "create", body: { name: "n", extra: 1 } })).res.success).toBe(false);
    expect(mock.seen).toHaveLength(1);
    const lines = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    writeFileSync("/tmp/qa05/audit-write.json", JSON.stringify(lines.filter((l) => String(l["resourceRef"] ?? "").includes("mock/create")), null, 1));
    // P4-03 (F4 fixed): write attempts are audited with write:true.
    expect(lines.filter((l) => l["resourceRef"] === "mock/create" && l["tool"] === "api_call_endpoint").every((l) => l["write"] === true)).toBe(true);
    c.child.stdin.end();
  }, 30000);

  it("startup failures: exit 1, JSON path on stderr, stdout empty; baseUrl userinfo", async () => {
    const cases: Record<string, unknown> = {
      badregex: mockProfile(mock, { endpoints: [{ name: "bad", method: "GET", path: "/x", description: "d", query: { q: { type: "string", pattern: "(a+)+$" } } }] }),
      badtype: mockProfile(mock, { endpoints: [{ name: "bad", method: "GET", path: "/x", description: "d", query: { q: { type: "object" } } }] }),
      unplaceholder: mockProfile(mock, { endpoints: [{ name: "bad", method: "GET", path: "/x/{id}", description: "d" }] }),
      userinfo: mockProfile(mock, { baseUrl: `http://user:pw-SECRET@127.0.0.1:${mock.port}` }),
      reserved: mockProfile(mock, { auth: { type: "header", headerName: "Host", valueEnv: "DEVWS_QA_TOKEN" } }),
      crlfHeader: mockProfile(mock, { auth: { type: "header", headerName: "X-A\r\nB", valueEnv: "DEVWS_QA_TOKEN" } }),
      fileScheme: mockProfile(mock, { baseUrl: "file:///etc/passwd" }),
      queryInBase: mockProfile(mock, { baseUrl: `http://127.0.0.1:${mock.port}/v1?x=1` }),
    };
    const summary: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(cases)) {
      const cfg = writeCfg(`bad-${k}.json`, { customApis: [p] });
      const child = spawn("node", [entry, "--config", cfg], { cwd: tmp, env: { ...process.env, DEVWORKSPACE_CONFIG: "", DEVWS_QA_TOKEN: CANARY } });
      let so = "", se = "";
      child.stdout.on("data", (d) => (so += d));
      child.stderr.on("data", (d) => (se += d));
      child.stdin.write(""); // keep open
      const code = await new Promise<number | null>((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r(-9); }, 8000); child.on("exit", (c) => { clearTimeout(t); r(c); }); });
      summary[k] = { code, stdout: so.length, stderr: se.slice(0, 300) };
      expect(so, k).toBe("");
      expect(se, k).not.toContain("pw-SECRET");
      expect(se, k).not.toContain(CANARY);
      expect(code, k).toBe(1);
    }
    writeFileSync("/tmp/qa05/startup.json", JSON.stringify(summary, null, 1));
  }, 120000);

  it("SIGTERM and stdin close shut down cleanly with a profile configured", async () => {
    const cfg = writeCfg("sig.json", { server: server(), customApis: [mockProfile(mock)] });
    const a = await open(cfg);
    a.child.kill("SIGTERM");
    const ca = await Promise.race([a.exited, new Promise((r) => setTimeout(() => r("hang"), 8000))]);
    const b = await open(cfg);
    b.child.stdin.end();
    const cb = await Promise.race([b.exited, new Promise((r) => setTimeout(() => r("hang"), 8000))]);
    writeFileSync("/tmp/qa05/shutdown.json", JSON.stringify({ ca, cb }));
    expect(ca).not.toBe("hang");
    expect(cb).toBe(0);
    expect(a.out.every((l) => { try { return JSON.parse(l).jsonrpc === "2.0"; } catch { return false; } })).toBe(true);
  }, 40000);
});
