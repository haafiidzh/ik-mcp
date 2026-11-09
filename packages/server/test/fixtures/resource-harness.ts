import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";
import { parseConfigText } from "../../src/config/load-config.js";
import { createAuditLog, type AuditEntry } from "../../src/core/audit.js";
import { DEFAULT_LIMITS } from "../../src/core/limits.js";
import { createLogger } from "../../src/core/logger.js";
import { createRedactor } from "../../src/core/redact.js";
import type { ServerDeps } from "../../src/server/register-tools.js";
import { createServer } from "../../src/server/create-server.js";
import type { GithubMock } from "./github-mock.js";

type Msg = Record<string, unknown>;

export interface ResourceClient {
  server: McpServer;
  audit: AuditEntry[];
  logs: string[];
  list(): Promise<{ uri: string; name: string }[]>;
  templates(): Promise<{ uriTemplate: string; name: string }[]>;
  read(uri: string): Promise<{ ok: true; text: string; mimeType: string; json: Record<string, any> } | { ok: false; message: string }>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test-only JSON view
  rawRequest(method: string, params?: unknown): Promise<Msg>;
  close(): Promise<void>;
}

/** Real McpServer (createServer) wired to a hand-driven JSON-RPC client over the SDK in-memory transport. */
export async function resourceClient(
  cfg: Record<string, unknown>,
  opts: { mock?: GithubMock; env?: Record<string, string | undefined>; limits?: Partial<typeof DEFAULT_LIMITS> } = {},
): Promise<ResourceClient> {
  const env = opts.env ?? {};
  const redactor = createRedactor({ secretValues: Object.values(env).filter((v): v is string => v !== undefined) });
  const audit: AuditEntry[] = [];
  const auditLog = createAuditLog();
  const real = auditLog.record.bind(auditLog);
  auditLog.record = (e) => (audit.push(e as AuditEntry), real(e));
  const logs: string[] = [];
  const deps: ServerDeps = {
    config: parseConfigText(JSON.stringify(cfg)),
    limits: { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) },
    logger: createLogger({ level: "debug", redactor, write: (l) => logs.push(l) }),
    audit: auditLog,
    redactor,
    startedAtMs: Date.now(),
    ...(opts.mock !== undefined ? { githubFetch: opts.mock.fetch } : {}),
    githubGetEnv: (n) => env[n],
  };
  const server = createServer(deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (m: Msg) => void>();
  b.onmessage = (m) => {
    const msg = m as Msg;
    const id = msg["id"];
    if (typeof id === "number") pending.get(id)?.(msg);
  };
  await server.connect(a);
  await b.start();
  let next = 1;
  const request = (method: string, params?: unknown): Promise<Msg> =>
    new Promise((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      void b.send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) } as never);
    });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  await b.send({ jsonrpc: "2.0", method: "notifications/initialized" } as never);
  return {
    server,
    audit,
    logs,
    rawRequest: request,
    async list() {
      const r = await request("resources/list");
      return ((r["result"] as { resources?: { uri: string; name: string }[] } | undefined)?.resources ?? []);
    },
    async templates() {
      const r = await request("resources/templates/list");
      return ((r["result"] as { resourceTemplates?: { uriTemplate: string; name: string }[] } | undefined)?.resourceTemplates ?? []);
    },
    async read(uri) {
      const r = await request("resources/read", { uri });
      const result = r["result"] as { contents?: { text?: string; mimeType?: string }[] } | undefined;
      const c = result?.contents?.[0];
      if (c?.text === undefined) return { ok: false, message: String((r["error"] as { message?: string } | undefined)?.message ?? "no contents") };
      return { ok: true, text: c.text, mimeType: c.mimeType ?? "", json: JSON.parse(c.text) };
    },
    async close() {
      await b.close();
      await server.close().catch(() => undefined);
    },
  };
}
