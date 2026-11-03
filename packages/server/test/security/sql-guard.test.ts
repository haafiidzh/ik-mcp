import { describe, expect, it } from "vitest";
import { AppError } from "../../src/core/errors.js";
import type { DatabaseDialect } from "../../src/integrations/database/database.types.js";
import { assertReadOnlySql, buildExplainSql, MAX_SQL_CHARS, wrapWithRowCap } from "../../src/integrations/database/sql-guard.js";

const DIALECTS: DatabaseDialect[] = ["sqlite", "postgres"];

function outcome(sql: unknown, dialect: DatabaseDialect): { code: string; message: string } | "ok" {
  try {
    assertReadOnlySql(sql, { dialect });
  } catch (e) {
    if (e instanceof AppError) return { code: e.code, message: e.message };
    throw e;
  }
  return "ok";
}

const REJECTED: string[] = [
  // doc 05 S8 examples
  "INSERT INTO t VALUES (1)",
  "UPDATE t SET a = 1",
  "DELETE FROM t",
  "DROP TABLE t",
  "CREATE TABLE t (a int)",
  "SELECT 1; DROP TABLE t",
  "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x",
  "ATTACH DATABASE '/tmp/other.db' AS o",
  "PRAGMA table_info(t)",
  "PRAGMA writable_schema = 1",
  "SELECT * FROM t FOR UPDATE",
  "SELECT * FROM t FOR SHARE",
  "EXPLAIN ANALYZE DELETE FROM t",
  "EXPLAIN SELECT 1",
  // other write / admin statements
  "REPLACE INTO t VALUES (1)",
  "INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING",
  "MERGE INTO t USING s ON 1=1 WHEN MATCHED THEN DELETE",
  "ALTER TABLE t ADD COLUMN b int",
  "TRUNCATE t",
  "SELECT * INTO u FROM t",
  "COPY t TO '/tmp/x'",
  "CALL f()",
  "DO $$ begin end $$",
  "SET search_path = x",
  "VACUUM",
  "DETACH DATABASE o",
  "LOAD 'x'",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x",
  "WITH x AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM x",
  // dangerous functions inside an otherwise valid SELECT
  "SELECT load_extension('x')",
  "SELECT * FROM (SELECT load_extension('x')) a",
  "SELECT readfile('/etc/passwd')",
  "SELECT pg_read_file('/etc/passwd')",
  "SELECT pg_catalog.pg_read_file('/etc/passwd')",
  "SELECT lo_import('/etc/passwd')",
  "SELECT nextval('s')",
  "SELECT set_config('a', 'b', false)",
  "SELECT query_to_xml('delete from t', true, true, '')",
  // multi-statement variants
  "SELECT 1; SELECT 2",
  "SELECT 1;\nDELETE FROM t",
  "SELECT 1; -- c\nDROP TABLE t",
  // case / whitespace / comment tricks
  "dElEtE FrOm t",
  "  \n\t drop   table t",
  "/* c */ DELETE FROM t",
  "-- c\nDELETE FROM t",
  "DEL/**/ETE FROM t",
  "SELECT 1 /* ; DROP TABLE t",
  "SELECT 1 -- x\n; DROP TABLE t",
  // unicode / control tricks
  "ＤＥＬＥＴＥ FROM t",
  "SELECT 1\u0000; DROP TABLE t",
  "SELECT 1\u0007",
  "DELETE\u00a0FROM t",
  "DELETE\u200bFROM t",
  // parser/engine disagreement tricks (lexical pass)
  "SELECT '\\'; DROP TABLE t; --'",
  "SELECT 1 WHERE x = 'a\\'; DROP TABLE t; --'",
  "SELECT E'\\'; DROP TABLE t; --'",
  "SELECT $$;DROP TABLE t;--$$",
  "SELECT $q$;DROP TABLE t;$q$",
  "SELECT /* a /* b */ ; DROP TABLE t; */ 1",
  "SELECT 1 /*! ; DROP TABLE t */",
  "SELECT 1 ;; DROP TABLE t",
  "SELECT 1; SELECT 2;",
  // fail closed
  "SELEC 1",
  "SELECT FROM WHERE",
  "SELECT (1",
  "'; DROP TABLE t; --",
  "VALUES (1); DROP TABLE t",
  "VALUES (1) ORDER BY 1",
  "VALUES (abs(1))",
  "VALUES (1",
  "VALUES",
  "VALUES (1) /* open",
];

