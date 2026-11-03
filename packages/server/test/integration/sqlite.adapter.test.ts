import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError } from "../../src/core/errors.js";
import { createDatabaseRegistry } from "../../src/integrations/database/database.registry.js";
import type { DatabaseAdapter } from "../../src/integrations/database/database.types.js";
import {
  createSqliteAdapter,
  createSqliteAdapterFactory,
  type SqliteConnection,
} from "../../src/integrations/database/sqlite.adapter.js";
import { makeSqliteFixture, SAMPLE_LONG_TEXT_CHARS, type SqliteFixture } from "../fixtures/sqlite-fixture.js";

let fx: SqliteFixture;
let db: DatabaseAdapter;

const conn = (databasePath: string): SqliteConnection => ({ name: "sample", type: "sqlite", enabled: true, readOnly: true, databasePath });
const opts = { maxRows: 100, timeoutMs: 5000 };

async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("expected rejection");
}

beforeAll(() => {
  fx = makeSqliteFixture();
  db = createSqliteAdapter(conn(fx.dbPath), { maxCellChars: 1000 });
});
afterAll(async () => {
  await db.close();
  fx.cleanup();
});

describe("sqlite adapter: catalog", () => {
  it("lists tables and views sorted, without sqlite_ internals", async () => {
    const tables = await db.listTables();
    expect(tables).toEqual([
      { schema: null, name: "customer_totals", kind: "view" },
      { schema: null, name: "customers", kind: "table" },
      { schema: null, name: "order_items", kind: "table" },
      { schema: null, name: "orders", kind: "table" },
      { schema: null, name: "products", kind: "table" },
    ]);
    expect(tables.some((t) => t.name.startsWith("sqlite_"))).toBe(false);
  });

  it("accepts schema main and refuses any other schema", async () => {
    expect((await db.listTables({ schema: "main" })).length).toBe(5);
    expect((await failure(db.listTables({ schema: "other" }))).code).toBe("INVALID_INPUT");
    expect((await failure(db.listRelationships({ schema: "/etc/x.db" }))).code).toBe("INVALID_INPUT");
  });

  it("describes columns, nullability, defaults and primary key", async () => {
    const d = await db.describeTable("customers");
    expect(d.name).toBe("customers");
    expect(d.primaryKey).toEqual(["id"]);
    expect(d.columns.map((c) => c.name)).toEqual(["id", "name", "email", "note"]);
    expect(d.columns.find((c) => c.name === "name")).toMatchObject({ type: "TEXT", nullable: false });
    expect(d.columns.find((c) => c.name === "email")).toMatchObject({ nullable: true });
    expect(d.columns.find((c) => c.name === "note")?.default).toBe("'none'");
    expect(d.foreignKeys).toEqual([]);
  });

  it("describes a composite key and foreign keys (explicit and implicit targets)", async () => {
    const d = await db.describeTable("order_items");
    expect(d.primaryKey).toEqual(["order_id", "line_no"]);
    expect(d.foreignKeys).toHaveLength(2);
    expect(d.foreignKeys).toContainEqual({ columns: ["order_id"], referencedSchema: null, referencedTable: "orders", referencedColumns: ["id"] });
    // `REFERENCES products` has no column list: resolved to products' primary key.
    expect(d.foreignKeys).toContainEqual({ columns: ["sku"], referencedSchema: null, referencedTable: "products", referencedColumns: ["sku"] });
  });

  it("describes a view (no keys)", async () => {
    const d = await db.describeTable("customer_totals");
    expect(d.columns.map((c) => c.name)).toEqual(["customer_id", "name", "order_count"]);
    expect(d.foreignKeys).toEqual([]);
  });

  it("validates identifiers against the catalog: unknown, internal and injected names are NOT_FOUND", async () => {
    for (const name of ["nope", "sqlite_sequence", "sqlite_schema", "customers; DROP TABLE customers", "customers') --", "main.customers", "../x", ""]) {
      const e = await failure(db.describeTable(name));
      expect(["NOT_FOUND", "INVALID_INPUT"]).toContain(e.code);
    }
    expect((await db.listTables()).length).toBe(5);
  });

  it("lists relationships", async () => {
    const rels = await db.listRelationships();
    expect(rels).toContainEqual({ fromTable: "orders", fromColumns: ["customer_id"], toTable: "customers", toColumns: ["id"] });
    expect(rels).toContainEqual({ fromTable: "order_items", fromColumns: ["order_id"], toTable: "orders", toColumns: ["id"] });
    expect(rels).toContainEqual({ fromTable: "order_items", fromColumns: ["sku"], toTable: "products", toColumns: ["sku"] });
    expect(rels).toHaveLength(3);
  });

  it("bounds catalog listings (LIMIT_EXCEEDED, never silent truncation)", async () => {
    const tiny = createSqliteAdapter(conn(fx.dbPath), { maxCatalogEntries: 2 });
    expect((await failure(tiny.listTables())).code).toBe("LIMIT_EXCEEDED");
    expect((await failure(tiny.listRelationships())).code).toBe("LIMIT_EXCEEDED");
    await tiny.close();
  });

  it("page variants report truncation instead of failing (ADR-055); cut cells are flagged", async () => {
    const tiny = createSqliteAdapter(conn(fx.dbPath), { maxCatalogEntries: 2, maxCellChars: 100 });
    const tables = await tiny.listTablesPage();
    expect(tables.items).toHaveLength(2);
    expect(tables.truncated).toBe(true);
    const rels = await tiny.listRelationshipsPage();
    expect(rels.items.length).toBeLessThanOrEqual(2);
    expect(rels.truncated).toBe(true);
    expect((await db.listTablesPage()).truncated).toBe(false);
    expect((await db.listRelationshipsPage()).items).toHaveLength(3);
    expect((await tiny.query("SELECT note FROM customers WHERE id = 1", opts)).cellsTruncated).toBe(true);
    expect((await tiny.query("SELECT id FROM customers", opts)).cellsTruncated).toBe(false);
    await tiny.close();
  });
});

