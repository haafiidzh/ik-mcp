import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError } from "../../src/core/errors.js";
import { createSqliteAdapter } from "../../src/integrations/database/sqlite.adapter.js";
import { makeSqliteFixture, type SqliteFixture } from "../fixtures/sqlite-fixture.js";

// P2-07 / QA-03 F1: query/explain run in a killable child process.
const RUNAWAY = "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n) SELECT count(*) FROM n";
let fx: SqliteFixture;

beforeAll(() => {
  fx = makeSqliteFixture();
});
afterAll(() => fx.cleanup());

const make = () => createSqliteAdapter({ name: "s", type: "sqlite", enabled: true, readOnly: true, databasePath: fx.dbPath });

describe("sqlite runner process", () => {
  it("preempts a runaway query, then serves the next one", async () => {
    const db = make();
    const t0 = Date.now();
    await expect(db.query(RUNAWAY, { maxRows: 10, timeoutMs: 300 })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(Date.now() - t0).toBeLessThan(2500);
    const r = await db.query("SELECT 1 AS one", { maxRows: 10, timeoutMs: 5000 });
    expect(r.rows).toEqual([[1]]);
    await db.close();
  }, 20000);

  it("abort signal kills the runner and reports TIMEOUT", async () => {
    const db = make();
    const ac = new AbortController();
    const p = db.query(RUNAWAY, { maxRows: 10, timeoutMs: 60000, signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    await expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
    await db.close();
  }, 20000);

  it("close() mid-query rejects the pending call and later calls fail closed", async () => {
    const db = make();
    const p = db.query(RUNAWAY, { maxRows: 10, timeoutMs: 60000 });
    const settled = p.then(() => undefined, (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 400));
    await db.close();
    expect(await settled).toBeInstanceOf(AppError);
    await expect(db.query("SELECT 1", { maxRows: 1, timeoutMs: 1000 })).rejects.toBeInstanceOf(AppError);
  }, 20000);

  it("BigInt and binary cells survive the process boundary", async () => {
    const db = make();
    const r = await db.query("SELECT 9223372036854775807 AS big, x'0102' AS b", { maxRows: 1, timeoutMs: 5000 });
    expect(r.rows).toEqual([["9223372036854775807", "<binary 2 bytes>"]]);
    await db.close();
  }, 20000);
});