describe("S8 sql-guard rejects non-read SQL (both dialects)", () => {
  for (const dialect of DIALECTS) {
    it.each(REJECTED)(`${dialect}: rejects %j`, (sql) => {
      const r = outcome(sql, dialect);
      expect(r).not.toBe("ok");
      if (r !== "ok") {
        expect(r.code).toBe("QUERY_REJECTED");
        // SQL text is never echoed back.
        expect(r.message).not.toContain("passwd");
        expect(r.message).not.toContain("DROP");
      }
    });
  }

  it("rejects an overlong statement without parsing it", () => {
    for (const dialect of DIALECTS) {
      const r = outcome(`SELECT ${"1,".repeat(MAX_SQL_CHARS)}1`, dialect);
      expect(r).toMatchObject({ code: "QUERY_REJECTED" });
    }
  });

  it("honours a tighter maxChars option", () => {
    expect(() => assertReadOnlySql("SELECT 1, 2, 3", { dialect: "sqlite", maxChars: 5 })).toThrow(/longer than 5/);
  });

  it("rejects empty and non-string input as INVALID_INPUT", () => {
    for (const bad of ["", "   \n", 5, null, undefined, { sql: "SELECT 1" }]) {
      expect(outcome(bad, "sqlite")).toMatchObject({ code: "INVALID_INPUT" });
    }
  });
});

describe("S8 sql-guard accepts read-only SQL", () => {
  const ACCEPTED = [
    "SELECT 1",
    "select 1;",
    "SELECT * FROM t WHERE a = 1 ORDER BY a LIMIT 5",
    "SELECT a, count(*) FROM t GROUP BY a HAVING count(*) > 1",
    "SELECT a FROM t UNION SELECT b FROM u",
    "SELECT t.a, u.b FROM t JOIN u ON u.id = t.id",
    "SELECT * FROM t WHERE name = 'DROP TABLE t; --'",
    "SELECT 'a;b' AS x",
    "SELECT 1 AS \"delete\"",
    "WITH x AS (SELECT 1 AS a) SELECT * FROM x",
    "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 5) SELECT n FROM c",
    "SELECT * FROM (SELECT 1 AS a) AS s",
    "/* leading comment */ SELECT 1",
    "-- leading comment\nSELECT 1",
    "SELECT 1 -- trailing comment",
    "  \n SELECT\t1  \n",
    "SELECT 'héllo wörld ✓' AS s",
    "VALUES (1, 'a'), (2, 'b')",
    "values (1), (-2.5), (NULL), (true), ('it''s')",
    "VALUES (1);",
    "/* c */ VALUES (1)",
  ];
  for (const dialect of DIALECTS) {
    it.each(ACCEPTED)(`${dialect}: accepts %j`, (sql) => {
      expect(outcome(sql, dialect)).toBe("ok");
    });
  }

  it("accepts postgres-only syntax on postgres", () => {
    expect(outcome("SELECT now()::date, pg_sleep(0)", "postgres")).toBe("ok");
  });
});

describe("row cap wrapper and EXPLAIN builder", () => {
  it("wraps in a subselect with the limit, newline-separated so comments cannot swallow it", () => {
    for (const dialect of DIALECTS) {
      const v = assertReadOnlySql("SELECT a FROM t -- note", { dialect });
      const w = wrapWithRowCap(v, 101);
      expect(w).toBe("SELECT * FROM (\nSELECT a FROM t -- note\n) AS _dw LIMIT 101");
    }
  });
  it("drops one trailing semicolon and wraps VALUES", () => {
    const v = assertReadOnlySql("VALUES (1),(2);", { dialect: "sqlite" });
    expect(wrapWithRowCap(v, 3)).toBe("SELECT * FROM (\nVALUES (1),(2)\n) AS _dw LIMIT 3");
    const s = assertReadOnlySql("SELECT 1;", { dialect: "postgres" });
    expect(wrapWithRowCap(s, 3)).toBe("SELECT * FROM (\nSELECT 1\n) AS _dw LIMIT 3");
  });
  it("rejects a statement whose wrapped form is not one safe SELECT", () => {
    const v = assertReadOnlySql("SELECT 1; -- c", { dialect: "sqlite" });
    expect(() => wrapWithRowCap(v, 5)).toThrow(AppError);
  });
  it("rejects invalid limits", () => {
    const v = assertReadOnlySql("SELECT 1", { dialect: "sqlite" });
    for (const n of [0, -1, 1.5, Number.NaN]) expect(() => wrapWithRowCap(v, n)).toThrow(/positive integer/);
  });
  it("builds plain EXPLAIN / EXPLAIN QUERY PLAN, never ANALYZE", () => {
    const pg = buildExplainSql(assertReadOnlySql("SELECT * FROM t;", { dialect: "postgres" }));
    const lite = buildExplainSql(assertReadOnlySql("SELECT * FROM t", { dialect: "sqlite" }));
    expect(pg).toBe("EXPLAIN\nSELECT * FROM t");
    expect(lite).toBe("EXPLAIN QUERY PLAN\nSELECT * FROM t");
    expect(`${pg}${lite}`).not.toMatch(/analyze/i);
  });
  it("cannot build EXPLAIN for input the guard rejected (ANALYZE never reachable)", () => {
    expect(() => assertReadOnlySql("EXPLAIN ANALYZE SELECT 1", { dialect: "postgres" })).toThrow(AppError);
  });
});
