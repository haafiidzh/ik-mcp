/**
 * GitHub service (doc 04 section B, doc 05 section 4). MCP-free. Sits between the tools and the
 * read-only client and owns: the allowlist (checked BEFORE every request, case-insensitive; names are
 * validated first; EMPTY allowlist = fail-closed, P3-04),
 * the S16 re-check after a renamed-repo redirect (data is discarded when the final repo is not
 * allowed), pull-request filtering, text/changed-file caps and limit/page validation (S17).
 * Text from GitHub (titles, bodies, commit messages) is untrusted data: truncated, never interpreted.
 */
import { AppError } from "../../core/errors.js";
import { clampLimit, truncateList, truncateString, type Limits } from "../../core/limits.js";
import type { Logger } from "../../core/logger.js";
import { MAX_PAGE, createGithubClient, type FetchLike, type GithubClient } from "./github.client.js";
import type {
  GithubChangedFile,
  GithubCommit,
  GithubIssue,
  GithubIssueState,
  GithubPullRequest,
  GithubRepo,
  GithubResponse,
} from "./github.types.js";

export interface GithubServiceConfig {
  tokenEnv?: string | undefined;
  allowedRepositories: readonly string[];
  allowedOwners: readonly string[];
}

export interface GithubServiceOptions {
  config: GithubServiceConfig;
  limits: Limits;
  logger?: Logger;
  /** Test seam (wired only from ServerDeps, never from config or tool input). */
  fetch?: FetchLike;
  getEnv?: (name: string) => string | undefined;
  /** Test seam: replaces the client. */
  client?: GithubClient;
}

/** What a service call returns; the tool layer wraps it with `ok()`. */
export interface GithubOutcome<T> {
  data: T;
  /** Final "owner/repo" the data belongs to (after redirect resolution), when repo-scoped. */
  repository?: string;
  nextPageAvailable: boolean;
  truncated: boolean;
  limit?: number;
  warnings: string[];
}

export interface ListArgs {
  limit?: number | undefined;
  page?: number | undefined;
}

export interface GithubService {
  listRepositories(args: ListArgs & { owner?: string | undefined }): Promise<GithubOutcome<GithubRepo[]>>;
  getRepository(owner: string, repo: string): Promise<GithubOutcome<GithubRepo>>;
  listIssues(owner: string, repo: string, args: ListArgs & { state?: GithubIssueState | undefined; labels?: string | undefined }): Promise<GithubOutcome<GithubIssue[]>>;
  getIssue(owner: string, repo: string, number: number): Promise<GithubOutcome<GithubIssue>>;
  listPullRequests(owner: string, repo: string, args: ListArgs & { state?: GithubIssueState | undefined }): Promise<GithubOutcome<GithubPullRequest[]>>;
  getPullRequest(owner: string, repo: string, number: number): Promise<GithubOutcome<GithubPullRequest & { files: GithubChangedFile[]; filesTruncated: boolean }>>;
  listCommits(owner: string, repo: string, args: ListArgs & { branch?: string | undefined }): Promise<GithubOutcome<GithubCommit[]>>;
  getCommit(owner: string, repo: string, sha: string): Promise<GithubOutcome<GithubCommit>>;
}

const lc = (s: string): string => s.toLowerCase();

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
/** P3-08: validate a path segment BEFORE any case folding or allowlist comparison. */
function validName(value: string): boolean {
  return NAME_RE.test(value) && value !== "." && value !== "..";
}

/** P3-09: delegates to core truncateString (code point safe); keeps the {text, truncated} shape. */
export function truncateCodePoints(text: string, maxChars: number): { text: string; truncated: boolean } {
  const r = truncateString(text, maxChars);
  return { text: r.text, truncated: r.meta.truncated };
}

/** P3-04: shown when github is enabled but neither allowedRepositories nor allowedOwners is set. */
export const EMPTY_ALLOWLIST_MESSAGE =
  "GitHub access is disabled: no allowlist is configured. Set github.allowedRepositories or github.allowedOwners in the config.";

