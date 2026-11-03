import type { McpServer } from "@modelcontextprotocol/server";
import type { Config } from "../config/schema.js";
import type { AuditLog } from "../core/audit.js";
import type { Limits } from "../core/limits.js";
import type { Logger } from "../core/logger.js";
import type { Redactor } from "../core/redact.js";
import { AppError } from "../core/errors.js";
import { fail, ok, toMcpResult, type McpToolResult, type ToolResult } from "../core/response.js";
import { createDatabaseRegistry, type AdapterFactories } from "../integrations/database/database.registry.js";
import { registerDatabaseTools } from "../tools/database/index.js";
import { registerFilesystemTools } from "../tools/filesystem/index.js";
import { buildStatus, resolvePackState } from "./status.js";

export interface ServerDeps {
  config: Config;
  limits: Limits;
  logger: Logger;
  audit: AuditLog;
  redactor: Redactor;
  startedAtMs: number;
  /** Test seam: replaces the real adapter factories (for example a fake PostgreSQL pool). */
  databaseFactories?: AdapterFactories<DatabaseConnection>;
}

export type DatabaseConnection = Config["databases"][number];

/**
 * Drivers (better-sqlite3 native module, pg) are loaded on first use, not at server start:
 * a server without database connections never pays for them, and startup stays fast.
 */
function defaultDatabaseFactories(deps: ServerDeps): AdapterFactories<DatabaseConnection> {
  return {
    sqlite: async (c) => {
      const { createSqliteAdapterFactory } = await import("../integrations/database/sqlite.adapter.js");
      return createSqliteAdapterFactory<DatabaseConnection>({ maxCellChars: deps.limits.maxCellChars })(c);
    },
    postgres: async (c) => {
      if (c.type !== "postgres") throw new AppError("INTEGRATION_UNAVAILABLE", "Database connection could not be opened.");
      const { createPostgresAdapter } = await import("../integrations/database/postgres.adapter.js");
      return createPostgresAdapter(c, {
        maxCellChars: deps.limits.maxCellChars,
        defaultTimeoutMs: deps.limits.dbQueryTimeoutMs,
        logger: deps.logger,
      });
    },
  };
}

/** Run a handler: time it, audit metadata only, map to MCP. Never throws. */
export async function runTool(
  deps: ServerDeps,
  tool: string,
  integration: string,
  handler: () => Promise<ToolResult> | ToolResult,
  resourceRef?: string,
): Promise<McpToolResult> {
  const t0 = Date.now();
  let result: ToolResult;
  try {
    result = await handler();
  } catch (err) {
    deps.logger.error("tool failed", { tool, error: err instanceof Error ? err.message : "unknown" });
    result = fail(err);
  }
  deps.audit.record({
    tool,
    integration,
    ...(resourceRef !== undefined ? { resourceRef } : {}),
    outcome: result.success ? "success" : "error",
    ...(!result.success ? { errorCode: result.error.code } : {}),
    durationMs: Date.now() - t0,
    write: false,
  });
  return toMcpResult(result, deps.redactor, deps.limits.maxResponseBytes);
}

/**
 * Registers tools. A disabled pack's tools are NOT registered (doc 03 §4).
 * Pack registrars are added by later tasks (P1+) inside the matching `if`.
 */
export function registerTools(server: McpServer, deps: ServerDeps): string[] {
  const registered: string[] = [];

  server.registerTool(
    "server_get_status",
    {
      title: "Server status",
      description:
        "Read-only. Returns server name and version, protocol info, which capability packs are enabled, whether writes are allowed, uptime and the active limits. Takes no input. Never returns paths, secrets or config contents.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () =>
      runTool(deps, "server_get_status", "server", () =>
        ok(
          buildStatus({ config: deps.config, limits: deps.limits, startedAtMs: deps.startedAtMs }),
          { source: "server" },
        ),
      ),
  );
  registered.push("server_get_status");

  const packs = resolvePackState(deps.config);
  if (packs.database) {
    const registry = createDatabaseRegistry<DatabaseConnection>(
      deps.config.databases,
      deps.databaseFactories ?? defaultDatabaseFactories(deps),
    );
    registered.push(...registerDatabaseTools(server, deps, registry, runTool));
    // Release connections when the transport closes (best effort; never throws).
    const previous = server.server.onclose;
    server.server.onclose = () => {
      previous?.();
      registry.closeAll().catch(() => undefined);
    };
  }
  if (packs.filesystem) {
    registered.push(...registerFilesystemTools(server, deps, runTool));
  }
  if (packs.github) {
    // P3: registerGithubTools(server, deps)
  }
  if (packs.customApi) {
    // P4: registerCustomApiTools(server, deps)
  }
  if (packs.workflows) {
    // P5: registerWorkflowTools(server, deps)
  }
  return registered;
}
