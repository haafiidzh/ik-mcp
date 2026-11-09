import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../src/core/limits.js";
import { AppError } from "../../src/core/errors.js";
import {
  API_REDIRECT_POLICY,
  assertMethodAllowed,
  assertNoArbitraryTargetArgs,
  checkTarget,
  classifyAddress,
  createPinnedLookup,
  parseLegacyIPv4,
  prepareApiRequest,
  type GuardProfile,
  type ResolveFn,
} from "../../src/integrations/custom-api/url-guard.js";

const PUBLIC = "93.184.216.34";
const pub: ResolveFn = async () => [{ address: PUBLIC, family: 4 }];

function profile(over: Partial<GuardProfile> = {}): GuardProfile {
  return {
    name: "svc",
    enabled: true,
    baseUrl: "https://api.example.com/v1",
    allowPrivateNetwork: false,
    allowedMethods: ["GET", "POST"],
    endpoints: [
      {
        name: "getItem",
        method: "GET",
        path: "/items/{id}",
        pathParams: { id: { type: "string", maxLength: 40 } },
        query: { q: { type: "string" }, n: { type: "integer", minimum: 1, maximum: 10 } },
      },
      { name: "make", method: "POST", path: "/items", permission: "write", body: { title: { type: "string", required: true } } },
    ],
    ...over,
  };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  return "ok";
}

function call(over: Partial<Parameters<typeof prepareApiRequest>[0]> = {}, profiles = [profile()]) {
  return prepareApiRequest({ profiles, profile: "svc", endpoint: "getItem", pathParams: { id: "42" }, resolve: pub, ...over });
}

describe("S11 unconfigured profile / endpoint / arbitrary URL", () => {
  it("unknown profile, unknown endpoint, disabled profile -> NOT_FOUND", async () => {
    expect(await code(call({ profile: "nope" }))).toBe("NOT_FOUND");
    expect(await code(call({ endpoint: "nope" }))).toBe("NOT_FOUND");
    expect(await code(call({}, [profile({ enabled: false })]))).toBe("NOT_FOUND");
  });
  it("URL as profile or endpoint name -> INVALID_INPUT, never echoed", async () => {
    for (const a of [{ profile: "https://evil.test/" }, { endpoint: "http://169.254.169.254/x" }]) {
      try {
        await call(a);
        expect.unreachable();
      } catch (e) {
        expect((e as AppError).code).toBe("INVALID_INPUT");
        expect((e as AppError).message).not.toMatch(/evil|169\.254/);
      }
    }
    expect(await code(call({ profile: 5 }))).toBe("INVALID_INPUT");
  });
  it.each(["url", "baseUrl", "host", "headers", "Authorization", "URI"])("argument key %s -> INVALID_INPUT", async (k) => {
    expect(() => assertNoArbitraryTargetArgs({ [k]: "x" })).toThrow(AppError);
    expect(await code(call({ extraArgs: { [k]: "https://evil.test" } }))).toBe("INVALID_INPUT");
  });
  it("undeclared path/query keys and a body on a GET are rejected", async () => {
    expect(await code(call({ pathParams: { id: "1", extra: "x" } }))).toBe("INVALID_INPUT");
    expect(await code(call({ query: { url: "https://evil.test" } }))).toBe("INVALID_INPUT");
    expect(await code(call({ body: { a: 1 } }))).toBe("INVALID_INPUT");
  });
});

