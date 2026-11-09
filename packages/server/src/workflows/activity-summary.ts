import { AppError } from "../core/errors.js";
import type { Redactor } from "../core/redact.js";
import type { GithubOutcome } from "../integrations/github/github.service.js";
import type { GithubCommit, GithubIssue, GithubIssueState, GithubPullRequest } from "../integrations/github/github.types.js";
import { githubSource, githubNoRepoSource } from "./source-ref.js";
import { runSections, sectionOutput, type SectionSpec, type WorkflowResult } from "./workflow-core.js";

/**
 * workspace_summarize_activity (doc 04 sections 5/6): the last N open issues, open pull requests
 * and commits on the default branch of the workspace's linked repository, with counts by state.
 * No ranking, no judgment: items keep the order the service returned them in (GitHub default:
 * most recently updated first). Calls the GitHub service only; its allowlist applies.
 */

export interface ActivityGithubPort {
  listIssues(owner: string, repo: string, args: { limit?: number | undefined; state?: GithubIssueState | undefined }): Promise<GithubOutcome<GithubIssue[]>>;
  listPullRequests(owner: string, repo: string, args: { limit?: number | undefined; state?: GithubIssueState | undefined }): Promise<GithubOutcome<GithubPullRequest[]>>;
  listCommits(owner: string, repo: string, args: { limit?: number | undefined; branch?: string | undefined }): Promise<GithubOutcome<GithubCommit[]>>;
}

export interface ActivityWorkspaceLink {
  id: string;
  github?: string | undefined;
}

export interface ActivityDeps {
  workspaces: readonly ActivityWorkspaceLink[];
  /** Absent when the GitHub pack is disabled: every section reports "disabled". */
  github?: ActivityGithubPort | undefined;
  redactor?: Redactor | undefined;
  deadlineMs?: number | undefined;
  /** Upper bound for N (use limits.maxResults). */
  maxItems?: number | undefined;
  maxSnippetChars?: number | undefined;
}

export const DEFAULT_ACTIVITY_ITEMS = 10;

function clip(text: string, max: number): string {
  const cp = [...text];
  return cp.length > max ? cp.slice(0, max).join("") : text;
}

function firstLine(text: string): string {
  const i = text.search(/\r|\n/);
  return i < 0 ? text : text.slice(0, i);
}

export function resolveCount(requested: number | undefined, max: number): number {
  const n = requested === undefined ? DEFAULT_ACTIVITY_ITEMS : Math.floor(requested);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_ACTIVITY_ITEMS;
  return Math.min(n, max);
}

export async function summarizeActivity(
  deps: ActivityDeps,
  workspaceId: string,
  requestedCount?: number,
  signal?: AbortSignal,
): Promise<WorkflowResult> {
  const ws = deps.workspaces.find((w) => w.id === workspaceId);
  if (ws === undefined) throw new AppError("NOT_FOUND", "Unknown workspace. Use a workspace id from the server configuration.");
  const maxItems = Math.max(1, deps.maxItems ?? 100);
  const n = resolveCount(requestedCount, maxItems);
  const maxText = deps.maxSnippetChars ?? 300;
  const i = ws.github?.indexOf("/") ?? -1;
  const link = ws.github !== undefined && i > 0 && i < ws.github.length - 1 ? { owner: ws.github.slice(0, i), repo: ws.github.slice(i + 1) } : undefined;
  const source = link !== undefined ? githubSource(link.owner, link.repo) : githubNoRepoSource();
  const gh = deps.github;
  const availability: SectionSpec["availability"] =
    gh === undefined
      ? { state: "disabled", reason: "The GitHub pack is not enabled." }
      : link === undefined
        ? { state: "unavailable", reason: "No GitHub repository is linked to this workspace." }
        : { state: "enabled" };

  const make = (id: string, title: string, run: (g: ActivityGithubPort, owner: string, repo: string) => Promise<unknown>): SectionSpec => ({
    id,
    title,
    source,
    availability,
    run: async () => {
      if (gh === undefined || link === undefined) return null;
      return run(gh, link.owner, link.repo);
    },
  });

  const specs: SectionSpec[] = [
    make("issues", "Open issues", async (g, owner, repo) => {
      const o = await g.listIssues(owner, repo, { limit: n, state: "open" });
      const items = o.data.slice(0, n).map((x) => ({
        number: x.number,
        title: clip(x.title, maxText),
        state: x.state,
        author: x.author,
        labels: x.labels.slice(0, 10),
        comments: x.commentsCount,
        updatedAt: x.updatedAt,
      }));
      return sectionOutput(
        { requested: n, items, counts: { byState: { open: items.length } }, moreAvailable: o.nextPageAvailable },
        { truncated: o.truncated || o.nextPageAvailable },
      );
    }),
    make("pull_requests", "Open pull requests", async (g, owner, repo) => {
      const o = await g.listPullRequests(owner, repo, { limit: n, state: "open" });
      const items = o.data.slice(0, n).map((x) => ({
        number: x.number,
        title: clip(x.title, maxText),
        state: x.state,
        draft: x.draft,
        author: x.author,
        headRef: x.headRef,
        baseRef: x.baseRef,
        updatedAt: x.updatedAt,
      }));
      const drafts = items.filter((x) => x.draft).length;
      return sectionOutput(
        { requested: n, items, counts: { byState: { open: items.length }, draft: drafts, ready: items.length - drafts }, moreAvailable: o.nextPageAvailable },
        { truncated: o.truncated || o.nextPageAvailable },
      );
    }),
    make("commits", "Recent commits on the default branch", async (g, owner, repo) => {
      // No branch argument: the service uses the repository's default branch.
      const o = await g.listCommits(owner, repo, { limit: n });
      const items = o.data.slice(0, n).map((x) => ({
        sha: x.sha.slice(0, 12),
        message: clip(firstLine(x.message), maxText),
        author: x.authorLogin ?? x.authorName,
        date: x.authorDate,
      }));
      return sectionOutput({ requested: n, items, counts: { returned: items.length }, moreAvailable: o.nextPageAvailable }, { truncated: o.truncated || o.nextPageAvailable });
    }),
  ];

  return runSections(specs, {
    ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}),
    ...(deps.redactor !== undefined ? { redactor: deps.redactor } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
}
