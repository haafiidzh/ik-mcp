import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError } from "../../src/core/errors.js";
import { PostgresAdapter, type PostgresConnectionConfig } from "../../src/integrations/database/postgres.adapter.js";
import { assertReadOnlySql } from "../../src/integrations/database/sql-guard.js";

/**
 * Real PostgreSQL (throwaway Docker container). Run with `bash scripts/test-postgres.sh`
 * from packages/server (ADR-046, D21). Without DEVWS_TEST_PG_URL the whole suite is skipped.
 * Covers S8 "data unchanged (verified)" on a real connection with the SQL guard bypassed
 * (ADR-050) and S9 (row cap, TIMEOUT).
 */

const ADMIN_URL = process.env["DEVWS_TEST_PG_URL"];
const RO_URL = process.env["DEVWS_TEST_PG_RO_URL"];
const enabled = ADMIN_URL !== undefined && ADMIN_URL !== "" && RO_URL !== undefined && RO_URL !== "";
const suite = enabled ? describe : describe.skip;

const ENV: Record<string, string | undefined> = { TEST_PG_ADMIN: ADMIN_URL, TEST_PG_RO: RO_URL };
const getEnv = (n: string): string | undefined => ENV[n];

function config(envName: string, schemas = ["public", "sales"]): PostgresConnectionConfig {
  return { name: "docker", connectionStringEnv: envName, schemas };
}

async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error("expected rejection");
}

