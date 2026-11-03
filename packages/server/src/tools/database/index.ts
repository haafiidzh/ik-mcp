import type { McpServer } from "@modelcontextprotocol/server";
import type { DatabaseRegistry } from "../../integrations/database/database.registry.js";
import type { ServerDeps } from "../../server/register-tools.js";
import { registerDbCatalogTools } from "./db-catalog.js";
import { registerDbListConnections } from "./db-list-connections.js";
import { registerDbQueryTools } from "./db-query.js";
import { buildDbContext, type RunTool } from "./shared.js";

/** Registers the six read-only db_* tools. Call only when the database pack is enabled. */
export function registerDatabaseTools(server: McpServer, deps: ServerDeps, registry: DatabaseRegistry, runTool: RunTool): string[] {
  const ctx = buildDbContext(server, deps, registry, runTool);
  registerDbListConnections(ctx);
  registerDbCatalogTools(ctx);
  registerDbQueryTools(ctx);
  return [
    "db_list_connections",
    "db_list_tables",
    "db_describe_table",
    "db_list_relationships",
    "db_execute_readonly_query",
    "db_explain_query",
  ];
}
