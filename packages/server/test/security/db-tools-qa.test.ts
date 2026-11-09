import { execSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileFingerprint, makeSqliteFixture, type SqliteFixture } from "../fixtures/sqlite-fixture.js";

/** QA-03: black-box attacks on the BUILT server (dist/index.js, plain Node ESM, no vitest transforms). */
const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../..");
const dist = path.join(pkgRoot, "dist/index.js");
const CANARY = "QA03-CANARY-pw-5d1e";

interface Call { res: { success: boolean; data?: unknown; error?: { code: string; message: string }; meta?: Record<string, unknown>; warnings?: string[] }; text: string; isError: boolean }
let tmp: string; let fx: SqliteFixture; let cfg: string; let slowCfg: string; let audit: string;
const kids: ChildProcessWithoutNullStreams[] = [];

class Client {
  out: string[] = []; err: string[] = []; id = 1;
  child: ChildProcessWithoutNullStreams; exited: Promise<{ code: number | null; sig: string | null }>;
  constructor(cfgPath: string) {
    this.child = spawn(process.execPath, [dist, "--config", cfgPath], { cwd: tmp, env: { ...process.env, DEVWORKSPACE_CONFIG: "", DEVWS_QA_PW: CANARY }, stdio: ["pipe", "pipe", "pipe"] });
    kids.push(this.child);
    let buf = "";
    this.child.stdout.setEncoding("utf8").on("data", (d: string) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { this.out.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    this.child.stderr.setEncoding("utf8").on("data", (d: string) => this.err.push(d));
    this.exited = new Promise((r) => this.child.on("exit", (code, sig) => r({ code, sig })));
  }
  async req(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.id++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }) + "\n");
    for (let i = 0; i < 600; i++) {
      for (const l of this.out) { const m = JSON.parse(l) as Record<string, unknown>; if (m["id"] === id) return m; }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("timeout " + method);
  }
  async init(): Promise<void> {
    await this.req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "qa", version: "0" } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }
  async call(name: string, args: Record<string, unknown>): Promise<Call> {
    const r = (await this.req("tools/call", { name, arguments: args }))["result"] as { content: { text: string }[]; isError?: boolean } | undefined;
    if (!r) return { res: { success: false }, text: "", isError: true };
    const text = r.content[0]?.text ?? "";
    let res: Call["res"];
    try { res = JSON.parse(text) as Call["res"]; } catch { res = { success: false, error: { code: "RAW", message: text } }; }
    return { res, text, isError: r.isError === true };
  }
  pure(): void { for (const l of this.out) expect((JSON.parse(l) as { jsonrpc: string }).jsonrpc).toBe("2.0"); }
}
async function open(c: string): Promise<Client> { const k = new Client(c); await k.init(); return k; }

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "dwmcp-qa03-")));
  fx = makeSqliteFixture();
  audit = path.join(tmp, "audit.jsonl");
  const dbs = [
    { name: "sample", type: "sqlite", enabled: true, databasePath: fx.dbPath, readOnly: true },
    { name: "off", type: "sqlite", enabled: false, databasePath: fx.dbPath },
    { name: "pg", type: "postgres", enabled: true, host: "127.0.0.1", port: 1, database: "qadb", user: "qauser", passwordEnv: "DEVWS_QA_PW", schemas: ["public"] },
  ];
  cfg = path.join(tmp, "c.json");
  writeFileSync(cfg, JSON.stringify({ server: { name: "qa", logLevel: "debug", auditLogPath: audit }, databases: dbs, limits: { dbMaxRows: 5, maxCellChars: 40 } }));
  slowCfg = path.join(tmp, "s.json");
  writeFileSync(slowCfg, JSON.stringify({ server: { name: "qa", logLevel: "debug", auditLogPath: audit }, databases: dbs, limits: { dbQueryTimeoutMs: 1000 } }));
});
afterAll(() => { for (const k of kids) if (k.exitCode === null) k.kill("SIGKILL"); rmSync(tmp, { recursive: true, force: true }); fx.cleanup(); });

