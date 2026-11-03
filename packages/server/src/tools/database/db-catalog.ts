import { z } from "zod";
import { ok } from "../../core/response.js";
import type { CatalogPage } from "../../integrations/database/database.types.js";
import { connectionField, READ_ONLY_ANNOTATIONS, schemaField, type DbToolContext } from "./shared.js";

/** Slice a bounded catalog page to the maxResults limit and report truncation in meta (doc 03 section 5). */
function pageResult<T>(ctx: DbToolContext, page: CatalogPage<T>, what: string) {
  const limit = ctx.deps.limits.maxResults;
  const items = page.items.slice(0, limit);
  const truncated = page.truncated || page.items.length > limit;
  return ok(
    items,
    { source: "database", returnedCount: items.length, truncated, partial: truncated, limit },
    truncated ? [`The ${what} list was truncated; narrow it with the schema argument if available.`] : [],
  );
}

export function registerDbCatalogTools(ctx: DbToolContext): void {
  ctx.server.registerTool(
    "db_list_tables",
    {
      title: "List tables",
      description:
        "Read-only. Lists tables and views of one configured database connection (schema, name, kind). Required: connection (a configured name). Optional: schema (must be configured for PostgreSQL; SQLite has only main). Results are capped and truncation is reported in meta.",
      inputSchema: z.strictObject({ connection: connectionField, schema: schemaField }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (a) =>
      ctx.run("db_list_tables", a.connection, async (h) =>
        pageResult(ctx, await (await h.adapter()).listTablesPage(a.schema !== undefined ? { schema: a.schema } : {}), "table"),
      ),
  );

  ctx.server.registerTool(
    "db_describe_table",
    {
      title: "Describe table",
      description:
        "Read-only. Describes one table or view: columns (name, type, nullable, default), primary key and foreign keys. Required: connection, table (looked up in the catalog, never interpolated). Optional: schema.",
      inputSchema: z.strictObject({
        connection: connectionField,
        table: z.string().min(1).max(256).describe("Table or view name as listed by db_list_tables."),
        schema: schemaField,
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (a) =>
      ctx.run("db_describe_table", a.connection, async (h) =>
        ok(await (await h.adapter()).describeTable(a.table, a.schema !== undefined ? { schema: a.schema } : {}), { source: "database" }),
      ),
  );

  ctx.server.registerTool(
    "db_list_relationships",
    {
      title: "List relationships",
      description:
        "Read-only. Lists foreign-key relationships of one configured connection (fromTable, fromColumns, toTable, toColumns, name). Required: connection. Optional: schema. Results are capped and truncation is reported in meta.",
      inputSchema: z.strictObject({ connection: connectionField, schema: schemaField }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (a) =>
      ctx.run("db_list_relationships", a.connection, async (h) =>
        pageResult(ctx, await (await h.adapter()).listRelationshipsPage(a.schema !== undefined ? { schema: a.schema } : {}), "relationship"),
      ),
  );
}
