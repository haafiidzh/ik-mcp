import { AppError } from "../core/errors.js";
import { ok } from "../core/response.js";
import { runResource, variable } from "./common.js";
import type { ResourceCtx } from "./index.js";

const MAX_DESCRIBED = 25;

/** database://{connectionName}/schema: tables, columns and relationships via the registry/adapter (read-only metadata). */
export function registerDatabaseResources({ server, deps, template }: ResourceCtx): string[] {
  const enabled = deps.config.databases.filter((d) => d.enabled).map((d) => d.name);
  server.registerResource(
    "database_schema",
    new template("database://{connectionName}/schema", {
      list: () => ({ resources: enabled.map((n) => ({ uri: `database://${n}/schema`, name: `${n} schema`, mimeType: "application/json" })) }),
    }),
    {
      title: "Database schema",
      description: "Read-only schema (tables, columns, keys, relationships) of a configured connection. Metadata only, no row data.",
      mimeType: "application/json",
    },
    (uri, vars) => {
      const raw = vars["connectionName"];
      const ref = typeof raw === "string" && enabled.includes(raw) ? raw : "unknown-connection";
      return runResource(deps, "database_schema", "database", ref, uri, async () => {
        const name = variable(vars, "connectionName");
        const registry = deps.shared?.databaseRegistry;
        if (registry === undefined) throw new AppError("INTEGRATION_DISABLED", "The database pack is not enabled.");
        const adapter = await registry.get(name); // rejects names that are not configured and enabled
        const limit = Math.min(deps.limits.maxResults, MAX_DESCRIBED);
        const tables = await adapter.listTablesPage();
        const chosen = tables.items.slice(0, limit);
        const described = [];
        for (const t of chosen) described.push(await adapter.describeTable(t.name, t.schema !== null ? { schema: t.schema } : {}));
        const rel = await adapter.listRelationshipsPage();
        const relationships = rel.items.slice(0, deps.limits.maxResults);
        const truncated = tables.truncated || tables.items.length > chosen.length || rel.truncated || rel.items.length > relationships.length;
        return ok(
          {
            connection: name,
            dialect: registry.dialectOf(name),
            tables: described.map((d, i) => ({ ...d, kind: chosen[i]?.kind ?? "table" })),
            tableNames: tables.items.map((t) => (t.schema !== null ? `${t.schema}.${t.name}` : t.name)).slice(0, deps.limits.maxResults),
            relationships,
          },
          { source: "resource:database_schema", returnedCount: described.length, truncated, partial: truncated, limit },
        );
      });
    },
  );
  return ["database_schema"];
}
