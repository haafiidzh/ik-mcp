import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { fitToBudget, type McpToolResult, type ToolResult } from "../../core/response.js";
import type { DatabaseRegistry } from "../../integrations/database/database.registry.js";
import type { DatabaseAdapter, DatabaseDialect } from "../../integrations/database/database.types.js";
import type { ServerDeps } from "../../server/register-tools.js";

export type RunTool = (
  deps: ServerDeps,
  tool: string,
  integration: string,
  handler: () => Promise<ToolResult> | ToolResult,
  resourceRef?: string,
) => Promise<McpToolResult>;

/** Handed to tool bodies: the connection is validated; the adapter is opened only when asked for (after SQL validation). */
export interface DbHandle {
  dialect: DatabaseDialect;
  adapter(): Promise<DatabaseAdapter>;
}

/** What every db_* tool needs: shared deps, the registry and a safe audit reference (connection name only). */
export interface DbToolContext {
  server: McpServer;
  deps: ServerDeps;
  registry: DatabaseRegistry;
  /** Run `fn` with the adapter of a configured, enabled connection. Audit resourceRef = that name or "unknown-connection". */
  run(
    tool: string,
    connection: string,
    fn: (handle: DbHandle) => Promise<ToolResult>,
  ): Promise<McpToolResult>;
  /** Run a tool that takes no connection (no audit resourceRef). */
  plain(tool: string, fn: () => ToolResult): Promise<McpToolResult>;
}

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * Bounded but lenient: the registry decides whether the value is a configured name
 * (anything else, such as a URL, DSN or path, is INVALID_INPUT there).
 */
export const connectionField = z
  .string()
  .min(1)
  .max(2048)
  .describe("Name of a configured database connection (see db_list_connections). Connection strings, URLs and paths are rejected.");
export const schemaField = z.string().min(1).max(128).optional().describe("Schema name. Optional. Must be configured for the connection.");

export function buildDbContext(server: McpServer, deps: ServerDeps, registry: DatabaseRegistry, runTool: RunTool): DbToolContext {
  const known = new Set(registry.names());
  return {
    server,
    deps,
    registry,
    plain: (tool, fn) => runTool(deps, tool, "database", fn),
    run: (tool, connection, fn) =>
      runTool(
        deps,
        tool,
        "database",
        async () => {
          const dialect = registry.dialectOf(connection); // NOT_FOUND / INVALID_INPUT before anything else
          return fitToBudget(await fn({ dialect, adapter: () => registry.get(connection) }), deps.limits.maxResponseBytes);
        },
        known.has(connection) ? connection : "unknown-connection",
      ),
  };
}
