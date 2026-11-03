import { z } from "zod";
import { ok } from "../../core/response.js";
import { assertReadOnlySql } from "../../integrations/database/sql-guard.js";
import { connectionField, READ_ONLY_ANNOTATIONS, type DbToolContext } from "./shared.js";

/** Transport-level bound only; the guard enforces MAX_SQL_CHARS with a QUERY_REJECTED error. */
const sqlField = z.string().min(1).max(100_000).describe("A single read-only SELECT statement (no semicolon-chained statements).");

export function registerDbQueryTools(ctx: DbToolContext): void {
  ctx.server.registerTool(
    "db_execute_readonly_query",
    {
      title: "Run read-only query",
      description:
        "Read-only. Runs one SELECT statement on a configured connection and returns columns, rows, rowCount and truncated. Required: connection, sql. Optional: maxRows (capped by the server maximum). Writes, DDL, PRAGMA, ATTACH, multiple statements and administrative commands are rejected (QUERY_REJECTED). Row, cell and time limits apply; truncation is reported in meta.",
      inputSchema: z.strictObject({
        connection: connectionField,
        sql: sqlField,
        maxRows: z.number().int().min(1).optional().describe("Maximum rows to return; clamped to the server maximum."),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (a) =>
      ctx.run("db_execute_readonly_query", a.connection, async (h) => {
        const cap = ctx.deps.limits.dbMaxRows;
        const maxRows = Math.min(a.maxRows ?? cap, cap);
        // Guard first (layer 1), then the adapter, which wraps/caps the unwrapped statement itself (layer 2).
        const validated = assertReadOnlySql(a.sql, { dialect: h.dialect });
        const adapter = await h.adapter();
        const r = await adapter.query(validated.statement, { maxRows, timeoutMs: ctx.deps.limits.dbQueryTimeoutMs });
        const warnings: string[] = [];
        if (a.maxRows !== undefined && a.maxRows > cap) warnings.push(`maxRows was clamped to the server maximum of ${cap}.`);
        if (r.truncated) warnings.push(`Result truncated at ${maxRows} rows.`);
        if (r.cellsTruncated) warnings.push(`Some cell values were cut at ${ctx.deps.limits.maxCellChars} characters.`);
        return ok(
          { columns: r.columns, rows: r.rows, rowCount: r.rowCount, truncated: r.truncated },
          {
            source: "database",
            returnedCount: r.rowCount,
            truncated: r.truncated || r.cellsTruncated,
            partial: r.truncated,
            rowsTruncated: r.truncated,
            cellsTruncated: r.cellsTruncated,
            limit: maxRows,
          },
          warnings,
        );
      }),
  );

  ctx.server.registerTool(
    "db_explain_query",
    {
      title: "Explain query",
      description:
        "Read-only. Returns the query plan of one SELECT statement (plain EXPLAIN or EXPLAIN QUERY PLAN; the query is never executed and ANALYZE is never used). Required: connection, sql. The same SQL restrictions as db_execute_readonly_query apply.",
      inputSchema: z.strictObject({ connection: connectionField, sql: sqlField }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (a) =>
      ctx.run("db_explain_query", a.connection, async (h) => {
        const validated = assertReadOnlySql(a.sql, { dialect: h.dialect });
        const adapter = await h.adapter();
        const r = await adapter.explain(validated.statement);
        return ok({ plan: r.plan }, { source: "database" });
      }),
  );
}