const REJECT = [
  "SELECT 1; DROP TABLE customers",
  "SELECT 1 /* x */ ; /* y */ DELETE FROM customers",
  "SELECT 1\n;\nINSERT INTO customers(name) VALUES('x')",
  "  \t\n insert into customers(name) values('x')",
  "InSeRt INTO customers(name) VALUES('x')",
  "/* hi */ UPDATE customers SET name='x'",
  "-- c\nDELETE FROM customers",
  "WITH x AS (SELECT 1) INSERT INTO customers(name) SELECT 'a' FROM x",
  "WITH x AS (DELETE FROM customers RETURNING *) SELECT * FROM x",
  "WITH x AS (UPDATE customers SET name='a' RETURNING *) SELECT * FROM x",
  "SELECT load_extension('/tmp/x.so')",
  "SELECT LOAD_EXTENSION('/tmp/x.so')",
  'SELECT "load_extension"(\'/tmp/x.so\')',
  "SELECT main.load_extension('/tmp/x.so')",
  "SELECT 1 WHERE load_extension('x') IS NULL",
  "SELECT (SELECT load_extension('x'))",
  "SELECT writefile('/tmp/dwmcp-qa-w','x')",
  "SELECT readfile('/etc/passwd')",
  "SELECT fts3_tokenizer('x')",
  "PRAGMA table_info(customers)",
  "pragma writable_schema=1",
  "SELECT * FROM sqlite_master",
  "SELECT * FROM main.sqlite_schema",
  'SELECT * FROM "sqlite_temp_master"',
  "SELECT * FROM [sqlite_sequence]",
  "SELECT * FROM pragma_table_info('customers')",
  "SELECT * FROM pragma_database_list",
  "VALUES ((SELECT 1 FROM sqlite_master))",
  "PrAgMa journal_mode",
  "SELECT * FROM pragma_table_info('customers'); PRAGMA x",
  "ATTACH DATABASE '/tmp/dwmcp-qa-evil.db' AS e",
  "attach '/tmp/dwmcp-qa-evil.db' as e",
  "DETACH DATABASE main",
  "EXPLAIN ANALYZE SELECT 1",
  "EXPLAIN SELECT 1",
  "EXPLAIN QUERY PLAN SELECT 1",
  "ANALYZE",
  "REINDEX",
  "VACUUM INTO '/tmp/dwmcp-qa-vac.db'",
  "BEGIN; DELETE FROM customers; COMMIT",
  "REPLACE INTO customers(id,name) VALUES(1,'x')",
  "CREATE TABLE t AS SELECT * FROM customers",
  "CREATE TEMP TABLE t(a)",
  "DROP VIEW v",
  "ALTER TABLE customers ADD COLUMN z",
  "SELECT * INTO newt FROM customers",
  "SELECT 1 ; DROP TABLE customers",
  "SELECT 1 ; DROP TABLE customers",
  "SELECT 1; DROP TABLE customers",
  "SELECT 1； DROP TABLE customers",
  "SELECT 1\u0000; DROP TABLE customers",
  "SELECT 'a\\'; DROP TABLE customers; --'",
  "SELECT 1 /*! ; DROP TABLE customers */",
  "SELECT 1 /* /* */ ; DROP TABLE customers */",
  "SELECT $$; DROP TABLE customers; $$",
  "SELECT [a; DROP TABLE customers; --]",
  "VALUES (1); DROP TABLE customers",
  "VALUES (load_extension('x'))",
  "VALUES (1) UNION SELECT load_extension('x')",
  "SELECT 1 UNION ALL SELECT load_extension('x')",
  "SELECT " + "(".repeat(3000) + "1" + ")".repeat(3000),
  "SELECT 1 /*" + "x".repeat(12000) + "*/",
  "",
  "   ",
];
// Forms that are legitimately read-only; recorded, not required to reject.
const OBSERVE = [
  "SELECT 1;",
  "SELECT \"name\" FROM \"customers\" LIMIT 1",
  "SELECT sqlite_version()",
  "SELECT 'DROP TABLE x'",
  "SELECT 1 -- ; DROP TABLE customers",
  "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<3) SELECT x FROM n",
  "VALUES (1),(2)",
  "SELECT random(), randomblob(4)",
  "SELECT printf('%.*c', 1000, 'a')",
];

