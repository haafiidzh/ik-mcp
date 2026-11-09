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
import type { FetchLike } from "../integrations/github/github.client.js";
import { registerFilesystemTools } from "../tools/filesystem/index.js";
import { registerGithubTools } from "../tools/github/index.js";
import { registerCustomApiTools } from "../tools/custom-api/index.js";
import type { ResolveFn } from "../integrations/custom-api/url-guard.js";
import { registerWorkflowTools } from "../tools/workflows/index.js";
import { createSharedServices, type SharedServices } from "./shared-services.js";
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
  /**
   * Test seams for the GitHub pack. Set only by code that builds ServerDeps (tests); never from
   * config or tool input. Production (`src/index.ts`) leaves both unset: global fetch to the fixed
   * https://api.github.com and real process.env.
   */
  githubFetch?: FetchLike;
  githubGetEnv?: (name: string) => string | undefined;
  /**
   * Test seams for the Custom API pack (same rules as the GitHub seams: set only by code that builds
   * ServerDeps, never from config or tool input). `apiResolve` replaces DNS (the answer is still
   * SSRF-checked and then pinned); `apiGetEnv` replaces process.env for auth variables.
   */
  apiResolve?: ResolveFn;
  apiGetEnv?: (name: string) => string | undefined;
  /** P5-05: service instances shared by pack tools and workflow tools. Set by registerTools only. */
  shared?: SharedServices;
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
  /** P4-03: evaluated after the handler; must derive write-ness from CONFIG (never from tool input). */
  isWriteAttempt?: () => boolean,
): Promise<McpToolResult> {
  const t0 = Date.now();
  let result: ToolResult;
  try {
    result = await handler();
  } catch (err) {
    deps.logger.error("tool failed", { tool, error: err instanceof Error ? err.message : "unknown" });
    result = fail(err);
  }
  let write = false;
  try {
    write = isWriteAttempt?.() === true;
  } catch {
    write = false;
  }
  deps.audit.record({
    tool,
    integration,
    ...(resourceRef !== undefined ? { resourceRef } : {}),
    outcome: result.success ? "success" : "error",
    ...(!result.success ? { errorCode: result.error.code } : {}),
    durationMs: Date.now() - t0,
    write,
  });
  return toMcpResult(result, deps.redactor, deps.limits.maxResponseBytes);
}

/**
 * Registers tools. A disabled pack's tools are NOT registered (doc 03 §4).
 * Pack registrars are added by later tasks (P1+) inside the matching `if`.
 */
export function registerTools(server: McpServer, baseDeps: ServerDeps): string[] {
  baseDeps.shared ??= createSharedServices(baseDeps); // also visible to registerResources (P6-01)
  const deps: ServerDeps = { ...baseDeps, shared: baseDeps.shared };
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
  let registry: ReturnType<typeof createDatabaseRegistry<DatabaseConnection>> | undefined;
  if (packs.database) {
    registry = createDatabaseRegistry<DatabaseConnection>(
      deps.config.databases,
      deps.databaseFactories ?? defaultDatabaseFactories(deps),
    );
    const reg = registry;
    if (deps.shared !== undefined) deps.shared.databaseRegistry = registry;
    registered.push(...registerDatabaseTools(server, deps, registry, runTool));
    // Release connections when the transport closes (best effort; never throws).
    const previous = server.server.onclose;
    server.server.onclose = () => {
      previous?.();
      reg.closeAll().catch(() => undefined);
    };
  }
  if (packs.filesystem) {
    registered.push(...registerFilesystemTools(server, deps, runTool));
  }
  if (packs.github) {
    if (deps.config.github.allowedRepositories.length === 0 && deps.config.github.allowedOwners.length === 0) {
      deps.logger.warn("github is enabled but no allowlist is configured (allowedRepositories/allowedOwners); all github tools will return PERMISSION_DENIED");
    }
    registered.push(...registerGithubTools(server, deps, runTool));
  }
  if (packs.customApi) {
    registered.push(...registerCustomApiTools(server, deps, runTool));
  }
  // Phase 5 composite tools: each is registered only when its required packs are enabled (doc 04 §5).
  registered.push(...registerWorkflowTools(server, deps, runTool, packs, registry));
  return registered;
}