describe("S12 path parameter and method hardening", () => {
  const bad = ["../admin", "a/b", "%2e%2e", "%2E%2e", "a%2fb", "a%2Fb", "a\\b", "a%5cb", "..", ".", "", "a\u0000b", "a%00b", "a\nb", "x..y", "%252e%252e", "%252f", "\u007f"];
  it.each(bad)("path param %j is rejected", async (v) => {
    expect(await code(call({ pathParams: { id: v } }))).toBe("INVALID_INPUT");
  });
  it("lone surrogate is rejected, not thrown raw", async () => {
    expect(await code(call({ pathParams: { id: "\ud800" } }))).toBe("INVALID_INPUT");
  });
  it("a valid value is encoded and stays under the base path", async () => {
    const r = await call({ pathParams: { id: "a b?c#d" } });
    expect(r.url.href).toBe("https://api.example.com/v1/items/a%20b%3Fc%23d");
    expect(r.url.hash).toBe("");
  });
  it("query is built from the validated object only, encoded, no smuggling", async () => {
    const r = await call({ query: { q: "x&admin=1#frag", n: 3 } });
    expect(r.url.search).toBe("?q=x%26admin%3D1%23frag&n=3");
    expect(r.url.searchParams.getAll("admin")).toEqual([]);
    expect(await code(call({ query: { n: 99 } }))).toBe("INVALID_INPUT");
    expect(await code(call({ query: { "q&x": "1" } }))).toBe("INVALID_INPUT");
  });
  it("origin and path prefix are preserved", async () => {
    const r = await call();
    expect(r.url.origin).toBe("https://api.example.com");
    expect(r.url.pathname.startsWith("/v1/")).toBe(true);
    expect(r.method).toBe("GET");
  });
  it("method must equal the endpoint's and be allowed", () => {
    const p = profile();
    const e = p.endpoints[0]!;
    expect(() => assertMethodAllowed(p, e, undefined, "DELETE")).toThrow(/fixed/);
    expect(() => assertMethodAllowed(p, e, undefined, "get")).not.toThrow();
    const noPost = profile({ allowedMethods: ["GET"] });
    expect(() => assertMethodAllowed(noPost, noPost.endpoints[1]!, { allowWrites: true, writeOperations: ["api:svc/make"] })).toThrow(AppError);
  });
  it("write endpoints need allowWrites and the exact writeOperations entry", async () => {
    const args = { endpoint: "make", pathParams: {}, body: { title: "t" } };
    expect(await code(call(args))).toBe("PERMISSION_DENIED");
    expect(await code(call({ ...args, permissions: { allowWrites: true, writeOperations: [] } }))).toBe("PERMISSION_DENIED");
    expect(await code(call({ ...args, permissions: { allowWrites: false, writeOperations: ["api:svc/make"] } }))).toBe("PERMISSION_DENIED");
    const ok = await call({ ...args, permissions: { allowWrites: true, writeOperations: ["api:svc/make"] } });
    expect(ok.method).toBe("POST");
    expect(ok.body).toEqual({ title: "t" });
  });
  it("a non-GET endpoint declared permission:read is still treated as a write", async () => {
    const p = profile();
    p.endpoints = [{ name: "x", method: "POST", path: "/x", permission: "read" }];
    expect(await code(call({ endpoint: "x", pathParams: {} }, [p]))).toBe("PERMISSION_DENIED");
  });
  it("placeholder not declared in pathParams fails closed", async () => {
    const p = profile();
    p.endpoints = [{ name: "bad", method: "GET", path: "/a/{ghost}" }];
    expect(await code(call({ endpoint: "bad", pathParams: {} }, [p]))).toBe("INVALID_INPUT");
  });
});

