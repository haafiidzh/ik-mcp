import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "../../config/schema.js";
import { createFilesystemService, type FilesystemService } from "../../integrations/filesystem/filesystem.service.js";
import { fitToBudget, type McpToolResult, type ToolResult } from "../../core/response.js";
import type { ServerDeps } from "../../server/register-tools.js";

/** What every fs_* tool needs: shared deps, the lazily built service and a safe audit reference. */
export interface FsToolContext {
  server: McpServer;
  deps: ServerDeps;
  service(): Promise<FilesystemService>;
  run(tool: string, workspace: string, fn: (svc: FilesystemService) => Promise<ToolResult>): Promise<McpToolResult>;
}

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Shared input fields. Strings are bounded; numeric caps are enforced by the service (clamped, reported in meta). */
export const workspaceField = z.string().min(1).max(64).describe("Workspace id from the server configuration (not a path).");
export const optionalPathField = z
  .string()
  .max(1024)
  .optional()
  .describe("Path relative to the workspace root. Defaults to the root (.). Absolute paths and .. are rejected.");
export const requiredPathField = z
  .string()
  .min(1)
  .max(1024)
  .describe("Path relative to the workspace root. Absolute paths and .. are rejected.");
export const limitField = z.number().int().min(1).optional();

export function buildFsContext(
  server: McpServer,
  deps: ServerDeps,
  runTool: (
    deps: ServerDeps,
    tool: string,
    integration: string,
    handler: () => Promise<ToolResult> | ToolResult,
    resourceRef?: string,
  ) => Promise<McpToolResult>,
): FsToolContext {
  const config: Config = deps.config;
  let pending: Promise<FilesystemService> | undefined;
  const service = (): Promise<FilesystemService> => {
    pending ??= createFilesystemService({
      workspaces: config.workspaces.map((w) => ({ id: w.id, rootPath: w.rootPath })),
      blockedNames: config.filesystem.blockedNames,
      unblock: config.filesystem.unblock,
      ignoreDirs: config.filesystem.ignoreDirs,
      allowedExtensions: config.filesystem.allowedExtensions,
      limits: { ...deps.limits, maxFileBytes: Math.min(deps.limits.maxFileBytes, config.filesystem.maxFileBytes) },
      searchTimeoutMs: deps.limits.workflowTimeoutMs,
    });
    return pending;
  };
  const known = new Set(config.workspaces.map((w) => w.id));
  return {
    server,
    deps,
    service,
    run: (tool, workspace, fn) =>
      runTool(
        deps,
        tool,
        "filesystem",
        async () => fitToBudget(await fn(await service()), deps.limits.maxResponseBytes),
        known.has(workspace) ? workspace : "unknown-workspace",
      ),
  };
}
