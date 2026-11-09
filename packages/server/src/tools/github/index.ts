import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerDeps } from "../../server/register-tools.js";
import { registerGhCommitTools } from "./gh-commits.js";
import { registerGhIssueTools } from "./gh-issues.js";
import { registerGhPullTools } from "./gh-pulls.js";
import { registerGhRepoTools } from "./gh-repos.js";
import { buildGhContext, type RunTool } from "./shared.js";

/** Registers the eight read-only github_* tools. Call only when the GitHub pack is enabled. No write tools (ADR-059). */
export function registerGithubTools(server: McpServer, deps: ServerDeps, runTool: RunTool): string[] {
  const ctx = buildGhContext(server, deps, runTool);
  registerGhRepoTools(ctx);
  registerGhIssueTools(ctx);
  registerGhPullTools(ctx);
  registerGhCommitTools(ctx);
  return [
    "github_list_repositories",
    "github_get_repository",
    "github_list_issues",
    "github_get_issue",
    "github_list_pull_requests",
    "github_get_pull_request",
    "github_list_commits",
    "github_get_commit",
  ];
}
