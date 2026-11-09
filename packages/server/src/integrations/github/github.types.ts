/**
 * GitHub pack contracts (doc 04 section B). MCP-free. Raw schemas validate the
 * upstream JSON at the boundary (zod, unknown keys stripped); the client maps
 * them to the small camelCase shapes below. Request bodies are never modelled:
 * P3-01 has no write methods (ADR-059).
 */
import { z } from "zod";

const str = z.string();
const nullableStr = z.string().nullish();
const count = z.number().int().nonnegative();
const user = z.object({ login: str }).nullish();

export const rawRepoSchema = z.object({
  name: str,
  full_name: str,
  owner: z.object({ login: str }),
  description: nullableStr,
  private: z.boolean(),
  visibility: z.string().optional(),
  default_branch: str,
  topics: z.array(str).optional(),
  stargazers_count: count.optional(),
  forks_count: count.optional(),
  open_issues_count: count.optional(),
  language: nullableStr,
  archived: z.boolean().optional(),
  pushed_at: nullableStr,
  html_url: str,
});

export const rawIssueSchema = z.object({
  number: z.number().int().positive(),
  title: str,
  state: str,
  body: nullableStr,
  user,
  labels: z.array(z.union([str, z.object({ name: z.string().nullish() })])).default([]),
  assignees: z.array(z.object({ login: str })).nullish(),
  comments: count.optional(),
  created_at: str,
  updated_at: str,
  closed_at: nullableStr,
  html_url: str,
  /** Present (any object) only when the "issue" is a pull request. */
  pull_request: z.unknown().optional(),
});

export const rawPullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: str,
  state: str,
  draft: z.boolean().optional(),
  merged: z.boolean().optional(),
  merged_at: nullableStr,
  body: nullableStr,
  user,
  head: z.object({ ref: str, sha: str.optional() }),
  base: z.object({ ref: str }),
  comments: count.optional(),
  changed_files: count.optional(),
  additions: count.optional(),
  deletions: count.optional(),
  created_at: str,
  updated_at: str,
  html_url: str,
});

export const rawFileSchema = z.object({
  filename: str,
  status: str,
  additions: count.optional(),
  deletions: count.optional(),
  changes: count.optional(),
  previous_filename: nullableStr,
});

export const rawCommitSchema = z.object({
  sha: str,
  html_url: str,
  author: user,
  commit: z.object({
    message: str,
    author: z.object({ name: nullableStr, date: nullableStr }).nullish(),
  }),
  stats: z.object({ additions: count.optional(), deletions: count.optional(), total: count.optional() }).nullish(),
  files: z.array(rawFileSchema).optional(),
});

export interface GithubRepo {
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  visibility: string | null;
  defaultBranch: string;
  topics: string[];
  stars: number | null;
  forks: number | null;
  openIssues: number | null;
  language: string | null;
  archived: boolean;
  pushedAt: string | null;
  htmlUrl: string;
}

export interface GithubIssue {
  number: number;
  title: string;
  state: string;
  /** Untrusted text; the service truncates it. */
  body: string | null;
  author: string | null;
  labels: string[];
  assignees: string[];
  commentsCount: number | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  htmlUrl: string;
  /** True for pull requests returned by the issues endpoint; the service filters them out. */
  isPullRequest: boolean;
}

export interface GithubPullRequest {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  /** null in list responses (not provided there). */
  merged: boolean | null;
  mergedAt: string | null;
  body: string | null;
  author: string | null;
  headRef: string;
  baseRef: string;
  commentsCount: number | null;
  changedFiles: number | null;
  additions: number | null;
  deletions: number | null;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

/** Changed-file summary only: patches are never requested or returned. */
export interface GithubChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  previousFilename: string | null;
}

export interface GithubCommit {
  sha: string;
  message: string;
  authorName: string | null;
  authorLogin: string | null;
  authorDate: string | null;
  htmlUrl: string;
  additions: number | null;
  deletions: number | null;
  /** Present for single-commit reads only (GitHub caps it at 300 files). */
  files: GithubChangedFile[] | null;
}

export type GithubIssueState = "open" | "closed" | "all";

/** Where the request ended up after same-host redirects (S16). */
export interface GithubRedirectInfo {
  redirected: boolean;
  redirectCount: number;
  /** Path (no query) of the final URL on api.github.com. */
  finalPath: string;
  /** Owner/repo parsed from a final `/repos/{owner}/{repo}/...` path, else null. */
  resolvedRepo: { owner: string; repo: string } | null;
  /** Set when the final path is `/repositories/{id}/...` (owner/repo unknown; resolve with getRepositoryById). */
  resolvedRepositoryId: number | null;
}

export interface GithubRateLimit {
  limit: number | null;
  remaining: number | null;
  /** Epoch seconds. */
  resetAt: number | null;
}

export interface GithubResponse<T> extends GithubRedirectInfo {
  data: T;
  /** Next page number from the `Link` header, or null. */
  nextPage: number | null;
  rateLimit: GithubRateLimit | null;
  authenticated: boolean;
}
