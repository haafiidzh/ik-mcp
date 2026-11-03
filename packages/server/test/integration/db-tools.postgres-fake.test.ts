import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { parseConfigText } from "../../src/config/load-config.js";
import { createAuditLog } from "../../src/core/audit.js";
import { DEFAULT_LIMITS } from "../../src/core/limits.js";
import { createLogger } from "../../src/core/logger.js";
import { createRedactor } from "../../src/core/redact.js";
import { PostgresAdapter, type PgPoolConfig } from "../../src/integrations/database/postgres.adapter.js";
import { registerTools, type ServerDeps } from "../../src/server/register-tools.js";
import { makeFakePg, type FakeHandler, type FakePg } from "../fixtures/pg-fake.js";

/**
 * db_* tools on the PostgreSQL path without Docker: the real tool layer, registry and
 * PostgresAdapter over a scripted fake pool (the Docker run covers the real server).
 */

const CANARY_URL = "postgres://canary_user:CANARY_PASSWORD_9f3a@canary-host.internal:5432/canary_db";
const CONFIG = JSON.stringify({
  databases: [
    { name: "pg", type: "postgres", enabled: true, connectionStringEnv: "DEVWS_FAKE_URL", schemas: ["public"] },
  ],
});

interface Harness {
  call(tool: string, args: Record<string, unknown>): Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string }; meta?: Record<string, unknown> }>;
  fake: FakePg;
  audit: { tool: string; resourceRef?: string }[];
  names: string[];
}

function harness(handler: FakeHandler, limits: Partial<typeof DEFAULT_LIMITS> = {}): Harness {
  const fake = makeFakePg(handler);
  const handlers = new Map<string, { schema: { safeParse(v: unknown): { success: boolean; data?: unknown } }; fn: (a: unknown) => Promise<{ content: { text: string }[] }> }>();
  const server = {
    server: {},
    registerTool: (name: string, cfg: { inputSchema?: { safeParse(v: unknown): { success: boolean; data?: unknown } } }, fn: (a: unknown) => Promise<{ content: { text: string }[] }>) => {
      handlers.set(name, { schema: cfg.inputSchema ?? { safeParse: (v) => ({ success: true, data: v }) }, fn });
    },
  } as unknown as McpServer;
  const auditRecords: { tool: string; resourceRef?: string }[] = [];
  const audit = createAuditLog();
  const realRecord = audit.record.bind(audit);
  audit.record = (e) => {
    auditRecords.push({ tool: e.tool, ...(e.resourceRef !== undefined ? { resourceRef: e.resourceRef } : {}) });
    realRecord(e);
  };
  const deps: ServerDeps = {
    config: parseConfigText(CONFIG),
    limits: { ...DEFAULT_LIMITS, ...limits },
    logger: createLogger({ level: "error" }),
    audit,
    redactor: createRedactor(),
    startedAtMs: Date.now(),
    databaseFactories: {
      postgres: (c) =>
        new PostgresAdapter(
          { name: c.name, connectionStringEnv: "DEVWS_FAKE_URL", schemas: c.type === "postgres" ? c.schemas : [] },
          { getEnv: () => CANARY_URL, createPool: (p: PgPoolConfig) => (fake.poolConfigs.push(p), fake.pool) },
        ),
    },
  };
  const names = registerTools(server, deps);
  return {
    fake,
    audit: auditRecords,
    names,
    async call(tool, args) {
      const h = handlers.get(tool);
      if (h === undefined) throw new Error(`tool not registered: ${tool}`);
      const parsed = h.schema.safeParse(args);
      if (!parsed.success) return { success: false, error: { code: "INVALID_INPUT", message: "schema" } };
      const r = await h.fn(parsed.data);
      return JSON.parse(r.content[0]?.text ?? "{}") as never;
    },
  };
}

const rows = (n: number): FakeHandler => () => ({
  rows: Array.from({ length: n }, (_, i) => [i, `v${i}`]),
  fields: [{ name: "id" }, { name: "label" }],
});