describe("sqlite adapter: query", () => {
  it("returns columns, rows and counts", async () => {
    const r = await db.query("SELECT id, name, email FROM customers ORDER BY id", opts);
    expect(r.columns).toEqual(["id", "name", "email"]);
    expect(r.rows).toEqual([
      [1, "Ada", "ada@example.test"],
      [2, "Grace", "grace@example.test"],
      [3, "Linus", null],
    ]);
    expect(r.rowCount).toBe(3);
    expect(r.truncated).toBe(false);
  });

  it("truncates at maxRows (maxRows + 1 detection) and not before", async () => {
    const cte = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000) SELECT x FROM c";
    const cut = await db.query(cte, { ...opts, maxRows: 10 });
    expect(cut.rowCount).toBe(10);
    expect(cut.rows).toHaveLength(10);
    expect(cut.truncated).toBe(true);
    const exact = await db.query("SELECT id FROM customers", { ...opts, maxRows: 3 });
    expect(exact.rowCount).toBe(3);
    expect(exact.truncated).toBe(false);
    const one = await db.query("SELECT id FROM customers", { ...opts, maxRows: 2 });
    expect(one.truncated).toBe(true);
  });

  it("truncates long cells at maxCellChars", async () => {
    const r = await db.query("SELECT note FROM customers WHERE id = 1", opts);
    const cell = r.rows[0]?.[0];
    expect(typeof cell).toBe("string");
    expect((cell as string).length).toBe(1000);
    expect((cell as string).endsWith("…")).toBe(true);
    expect(SAMPLE_LONG_TEXT_CHARS).toBeGreaterThan(1000);
    const small = createSqliteAdapter(conn(fx.dbPath), { maxCellChars: 3 });
    const s = await small.query("SELECT name FROM customers WHERE id = 2", opts);
    expect(s.rows[0]?.[0]).toBe("Gr\u2026");
    await small.close();
  });

  it("renders binary cells as <binary N bytes>", async () => {
    const r = await db.query("SELECT photo FROM products ORDER BY sku", opts);
    expect(r.rows).toEqual([["<binary 8 bytes>"], [null]]);
    const z = await db.query("SELECT zeroblob(3) AS z", opts);
    expect(z.rows).toEqual([["<binary 3 bytes>"]]);
  });

  it("keeps integers exact: safe ones as numbers, unsafe ones as strings", async () => {
    const r = await db.query("SELECT 42 AS a, 9007199254740993 AS b, 1.5 AS c, 'x' AS d", opts);
    expect(r.rows).toEqual([[42, "9007199254740993", 1.5, "x"]]);
  });

  it("supports views, joins, CTEs and bare VALUES", async () => {
    const v = await db.query("SELECT name, order_count FROM customer_totals ORDER BY customer_id", opts);
    expect(v.rows).toEqual([["Ada", 2], ["Grace", 1], ["Linus", 0]]);
    const vals = await db.query("VALUES (1, 'a'), (2, 'b')", opts);
    expect(vals.rowCount).toBe(2);
  });

  it("maps SQL errors to INVALID_INPUT without leaking the database path", async () => {
    for (const sql of ["SELECT * FROM missing_table", "SELECT nope FROM customers", "SELEC 1", "SELECT 1; SELECT 2", "SELECT ?"]) {
      const e = await failure(db.query(sql, opts));
      expect(e.code).toBe("INVALID_INPUT");
      expect(e.message).not.toContain(fx.dir);
      expect(e.message).not.toContain("sample.db");
    }
  });

  it("validates options", async () => {
    expect((await failure(db.query("SELECT 1", { maxRows: 0, timeoutMs: 1000 }))).code).toBe("INVALID_INPUT");
    expect((await failure(db.query("SELECT 1", { maxRows: 1, timeoutMs: 0 }))).code).toBe("INVALID_INPUT");
    expect((await failure(db.query("", opts))).code).toBe("INVALID_INPUT");
  });
});

