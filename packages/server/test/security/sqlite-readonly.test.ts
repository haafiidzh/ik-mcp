import { copyFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError } from "../../src/core/errors.js";
import { createDatabaseRegistry } from "../../src/integrations/database/database.registry.js";
import type { DatabaseAdapter } from "../../src/integrations/database/database.types.js";
import {
  createSqliteAdapter,
  createSqliteAdapterFactory,
  openSqliteReadOnly,
  type SqliteConnection,
} from "../../src/integrations/database/sqlite.adapter.js";
import { fileFingerprint, makeSqliteFixture, type SqliteFixture } from "../fixtures/sqlite-fixture.js";

/**
 * doc 05 section 8: S8 (data unchanged, verified on a real connection, independent of
 * sql-guard, ADR-050), S9 (maxRows truncation, timeout behaviour), S10 (nothing from
 * arguments can select a file).
 */

let fx: SqliteFixture;
let adapter: DatabaseAdapter;
const opts = { maxRows: 100, timeoutMs: 5000 };
const conn = (databasePath: string): SqliteConnection => ({ name: "sample", type: "sqlite", enabled: true, readOnly: true, databasePath });

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  return "RESOLVED";
}

beforeAll(() => {
  fx = makeSqliteFixture();
  adapter = createSqliteAdapter(conn(fx.dbPath));
});
afterAll(async () => {
  await adapter.close();
  fx.cleanup();
});

const WRITE_ATTEMPTS = [
  "INSERT INTO customers (name) VALUES ('mallory')",
  "UPDATE customers SET name = 'x'",
  "DELETE FROM customers",
  "DROP TABLE customers",
  "CREATE TABLE evil (a)",
  "ALTER TABLE customers ADD COLUMN pwn TEXT",
  "REPLACE INTO customers (id, name) VALUES (1, 'x')",
  "INSERT INTO customers (name) VALUES ('m') RETURNING id",
  "DELETE FROM customers RETURNING *",
  "SELECT 1; DROP TABLE customers",
  "SELECT 1; INSERT INTO customers (name) VALUES ('m')",
  "ATTACH DATABASE ':memory:' AS evil",
  "DETACH DATABASE main",
  "PRAGMA query_only = OFF",
  "PRAGMA writable_schema = ON",
  "PRAGMA journal_mode = DELETE",
  "VACUUM",
  "VACUUM INTO '/tmp/dwmcp-should-not-exist.db'",
  "BEGIN",
  "COMMIT",
  "SAVEPOINT s",
  "REINDEX",
  "ANALYZE",
  "CREATE VIEW v AS SELECT 1",
  "SELECT load_extension('/tmp/evil.so')",
];

describe("S8: connection-level read-only holds without sql-guard (adapter, real connection)", () => {
  it("every write/DDL/ATTACH/PRAGMA attempt is refused and the database file is byte-identical afterwards", async () => {
    const before = fileFingerprint(fx.dbPath);
    const filesBefore = readdirSync(fx.dir).sort();
    for (const sql of WRITE_ATTEMPTS) {
      const outcome = await code(adapter.query(sql, opts));
      expect(outcome, sql).not.toBe("RESOLVED");
    }
    expect(fileFingerprint(fx.dbPath)).toEqual(before);
    // No journal / wal / temp files appeared next to the database.
    expect(readdirSync(fx.dir).sort()).toEqual(filesBefore);
    // And the data is still there.
    const r = await adapter.query("SELECT count(*) FROM customers", opts);
    expect(r.rows).toEqual([[3]]);
    expect((await adapter.listTables()).some((t) => t.name === "evil")).toBe(false);
  });

  it("explain() never executes and refuses writes", async () => {
    const before = fileFingerprint(fx.dbPath);
    await adapter.explain("DELETE FROM customers").catch(() => undefined);
    await adapter.explain("SELECT 1; DELETE FROM customers").catch(() => undefined);
    expect(fileFingerprint(fx.dbPath)).toEqual(before);
    expect((await adapter.query("SELECT count(*) FROM customers", opts)).rows).toEqual([[3]]);
  });

  it("the exact connection the adapter opens rejects writes even when SQL is sent straight to the driver", () => {
    const before = fileFingerprint(fx.dbPath);
    const raw = openSqliteReadOnly(fx.dbPath);
    try {
      expect(raw.readonly).toBe(true);
      expect(raw.pragma("query_only", { simple: true })).toBe(1);
      for (const sql of [
        "INSERT INTO customers (name) VALUES ('mallory')",
        "UPDATE customers SET name = 'x'",
        "DELETE FROM customers",
        "DROP TABLE customers",
        "CREATE TABLE evil (a)",
        "CREATE TEMP TABLE t (a)",
      ]) {
        expect(() => raw.exec(sql), sql).toThrowError(/readonly|read-only|query_only|not authorized/i);
      }
      // Turning query_only off does not help: the file itself is opened read-only.
      raw.pragma("query_only = OFF");
      expect(() => raw.exec("INSERT INTO customers (name) VALUES ('mallory')")).toThrowError(/readonly|read-only/i);
      expect(() => raw.exec("DELETE FROM customers")).toThrowError(/readonly|read-only/i);
      expect(() => raw.exec("VACUUM")).toThrow();
      // Extension loading is not available to SQL.
      expect(() => raw.prepare("SELECT load_extension('/tmp/evil.so')").get()).toThrow();
    } finally {
      raw.close();
    }
    expect(fileFingerprint(fx.dbPath)).toEqual(before);
  });

  it("ATTACH on the real connection cannot reach another file with write access", () => {
    const other = path.join(fx.dir, "other.db");
    copyFileSync(fx.dbPath, other);
    const beforeOther = fileFingerprint(other);
    const raw = openSqliteReadOnly(fx.dbPath);
    try {
      // Even if an ATTACH ran, the attached file inherits the read-only flag: writes through it fail.
      let attached = true;
      try {
        raw.exec(`ATTACH DATABASE '${other.replace(/'/g, "''")}' AS o`);
      } catch {
        attached = false;
      }
      if (attached) expect(() => raw.exec("DELETE FROM o.customers")).toThrow();
    } finally {
      raw.close();
    }
    expect(fileFingerprint(other)).toEqual(beforeOther);
  });

  it("a database that is not readable is not opened for writing (missing file is never created)", () => {
    const missing = path.join(fx.dir, "created-by-mistake.db");
    expect(() => createSqliteAdapter(conn(missing))).toThrowError(/could not be opened/);
    expect(readdirSync(fx.dir)).not.toContain("created-by-mistake.db");
  });
});