describe("QA-03 db tools on dist/index.js", () => {
  it("S8: guard bypass attempts rejected through both tools, file + dir unchanged", async () => {
    expect(existsSync(dist)).toBe(true);
    const before = fileFingerprint(fx.dbPath);
    const c = await open(cfg);
    const failures: string[] = [];
    for (const sql of REJECT) {
      for (const tool of ["db_execute_readonly_query", "db_explain_query"]) {
        const r = await c.call(tool, { connection: "sample", sql });
        const ok = !r.res.success && ["QUERY_REJECTED", "INVALID_INPUT"].includes(r.res.error?.code ?? "") || r.isError;
        if (!ok) failures.push(`${tool}: ${JSON.stringify(sql.slice(0, 80))} -> ${r.text.slice(0, 120)}`);
        if (r.text.includes(fx.dbPath)) failures.push("path leaked for " + sql.slice(0, 40));
      }
    }
    expect(failures).toEqual([]);
    const observed: string[] = [];
    for (const sql of OBSERVE) {
      const r = await c.call("db_execute_readonly_query", { connection: "sample", sql });
      observed.push(`${r.res.success ? "OK " : "REJ"} ${sql} ${r.res.success ? "" : r.res.error?.message}`);
    }
    console.error("OBSERVED:\n" + observed.join("\n"));
    expect(existsSync("/tmp/dwmcp-qa-evil.db")).toBe(false);
    expect(existsSync("/tmp/dwmcp-qa-w")).toBe(false);
    expect(existsSync("/tmp/dwmcp-qa-vac.db")).toBe(false);
    expect(fileFingerprint(fx.dbPath)).toEqual(before);
    c.pure();
    c.child.stdin.end();
    expect((await c.exited).code).toBe(0);
  }, 120000);

  it("S10 + S19 + S9 cells/rows + status", async () => {
    const c = await open(cfg);
    const bad: [string, Record<string, unknown>][] = [
      ["db_list_tables", { connection: "nope" }],
      ["db_list_tables", { connection: "off" }],
      ["db_list_tables", { connection: fx.dbPath }],
      ["db_list_tables", { connection: "../../etc/passwd" }],
      ["db_list_tables", { connection: "postgres://u:p@h/db" }],
      ["db_list_tables", { connection: "file:" + fx.dbPath }],
      ["db_list_tables", { connection: "sample", databasePath: "/etc/passwd" }],
      ["db_execute_readonly_query", { connection: "sample", sql: "SELECT 1", host: "evil" }],
      ["db_describe_table", { connection: "sample", table: "customers; DROP TABLE customers" }],
      ["db_describe_table", { connection: "sample", table: "sqlite_master" }],
      ["db_execute_readonly_query", { connection: "sample", sql: "SELECT 1", maxRows: -1 }],
      ["db_execute_readonly_query", { connection: "sample", sql: "SELECT 1", maxRows: 1e12 }],
      ["db_execute_readonly_query", { connection: "sample", sql: 5 }],
      ["db_execute_readonly_query", { connection: "pg", sql: "SELECT 1" }],
      ["db_list_tables", { connection: "pg" }],
    ];
    for (const [t, a] of bad) {
      const r = await c.call(t, a);
      const isRejectedOrOk = t === "db_execute_readonly_query" && a["maxRows"] === 1e12;
      if (!isRejectedOrOk) expect(r.res.success && !r.isError, `${t} ${JSON.stringify(a)} -> ${r.text}`).toBe(false);
      expect(r.text).not.toContain(CANARY);
      expect(r.text).not.toContain(fx.dbPath);
      expect(r.text).not.toContain("qauser");
      expect(r.text).not.toContain("qadb");
      console.error(`ERR ${t} ${JSON.stringify(a).slice(0, 70)} -> ${r.res.error?.code} ${r.res.error?.message}`);
    }
    const rows = await c.call("db_execute_readonly_query", { connection: "sample", sql: "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000) SELECT x FROM n", maxRows: 1000000 });
    expect(rows.res.success).toBe(true);
    expect((rows.res.data as { rowCount: number; truncated: boolean }).rowCount).toBe(5);
    expect((rows.res.data as { truncated: boolean }).truncated).toBe(true);
    const cell = await c.call("db_execute_readonly_query", { connection: "sample", sql: "SELECT replace(hex(zeroblob(5000)),'0','a') AS big, 'k' AS k" });
    expect(cell.text.length).toBeLessThan(4000);
    expect(cell.res.meta?.["cellsTruncated"]).toBe(true);
    const st = await c.call("server_get_status", {});
    expect(JSON.stringify(st.res.data)).toContain('"database":true');
    expect(st.text).not.toContain(CANARY);
    c.pure();
    const stderr = c.err.join("");
    c.child.stdin.end();
    await c.exited;
    const all = stderr + c.err.join("") + c.out.join("\n") + (existsSync(audit) ? readFileSync(audit, "utf8") : "");
    expect(all).not.toContain(CANARY);
    expect(all).not.toContain(fx.dbPath);
    expect(all).not.toContain("DROP TABLE customers");
    expect(existsSync(audit)).toBe(true);
  }, 60000);

  // QA-03 finding F1 (P1), fixed in P2-07: query/explain run in a killable child process.
  const RUNAWAY = "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n) SELECT count(*) FROM n";

  it("S9 DoS: unbounded recursive aggregate returns TIMEOUT, connection stays usable", async () => {
    const c = await open(slowCfg);
    const t0 = Date.now();
    const r = await c.call("db_execute_readonly_query", { connection: "sample", sql: RUNAWAY });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.res.success).toBe(false);
    expect(r.res.error?.code).toBe("TIMEOUT");
    const again = await c.call("db_execute_readonly_query", { connection: "sample", sql: "SELECT 1 AS one" });
    expect(again.res.success).toBe(true);
    const plan = await c.call("db_explain_query", { connection: "sample", sql: "SELECT * FROM customers" });
    expect(plan.res.success).toBe(true);
    c.pure();
    c.child.kill("SIGKILL");
  }, 30000);

  it("S9 DoS: SIGTERM during a runaway query exits promptly", async () => {
    const c = await open(cfg);
    void c.call("db_execute_readonly_query", { connection: "sample", sql: RUNAWAY }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
    c.child.kill("SIGTERM");
    const e = await Promise.race([c.exited, new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
    if (e === null) c.child.kill("SIGKILL");
    expect(e).not.toBeNull();
  }, 30000);

  it("shutdown: SIGTERM exits cleanly", async () => {
    const c = await open(cfg);
    await c.call("db_list_tables", { connection: "sample" });
    c.child.kill("SIGTERM");
    const e = await Promise.race([c.exited, new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
    expect(e).not.toBeNull();
    expect(e?.code === 0 || e?.sig === "SIGTERM").toBe(true);
  }, 30000);

  // QA-03 retest additions
  // Orphans only: a runner whose parent is a live server process belongs to a concurrently running test file
  // (P5-05 workflow stdio tests also use sqlite), so it must not count. An orphan is re-parented away from node.
  const runners = (): string => {
    try {
      const rows = execSync("ps -eo pid=,ppid=,comm=,args=", { encoding: "utf8" }).split("\n").map((l) => l.trim().split(/\s+/, 3).concat(l.trim()));
      const comm = new Map(rows.map((r) => [r[0], r[2]] as const));
      return rows.filter((r) => /sqlite\.runner/.test(r[3] ?? "") && !/grep/.test(r[3] ?? "") && comm.get(r[1] ?? "") !== "node").map((r) => r[3]).join("\n").trim();
    } catch { return ""; }
  };

  it("retest: cartesian join TIMEOUT, no orphan runner after timeout / stdin close / parent SIGKILL", async () => {
    const CART = "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5000) SELECT count(*) FROM n a, n b, n c, n d";
    const c = await open(slowCfg);
    const r = await c.call("db_execute_readonly_query", { connection: "sample", sql: CART });
    expect(r.res.error?.code).toBe("TIMEOUT");
    await new Promise((x) => setTimeout(x, 400));
    const ok = await c.call("db_execute_readonly_query", { connection: "sample", sql: "SELECT 1 AS one" });
    expect(ok.res.success).toBe(true);
    void c.call("db_execute_readonly_query", { connection: "sample", sql: CART }).catch(() => undefined);
    await new Promise((x) => setTimeout(x, 300));
    c.child.stdin.end();
    expect((await c.exited).code).toBe(0);
    await new Promise((x) => setTimeout(x, 500));
    const k = await open(slowCfg);
    void k.call("db_execute_readonly_query", { connection: "sample", sql: RUNAWAY }).catch(() => undefined);
    await new Promise((x) => setTimeout(x, 400));
    k.child.kill("SIGKILL");
    await k.exited;
    await new Promise((x) => setTimeout(x, 1500));
    expect(runners()).toBe("");
  }, 60000);

  it("retest F3: internals blocked, look-alike identifiers not blocked by quoting/case/prefix tricks", async () => {
    const c = await open(cfg);
    for (const sql of ['SELECT * FROM "main"."SQLITE_MASTER"', "SELECT * FROM temp.sqlite_schema", "SELECT * FROM sqlite_master m", "SELECT * FROM/**/sqlite_master", "SELECT * FROM dbstat", 'SELECT * FROM "PRAGMA_table_info"(\'customers\')', "WITH x AS (SELECT * FROM sqlite_master) SELECT * FROM x"]) {
      const r = await c.call("db_execute_readonly_query", { connection: "sample", sql });
      expect(r.res.success, sql).toBe(false);
    }
    const okq = await c.call("db_execute_readonly_query", { connection: "sample", sql: "SELECT id AS sqlite_x FROM customers" });
    expect(okq.res.success).toBe(true);
    c.child.stdin.end();
    await c.exited;
  }, 60000);
});
