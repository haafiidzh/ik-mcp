import { describe, expect, it } from "vitest";
import { AppError } from "../../src/core/errors.js";
import {
  MAX_CATALOG_ROWS,
  PostgresAdapter,
  mapPostgresError,
  normalizeCell,
  type PgPoolConfig,
  type PostgresConnectionConfig,
} from "../../src/integrations/database/postgres.adapter.js";
import { makeFakePg, pgError, type FakePg, type FakeHandler } from "../fixtures/pg-fake.js";

// Docker-free tests: the adapter runs against a scripted fake pool (docker tests: postgres.adapter.docker.test.ts).

const CANARY_URL = "postgres://canary_user:CANARY_PASSWORD_9f3a@canary-host.internal:5432/canary_db";
const CONFIG: PostgresConnectionConfig = { name: "pg", connectionStringEnv: "DEVWS_TEST_URL", schemas: ["public", "sales"] };
const ENV = (n: string): string | undefined => (n === "DEVWS_TEST_URL" ? CANARY_URL : undefined);

function adapterWith(fake: FakePg, extra: Partial<ConstructorParameters<typeof PostgresAdapter>[1]> = {}): PostgresAdapter {
  return new PostgresAdapter(CONFIG, { getEnv: ENV, createPool: (c: PgPoolConfig) => (fake.poolConfigs.push(c), fake.pool), ...extra });
}