describe("db_* tools on PostgreSQL (fake pool)", () => {
  it("registers the six tools", () => {
    expect(harness(rows(0)).names.filter((n) => n.startsWith("db_")).sort()).toEqual([
      "db_describe_table",
      "db_execute_readonly_query",
      "db_explain_query",
      "db_list_connections",
      "db_list_relationships",
      "db_list_tables",
    ]);
  });

  it("passes the validated statement UNWRAPPED: the adapter owns the row cap (one wrapper only)", async () => {
    const h = harness(rows(3));
    const r = await h.call("db_execute_readonly_query", { connection: "pg", sql: "SELECT id, label FROM t;", maxRows: 2 });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ columns: ["id", "label"], rowCount: 2, truncated: true });
    expect(r.meta).toMatchObject({ truncated: true, rowsTruncated: true, limit: 2 });
    const stmt = h.fake.calls.find((c) => c.text.includes("SELECT id, label FROM t"));
    expect(stmt?.text.match(/_dw/g)).toHaveLength(1);
    expect(stmt?.values).toEqual([3]);
  });

  it("explain sends plain EXPLAIN once (never ANALYZE, no double prefix)", async () => {
    const h = harness(() => ({ rows: [["Seq Scan on t"]] }));
    const r = await h.call("db_explain_query", { connection: "pg", sql: "SELECT * FROM t" });
    expect(r.data).toEqual({ plan: "Seq Scan on t" });
    const text = h.fake.texts.find((t) => t.startsWith("EXPLAIN")) ?? "";
    expect(text).toMatch(/^EXPLAIN\nSELECT \* FROM t$/);
    expect(text).not.toMatch(/ANALYZE/i);
  });

  it("rejects writes before any connection is opened (S8) and audits the connection name only", async () => {
    const h = harness(rows(1));
    for (const sql of ["INSERT INTO t VALUES (1)", "SELECT 1; DROP TABLE t", "DROP TABLE t", "COPY t TO '/tmp/x'", "SELECT pg_read_file('/etc/passwd')"]) {
      const r = await h.call("db_execute_readonly_query", { connection: "pg", sql });
      expect(r.error?.code, sql).toBe("QUERY_REJECTED");
    }
    expect(h.fake.texts).toHaveLength(0);
    for (const a of h.audit.filter((x) => x.tool.startsWith("db_"))) expect(a.resourceRef).toBe("pg");
  });

  it("schema outside the configured list is PERMISSION_DENIED (pg); table list is capped by maxResults", async () => {
    const tables = Array.from({ length: 5 }, (_, i) => ({ oid: String(i), schema: "public", name: `t${i}`, relkind: "r" }));
    const h = harness(() => ({ rows: tables }), { maxResults: 2 });
    expect((await h.call("db_list_tables", { connection: "pg", schema: "pg_catalog" })).error?.code).toBe("PERMISSION_DENIED");
    const r = await h.call("db_list_tables", { connection: "pg" });
    expect((r.data as unknown[]).length).toBe(2);
    expect(r.meta).toMatchObject({ truncated: true, limit: 2, returnedCount: 2 });
  });

  it("a backend failure surfaces as fixed text with no URL, user or host (S19)", async () => {
    const h = harness(() => {
      throw Object.assign(new Error(`password authentication failed for user "canary_user" at ${CANARY_URL}`), { code: "28P01" });
    });
    const r = await h.call("db_execute_readonly_query", { connection: "pg", sql: "SELECT 1" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/canary_user|CANARY_PASSWORD|canary-host|canary_db/);
  });

  it("hostile connection values are INVALID_INPUT without touching the pool", async () => {
    const h = harness(rows(1));
    for (const connection of [CANARY_URL, "host=x user=y", "/var/run/postgresql", "pg;DROP"]) {
      const r = await h.call("db_list_tables", { connection });
      expect(r.error?.code).toBe("INVALID_INPUT");
      expect(JSON.stringify(r)).not.toContain("CANARY_PASSWORD");
    }
    expect((await h.call("db_list_tables", { connection: "other" })).error?.code).toBe("NOT_FOUND");
    expect(h.fake.texts).toHaveLength(0);
  });
});