describe("sqlite adapter: explain", () => {
  it("returns an EXPLAIN QUERY PLAN text and never executes the query", async () => {
    const r = await db.explain("SELECT * FROM orders WHERE customer_id = 1;");
    expect(typeof r.plan).toBe("string");
    expect(r.plan as string).toMatch(/SEARCH|SCAN/);
    expect(r.plan as string).toContain("orders");
    expect(db.capabilities.explain).toBe(true);
  });

  it("rejects an EXPLAIN-prefixed or multi-statement input", async () => {
    expect((await failure(db.explain("EXPLAIN QUERY PLAN SELECT 1"))).code).toBe("QUERY_REJECTED");
    expect((await failure(db.explain("SELECT 1; DROP TABLE customers"))).code).toBe("INVALID_INPUT");
    expect((await db.listTables()).length).toBe(5);
  });
});

describe("sqlite adapter: lifecycle and registry wiring", () => {
  it("close() is idempotent and later calls fail with INTEGRATION_UNAVAILABLE", async () => {
    const a = createSqliteAdapter(conn(fx.dbPath));
    await a.close();
    await a.close();
    expect((await failure(a.listTables())).code).toBe("INTEGRATION_UNAVAILABLE");
    expect((await failure(a.query("SELECT 1", opts))).code).toBe("INTEGRATION_UNAVAILABLE");
  });

  it("the factory plugs into the registry; a missing file is INTEGRATION_UNAVAILABLE with no path", async () => {
    const good = { name: "sample", type: "sqlite" as const, enabled: true, readOnly: true, databasePath: fx.dbPath };
    const bad = { name: "gone", type: "sqlite" as const, enabled: true, readOnly: true, databasePath: `${fx.dir}/missing-secret-name.db` };
    const reg = createDatabaseRegistry([good, bad], { sqlite: createSqliteAdapterFactory<typeof good>() });
    const a = await reg.get("sample");
    expect((await a.listTables()).length).toBe(5);
    const e = await failure(reg.get("gone"));
    expect(e.code).toBe("INTEGRATION_UNAVAILABLE");
    expect(e.message).not.toContain(fx.dir);
    expect(e.message).not.toContain("missing-secret-name");
    await reg.closeAll();
  });

  it("refuses a directory, :memory:, file: URIs, a non-database file and a non-readOnly connection", () => {
    for (const p of [fx.dir, ":memory:", `file:${fx.dbPath}`, "", `${fx.dir}/nope.db`]) {
      expect(() => createSqliteAdapter(conn(p))).toThrowError(/could not be opened/);
    }
    const factory = createSqliteAdapterFactory();
    expect(() => factory({ name: "x", type: "sqlite", enabled: true, readOnly: false, databasePath: fx.dbPath } as never)).toThrowError(/could not be opened/);
    expect(() => factory({ name: "x", type: "postgres", enabled: true, readOnly: true } as never)).toThrowError(/could not be opened/);
  });
});