export function createGithubService(options: GithubServiceOptions): GithubService {
  const { limits } = options;
  const client =
    options.client ??
    createGithubClient({
      ...(options.config.tokenEnv !== undefined ? { tokenEnv: options.config.tokenEnv } : {}),
      getEnv: options.getEnv ?? ((n) => process.env[n]),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      limits,
    });

  const repos = new Set(options.config.allowedRepositories.map(lc));
  const owners = new Set(options.config.allowedOwners.map(lc));
  const hasAllowlist = repos.size > 0 || owners.size > 0;
  const bodyMax = limits.maxCellChars;
  /** P3-07: per-field caps (existing limit keys): short strings, label count, changed-file names. */
  const shortMax = limits.maxSnippetChars;
  const labelsMax = limits.maxResults;
  const filesMax = Math.min(limits.maxResults, limits.githubPerPageMax);
  let tokenWarned = false;

  const isAllowed = (owner: string, repo: string): boolean =>
    hasAllowlist && validName(owner) && validName(repo) && (owners.has(lc(owner)) || repos.has(`${lc(owner)}/${lc(repo)}`));
  const isAllowedFull = (fullName: string): boolean => {
    const i = fullName.indexOf("/");
    return i > 0 && isAllowed(fullName.slice(0, i), fullName.slice(i + 1));
  };
  const denied = (): AppError =>
    new AppError("PERMISSION_DENIED", "This repository is not in the configured GitHub allowlist.");

  /** P3-04: fail closed before any request when no allowlist exists. */
  function assertConfigured(): void {
    if (!hasAllowlist) throw new AppError("PERMISSION_DENIED", EMPTY_ALLOWLIST_MESSAGE);
  }

  function assertAllowed(owner: string, repo: string): void {
    assertConfigured();
    if (!validName(owner) || !validName(repo)) throw new AppError("INVALID_INPUT", "Invalid repository owner or name.");
    if (!isAllowed(owner, repo)) throw denied();
  }

  function baseWarnings(): string[] {
    const w: string[] = [];
    if (client.tokenConfigured && !client.tokenAvailable()) {
      w.push(
        `The configured token environment variable (${options.config.tokenEnv ?? "tokenEnv"}) is not set: using unauthenticated public reads (lower rate limit, private repositories unreachable).`,
      );
      if (!tokenWarned) {
        tokenWarned = true;
        options.logger?.warn("github token env var not set; falling back to unauthenticated public reads");
      }
    }
    return w;
  }

  function checkPage(page: number | undefined): number | undefined {
    if (page === undefined) return undefined;
    if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) {
      throw new AppError("INVALID_INPUT", `page must be an integer between 1 and ${MAX_PAGE}.`);
    }
    return page;
  }

  function resolveLimit(args: ListArgs, warnings: string[]): { perPage: number; page: number | undefined } {
    const page = checkPage(args.page);
    const cap = limits.githubPerPageMax;
    if (args.limit !== undefined && args.limit > cap) warnings.push(`limit was clamped to the server maximum (${cap}).`);
    const perPage = clampLimit(args.limit, cap, Math.min(limits.githubPerPage, cap));
    return { perPage, page };
  }

  /**
   * S16: after a request, if GitHub redirected (renamed repo), resolve the FINAL repo and re-check the
   * allowlist. On denial the fetched data is dropped by throwing. Returns the final "owner/repo".
   */
  async function finalRepo<T>(owner: string, repo: string, res: GithubResponse<T>): Promise<{ owner: string; repo: string }> {
    if (!res.redirected) return { owner, repo };
    let final = res.resolvedRepo;
    if (final === null && res.resolvedRepositoryId !== null) {
      const byId = await client.getRepositoryById(res.resolvedRepositoryId);
      const full = byId.data.fullName;
      const i = full.indexOf("/");
      final = i > 0 ? { owner: full.slice(0, i), repo: full.slice(i + 1) } : null;
    }
    if (final === null || !isAllowed(final.owner, final.repo)) throw denied();
    return final;
  }

  const truncText = (text: string | null): { text: string | null; truncated: boolean } => {
    if (text === null) return { text: null, truncated: false };
    const t = truncateCodePoints(text, bodyMax);
    return { text: t.text, truncated: t.truncated };
  };

  const cap = (text: string, max: number): { text: string; truncated: boolean } => truncateCodePoints(text, max);

  function capFile(f: GithubChangedFile): { file: GithubChangedFile; truncated: boolean } {
    const n = cap(f.filename, shortMax);
    const p = f.previousFilename === null ? null : cap(f.previousFilename, shortMax);
    return { file: { ...f, filename: n.text, previousFilename: p === null ? null : p.text }, truncated: n.truncated || (p?.truncated ?? false) };
  }

  function capFiles(files: GithubChangedFile[]): { files: GithubChangedFile[]; truncated: boolean } {
    let truncated = false;
    const out = files.map((f) => {
      const c = capFile(f);
      truncated = truncated || c.truncated;
      return c.file;
    });
    return { files: out, truncated };
  }

  function capLabels(labels: string[]): { labels: string[]; truncated: boolean } {
    const list = truncateList(labels, labelsMax);
    let truncated = list.meta.truncated;
    const out = list.items.map((l) => {
      const c = cap(l, shortMax);
      truncated = truncated || c.truncated;
      return c.text;
    });
    return { labels: out, truncated };
  }

  function cleanIssue(i: GithubIssue): { issue: GithubIssue; truncated: boolean } {
    const b = truncText(i.body);
    const t = cap(i.title, shortMax);
    const l = capLabels(i.labels);
    return { issue: { ...i, title: t.text, body: b.text, labels: l.labels }, truncated: b.truncated || t.truncated || l.truncated };
  }

  function cleanPr(p: GithubPullRequest): { pr: GithubPullRequest; truncated: boolean } {
    const b = truncText(p.body);
    const t = cap(p.title, shortMax);
    return { pr: { ...p, title: t.text, body: b.text }, truncated: b.truncated || t.truncated };
  }

  function cleanCommit(c: GithubCommit): { commit: GithubCommit; truncated: boolean } {
    const m = truncateCodePoints(c.message, bodyMax);
    const files = c.files === null ? null : truncateList(c.files, filesMax);
    const capped = files === null ? null : capFiles(files.items);
    return {
      commit: { ...c, message: m.text, files: capped === null ? null : capped.files },
      truncated: m.truncated || (files?.meta.truncated ?? false) || (capped?.truncated ?? false),
    };
  }

  function listOutcome<T>(items: T[], res: GithubResponse<unknown>, warnings: string[], repository: string | undefined, truncated: boolean, limit: number): GithubOutcome<T[]> {
    return {
      data: items,
      ...(repository !== undefined ? { repository } : {}),
      nextPageAvailable: res.nextPage !== null,
      truncated,
      ...(truncated ? { limit } : {}),
      warnings,
    };
  }

  return {
    async listRepositories(args) {
      assertConfigured();
      if (args.owner !== undefined && !validName(args.owner)) throw new AppError("INVALID_INPUT", "Invalid repository owner.");
      const warnings = baseWarnings();
      const { perPage, page } = resolveLimit(args, warnings);
      const owner = args.owner;
      const listOpts = { perPage, ...(page !== undefined ? { page } : {}) };

      // Explicit allowlisted repos of one owner (no owner-level grant): fetch each by name.
      const fetchNamed = async (filterOwner?: string): Promise<GithubRepo[]> => {
        const names = options.config.allowedRepositories.filter(
          (r) => filterOwner === undefined || lc(r.split("/")[0] ?? "") === lc(filterOwner),
        );
        const out: GithubRepo[] = [];
        for (const full of names.slice(0, perPage)) {
          const [o, r] = full.split("/") as [string, string];
          const res = await client.getRepository(o, r);
          const f = await finalRepo(o, r, res);
          if (isAllowed(f.owner, f.repo)) out.push(res.data);
        }
        return out;
      };

      if (owner === undefined) {
        const items: GithubRepo[] = await fetchNamed();
        let more = false;
        for (const o of options.config.allowedOwners) {
          if (items.length >= perPage) {
            more = true;
            break;
          }
          const res = await client.listRepositories({ owner: o, perPage: perPage - items.length });
          more = more || res.nextPage !== null;
          for (const r of res.data) {
            if (isAllowedFull(r.fullName) && !items.some((x) => lc(x.fullName) === lc(r.fullName))) items.push(r);
          }
        }
        const cut = truncateList(items, perPage);
        return {
          data: cut.items,
          nextPageAvailable: more || cut.meta.truncated,
          truncated: cut.meta.truncated,
          ...(cut.meta.truncated ? { limit: perPage } : {}),
          warnings: [...warnings, "Without owner, only the first page of allowlisted repositories is returned."],
        };
      }

      if (!owners.has(lc(owner))) {
        const hasNamed = options.config.allowedRepositories.some((r) => lc(r.split("/")[0] ?? "") === lc(owner));
        if (!hasNamed) throw denied();
        const items = await fetchNamed(owner);
        return { data: items, nextPageAvailable: false, truncated: false, warnings };
      }
      const res = await client.listRepositories({ owner, ...listOpts });
      // Redirected owner listing (renamed account): keep only repos that pass the allowlist.
      const items = res.data.filter((r) => isAllowedFull(r.fullName));
      return listOutcome(items, res, warnings, undefined, false, perPage);
    },

    async getRepository(owner, repo) {
      assertAllowed(owner, repo);
      const res = await client.getRepository(owner, repo);
      const f = await finalRepo(owner, repo, res);
      return { data: res.data, repository: `${f.owner}/${f.repo}`, nextPageAvailable: false, truncated: false, warnings: baseWarnings() };
    },

    async listIssues(owner, repo, args) {
      assertAllowed(owner, repo);
      const warnings = baseWarnings();
      const { perPage, page } = resolveLimit(args, warnings);
      const res = await client.listIssues(owner, repo, {
        perPage,
        ...(page !== undefined ? { page } : {}),
        ...(args.state !== undefined ? { state: args.state } : {}),
        ...(args.labels !== undefined ? { labels: args.labels } : {}),
      });
      const f = await finalRepo(owner, repo, res);
      let truncated = false;
      const items = res.data
        .filter((i) => !i.isPullRequest)
        .map((i) => {
          const c = cleanIssue(i);
          truncated = truncated || c.truncated;
          return c.issue;
        });
      return listOutcome(items, res, warnings, `${f.owner}/${f.repo}`, truncated, bodyMax);
    },

    async getIssue(owner, repo, number) {
      assertAllowed(owner, repo);
      const res = await client.getIssue(owner, repo, number);
      const f = await finalRepo(owner, repo, res);
      if (res.data.isPullRequest) {
        throw new AppError("NOT_FOUND", `#${number} is a pull request, not an issue; use github_get_pull_request.`);
      }
      const c = cleanIssue(res.data);
      return { data: c.issue, repository: `${f.owner}/${f.repo}`, nextPageAvailable: false, truncated: c.truncated, ...(c.truncated ? { limit: bodyMax } : {}), warnings: baseWarnings() };
    },

    async listPullRequests(owner, repo, args) {
      assertAllowed(owner, repo);
      const warnings = baseWarnings();
      const { perPage, page } = resolveLimit(args, warnings);
      const res = await client.listPullRequests(owner, repo, {
        perPage,
        ...(page !== undefined ? { page } : {}),
        ...(args.state !== undefined ? { state: args.state } : {}),
      });
      const f = await finalRepo(owner, repo, res);
      let truncated = false;
      const items = res.data.map((p) => {
        const c = cleanPr(p);
        truncated = truncated || c.truncated;
        return c.pr;
      });
      return listOutcome(items, res, warnings, `${f.owner}/${f.repo}`, truncated, bodyMax);
    },

    async getPullRequest(owner, repo, number) {
      assertAllowed(owner, repo);
      const res = await client.getPullRequest(owner, repo, number);
      const f = await finalRepo(owner, repo, res);
      const filesRes = await client.listPullRequestFiles(f.owner, f.repo, number, { perPage: filesMax });
      const f2 = await finalRepo(f.owner, f.repo, filesRes);
      const listed = truncateList(filesRes.data, filesMax);
      const files = { items: capFiles(listed.items).files, meta: listed.meta };
      const c = cleanPr(res.data);
      const filesTruncated = files.meta.truncated || filesRes.nextPage !== null;
      return {
        data: { ...c.pr, files: files.items, filesTruncated },
        repository: `${f2.owner}/${f2.repo}`,
        nextPageAvailable: false,
        truncated: c.truncated || filesTruncated,
        limit: c.truncated ? bodyMax : filesMax,
        warnings: baseWarnings(),
      };
    },

    async listCommits(owner, repo, args) {
      assertAllowed(owner, repo);
      const warnings = baseWarnings();
      const { perPage, page } = resolveLimit(args, warnings);
      const res = await client.listCommits(owner, repo, {
        perPage,
        ...(page !== undefined ? { page } : {}),
        ...(args.branch !== undefined ? { branch: args.branch } : {}),
      });
      const f = await finalRepo(owner, repo, res);
      let truncated = false;
      const items = res.data.map((c0) => {
        const c = cleanCommit(c0);
        truncated = truncated || c.truncated;
        return c.commit;
      });
      return listOutcome(items, res, warnings, `${f.owner}/${f.repo}`, truncated, bodyMax);
    },

    async getCommit(owner, repo, sha) {
      assertAllowed(owner, repo);
      const res = await client.getCommit(owner, repo, sha);
      const f = await finalRepo(owner, repo, res);
      const c = cleanCommit(res.data);
      return { data: c.commit, repository: `${f.owner}/${f.repo}`, nextPageAvailable: false, truncated: c.truncated, ...(c.truncated ? { limit: bodyMax } : {}), warnings: baseWarnings() };
    },
  };
}
