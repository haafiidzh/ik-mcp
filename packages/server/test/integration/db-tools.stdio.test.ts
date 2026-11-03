import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileFingerprint, makeSqliteFixture, type SqliteFixture } from "../fixtures/sqlite-fixture.js";

/**
 * db_* tools against the real server over stdio (P2-04): registration, happy paths,
 * S8 (write/DDL/ATTACH/PRAGMA/multi-statement rejected, file unchanged), S9 (row cap,
 * cooperative timeout), S10 (names only), S19 (canaries), S21 (stdout purity).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../..");
const entry = path.join(pkgRoot, "src/index.ts");
const tsxBin = path.join(pkgRoot, "node_modules/.bin/tsx");
const PG_PW_CANARY = "PG-PASSWORD-CANARY-9f3a";
const PG_URL_CANARY = "postgres://canary-user:URL-CANARY-7b2c@127.0.0.1:1/canarydb";
const DB_TOOLS = [
  "db_describe_table",
  "db_execute_readonly_query",
  "db_explain_query",
  "db_list_connections",
  "db_list_relationships",
  "db_list_tables",
];

interface Res {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  meta?: Record<string, unknown>;
  warnings?: string[];
}
interface Call {
  res: Res;
  text: string;
  isError: boolean;
}

let tmp: string;
let fx: SqliteFixture;
let cfgPath: string;
let offCfgPath: string;
let slowCfgPath: string;
let auditPath: string;
const children: ChildProcessWithoutNullStreams[] = [];

const connections = (dbPath: string): unknown[] => [
  { name: "sample", type: "sqlite", enabled: true, databasePath: dbPath, readOnly: true },
  { name: "off-sqlite", type: "sqlite", enabled: false, databasePath: dbPath, readOnly: true },
  { name: "pg-canary", type: "postgres", enabled: true, host: "127.0.0.1", port: 1, database: "canarydb", user: "canary-user", passwordEnv: "DEVWS_T_PGPW", schemas: ["public"] },
  { name: "pg-url", type: "postgres", enabled: true, connectionStringEnv: "DEVWS_T_PGURL", schemas: ["public"] },
  { name: "pg-unset", type: "postgres", enabled: true, connectionStringEnv: "DEVWS_T_UNSET", schemas: ["public"] },
];

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "dwmcp-dbt-")));
  fx = makeSqliteFixture();
  auditPath = path.join(tmp, "audit.jsonl");
  const base = (enabled: boolean, limits: Record<string, number>): unknown => ({
    server: { name: "db-test", logLevel: "debug", auditLogPath: auditPath },
    databases: connections(fx.dbPath).map((c) => ({ ...(c as object), ...(enabled ? {} : { enabled: false }) })),
    limits,
  });
  cfgPath = path.join(tmp, "cfg.json");
  writeFileSync(cfgPath, JSON.stringify(base(true, { dbMaxRows: 5, maxCellChars: 50, maxResults: 3 })));
  offCfgPath = path.join(tmp, "off.json");
  writeFileSync(offCfgPath, JSON.stringify(base(false, {})));
  slowCfgPath = path.join(tmp, "slow.json");
  writeFileSync(slowCfgPath, JSON.stringify(base(true, { dbQueryTimeoutMs: 50 })));
});

afterAll(() => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
  fx.cleanup();
});

class Client {
  readonly out: string[] = [];
  readonly err: string[] = [];
  private nextId = 1;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<number | null>;
  constructor(args: string[]) {
    this.child = spawn(tsxBin, [entry, ...args], {
      cwd: pkgRoot,
      env: { ...process.env, DEVWORKSPACE_CONFIG: "", DEVWS_T_PGPW: PG_PW_CANARY, DEVWS_T_PGURL: PG_URL_CANARY },
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
  async tools(): Promise<{ name: string; description: string; annotations?: Record<string, unknown> }[]> {
    const r = await this.request("tools/list");
    return (r["result"] as { tools: { name: string; description: string }[] }).tools;
  }
  async call(name: string, args: Record<string, unknown>): Promise<Call> {
    const r = await this.request("tools/call", { name, arguments: args });
    const result = r["result"] as { content: { text: string }[]; isError?: boolean };
    const text = result.content[0]?.text ?? "";
    return { res: JSON.parse(text) as Res, text, isError: result.isError === true };
  }
  async close(): Promise<number | null> {
    this.child.stdin.end();
    return Promise.race([this.exited, new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
  }
  assertStdoutPure(): void {
    for (const l of this.out) expect((JSON.parse(l) as Record<string, unknown>)["jsonrpc"]).toBe("2.0");
  }
}

async function open(cfg: string): Promise<Client> {
  const c = new Client(["--config", cfg]);
  await c.init();
  return c;
}

const q = (c: Client, sql: string, extra: Record<string, unknown> = {}): Promise<Call> =>
  c.call("db_execute_readonly_query", { connection: "sample", sql, ...extra });

describe("db_* tools over stdio (P2-04)", () => {
  it("registers six read-only tools only when a connection is enabled", async () => {
    const on = await open(cfgPath);
    const tools = await on.tools();
    expect(tools.map((t) => t.name).sort()).toEqual(["server_get_status", ...DB_TOOLS].sort());
    for (const t of tools.filter((x) => x.name.startsWith("db_"))) {
      expect(t.description).toMatch(/^Read-only\./);
      expect(t.annotations?.["readOnlyHint"]).toBe(true);
    }
    const status = await on.call("server_get_status", {});
    expect((status.res.data as { packs: { database: boolean } }).packs.database).toBe(true);
    on.assertStdoutPure();
    expect(await on.close()).toBe(0);

    const off = await open(offCfgPath);
    expect((await off.tools()).map((t) => t.name)).toEqual(["server_get_status"]);
    const st = await off.call("server_get_status", {});
    expect((st.res.data as { packs: { database: boolean } }).packs.database).toBe(false);
    expect(await off.close()).toBe(0);
  }, 30000);

  it("happy paths: connections, tables, describe, relationships, query, explain", async () => {
    const c = await open(cfgPath);
    const conns = await c.call("db_list_connections", {});
    const list = conns.res.data as { name: string; type: string }[];
    expect(list.map((x) => x.name)).toEqual(["sample", "pg-canary", "pg-url", "pg-unset"]);
    expect(conns.text).not.toContain(fx.dbPath);
    expect(conns.text).not.toContain("127.0.0.1");
    expect(conns.text).not.toContain("canary-user");

    const tables = await c.call("db_list_tables", { connection: "sample" });
    expect(tables.res.success).toBe(true);
    // maxResults is 3 in this config: 6 objects exist, so the list is cut and flagged
    expect((tables.res.data as unknown[]).length).toBe(3);
    expect(tables.res.meta).toMatchObject({ truncated: true, limit: 3, returnedCount: 3 });

    const d = await c.call("db_describe_table", { connection: "sample", table: "orders" });
    const desc = d.res.data as { columns: { name: string }[]; primaryKey: string[]; foreignKeys: { referencedTable: string }[] };
    expect(desc.primaryKey).toEqual(["id"]);
    expect(desc.foreignKeys[0]?.referencedTable).toBe("customers");
    const missing = await c.call("db_describe_table", { connection: "sample", table: "nope" });
    expect(missing.res.error?.code).toBe("NOT_FOUND");
    const badSchema = await c.call("db_list_tables", { connection: "sample", schema: "other" });
    expect(badSchema.res.error?.code).toBe("INVALID_INPUT");

    const rel = await c.call("db_list_relationships", { connection: "sample" });
    expect(rel.res.success).toBe(true);
    expect((rel.res.data as unknown[]).length).toBe(3);
    expect(rel.res.meta?.["truncated"]).toBe(false);

    const r = await q(c, "SELECT id, name FROM customers ORDER BY id");
    expect(r.res.data).toEqual({ columns: ["id", "name"], rows: [[1, "Ada"], [2, "Grace"], [3, "Linus"]], rowCount: 3, truncated: false });

    const e = await c.call("db_explain_query", { connection: "sample", sql: "SELECT * FROM customers WHERE id = 1" });
    expect(typeof (e.res.data as { plan: unknown }).plan).toBe("string");
    expect((e.res.data as { plan: string }).plan.toUpperCase()).toContain("SEARCH");
    c.assertStdoutPure();
    expect(await c.close()).toBe(0);
  }, 30000);

  it("S8: writes, DDL, ATTACH, PRAGMA, multi-statement are QUERY_REJECTED; file unchanged", async () => {
    const before = fileFingerprint(fx.dbPath);
    const dirBefore = readdirSync(fx.dir).sort();
    const c = await open(cfgPath);
    const attacks = [
      "INSERT INTO customers (name) VALUES ('x')",
      "UPDATE customers SET name = 'x'",
      "DELETE FROM customers",
      "DROP TABLE customers",
      "CREATE TABLE t (a)",
      "ATTACH DATABASE '/tmp/dwmcp-evil.db' AS evil",
      "PRAGMA writable_schema = ON",
      "PRAGMA journal_mode = DELETE",
      "SELECT 1; DROP TABLE customers",
      "SELECT 1; SELECT 2",
      "WITH x AS (SELECT 1) DELETE FROM customers",
      "VACUUM",
      "SELECT load_extension('x')",
    ];
    for (const sql of attacks) {
      for (const tool of ["db_execute_readonly_query", "db_explain_query"]) {
        const r = await c.call(tool, { connection: "sample", sql });
        expect(r.res.success, `${tool}: ${sql}`).toBe(false);
        expect(r.res.error?.code, `${tool}: ${sql}`).toBe("QUERY_REJECTED");
        expect(r.text).not.toContain(fx.dbPath);
      }
    }
    expect(fileFingerprint(fx.dbPath)).toEqual(before);
    expect(readdirSync(fx.dir).sort()).toEqual(dirBefore);
    const count = await q(c, "SELECT count(*) AS n FROM customers");
    expect((count.res.data as { rows: unknown[][] }).rows).toEqual([[3]]);
    expect((await q(c, "SELECT 1", { sql: "" }).catch(() => ({ isError: true }) as Call)).isError).toBe(true);
    c.assertStdoutPure();
    await c.close();
  }, 60000);

  it("S9: maxRows truncation is reported; cells are cut; maxRows above the cap is clamped", async () => {
    const c = await open(cfgPath);
    const rec = "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 50) SELECT x FROM n";
    const r = await q(c, rec);
    const d = r.res.data as { rows: unknown[][]; rowCount: number; truncated: boolean };
    expect(d.rowCount).toBe(5);
    expect(d.rows).toHaveLength(5);
    expect(d.truncated).toBe(true);
    expect(r.res.meta).toMatchObject({ truncated: true, rowsTruncated: true, limit: 5, returnedCount: 5 });
    const small = await q(c, rec, { maxRows: 2 });
    expect((small.res.data as { rowCount: number }).rowCount).toBe(2);
    const big = await q(c, rec, { maxRows: 5000 });
    expect((big.res.data as { rowCount: number }).rowCount).toBe(5);
    expect(big.res.warnings?.join(" ")).toMatch(/clamped/);
    const cell = await q(c, "SELECT note FROM customers WHERE id = 1");
    expect(((cell.res.data as { rows: string[][] }).rows[0]?.[0] ?? "").length).toBeLessThanOrEqual(50);
    expect(cell.res.meta).toMatchObject({ truncated: true, cellsTruncated: true });
    await c.close();
  }, 30000);

  it("S9: a slow query is reported as TIMEOUT (cooperative on SQLite, ADR-053)", async () => {
    const c = await open(slowCfgPath);
    const slow =
      "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 3000000) SELECT count(*) FROM n";
    const r = await q(c, slow);
    expect(r.res.error?.code).toBe("TIMEOUT");
    // the server stays usable afterwards
    expect((await q(c, "SELECT 1")).res.success).toBe(true);
    await c.close();
  }, 60000);

  it("S10: unknown or disabled connection is NOT_FOUND; strings, URLs and paths are INVALID_INPUT; extra args are refused", async () => {
    const c = await open(cfgPath);
    expect((await c.call("db_list_tables", { connection: "nope" })).res.error?.code).toBe("NOT_FOUND");
    expect((await c.call("db_list_tables", { connection: "off-sqlite" })).res.error?.code).toBe("NOT_FOUND");
    const smuggled = [
      "sqlite:///etc/passwd",
      "postgres://u:p@evil.example/db",
      "/etc/passwd",
      "../x.db",
      fx.dbPath,
      "host=evil.example dbname=x",
    ];
    for (const connection of smuggled) {
      const r = await c.call("db_execute_readonly_query", { connection, sql: "SELECT 1" });
      expect(r.res.error?.code, connection).toBe("INVALID_INPUT");
      expect(r.text).not.toContain("evil.example");
      expect(r.text).not.toContain("/etc/passwd");
    }
    for (const extra of [{ databasePath: fx.dbPath }, { connectionString: "postgres://x/y" }, { host: "evil.example" }]) {
      const r = await c
        .call("db_list_tables", { connection: "sample", ...extra })
        .catch(() => undefined);
      expect(r === undefined || r.isError).toBe(true);
    }
    c.assertStdoutPure();
    await c.close();
  }, 30000);

  it("S19/S21: postgres failures carry fixed text; no canary, path or SQL leaks to stdout, stderr or the audit log", async () => {
    const secretSql = "SELECT 'SQL-SECRET-CANARY-55' AS leak, name FROM customers";
    const c = await open(cfgPath);
    const results: Call[] = [];
    for (const connection of ["pg-canary", "pg-url", "pg-unset"]) {
      results.push(await c.call("db_list_tables", { connection }));
      results.push(await c.call("db_execute_readonly_query", { connection, sql: secretSql }));
      results.push(await c.call("db_explain_query", { connection, sql: secretSql }));
    }
    results.push(await q(c, secretSql));
    results.push(await q(c, "INSERT INTO customers (name) VALUES ('SQL-SECRET-CANARY-55')"));
    results.push(await c.call("db_describe_table", { connection: "sample", table: "customers; DROP TABLE x" }));
    for (const r of results.slice(0, 9)) {
      expect(r.res.success).toBe(false);
      expect(["INTEGRATION_UNAVAILABLE", "TIMEOUT", "PERMISSION_DENIED"]).toContain(r.res.error?.code);
    }
    c.assertStdoutPure();
    await c.close();
    const audit = readFileSync(auditPath, "utf8");
    // The one successful query legitimately returns its own literal in stdout; the SQL text must not appear anywhere else.
    const everything = [...results.map((r) => r.text), ...c.out, c.err.join(""), audit];
    for (const text of everything) {
      for (const secret of [PG_PW_CANARY, "URL-CANARY-7b2c", "canary-user", "canarydb", fx.dbPath, fx.dir]) {
        expect(text.includes(secret), `leaked ${secret}`).toBe(false);
      }
    }
    const sqlSinks = [...results.filter((r) => !r.res.success).map((r) => r.text), c.err.join(""), audit];
    for (const text of sqlSinks) expect(text.includes("SQL-SECRET-CANARY-55")).toBe(false);
    // audit holds the connection name only
    const lines = audit.trim().split("\n").map((l) => JSON.parse(l) as { tool: string; resourceRef?: string | null });
    const dbLines = lines.filter((l) => l.tool.startsWith("db_"));
    expect(dbLines.length).toBeGreaterThan(10);
    for (const l of dbLines) {
      if (l.resourceRef !== undefined && l.resourceRef !== null) {
        expect(["sample", "pg-canary", "pg-url", "pg-unset", "unknown-connection"]).toContain(l.resourceRef);
      }
    }
  }, 120000);
});