describe("S13 SSRF", () => {
  const blocked = [
    "127.0.0.1", "127.255.255.254", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "169.254.1.1",
    "100.64.0.1", "100.127.255.255", "224.0.0.1", "255.255.255.255", "240.0.0.1", "192.0.2.1", "198.18.0.1",
    "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
    "::127.0.0.1", "::10.0.0.1", "64:ff9b::7f00:1", "2002:7f00:0001::", "fd00:ec2::254", "2001:db8::1", "100::1", "::ffff:8.8.8.8",
  ];
  it.each(blocked)("address %s is blocked by default", (a) => {
    expect(classifyAddress(a)).not.toBe("public");
  });
  it.each([PUBLIC, "8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])("address %s is public", (a) => {
    expect(classifyAddress(a)).toBe("public");
  });
  it("legacy IPv4 forms parse to the same address", () => {
    for (const f of ["2130706433", "0x7f.1", "0177.0.0.1", "127.1", "0x7f000001", "127.0.1", "017700000001"]) {
      expect(parseLegacyIPv4(f)).toBe(0x7f000001);
    }
    expect(parseLegacyIPv4("256.1.1.1")).toBeNull();
    expect(parseLegacyIPv4("1.2.3.4.5")).toBeNull();
    expect(parseLegacyIPv4("example.com")).toBeNull();
    expect(classifyAddress("2130706433")).toBe("loopback");
    expect(classifyAddress("garbage")).toBe("reserved");
  });

  const literalBases = [
    "http://127.0.0.1", "http://169.254.169.254/latest", "http://10.0.0.5", "http://[::1]", "http://[::ffff:127.0.0.1]", "http://[::ffff:7f00:1]",
    "http://2130706433", "http://0x7f.1", "http://0177.0.0.1", "http://127.1", "http://localhost.", "http://[fe80::1]", "http://[fd00:ec2::254]",
  ];
  it.each(literalBases)("baseUrl %s is refused without allowPrivateNetwork", async (base) => {
    const resolve: ResolveFn = async () => [{ address: "127.0.0.1", family: 4 }]; // also covers 'localhost.'
    const p = profile({ baseUrl: base });
    expect(await code(call({ resolve }, [p]))).toBe("PERMISSION_DENIED");
  });
  it("hostname resolving to private / AAAA private / mixed answers is refused", async () => {
    const p = profile();
    const r = (answers: { address: string; family: 4 | 6 }[]): ResolveFn => async () => answers;
    expect(await code(call({ resolve: r([{ address: "10.0.0.8", family: 4 }]) }, [p]))).toBe("PERMISSION_DENIED");
    expect(await code(call({ resolve: r([{ address: "fd00::1", family: 6 }]) }, [p]))).toBe("PERMISSION_DENIED");
    expect(await code(call({ resolve: r([{ address: PUBLIC, family: 4 }, { address: "::1", family: 6 }]) }, [p]))).toBe("PERMISSION_DENIED");
    expect(await code(call({ resolve: r([{ address: "::ffff:192.168.0.1", family: 6 }, { address: PUBLIC, family: 4 }]) }, [p]))).toBe("PERMISSION_DENIED");
  });
  it("empty / failing / slow DNS fails closed", async () => {
    expect(await code(call({ resolve: async () => [] }))).toBe("INTEGRATION_UNAVAILABLE");
    expect(await code(call({ resolve: async () => { throw new Error("secret-host.internal NXDOMAIN"); } }))).toBe("INTEGRATION_UNAVAILABLE");
    expect(await code(call({ resolve: () => new Promise(() => undefined), dnsTimeoutMs: 20 }))).toBe("TIMEOUT");
  });
  it("DNS errors never leak the upstream message", async () => {
    try {
      await call({ resolve: async () => { throw new Error("secret-host.internal NXDOMAIN"); } });
    } catch (e) {
      expect((e as Error).message).not.toMatch(/secret-host/);
    }
  });
  it("DNS rebinding: the pinned lookup answers the checked IP and never re-resolves", async () => {
    let calls = 0;
    const resolve: ResolveFn = async () => (++calls === 1 ? [{ address: PUBLIC, family: 4 }] : [{ address: "127.0.0.1", family: 4 }]);
    const r = await call({ resolve });
    expect(r.pinnedAddress).toBe(PUBLIC);
    expect(r.hostname).toBe("api.example.com");
    const got = await new Promise<unknown>((res, rej) => r.lookup("api.example.com", {}, (e, a, f) => (e ? rej(e) : res([a, f]))));
    expect(got).toEqual([PUBLIC, 4]);
    const all = await new Promise<unknown>((res, rej) => r.lookup("api.example.com", { all: true }, (e, a) => (e ? rej(e) : res(a))));
    expect(all).toEqual([{ address: PUBLIC, family: 4 }]);
    expect(calls).toBe(1);
    // a second preparation sees the rebinding answer and is refused
    expect(await code(call({ resolve }))).toBe("PERMISSION_DENIED");
  });
  it("pinned lookup refuses a different hostname (e.g. after a redirect)", async () => {
    const lookup = createPinnedLookup({ hostname: "api.example.com", address: PUBLIC, family: 4 });
    const err = await new Promise<NodeJS.ErrnoException | null>((res) => lookup("evil.test", {}, (e) => res(e)));
    expect(err?.code).toBe("ENOTFOUND");
  });
  it("allowPrivateNetwork: true allows loopback/private but never metadata, unspecified, multicast", async () => {
    const mk = (base: string) => profile({ baseUrl: base, allowPrivateNetwork: true });
    expect((await call({}, [mk("http://127.0.0.1:8080/api")])).pinnedAddress).toBe("127.0.0.1");
    expect((await call({}, [mk("http://[::1]:8080")])).pinnedAddress).toBe("::1");
    expect((await call({}, [mk("http://10.1.1.1")])).pinnedAddress).toBe("10.1.1.1");
    for (const bad of ["http://169.254.169.254", "http://[::ffff:169.254.169.254]", "http://0.0.0.0", "http://224.0.0.1", "http://[fd00:ec2::254]", "http://2852039166"]) {
      expect(await code(call({}, [mk(bad)]))).toBe("PERMISSION_DENIED");
    }
    const viaDns: ResolveFn = async () => [{ address: "169.254.169.254", family: 4 }];
    expect(await code(call({ resolve: viaDns }, [mk("https://api.example.com")]))).toBe("PERMISSION_DENIED");
  });
  it("checkTarget returns every checked answer and pins the first", async () => {
    const t = await checkTarget(new URL("https://h.example/"), false, async () => [{ address: PUBLIC, family: 4 }, { address: "2606:4700:4700::1111", family: 6 }]);
    expect(t.addresses).toHaveLength(2);
    expect(t.address).toBe(PUBLIC);
  });
});

describe("S14 redirect policy", () => {
  it("redirects are off: a 3xx is data, not followed", () => {
    expect(API_REDIRECT_POLICY).toEqual({ followRedirects: false, maxRedirects: 0 });
    expect(Object.isFrozen(API_REDIRECT_POLICY)).toBe(true);
    expect(DEFAULT_LIMITS.maxRedirectsCustomApi).toBe(0);
  });
  it("prepared requests carry the policy", async () => {
    const r = await call();
    expect(r.followRedirects).toBe(false);
    expect(r.maxRedirects).toBe(0);
  });
});
