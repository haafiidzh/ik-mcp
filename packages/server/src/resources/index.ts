import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";
import type { ServerDeps } from "../server/register-tools.js";
import { createSharedServices } from "../server/shared-services.js";
import { resolvePackState } from "../server/status.js";
import { registerDatabaseResources } from "./database.js";
import { registerFilesystemResources } from "./filesystem.js";
import { registerGithubResources } from "./github.js";
import { registerWorkspaceResources } from "./workspace.js";

export interface ResourceCtx {
  server: McpServer;
  deps: ServerDeps;
  template: typeof ResourceTemplate;
}

/**
 * Phase 6 resources (doc 04 section 7). Read-only, derived from configuration and the same pack
 * services as the tools. A resource of a disabled pack is NOT registered. URIs never carry paths,
 * hosts or connection strings; template variables are checked against configuration by the service
 * or by an explicit lookup. Returns the registered resource names.
 */
export function registerResources(server: McpServer, baseDeps: ServerDeps): string[] {
  const deps: ServerDeps = { ...baseDeps, shared: baseDeps.shared ?? createSharedServices(baseDeps) };
  const packs = resolvePackState(deps.config);
  const ctx: ResourceCtx = { server, deps, template: ResourceTemplate };
  const names: string[] = [];
  if (deps.config.workspaces.length > 0 && (packs.filesystem || packs.github || packs.database || packs.customApi)) {
    names.push(...registerWorkspaceResources(ctx, packs));
  }
  if (packs.filesystem) names.push(...registerFilesystemResources(ctx));
  if (packs.github) names.push(...registerGithubResources(ctx));
  if (packs.database) names.push(...registerDatabaseResources(ctx));
  return names;
}
