import type { GithubOutcome } from "../../src/integrations/github/github.service.js";
import type { GithubIssue } from "../../src/integrations/github/github.types.js";
import type { IssueGithubPort } from "../../src/workflows/issue-context.js";

export function issue(over: Partial<GithubIssue> = {}): GithubIssue {
  return {
    number: 7,
    title: "Login fails in src/auth/login.ts",
    state: "open",
    body: "Calling `validateSession` throws. See `users` table. Also `.env` is mentioned.",
    author: "a",
    labels: ["bug"],
    assignees: [],
    commentsCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    closedAt: null,
    htmlUrl: "https://github.com/x/y/issues/7",
    isPullRequest: false,
    ...over,
  };
}

export function ghFake(i: GithubIssue | Error, calls: unknown[][] = []): IssueGithubPort {
  return {
    async getIssue(owner, repo, n) {
      calls.push([owner, repo, n]);
      if (i instanceof Error) throw i;
      const out: GithubOutcome<GithubIssue> = { data: i, nextPageAvailable: false, truncated: false, warnings: [] };
      return out;
    },
  };
}

