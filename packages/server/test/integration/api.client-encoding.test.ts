import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createRedactor, REDACTED } from "../../src/core/redact.js";
import { executeApiRequest, type ApiRuntimeProfile } from "../../src/integrations/custom-api/api.client.js";
import type { PreparedApiRequest } from "../../src/integrations/custom-api/url-guard.js";

/** P4-06: a Content-Encoding other than identity is never read or decompressed. P4-05: encoded secret variants. */

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

async function start(headers: Record<string, string>, body: Buffer): Promise<number> {
  const s = http.createServer((_req, res) => {
    res.writeHead(200, headers);
    res.end(body);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as AddressInfo).port;
}

function prepared(port: number): PreparedApiRequest {
  return {
    profileName: "p",
    endpointName: "e",
    method: "GET",
    url: new URL(`http://127.0.0.1:${port}/x`),
    hostname: "127.0.0.1",
    pinnedAddress: "127.0.0.1",
    pinnedFamily: 4,
    lookup: ((_h: string, _o: unknown, cb: (e: null, a: string, f: number) => void) => cb(null, "127.0.0.1", 4)) as unknown as PreparedApiRequest["lookup"],
    body: null,
  } as unknown as PreparedApiRequest;
}
const rt: ApiRuntimeProfile = { auth: { type: "none" }, timeoutMs: 5000, maxResponseBytes: 100000 };

describe("P4-06 Content-Encoding", () => {
  it("gzip body is not read: kind other with encoding, no decompression", async () => {
    const port = await start({ "content-type": "application/json", "content-encoding": "gzip" }, gzipSync(Buffer.from('{"a":1}')));
    const res = await executeApiRequest(prepared(port), rt);
    expect(res.kind).toBe("other");
    expect(res.encoding).toBe("gzip");
    expect(res.text).toBe("");
    expect(res.bytesRead).toBe(0);
  });

  it("identity encoding is read normally", async () => {
    const port = await start({ "content-type": "application/json", "content-encoding": "identity" }, Buffer.from('{"a":1}'));
    const res = await executeApiRequest(prepared(port), rt);
    expect(res.kind).toBe("json");
    expect(res.encoding).toBeUndefined();
  });

});

describe("P4-05 encoded secret variants", () => {
  const SECRET = "tok_ENCODED+/secret=value_1234";
  const r = createRedactor({ secretValues: [SECRET] });
  it("redacts base64, url-safe base64, unpadded, percent-encoded and hex forms", () => {
    const b64 = Buffer.from(SECRET).toString("base64");
    for (const form of [b64, b64.replace(/=+$/, ""), b64.replace(/\+/g, "-").replace(/\//g, "_"), encodeURIComponent(SECRET), Buffer.from(SECRET).toString("hex")]) {
      const out = r.redactString(`echo ${form} end`);
      expect(out, form).toBe(`echo ${REDACTED} end`);
    }
  });
});