suite("PostgresAdapter against Docker postgres (SKIPPED unless DEVWS_TEST_PG_URL is set; run scripts/test-postgres.sh)", () => {
  let admin: PostgresAdapter;
  let ro: PostgresAdapter;
  const opts = { maxRows: 100, timeoutMs: 5000 };

  async function scalar(sql: string): Promise<unknown> {
    return (await admin.query(sql, { maxRows: 1, timeoutMs: 5000 })).rows[0]?.[0];
  }

  beforeAll(() => {
    admin = new PostgresAdapter(config("TEST_PG_ADMIN"), { getEnv, defaultTimeoutMs: 5000 });
    ro = new PostgresAdapter(config("TEST_PG_RO"), { getEnv, defaultTimeoutMs: 5000 });
  });
  afterAll(async () => {
    await Promise.all([admin.close(), ro.close()]);
  });

  describe("queries", () => {
    it("returns columns and rows, binary cells as <binary N bytes>, long cells truncated", async () => {
      const small = new PostgresAdapter(config("TEST_PG_ADMIN"), { getEnv, maxCellChars: 20 });
      try {
        const r = await small.query("SELECT id, note, blob FROM public.orders ORDER BY id", opts);
        expect(r.columns).toEqual(["id", "note", "blob"]);
        expect(r.rowCount).toBe(3);
        expect(r.rows[0]).toEqual([1, "first", "<binary 5 bytes>"]);
        expect((r.rows[1]?.[1] as string).length).toBe(20);
        expect(r.cellsTruncated).toBe(true);
        expect(r.truncated).toBe(false);
      } finally {
        await small.close();
      }
    });

    it("S9: more than maxRows rows is truncated at maxRows", async () => {
      const r = await admin.query("SELECT n FROM public.numbers ORDER BY n", { maxRows: 100, timeoutMs: 5000 });
      expect(r.rows).toHaveLength(100);
      expect(r.truncated).toBe(true);
      const exact = await admin.query("SELECT n FROM public.numbers WHERE n <= 5 ORDER BY n", { maxRows: 5, timeoutMs: 5000 });
      expect(exact.rows).toHaveLength(5);
      expect(exact.truncated).toBe(false);
    });

    it("accepts the statement shapes the guard allows (CTE, VALUES, trailing semicolon and comment)", async () => {
      expect((await admin.query("WITH x AS (SELECT 1 AS a) SELECT a FROM x;", opts)).rows).toEqual([[1]]);
      expect((await admin.query("VALUES (1), (2)", opts)).rows).toEqual([[1], [2]]);
      expect((await admin.query("SELECT 1 AS a -- why not", opts)).rows).toEqual([[1]]);
    });

    it("S9: pg_sleep beyond the timeout becomes TIMEOUT quickly and the pool keeps working", async () => {
      const started = Date.now();
      const e = await failure(admin.query("SELECT pg_sleep(10)", { maxRows: 5, timeoutMs: 300 }));
      expect(e.code).toBe("TIMEOUT");
      expect(e.retryable).toBe(true);
      expect(Date.now() - started).toBeLessThan(4000);
      expect(await scalar("SELECT 1")).toBe(1);
    });

    it("leaves no connection idle in transaction after success, error and timeout", async () => {
      await failure(admin.query("SELECT 1/0", opts));
      await failure(admin.query("SELECT pg_sleep(10)", { maxRows: 1, timeoutMs: 200 }));
      expect(await scalar("SELECT count(*)::int FROM pg_stat_activity WHERE state LIKE 'idle in transaction%'")).toBe(0);
    });

    it("maps SQL errors to fixed AppErrors", async () => {
      expect((await failure(admin.query("SELECT * FROM public.nope", opts))).code).toBe("NOT_FOUND");
      expect((await failure(admin.query("SELEC 1", opts))).code).toBe("INVALID_INPUT");
    });
  });

  describe("S8: read-only enforced at the connection, SQL guard bypassed (ADR-050)", () => {
    it("the guard would reject these, the adapter still cannot change data", async () => {
      expect(() => assertReadOnlySql("SELECT public.dw_write_probe()", { dialect: "postgres" })).not.toThrow(); // guard passes it: layer 2 must hold
      const before = await scalar("SELECT count(*)::int FROM public.write_probe");
      const e = await failure(admin.query("SELECT public.dw_write_probe()", opts));
      expect(e.code).toBe("QUERY_REJECTED");
      expect((await failure(admin.query("SELECT nextval('public.customers_id_seq')", opts))).code).toBe("QUERY_REJECTED");
      expect(await scalar("SELECT count(*)::int FROM public.write_probe")).toBe(before);
    });

    it("a chained COMMIT; INSERT (statement breakout) is refused and data is unchanged", async () => {
      const before = await scalar("SELECT count(*)::int FROM public.write_probe");
      const breakout = "1 AS a) AS z; COMMIT; INSERT INTO public.write_probe (v) VALUES ('boom'); SELECT * FROM (SELECT 1";
      const e = await failure(admin.query(`SELECT ${breakout}`, opts));
      expect(["INVALID_INPUT", "QUERY_REJECTED"]).toContain(e.code);
      expect(await scalar("SELECT count(*)::int FROM public.write_probe")).toBe(before);
      const raw = await failure(admin.query("INSERT INTO public.write_probe (v) VALUES ('boom')", opts));
      expect(["INVALID_INPUT", "QUERY_REJECTED"]).toContain(raw.code);
      expect(await scalar("SELECT count(*)::int FROM public.write_probe")).toBe(before);
    });

    it("a data-modifying statement cannot hide in EXPLAIN either", async () => {
      const before = await scalar("SELECT count(*)::int FROM public.write_probe");
      expect((await failure(admin.explain("SELECT 1; COMMIT"))).code).toBe("QUERY_REJECTED");
      await admin.explain("SELECT public.dw_write_probe()"); // plain EXPLAIN never executes the function
      expect(await scalar("SELECT count(*)::int FROM public.write_probe")).toBe(before);
    });

    it("SET LOCAL does not leak: session settings are default again on the next query", async () => {
      expect(await scalar("SELECT current_setting('transaction_read_only')")).toBe("on"); // inside the read-only tx
      expect(await scalar("SELECT current_setting('statement_timeout')")).toBe("5s");
      const other = await admin.query("SELECT current_setting('statement_timeout')", { maxRows: 1, timeoutMs: 1234 });
      expect(other.rows[0]?.[0]).toBe("1234ms");
    });

    it("read-only role: reads work, the writing function fails at the database", async () => {
      expect((await ro.query("SELECT count(*)::int FROM public.customers", opts)).rows).toEqual([[3]]);
      const before = await scalar("SELECT count(*)::int FROM public.write_probe");
      const e = await failure(ro.query("SELECT public.dw_write_probe()", opts));
      expect(["QUERY_REJECTED", "PERMISSION_DENIED"]).toContain(e.code);
      expect(await scalar("SELECT count(*)::int FROM public.write_probe")).toBe(before);
    });
  });

  describe("explain", () => {
    it("returns a plain text plan and never analyzes", async () => {
      const r = await admin.explain("SELECT * FROM public.customers WHERE id = 1");
      expect(typeof r.plan).toBe("string");
      expect(r.plan as string).toMatch(/Scan|Result/);
      expect(r.plan as string).not.toMatch(/actual time/i);
      const started = Date.now();
      await admin.explain("SELECT pg_sleep(10)"); // EXPLAIN without ANALYZE does not run the query
      expect(Date.now() - started).toBeLessThan(3000);
    });
  });

  describe("catalog tools", () => {
    it("lists tables and views of the configured schemas only", async () => {
      const t = await admin.listTables();
      const names = t.map((x) => `${x.schema}.${x.name}:${x.kind}`);
      expect(names).toContain("public.customers:table");
      expect(names).toContain("public.order_totals:view");
      expect(names).toContain("sales.regions:table");
      expect(names.some((n) => n.startsWith("hidden."))).toBe(false);
      expect(names.some((n) => n.startsWith("pg_catalog.") || n.startsWith("information_schema."))).toBe(false);
      expect((await admin.listTables({ schema: "sales" })).map((x) => x.name)).toEqual(["regions"]);
    });

    it("refuses schemas outside the configuration even though the role could read them", async () => {
      expect((await failure(ro.listTables({ schema: "hidden" }))).code).toBe("PERMISSION_DENIED");
      expect((await failure(ro.describeTable("internal_notes", { schema: "hidden" }))).code).toBe("PERMISSION_DENIED");
      expect((await failure(ro.describeTable("internal_notes"))).code).toBe("NOT_FOUND");
      expect((await failure(ro.describeTable("pg_class"))).code).toBe("NOT_FOUND");
    });

    it("describes columns, primary key and foreign keys", async () => {
      const d = await admin.describeTable("orders");
      expect(d.schema).toBe("public");
      expect(d.primaryKey).toEqual(["id"]);
      expect(d.columns.map((c) => c.name)).toEqual(["id", "customer_id", "total", "note", "blob"]);
      expect(d.columns[0]).toMatchObject({ type: "integer", nullable: false });
      expect(d.columns[0]?.default).toContain("nextval");
      expect(d.columns[2]).toMatchObject({ type: "numeric(10,2)", nullable: false });
      expect(d.foreignKeys).toEqual([
        { columns: ["customer_id"], referencedSchema: "public", referencedTable: "customers", referencedColumns: ["id"], name: "orders_customer_id_fkey" },
      ]);
    });

    it("a hostile table name is only ever data", async () => {
      const e = await failure(admin.describeTable(`customers'; DROP TABLE public.customers; --`));
      expect(e.code).toBe("NOT_FOUND");
      expect(await scalar("SELECT count(*)::int FROM public.customers")).toBe(3);
    });

    it("lists relationships", async () => {
      expect(await admin.listRelationships()).toEqual([
        { fromTable: "public.orders", fromColumns: ["customer_id"], toTable: "public.customers", toColumns: ["id"], name: "orders_customer_id_fkey" },
      ]);
      expect(await admin.listRelationships({ schema: "sales" })).toEqual([]);
    });
  });

  describe("S19: connection failures reveal nothing", () => {
    it("wrong password and unreachable port give fixed INTEGRATION_UNAVAILABLE errors", async () => {
      const url = new URL(ADMIN_URL ?? "postgres://x@127.0.0.1:1/x");
      const badPw = new URL(url);
      badPw.password = "CANARY_WRONG_PASSWORD_77";
      const closedPort = new URL(url);
      closedPort.port = "1";
      for (const bad of [badPw.toString(), closedPort.toString()]) {
        const a = new PostgresAdapter(config("BAD"), { getEnv: () => bad });
        try {
          const e = await failure(a.query("SELECT 1", opts));
          expect(e.code).toBe("INTEGRATION_UNAVAILABLE");
          const text = `${e.message}${JSON.stringify(e)}${e.stack ?? ""}`;
          expect(text).not.toMatch(/CANARY_WRONG_PASSWORD_77|127\.0\.0\.1|postgres:|devws_test/);
        } finally {
          await a.close();
        }
      }
    });
  });
});

if (!enabled) {
  // One visible line explaining the skip (vitest prints it with the skipped suite).
  describe("PostgresAdapter Docker tests", () => {
    it.skip("SKIPPED: DEVWS_TEST_PG_URL / DEVWS_TEST_PG_RO_URL are not set; run `bash scripts/test-postgres.sh` (needs Docker)", () => undefined);
  });
}