function tracesSecrets(value: unknown): boolean {
  const text = JSON.stringify(value) + String(value instanceof Error ? value.message + (value.stack ?? "") : "");
  return /CANARY_PASSWORD|canary_user|canary-host|canary_db/.test(text);
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

const rowsOf = (n: number): FakeHandler => () => ({
  rows: Array.from({ length: n }, (_, i) => [i, `v${i}`]),
  fields: [{ name: "id" }, { name: "label" }],
});

describe("transaction wrapping (ADR-050)", () => {
  it("runs BEGIN READ ONLY, SET LOCAL x2, the statement, then ROLLBACK, and returns the client", async () => {
    const fake = makeFakePg(rowsOf(2));
    const r = await adapterWith(fake).query("SELECT id, label FROM t", { maxRows: 10, timeoutMs: 1500 });
    expect(fake.texts).toHaveLength(5);
    expect(fake.texts[0]).toBe("BEGIN READ ONLY");
    expect(fake.texts[1]).toBe("SET LOCAL statement_timeout = 1500");
    expect(fake.texts[2]).toMatch(/^SET LOCAL idle_in_transaction_session_timeout = \d+$/);
    expect(fake.texts[3]).toContain("SELECT id, label FROM t");
    expect(fake.texts[4]).toBe("ROLLBACK");
    expect(fake.releases).toEqual([undefined]);
    expect(r).toMatchObject({ columns: ["id", "label"], rowCount: 2, truncated: false, cellsTruncated: false });
  });

  it("still ROLLBACKs and releases when the statement fails", async () => {
    const fake = makeFakePg(() => {
      throw pgError("42601", "syntax error at or near \"CANARY_PASSWORD_9f3a\"");
    });
    const e = await failure(adapterWith(fake).query("SELECT oops", { maxRows: 5, timeoutMs: 1000 }));
    expect(e.code).toBe("INVALID_INPUT");
    expect(fake.texts.at(-1)).toBe("ROLLBACK");
    expect(fake.releases).toEqual([undefined]);
    expect(tracesSecrets(e)).toBe(false);
  });

  it("destroys the connection when ROLLBACK itself fails", async () => {
    const fake = makeFakePg(rowsOf(1), (c) => {
      if (c.text === "ROLLBACK") throw new Error("socket closed");
      return { rows: [] };
    });
    await adapterWith(fake).query("SELECT 1", { maxRows: 5, timeoutMs: 1000 });
    expect(fake.releases).toEqual([true]);
  });

  it("wraps SQL with a parameterized LIMIT on the extended protocol (one statement only)", async () => {
    const fake = makeFakePg(rowsOf(0));
    await adapterWith(fake).query("SELECT 1 -- trailing comment\n;", { maxRows: 7, timeoutMs: 1000 });
    const call = fake.calls.find((c) => c.text.includes("_dw"));
    expect(call?.text).toBe("SELECT * FROM (\nSELECT 1 -- trailing comment\n) AS _dw LIMIT $1");
    expect(call?.values).toEqual([8]);
    expect(call?.queryMode).toBe("extended");
    expect(call?.rowMode).toBe("array");
  });

  it("never sends ANALYZE and refuses chained statements in EXPLAIN", async () => {
    const fake = makeFakePg(() => ({ rows: [["Seq Scan on t"], ["  Filter: (a > 1)"]] }));
    const a = adapterWith(fake);
    const r = await a.explain("SELECT * FROM t WHERE a > 1;");
    expect(r.plan).toBe("Seq Scan on t\n  Filter: (a > 1)");
    expect(fake.texts.find((t) => t.startsWith("EXPLAIN"))).toBe("EXPLAIN\nSELECT * FROM t WHERE a > 1");
    expect(fake.texts.join("\n")).not.toMatch(/ANALYZE/i);
    const e = await failure(a.explain("SELECT 1; COMMIT"));
    expect(e.code).toBe("QUERY_REJECTED");
  });

  it("maps a read-only violation (SQLSTATE 25006) to QUERY_REJECTED and a server timeout (57014) to TIMEOUT", async () => {
    let code = "25006";
    const fake = makeFakePg(() => {
      throw pgError(code, "cannot execute INSERT in a read-only transaction");
    });
    const a = adapterWith(fake);
    expect((await failure(a.query("SELECT f()", { maxRows: 5, timeoutMs: 1000 }))).code).toBe("QUERY_REJECTED");
    code = "57014";
    const t = await failure(a.query("SELECT pg_sleep(9)", { maxRows: 5, timeoutMs: 1000 }));
    expect(t.code).toBe("TIMEOUT");
    expect(t.retryable).toBe(true);
    expect(fake.texts.filter((x) => x === "ROLLBACK")).toHaveLength(2);
  });

  it("client-side backstop destroys a hung connection and reports TIMEOUT", async () => {
    const fake = makeFakePg(() => new Promise(() => undefined));
    const ac = new AbortController();
    const p = adapterWith(fake).query("SELECT 1", { maxRows: 5, timeoutMs: 1000, signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    const e = await failure(p);
    expect(e.code).toBe("TIMEOUT");
    expect(fake.releases).toEqual([true]);
    expect(fake.texts).not.toContain("ROLLBACK");
  });

  it("an already aborted signal never touches the pool", async () => {
    const fake = makeFakePg(rowsOf(1));
    const ac = new AbortController();
    ac.abort();
    const e = await failure(adapterWith(fake).query("SELECT 1", { maxRows: 5, timeoutMs: 1000, signal: ac.signal }));
    expect(e.code).toBe("TIMEOUT");
    expect(fake.texts).toHaveLength(0);
  });
});

describe("row cap, cell truncation, binary cells (S9, doc 05 section 3 step 4)", () => {
  it("fetches maxRows + 1 and reports truncation without returning the extra row", async () => {
    const fake = makeFakePg(rowsOf(4));
    const r = await adapterWith(fake).query("SELECT * FROM t", { maxRows: 3, timeoutMs: 1000 });
    expect(fake.calls.find((c) => c.text.includes("_dw"))?.values).toEqual([4]);
    expect(r.rows).toHaveLength(3);
    expect(r.rowCount).toBe(3);
    expect(r.truncated).toBe(true);
  });

  it("exactly maxRows rows is not truncated", async () => {
    const r = await adapterWith(makeFakePg(rowsOf(3))).query("SELECT * FROM t", { maxRows: 3, timeoutMs: 1000 });
    expect(r.truncated).toBe(false);
  });

  it("caps maxRows at the global maximum and rejects invalid values", async () => {
    const fake = makeFakePg(rowsOf(0));
    const a = adapterWith(fake);
    await a.query("SELECT 1", { maxRows: 100000, timeoutMs: 1000 });
    expect(fake.calls.find((c) => c.text.includes("_dw"))?.values).toEqual([101]);
    expect((await failure(a.query("SELECT 1", { maxRows: 0, timeoutMs: 1000 }))).code).toBe("INVALID_INPUT");
    expect((await failure(a.query("SELECT 1", { maxRows: 5, timeoutMs: 0 }))).code).toBe("INVALID_INPUT");
    expect((await failure(a.query("   ;", { maxRows: 5, timeoutMs: 1000 }))).code).toBe("INVALID_INPUT");
  });

  it("truncates cells at maxCellChars and flags it; binary cells become <binary N bytes>", async () => {
    const fake = makeFakePg(() => ({
      rows: [["x".repeat(50), Buffer.from([1, 2, 3, 4, 5]), 42, null, new Date("2026-01-02T03:04:05Z"), { a: 1 }, 10n]],
      fields: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }, { name: "e" }, { name: "f" }, { name: "g" }],
    }));
    const r = await adapterWith(fake, { maxCellChars: 10 }).query("SELECT 1", { maxRows: 5, timeoutMs: 1000 });
    expect(r.rows[0]).toEqual(["x".repeat(10), "<binary 5 bytes>", 42, null, "2026-01-02T03:04:05.000Z", '{"a":1}', "10"]);
    expect(r.cellsTruncated).toBe(true);
  });

  it("normalizeCell handles non-finite numbers and nested binary", () => {
    const flags = { truncated: false };
    expect(normalizeCell(Number.NaN, 10, flags)).toBe("NaN");
    expect(normalizeCell({ b: Buffer.from("abc") }, 100, flags)).toContain("<binary 3 bytes>");
    expect(flags.truncated).toBe(false);
  });
});

describe("secrets and error redaction (S19)", () => {
  it("reads the connection string only from the named env var through the injected getter", () => {
    const fake = makeFakePg(rowsOf(0));
    adapterWith(fake);
    expect(fake.poolConfigs[0]?.connectionString).toBe(CANARY_URL);
    expect(fake.poolConfigs[0]?.max).toBeLessThanOrEqual(10);
  });

  it("builds host/user/password config from named env vars", () => {
    const fake = makeFakePg(rowsOf(0));
    new PostgresAdapter(
      { name: "p", host: "h", port: 5433, database: "d", user: "u", passwordEnv: "PW", schemas: ["public"] },
      { getEnv: (n) => (n === "PW" ? "pw-value" : undefined), createPool: (c) => (fake.poolConfigs.push(c), fake.pool) },
    );
    expect(fake.poolConfigs[0]).toMatchObject({ host: "h", port: 5433, database: "d", user: "u", password: "pw-value" });
  });

  it("an unset env var fails with a fixed message that names the variable, not any value", () => {
    let thrown: unknown;
    try {
      new PostgresAdapter(CONFIG, { getEnv: () => undefined, createPool: () => makeFakePg(rowsOf(0)).pool });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("INTEGRATION_UNAVAILABLE");
    expect((thrown as AppError).message).toContain("DEVWS_TEST_URL");
  });

  it("a pool constructor failure that quotes the connection string is replaced by fixed text", () => {
    let thrown: unknown;
    try {
      new PostgresAdapter(CONFIG, {
        getEnv: ENV,
        createPool: () => {
          throw new TypeError(`Invalid URL: ${CANARY_URL}`);
        },
      });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as AppError).code).toBe("INTEGRATION_UNAVAILABLE");
    expect(tracesSecrets(thrown)).toBe(false);
  });

  it.each([
    ["28P01", `password authentication failed for user "canary_user" (CANARY_PASSWORD_9f3a)`],
    ["ECONNREFUSED", "connect ECONNREFUSED canary-host.internal:5432"],
    ["3D000", 'database "canary_db" does not exist'],
    ["ENOTFOUND", "getaddrinfo ENOTFOUND canary-host.internal"],
    ["08006", "connection failure canary-host.internal"],
  ])("connect error %s becomes INTEGRATION_UNAVAILABLE with no host, user or password", async (code, message) => {
    const fake = makeFakePg(rowsOf(0), undefined, pgError(code, message));
    const a = adapterWith(fake);
    const e = await failure(a.query("SELECT 1", { maxRows: 5, timeoutMs: 1000 }));
    expect(e.code).toBe("INTEGRATION_UNAVAILABLE");
    expect(tracesSecrets(e)).toBe(false);
    const c = await failure(a.listTables());
    expect(tracesSecrets(c)).toBe(false);
  });

  it("an error without a code whose message holds the connection string is not leaked", () => {
    const e = mapPostgresError(new Error(`Connection terminated unexpectedly ${CANARY_URL}`));
    expect(e.code).toBe("INTEGRATION_UNAVAILABLE");
    expect(tracesSecrets(e)).toBe(false);
    const u = mapPostgresError(new Error(`weird ${CANARY_URL}`));
    expect(u.code).toBe("INTERNAL_ERROR");
    expect(tracesSecrets(u)).toBe(false);
    expect(tracesSecrets(mapPostgresError(pgError("XX000", CANARY_URL)))).toBe(false);
  });

  it("maps common SQLSTATEs to fixed codes", () => {
    expect(mapPostgresError(pgError("42P01", "relation \"x\" does not exist")).code).toBe("NOT_FOUND");
    expect(mapPostgresError(pgError("42501", "permission denied for table t")).code).toBe("PERMISSION_DENIED");
    expect(mapPostgresError(pgError("22012", "division by zero")).code).toBe("INVALID_INPUT");
    expect(mapPostgresError(pgError("XX000", "x")).code).toBe("UPSTREAM_ERROR");
  });

  it("idle pool errors are logged by code only and never thrown", () => {
    const fake = makeFakePg(rowsOf(0));
    const lines: Record<string, unknown>[] = [];
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      error: () => undefined,
      warn: (_m: string, f?: Record<string, unknown>) => void lines.push(f ?? {}),
    };
    adapterWith(fake, { logger });
    fake.idleErrorListeners[0]?.(pgError("57P01", CANARY_URL));
    expect(JSON.stringify(lines)).not.toContain("CANARY");
    expect(lines[0]).toMatchObject({ code: "57P01" });
  });
});

