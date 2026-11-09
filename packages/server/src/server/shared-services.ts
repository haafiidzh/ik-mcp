import type { Config } from "../config/schema.js";
import { canWrite } from "../core/permissions.js";
import { createApiService, isWriteEndpoint, type ApiProfileConfig, type ApiService } from "../integrations/custom-api/api.service.js";
import { createFilesystemService, type FilesystemService } from "../integrations/filesystem/filesystem.service.js";
import { createGithubService, type GithubService } from "../integrations/github/github.service.js";
import type { DatabaseRegistry } from "../integrations/database/database.registry.js";
import type { ApiEndpointMeta, DataFlowApiPort } from "../workflows/data-flow.js";
import type { ServerDeps } from "./register-tools.js";

/**
 * One instance per server of each pack service, shared by the pack tools and the workflow tools
 * (no duplicate clients, no second token read, one set of allowlists and limits). All lazy and memoized.
 */
export interface SharedServices {
  fs(): Promise<FilesystemService>;
  github(): GithubService;
  api(): ApiService;
  /** Set by registerTools when the database pack is enabled; read by the resources (P6-01). */
  databaseRegistry?: DatabaseRegistry | undefined;
}

export function createSharedServices(deps: ServerDeps): SharedServices {
  const config: Config = deps.config;
  let fsPending: Promise<FilesystemService> | undefined;
  let gh: GithubService | undefined;
  let api: ApiService | undefined;
  return {
    fs() {
      fsPending ??= createFilesystemService({
        workspaces: config.workspaces.map((w) => ({ id: w.id, rootPath: w.rootPath })),
        blockedNames: config.filesystem.blockedNames,
        unblock: config.filesystem.unblock,
        ignoreDirs: config.filesystem.ignoreDirs,
        allowedExtensions: config.filesystem.allowedExtensions,
        limits: { ...deps.limits, maxFileBytes: Math.min(deps.limits.maxFileBytes, config.filesystem.maxFileBytes) },
        searchTimeoutMs: deps.limits.workflowTimeoutMs,
      });
      return fsPending;
    },
    github() {
      gh ??= createGithubService({
        config: config.github,
        limits: deps.limits,
        logger: deps.logger,
        ...(deps.githubFetch !== undefined ? { fetch: deps.githubFetch } : {}),
        ...(deps.githubGetEnv !== undefined ? { getEnv: deps.githubGetEnv } : {}),
      });
      return gh;
    },
    api() {
      api ??= createApiService({
        profiles: config.customApis as unknown as readonly ApiProfileConfig[],
        permissions: config.permissions,
        limits: deps.limits,
        ...(deps.apiResolve !== undefined ? { resolve: deps.apiResolve } : {}),
        ...(deps.apiGetEnv !== undefined ? { getEnv: deps.apiGetEnv } : {}),
      });
      return api;
    },
  };
}

/**
 * Endpoint metadata for the data-flow workflow, built from configuration only: no service call, no
 * base URL, no auth data. Undefined for unknown or disabled profiles. writeGated follows the same
 * rule as ApiService.getEndpointInfo (write endpoint that is not callable under the permissions).
 */
export function createDataFlowApiPort(config: Config): DataFlowApiPort {
  return {
    listEndpoints(profile: string): readonly ApiEndpointMeta[] | undefined {
      const p = config.customApis.find((a) => a.name === profile && a.enabled);
      if (p === undefined) return undefined;
      return p.endpoints.map((e) => {
        const write = isWriteEndpoint(e as unknown as { method: string; permission: "read" | "write" });
        const callable = !write || canWrite(config.permissions, `api:${p.name}/${e.name}`, true);
        return { name: e.name, method: e.method, path: e.path, permission: write ? "write" : "read", writeGated: write && !callable } as const;
      });
    },
  };
}