describe("S9: row cap and timeout", () => {
  const sequence = (n: number): string => `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${n}) `;

  it("a result larger than maxRows is truncated, flagged, and holds exactly maxRows rows", async () => {
    const r = await adapter.query(`${sequence(5000)}SELECT x FROM c`, { maxRows: 25, timeoutMs: 5000 });
    expect(r.rows).toHaveLength(25);
    expect(r.rowCount).toBe(25);
    expect(r.truncated).toBe(true);
  });

  it("a slow query that streams rows is aborted mid-way with TIMEOUT (cooperative deadline)", async () => {
    const started = Date.now();
    // 500M iterations would take far longer than the test timeout; a row appears every 1000 steps.
    const sql = `${sequence(500_000_000)}SELECT x FROM c WHERE x % 1000 = 0`;
    const e = await adapter.query(sql, { maxRows: 1_000_000, timeoutMs: 100 }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe("TIMEOUT");
    expect((e as AppError).message).not.toContain(fx.dir);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("a single long step is reported as TIMEOUT once it returns (in-process preemption is impossible)", async () => {
    // One step (aggregate over ~3M generated rows). better-sqlite3 cannot interrupt a running step; the
    // limit is enforced when control returns. This documents the limitation (implementation-notes P2-02).
    const e = await adapter.query(`${sequence(3_000_000)}SELECT count(*) FROM c`, { maxRows: 10, timeoutMs: 1 }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe("TIMEOUT");
  });

  it("an already-aborted signal cancels before reading rows", async () => {
    const ctl = new AbortController();
    ctl.abort();
    expect(await code(adapter.query("SELECT 1", { ...opts, signal: ctl.signal }))).toBe("TIMEOUT");
  });

  it("the adapter stays usable after a timeout", async () => {
    await adapter.query(`${sequence(2_000_000)}SELECT count(*) FROM c`, { maxRows: 1, timeoutMs: 1 }).catch(() => undefined);
    expect((await adapter.query("SELECT 1", opts)).rows).toEqual([[1]]);
  });
});

describe("S10: nothing from arguments can choose a database file", () => {
  it("query/describe/list arguments naming files or schemas never open or reach another database", async () => {
    const other = path.join(fx.dir, "secret.db");
    copyFileSync(fx.dbPath, other);
    const before = fileFingerprint(other);
    const attempts: Promise<unknown>[] = [
      adapter.query(`ATTACH DATABASE '${other}' AS s`, opts),
      adapter.query("SELECT * FROM s.customers", opts),
      adapter.query(`SELECT * FROM '${other}'.customers`, opts),
      adapter.describeTable(other),
      adapter.describeTable(`s.customers`),
      adapter.listTables({ schema: other }),
      adapter.listTables({ schema: "temp" }),
      adapter.listRelationships({ schema: "s" }),
    ];
    const outcomes = await Promise.all(attempts.map(code));
    for (const o of outcomes) expect(o).not.toBe("RESOLVED");
    expect(fileFingerprint(other)).toEqual(before);
  });

  it("the registry accepts only configured names; paths, URLs and DSNs are INVALID_INPUT", async () => {
    const c = { name: "sample", type: "sqlite" as const, enabled: true, readOnly: true, databasePath: fx.dbPath };
    const reg = createDatabaseRegistry([c], { sqlite: createSqliteAdapterFactory<typeof c>() });
    for (const arg of [fx.dbPath, "/etc/passwd", "../sample.db", "file:sample.db", "sqlite:///tmp/x.db", ":memory:", "postgres://u:p@h/db"]) {
      expect(await code(reg.get(arg)), arg).toBe("INVALID_INPUT");
    }
    expect(await code(reg.get("unknown"))).toBe("NOT_FOUND");
    expect((await (await reg.get("sample")).listTables()).length).toBe(5);
    await reg.closeAll();
  });

  it("the adapter refuses special paths even if config were wrong (:memory:, file: URI, NUL, directory)", () => {
    for (const p of [":memory:", `file:${fx.dbPath}?mode=rw`, `${fx.dbPath}\u0000x`, fx.dir]) {
      expect(() => openSqliteReadOnly(p)).toThrowError(/could not be opened/);
    }
  });

  it("error messages never contain the database path", async () => {
    const attempts = [
      adapter.query("SELECT * FROM nope", opts),
      adapter.query("SELEC", opts),
      adapter.describeTable("nope"),
      adapter.explain("SELECT * FROM nope"),
    ];
    for (const p of attempts) {
      try {
        await p;
        throw new Error("expected rejection");
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        const msg = (e as AppError).message;
        expect(msg).not.toContain(fx.dir);
        expect(msg).not.toContain("sample.db");
      }
    }
  });
});
