import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { parseConfigText } from "../../src/config/load-config.js";
import { executeApiRequest, type ApiRuntimeProfile } from "../../src/integrations/custom-api/api.client.js";
import { prepareApiRequest, type ResolveFn } from "../../src/integrations/custom-api/url-guard.js";
import { mockProfile, startMockApi, type MockApi } from "../fixtures/mock-api.js";

/** Real sockets: node:http client + pinned lookup against a local mock (P4-02). */

const TOKEN = "tok_CLIENTCANARY_1234567890";
const mocks: MockApi[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

async function setup(extra: Record<string, unknown> = {}, host = "127.0.0.1"): Promise<{ mock: MockApi; profiles: ReturnType<typeof parseConfigText>["customApis"] }> {
  const mock = await startMockApi(host);
  mocks.push(mock);
  const profiles = parseConfigText(JSON.stringify({ customApis: [mockProfile(mock, extra)] })).customApis;
  return { mock, profiles };
}

async function run(
  profiles: ReturnType<typeof parseConfigText>["customApis"],
  endpoint: string,
  args: { pathParams?: unknown; query?: unknown; body?: unknown } = {},
  env: Record<string, string> = {},
  resolve?: ResolveFn,
) {
  const prepared = await prepareApiRequest({ profiles, profile: "mock", endpoint, ...args, ...(resolve ? { resolve } : {}) });
  const p = profiles[0]!;
  const rt: ApiRuntimeProfile = { auth: p.auth, timeoutMs: p.timeoutMs, maxResponseBytes: p.maxResponseBytes };
  return { prepared, res: await executeApiRequest(prepared, rt, { getEnv: (n) => env[n] }) };
}

describe("api.client over real sockets", () => {
  it("GET with path param and query; only content-type header returned", async () => {
    const { mock, profiles } = await setup();
    const { res } = await run(profiles, "get-item", { pathParams: { id: "a b" }, query: { verbose: "1" } });
    expect(res.status).toBe(200);
    expect(res.kind).toBe("json");
    expect((res.json as { id: string; verbose: string }).id).toBe("a b");
    expect((res.json as { verbose: string }).verbose).toBe("1");
    expect(Object.keys(res.headers)).toEqual(["content-type"]);
    expect(mock.seen[0]?.url).toBe("/items/a%20b?verbose=1");
    expect(mock.seen[0]?.headers["host"]).toBe(`127.0.0.1:${mock.port}`);
    expect(mock.seen[0]?.headers["accept-encoding"]).toBe("identity");
  });

  it("bearer and header auth are injected from the named env var", async () => {
    const a = await setup({ auth: { type: "bearer", tokenEnv: "T_BEARER" } });
    const r1 = await run(a.profiles, "echo-auth", {}, { T_BEARER: TOKEN });
    expect(a.mock.seen[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(r1.res.status).toBe(200);
    const b = await setup({ auth: { type: "header", headerName: "X-Api-Key", valueEnv: "T_HDR" } });
    await run(b.profiles, "echo-auth", {}, { T_HDR: TOKEN });
    expect(b.mock.seen[0]?.headers["x-api-key"]).toBe(TOKEN);
    expect(b.mock.seen[0]?.headers["authorization"]).toBeUndefined();
  });

  it("missing auth env -> INTEGRATION_UNAVAILABLE before any connection, message has no value", async () => {
    const { mock, profiles } = await setup({ auth: { type: "bearer", tokenEnv: "T_MISSING" } });
    await expect(run(profiles, "health", {}, {})).rejects.toMatchObject({ code: "INTEGRATION_UNAVAILABLE" });
    expect(mock.seen).toHaveLength(0);
    await expect(run(profiles, "health", {}, { T_MISSING: "bad\r\nX-Evil: 1" })).rejects.toMatchObject({ code: "INTEGRATION_UNAVAILABLE" });
    expect(mock.seen).toHaveLength(0);
  });

  it("S14: 3xx is returned as data, Location not followed, no second request, Location/Set-Cookie not exposed", async () => {
    const { mock, profiles } = await setup();
    const { res } = await run(profiles, "redirect");
    expect(res.status).toBe(302);
    expect(res.headers).toEqual({ "content-type": "text/plain" });
    await new Promise((r) => setTimeout(r, 150));
    expect(mock.seen).toHaveLength(1);
  });

  it("S15: body over maxResponseBytes is cut, flagged and the connection aborted", async () => {
    const { mock, profiles } = await setup({ maxResponseBytes: 1000 });
    const { res } = await run(profiles, "big", { query: { bytes: 5_000_000 } });
    expect(res.truncated).toBe(true);
    expect(res.bytesRead).toBe(1000);
    expect(res.text).toHaveLength(1000);
    for (let i = 0; i < 40 && mock.aborted.count === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(mock.aborted.count).toBe(1);
  });

  it("timeout -> TIMEOUT", async () => {
    const { profiles } = await setup({ timeoutMs: 200 });
    await expect(run(profiles, "slow", { query: { ms: 3000 } })).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("abort signal cancels", async () => {
    const { profiles } = await setup();
    const prepared = await prepareApiRequest({ profiles, profile: "mock", endpoint: "slow", query: { ms: 3000 } });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await expect(executeApiRequest(prepared, { auth: { type: "none" }, timeoutMs: 5000, maxResponseBytes: 1000 }, { signal: ac.signal })).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("binary content is described, not read; text stays text", async () => {
    const { profiles } = await setup();
    const bin = await run(profiles, "binary");
    expect(bin.res.kind).toBe("other");
    expect(bin.res.text).toBe("");
    const txt = await run(profiles, "text");
    expect(txt.res).toMatchObject({ kind: "text", text: "hello text" });
  });

  it("connection refused is mapped without leaking the address", async () => {
    const { mock, profiles } = await setup();
    await mock.close();
    mocks.length = 0;
    const err = await run(profiles, "health").catch((e: unknown) => e as Error);
    expect(err).toMatchObject({ code: "INTEGRATION_UNAVAILABLE" });
    expect((err as Error).message).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
  });
});

describe("pinned DNS connection (S13, rebinding)", () => {
  it("connects to the validated address although the name later resolves elsewhere; Host keeps the name", async () => {
    // A on 127.0.0.1 (validated). B on 127.0.0.2, same port, is where a rebinding answer would send us.
    const a = await startMockApi("127.0.0.1");
    mocks.push(a);
    let b: MockApi;
    try {
      b = await startMockApi("127.0.0.2", a.port);
    } catch {
      return; // environment without 127.0.0.2 on loopback
    }
    mocks.push(b);
    let calls = 0;
    const resolve: ResolveFn = async () => {
      calls++;
      return [{ address: calls === 1 ? "127.0.0.1" : "127.0.0.2", family: 4 }];
    };
    const profiles = parseConfigText(
      JSON.stringify({ customApis: [mockProfile({ host: "pinned.test", port: a.port })] }),
    ).customApis;
    const prepared = await prepareApiRequest({ profiles, profile: "mock", endpoint: "health", resolve });
    expect(prepared.pinnedAddress).toBe("127.0.0.1");
    // The "DNS" now answers differently; the prepared request must not care and never re-resolves.
    await resolve("pinned.test");
    expect(calls).toBe(2);
    const res = await executeApiRequest(prepared, { auth: { type: "none" }, timeoutMs: 3000, maxResponseBytes: 5000 });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(a.seen).toHaveLength(1);
    expect(a.seen[0]?.headers["host"]).toBe(`pinned.test:${a.port}`);
    expect(b.seen).toHaveLength(0);
    // "pinned.test" is not resolvable by the system: success proves the pinned lookup was used.
  });

  it("public-then-private: the checked (first) address is the only one the lookup ever returns", async () => {
    let calls = 0;
    const resolve: ResolveFn = async () => [{ address: ++calls === 1 ? "93.184.216.34" : "10.0.0.5", family: 4 }];
    const profiles = parseConfigText(JSON.stringify({ customApis: [mockProfile({ host: "rebind.test", port: 9 }, { allowPrivateNetwork: false })] })).customApis;
    const prepared = await prepareApiRequest({ profiles, profile: "mock", endpoint: "health", resolve });
    expect(prepared.pinnedAddress).toBe("93.184.216.34");
    await resolve("x");
    const got = await new Promise<string>((res, rej) => prepared.lookup("rebind.test", {}, (e, addr) => (e ? rej(e) : res(String(addr)))));
    expect(got).toBe("93.184.216.34");
    const other = await new Promise<string>((res) => prepared.lookup("evil.test", {}, (e) => res(e ? "refused" : "answered")));
    expect(other).toBe("refused");
  });

  describe("TLS SNI", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dwmcp-tls-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    it("sends the original hostname as SNI while connecting to the pinned address", async () => {
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "1", "-subj", "/CN=sni.test"], { stdio: "ignore" });
      const ctx = tls.createSecureContext({ key: readFileSync(path.join(dir, "k.pem")), cert: readFileSync(path.join(dir, "c.pem")) });
      const names: string[] = [];
      const server = https.createServer({ SNICallback: (name, cb) => (names.push(name), cb(null, ctx)) }, (_q, r) => r.end("{}"));
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as AddressInfo).port;
      try {
        const profiles = parseConfigText(
          JSON.stringify({ customApis: [mockProfile({ host: "sni.test", port }, { baseUrl: `https://sni.test:${port}` })] }),
        ).customApis;
        const prepared = await prepareApiRequest({ profiles, profile: "mock", endpoint: "health", resolve: async () => [{ address: "127.0.0.1", family: 4 }] });
        // Self-signed cert is (correctly) not trusted: the handshake fails but SNI was observed.
        await expect(executeApiRequest(prepared, { auth: { type: "none" }, timeoutMs: 3000, maxResponseBytes: 5000 })).rejects.toMatchObject({ code: "INTEGRATION_UNAVAILABLE" });
        expect(names).toContain("sni.test");
      } finally {
        server.close();
      }
    });
  });
});
