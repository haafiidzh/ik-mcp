import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { fail, fitToBudget, ok, type McpToolResult, type ToolResult } from "../../core/response.js";
import { createGithubService, type GithubOutcome, type GithubService } from "../../integrations/github/github.service.js";
import type { ServerDeps } from "../../server/register-tools.js";

/** What every github_* tool needs: the lazily built service and a safe audit reference. */
export interface GhToolContext {
  server: McpServer;
  deps: ServerDeps;
  run<T>(tool: string, resourceRef: string | undefined, fn: (svc: GithubService) => Promise<GithubOutcome<T>>): Promise<McpToolResult>;
}

export type RunTool = (
  deps: ServerDeps,
  tool: string,
  integration: string,
  handler: () => Promise<ToolResult> | ToolResult,
  resourceRef?: string,
) => Promise<McpToolResult>;

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const NAME = /^[A-Za-z0-9_.-]+$/;
export const ownerField = z.string().min(1).max(100).regex(NAME).describe("Repository owner (user or organisation login).");
export const repoField = z.string().min(1).max(100).regex(NAME).describe("Repository name.");
export const limitField = z.number().int().min(1).optional().describe("Page size; clamped to the server maximum.");
export const pageField = z.number().int().min(1).max(1000).optional().describe("Page number (1-based).");
export const stateField = z.enum(["open", "closed", "all"]).optional();
export const numberField = z.number().int().min(1);

const SLUG = /^[A-Za-z0-9_.-]{1,100}$/;
/** owner/repo for the audit log only when both parts are well-formed; never tokens, bodies or URLs. */
export function repoRef(owner: string | undefined, repo?: string): string | undefined {
  if (owner === undefined || !SLUG.test(owner)) return undefined;
  if (repo === undefined) return owner;
  return SLUG.test(repo) ? `${owner}/${repo}` : undefined;
}

export function buildGhContext(server: McpServer, deps: ServerDeps, runTool: RunTool): GhToolContext {
  let service: GithubService | undefined;
  const get = (): GithubService => {
    if (deps.shared !== undefined) return deps.shared.github();
    service ??= createGithubService({
      config: deps.config.github,
      limits: deps.limits,
      logger: deps.logger,
      ...(deps.githubFetch !== undefined ? { fetch: deps.githubFetch } : {}),
      ...(deps.githubGetEnv !== undefined ? { getEnv: deps.githubGetEnv } : {}),
    });
    return service;
  };
  return {
    server,
    deps,
    run: (tool, resourceRef, fn) =>
      runTool(
        deps,
        tool,
        "github",
        async () => {
          try {
            const o = await fn(get());
            return fitToBudget(
              ok(
                o.data,
                {
                  source: "github",
                  nextPageAvailable: o.nextPageAvailable,
                  truncated: o.truncated,
                  ...(o.limit !== undefined ? { limit: o.limit } : {}),
                  ...(o.repository !== undefined ? { repository: o.repository } : {}),
                },
                o.warnings,
              ),
              deps.limits.maxResponseBytes,
            );
          } catch (err) {
            return fail(err);
          }
        },
        resourceRef,
      ),
  };
}