describe("catalog tools", () => {
  it("listTables filters to configured schemas with bound parameters and maps kinds", async () => {
    const fake = makeFakePg(() => ({
      rows: [
        { oid: "1", schema: "public", name: "a", relkind: "r" },
        { oid: "2", schema: "public", name: "v", relkind: "v" },
        { oid: "3", schema: "sales", name: "m", relkind: "m" },
      ],
    }));
    const t = await adapterWith(fake).listTables();
    expect(t).toEqual([
      { schema: "public", name: "a", kind: "table" },
      { schema: "public", name: "v", kind: "view" },
      { schema: "sales", name: "m", kind: "view" },
    ]);
    const call = fake.calls.find((c) => c.text.includes("pg_class"));
    expect(call?.values).toEqual([["public", "sales"], MAX_CATALOG_ROWS + 1]);
    expect(call?.text).not.toContain("public");
  });

  it("a schema outside the configured list is refused without touching the database", async () => {
    const fake = makeFakePg(rowsOf(0));
    const a = adapterWith(fake);
    expect((await failure(a.listTables({ schema: "pg_catalog" }))).code).toBe("PERMISSION_DENIED");
    expect((await failure(a.listRelationships({ schema: "other" }))).code).toBe("PERMISSION_DENIED");
    expect((await failure(a.describeTable("t", { schema: "information_schema" }))).code).toBe("PERMISSION_DENIED");
    expect(fake.texts).toHaveLength(0);
  });

  it("reports catalog truncation beyond MAX_CATALOG_ROWS", async () => {
    const rows = Array.from({ length: MAX_CATALOG_ROWS + 1 }, (_, i) => ({ oid: String(i), schema: "public", name: `t${i}`, relkind: "r" }));
    const page = await adapterWith(makeFakePg(() => ({ rows }))).listTablesPage();
    expect(page.items).toHaveLength(MAX_CATALOG_ROWS);
    expect(page.truncated).toBe(true);
  });

  it("describeTable passes the table name as a bound parameter, never in SQL text", async () => {
    const hostile = `t'; DROP TABLE users; --`;
    const fake = makeFakePg(() => ({ rows: [] }));
    const e = await failure(adapterWith(fake).describeTable(hostile));
    expect(e.code).toBe("NOT_FOUND");
    expect(fake.texts.join("\n")).not.toContain("DROP TABLE");
    expect(fake.calls.some((c) => c.values?.includes(hostile))).toBe(true);
  });

  it("describeTable assembles columns, primary key and foreign keys", async () => {
    let n = 0;
    const fake = makeFakePg(() => {
      n++;
      if (n === 1) return { rows: [{ oid: "42", schema: "public", name: "orders", relkind: "r" }] };
      if (n === 2) return { rows: [{ name: "id", type: "integer", nullable: false, default: "nextval('s'::regclass)" }, { name: "customer_id", type: "integer", nullable: true, default: null }] };
      return {
        rows: [
          { conname: "orders_pkey", contype: "p", schema: "public", tbl: "orders", cols: ["id"], ref_schema: null, ref_table: null, ref_cols: null },
          { conname: "orders_cust_fk", contype: "f", schema: "public", tbl: "orders", cols: ["customer_id"], ref_schema: "public", ref_table: "customers", ref_cols: ["id"] },
        ],
      };
    });
    const d = await adapterWith(fake).describeTable("orders");
    expect(d.primaryKey).toEqual(["id"]);
    expect(d.columns).toHaveLength(2);
    expect(d.columns[0]).toMatchObject({ name: "id", nullable: false });
    expect(d.foreignKeys).toEqual([{ columns: ["customer_id"], referencedSchema: "public", referencedTable: "customers", referencedColumns: ["id"], name: "orders_cust_fk" }]);
    expect(fake.texts[0]).toBe("BEGIN READ ONLY");
    expect(fake.texts.at(-1)).toBe("ROLLBACK");
  });

  it("listRelationships qualifies table names with the schema", async () => {
    const fake = makeFakePg(() => ({
      rows: [{ conname: "fk", contype: "f", schema: "public", tbl: "orders", cols: ["customer_id"], ref_schema: "public", ref_table: "customers", ref_cols: ["id"] }],
    }));
    expect(await adapterWith(fake).listRelationships()).toEqual([
      { fromTable: "public.orders", fromColumns: ["customer_id"], toTable: "public.customers", toColumns: ["id"], name: "fk" },
    ]);
  });
});

describe("lifecycle", () => {
  it("close() ends the pool once and later calls are refused", async () => {
    const fake = makeFakePg(rowsOf(0));
    const a = adapterWith(fake);
    await a.close();
    await a.close();
    expect(fake.ended()).toBe(true);
    expect((await failure(a.query("SELECT 1", { maxRows: 5, timeoutMs: 1000 }))).code).toBe("INTEGRATION_UNAVAILABLE");
  });
});
