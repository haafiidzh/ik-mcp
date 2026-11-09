import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Mock custom API for tests and the demo (node:http, loopback only). Records every request so tests
 * can prove what the server did (or did not) send. Routes:
 *   GET  /health                 -> {status:"ok"}
 *   GET  /items/:id?verbose=...  -> JSON item with nested sensitive data
 *   POST /items                  -> echo of the JSON body (201)
 *   GET  /echo-auth              -> echoes the Authorization header and a custom header (to test redaction)
 *   GET  /redirect               -> 302 Location: /health (S14)
 *   GET  /big?bytes=N            -> N bytes of JSON-ish text, streamed; records aborts (S15)
 *   GET  /slow?ms=N              -> responds after N ms
 *   GET  /binary                 -> application/octet-stream
 *   GET  /text                   -> text/plain
 */
export interface SeenApiRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export interface MockApi {
  port: number;
  /** Bound address. */
  host: string;
  seen: SeenApiRequest[];
  /** Number of /big responses whose connection closed before the body was fully written. */
  aborted: { count: number };
  close(): Promise<void>;
}

const send = (res: ServerResponse, status: number, body: unknown, type = "application/json"): void => {
  res.writeHead(status, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

export async function startMockApi(host = "127.0.0.1", listenPort = 0): Promise<MockApi> {
  const seen: SeenApiRequest[] = [];
  const aborted = { count: 0 };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const u = new URL(req.url ?? "/", "http://x");
      const m = /^\/items\/([^/]+)$/.exec(u.pathname);
      if (req.method === "GET" && u.pathname === "/health") return send(res, 200, { status: "ok" });
      if (req.method === "GET" && m) {
        return send(res, 200, {
          id: decodeURIComponent(m[1] ?? ""),
          verbose: u.searchParams.get("verbose"),
          name: "widget",
          Password: "hunter2-secret",
          owner: { Email: "a@b.test", nested: [{ SSN: "123-45-6789", keep: 1 }] },
          list: [{ api_key_x: "k", ok: true }],
        });
      }
      if (req.method === "POST" && u.pathname === "/items") return send(res, 201, { created: true, echo: JSON.parse(body === "" ? "{}" : body) });
      if (u.pathname === "/echo-auth") {
        return send(res, 200, { authorization: req.headers["authorization"] ?? null, note: `got ${String(req.headers["authorization"] ?? req.headers["x-api-key"] ?? "none")}`, xApiKey: req.headers["x-api-key"] ?? null, host: req.headers["host"] ?? null });
      }
      if (u.pathname === "/redirect") {
        res.writeHead(302, { location: "/health", "content-type": "text/plain", "set-cookie": "sid=1" });
        return void res.end("moved");
      }
      if (u.pathname === "/big") {
        const total = Number(u.searchParams.get("bytes") ?? "1000000");
        res.writeHead(200, { "content-type": "text/plain" });
        let sent = 0;
        res.on("close", () => {
          if (sent < total) aborted.count++;
        });
        const piece = "x".repeat(8192);
        const pump = (): void => {
          while (sent < total) {
            const n = Math.min(piece.length, total - sent);
            sent += n;
            if (!res.write(piece.slice(0, n))) return void res.once("drain", pump);
          }
          res.end();
        };
        return pump();
      }
      if (u.pathname === "/slow") {
        const t = setTimeout(() => send(res, 200, { slow: true }), Number(u.searchParams.get("ms") ?? "1000"));
        res.on("close", () => clearTimeout(t));
        return;
      }
      if (u.pathname === "/binary") return send(res, 200, "\u0000\u0001\u0002", "application/octet-stream");
      if (u.pathname === "/text") return send(res, 200, "hello text", "text/plain; charset=utf-8");
      return send(res, 404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(listenPort, host, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    host,
    seen,
    aborted,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Build a customApis profile object pointing at a mock (loopback needs allowPrivateNetwork). */
export function mockProfile(mock: Pick<MockApi, "port" | "host">, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "mock",
    enabled: true,
    baseUrl: `http://${mock.host}:${mock.port}`,
    allowPrivateNetwork: true,
    auth: { type: "none" },
    allowedMethods: ["GET"],
    timeoutMs: 3000,
    maxResponseBytes: 5000,
    sensitiveFields: ["password", "email", "ssn"],
    endpoints: [
      { name: "health", method: "GET", path: "/health", description: "Health" },
      { name: "get-item", method: "GET", path: "/items/{id}", description: "Get item", pathParams: { id: { type: "string", maxLength: 40 } }, query: { verbose: { type: "string", maxLength: 10 } } },
      { name: "echo-auth", method: "GET", path: "/echo-auth", description: "Echo auth" },
      { name: "redirect", method: "GET", path: "/redirect", description: "Redirect" },
      { name: "big", method: "GET", path: "/big", description: "Big", query: { bytes: { type: "integer", maximum: 100000000 } } },
      { name: "slow", method: "GET", path: "/slow", description: "Slow", query: { ms: { type: "integer", maximum: 100000 } } },
      { name: "binary", method: "GET", path: "/binary", description: "Binary" },
      { name: "text", method: "GET", path: "/text", description: "Text" },
    ],
    ...extra,
  };
}
