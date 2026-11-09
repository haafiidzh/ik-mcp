/**
 * Read-only GitHub REST client (doc 04 section B, doc 05 section 4). MCP-free.
 *
 * - Fixed base https://api.github.com (never from arguments; GHES out of scope).
 * - GET only (ADR-059). No generic proxy: one method per endpoint behind a tool.
 * - Token only from the env var NAMED in config (`tokenEnv`), read per request via
 *   the injected `getEnv`; sent only in the Authorization header to api.github.com.
 * - Redirects (renamed repos): same host only, at most `maxRedirectsGithub`; the
 *   final owner/repo is surfaced so the service can re-check the allowlist (S16).
 * - Bounded: per-request timeout, response size cap, per_page clamped (S17).
 * Official docs: https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api
 * (User-Agent, X-GitHub-Api-Version), .../rate-limits-for-the-rest-api, .../using-pagination-in-the-rest-api.
 */
import type { z } from "zod";
import { AppError } from "../../core/errors.js";
import { clampLimit, DEFAULT_LIMITS, type Limits } from "../../core/limits.js";
import { createRedactor, type Redactor } from "../../core/redact.js";
import {
  rawCommitSchema,
  rawFileSchema,
  rawIssueSchema,
  rawPullRequestSchema,
  rawRepoSchema,
  type GithubChangedFile,
  type GithubCommit,
  type GithubIssue,
  type GithubIssueState,
  type GithubPullRequest,
  type GithubRateLimit,
  type GithubRedirectInfo,
  type GithubRepo,
  type GithubResponse,
} from "./github.types.js";

export const GITHUB_API_HOST = "api.github.com";
export const GITHUB_API_BASE_URL = `https://${GITHUB_API_HOST}`;
/** Stable REST API version (https://docs.github.com/en/rest/about-the-rest-api/api-versions). */
export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_USER_AGENT = "devworkspace-mcp";
/** Highest page number accepted (bounds pagination walks). */
export const MAX_PAGE = 1000;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GithubClientOptions {
  /** Name of the env var holding the token (config `tokenEnv`). Omitted: unauthenticated public reads. */
  tokenEnv?: string;
  /** Injected env getter (defaults to process.env). Used only for `tokenEnv`. */
  getEnv?: (name: string) => string | undefined;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetch?: FetchLike;
  limits?: Partial<Pick<Limits, "networkTimeoutMs" | "maxResponseBytes" | "githubPerPage" | "githubPerPageMax" | "maxRedirectsGithub">>;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface ListOptions extends RequestOptions {
  /** Requested page size; clamped to githubPerPageMax (S17). */
  perPage?: number;
  page?: number;
}

export interface GithubClient {
  /** True when a token env var is configured (value may still be missing at request time). */
  readonly tokenConfigured: boolean;
  /** True when the configured env var currently holds a usable token (never exposes it). */
  tokenAvailable(): boolean;
  listRepositories(opts: ListOptions & { owner?: string }): Promise<GithubResponse<GithubRepo[]>>;
  getRepository(owner: string, repo: string, opts?: RequestOptions): Promise<GithubResponse<GithubRepo>>;
  /** For `/repositories/{id}` redirects: resolve the current owner/repo before the allowlist re-check. */
  getRepositoryById(id: number, opts?: RequestOptions): Promise<GithubResponse<GithubRepo>>;
  listIssues(
    owner: string,
    repo: string,
    opts?: ListOptions & { state?: GithubIssueState; labels?: string },
  ): Promise<GithubResponse<GithubIssue[]>>;
  getIssue(owner: string, repo: string, number: number, opts?: RequestOptions): Promise<GithubResponse<GithubIssue>>;
  listPullRequests(
    owner: string,
    repo: string,
    opts?: ListOptions & { state?: GithubIssueState },
  ): Promise<GithubResponse<GithubPullRequest[]>>;
  getPullRequest(owner: string, repo: string, number: number, opts?: RequestOptions): Promise<GithubResponse<GithubPullRequest>>;
  listPullRequestFiles(
    owner: string,
    repo: string,
    number: number,
    opts?: ListOptions,
  ): Promise<GithubResponse<GithubChangedFile[]>>;
  listCommits(owner: string, repo: string, opts?: ListOptions & { branch?: string }): Promise<GithubResponse<GithubCommit[]>>;
  getCommit(owner: string, repo: string, sha: string, opts?: RequestOptions): Promise<GithubResponse<GithubCommit>>;
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA_RE = /^[0-9a-fA-F]{7,40}$/;
const REF_RE = /^[A-Za-z0-9._/@+-]{1,255}$/;
const LABELS_RE = /^[^\u0000-\u001f\u007f]{1,200}$/;
const TOKEN_RE = /^[\x21-\x7e]+$/;
const MAX_ERROR_BODY_BYTES = 16384;
const MAX_SAFE_MESSAGE = 120;

function invalid(message: string): AppError {
  return new AppError("INVALID_INPUT", message);
}

function checkName(kind: "owner" | "repo", value: string): string {
  if (!NAME_RE.test(value) || value === "." || value === "..") {
    throw invalid(`Invalid ${kind} name.`);
  }
  return value;
}

function checkPositiveInt(kind: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid(`${kind} must be a positive integer.`);
  return value;
}

function seg(value: string): string {
  return encodeURIComponent(value);
}

export function createGithubClient(options: GithubClientOptions = {}): GithubClient {
  const limits = { ...DEFAULT_LIMITS, ...stripUndefined(options.limits) };
  const getEnv = options.getEnv ?? ((n: string) => process.env[n]);
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const tokenEnv = options.tokenEnv;

  function resolveToken(): string | null {
    if (tokenEnv === undefined) return null;
    const value = getEnv(tokenEnv);
    // Unset or empty: unauthenticated public reads (doc 03, PRD 7.2). The service adds a warning.
    if (value === undefined || value.trim() === "") return null;
    const token = value.trim();
    if (!TOKEN_RE.test(token)) {
      throw new AppError("INTEGRATION_UNAVAILABLE", `GitHub token environment variable ${tokenEnv} has an invalid format.`, {
        retryable: false,
      });
    }
    return token;
  }

  function pageParams(opts: ListOptions | undefined): URLSearchParams {
    const q = new URLSearchParams();
    q.set("per_page", String(clampLimit(opts?.perPage, limits.githubPerPageMax, Math.min(limits.githubPerPage, limits.githubPerPageMax))));
    const page = opts?.page;
    if (page !== undefined) {
      if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) throw invalid(`page must be an integer between 1 and ${MAX_PAGE}.`);
      q.set("page", String(page));
    }
    return q;
  }

  async function request<T>(
    path: string,
    query: URLSearchParams | undefined,
    schema: z.ZodType<T>,
    opts: RequestOptions | undefined,
  ): Promise<GithubResponse<T>> {
    const token = resolveToken();
    const redactor = createRedactor({ secretValues: token === null ? [] : [token] });

    const userAborted = (): boolean => opts?.signal?.aborted === true;
    if (userAborted()) throw new AppError("TIMEOUT", "The GitHub request was cancelled before it started.");
    const timeoutSignal = AbortSignal.timeout(limits.networkTimeoutMs);
    const signal = opts?.signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, opts.signal]);

    const qs = query === undefined ? "" : `?${query.toString()}`;
    let url = `${GITHUB_API_BASE_URL}${path}${qs}`;
    let redirectCount = 0;

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": GITHUB_USER_AGENT,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    };
    if (token !== null) headers["Authorization"] = `Bearer ${token}`;

    for (;;) {
      let res: Response;
      try {
        res = await doFetch(url, { method: "GET", headers, redirect: "manual", signal });
      } catch (err) {
        if (userAborted()) throw new AppError("TIMEOUT", "The GitHub request was cancelled.");
        if (timeoutSignal.aborted) {
          throw new AppError("TIMEOUT", `The GitHub request timed out after ${limits.networkTimeoutMs} ms.`);
        }
        if (isAbortError(err)) throw new AppError("TIMEOUT", "The GitHub request was aborted.");
        throw new AppError("INTEGRATION_UNAVAILABLE", "Could not reach the GitHub API.");
      }

      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        await discard(res);
        redirectCount++;
        if (redirectCount > limits.maxRedirectsGithub) {
          throw new AppError("UPSTREAM_ERROR", `GitHub redirected more than ${limits.maxRedirectsGithub} times; request refused.`);
        }
        url = nextRedirectUrl(res, url);
        continue;
      }

      const finalUrl = new URL(url);
      if (!res.ok) throw await mapError(res, redactor, limits.networkTimeoutMs);

      const text = await readBounded(res, limits.maxResponseBytes, signal, timeoutSignal, limits.networkTimeoutMs, opts?.signal);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new AppError("UPSTREAM_ERROR", "GitHub returned a response that is not valid JSON.");
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new AppError("UPSTREAM_ERROR", "GitHub returned a response with an unexpected shape.");

      return {
        data: parsed.data,
        nextPage: parseNextPage(res.headers.get("link")),
        rateLimit: parseRateLimit(res.headers),
        authenticated: token !== null,
        ...redirectInfo(finalUrl, redirectCount),
      };
    }
  }

  const repoPath = (owner: string, repo: string): string => `/repos/${seg(checkName("owner", owner))}/${seg(checkName("repo", repo))}`;

  return {
    tokenConfigured: tokenEnv !== undefined,
    tokenAvailable: () => resolveToken() !== null,

    async listRepositories(opts) {
      const q = pageParams(opts);
      let path: string;
      if (opts.owner !== undefined) {
        path = `/users/${seg(checkName("owner", opts.owner))}/repos`;
        q.set("sort", "pushed");
      } else {
        if (resolveToken() === null) throw invalid("An owner is required when no GitHub token is available.");
        path = "/user/repos";
        q.set("sort", "pushed");
      }
      const res = await request(path, q, rawRepoSchema.array(), opts);
      return { ...res, data: res.data.map(mapRepo) };
    },

    async getRepository(owner, repo, opts) {
      const res = await request(repoPath(owner, repo), undefined, rawRepoSchema, opts);
      return { ...res, data: mapRepo(res.data) };
    },

    async getRepositoryById(id, opts) {
      const res = await request(`/repositories/${checkPositiveInt("Repository id", id)}`, undefined, rawRepoSchema, opts);
      return { ...res, data: mapRepo(res.data) };
    },

    async listIssues(owner, repo, opts) {
      const q = pageParams(opts);
      q.set("state", checkState(opts?.state ?? "open"));
      if (opts?.labels !== undefined) {
        if (!LABELS_RE.test(opts.labels)) throw invalid("Invalid labels filter.");
        q.set("labels", opts.labels);
      }
      const res = await request(`${repoPath(owner, repo)}/issues`, q, rawIssueSchema.array(), opts);
      return { ...res, data: res.data.map(mapIssue) };
    },

    async getIssue(owner, repo, number, opts) {
      const res = await request(
        `${repoPath(owner, repo)}/issues/${checkPositiveInt("Issue number", number)}`,
        undefined,
        rawIssueSchema,
        opts,
      );
      return { ...res, data: mapIssue(res.data) };
    },

    async listPullRequests(owner, repo, opts) {
      const q = pageParams(opts);
      q.set("state", checkState(opts?.state ?? "open"));
      const res = await request(`${repoPath(owner, repo)}/pulls`, q, rawPullRequestSchema.array(), opts);
      return { ...res, data: res.data.map(mapPull) };
    },

    async getPullRequest(owner, repo, number, opts) {
      const res = await request(
        `${repoPath(owner, repo)}/pulls/${checkPositiveInt("Pull request number", number)}`,
        undefined,
        rawPullRequestSchema,
        opts,
      );
      return { ...res, data: mapPull(res.data) };
    },

    async listPullRequestFiles(owner, repo, number, opts) {
      const res = await request(
        `${repoPath(owner, repo)}/pulls/${checkPositiveInt("Pull request number", number)}/files`,
        pageParams(opts),
        rawFileSchema.array(),
        opts,
      );
      return { ...res, data: res.data.map(mapFile) };
    },

    async listCommits(owner, repo, opts) {
      const q = pageParams(opts);
      if (opts?.branch !== undefined) {
        if (!REF_RE.test(opts.branch) || opts.branch.includes("..")) throw invalid("Invalid branch name.");
        q.set("sha", opts.branch);
      }
      const res = await request(`${repoPath(owner, repo)}/commits`, q, rawCommitSchema.array(), opts);
      return { ...res, data: res.data.map(mapCommit) };
    },

    async getCommit(owner, repo, sha, opts) {
      if (!SHA_RE.test(sha)) throw invalid("sha must be 7 to 40 hexadecimal characters.");
      const res = await request(`${repoPath(owner, repo)}/commits/${sha}`, undefined, rawCommitSchema, opts);
      return { ...res, data: mapCommit(res.data) };
    },
  };
}

function stripUndefined<T extends object>(o: T | undefined): Partial<T> {
  const out: Partial<T> = {};
  if (o === undefined) return out;
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

function checkState(state: string): GithubIssueState {
  if (state === "open" || state === "closed" || state === "all") return state;
  throw invalid("state must be open, closed or all.");
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/** Only same-host https redirects, no userinfo, default port (S16 / doc 05 section 4). */
function nextRedirectUrl(res: Response, current: string): string {
  const location = res.headers.get("location");
  if (location === null || location === "") throw new AppError("UPSTREAM_ERROR", "GitHub sent a redirect without a location.");
  let target: URL;
  try {
    target = new URL(location, current);
  } catch {
    throw new AppError("UPSTREAM_ERROR", "GitHub sent an invalid redirect location.");
  }
  if (
    target.protocol !== "https:" ||
    target.hostname !== GITHUB_API_HOST ||
    target.port !== "" ||
    target.username !== "" ||
    target.password !== ""
  ) {
    throw new AppError("UPSTREAM_ERROR", "GitHub redirected to a different host; the redirect was not followed.");
  }
  return target.toString();
}

function redirectInfo(finalUrl: URL, redirectCount: number): GithubRedirectInfo {
  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(?:\/|$)/.exec(finalUrl.pathname);
  const idMatch = /^\/repositories\/(\d+)(?:\/|$)/.exec(finalUrl.pathname);
  let resolvedRepo: GithubRedirectInfo["resolvedRepo"] = null;
  if (repoMatch?.[1] !== undefined && repoMatch[2] !== undefined) {
    try {
      resolvedRepo = { owner: decodeURIComponent(repoMatch[1]), repo: decodeURIComponent(repoMatch[2]) };
    } catch {
      resolvedRepo = null;
    }
  }
  return {
    redirected: redirectCount > 0,
    redirectCount,
    finalPath: finalUrl.pathname,
    resolvedRepo,
    resolvedRepositoryId: idMatch?.[1] === undefined ? null : Number(idMatch[1]),
  };
}

function parseNextPage(link: string | null): number | null {
  if (link === null) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m?.[1] === undefined) continue;
    try {
      const page = Number(new URL(m[1]).searchParams.get("page"));
      return Number.isSafeInteger(page) && page > 0 ? page : null;
    } catch {
      return null;
    }
  }
  return null;
}

function intHeader(headers: Headers, name: string): number | null {
  const v = headers.get(name);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function parseRateLimit(headers: Headers): GithubRateLimit | null {
  const limit = intHeader(headers, "x-ratelimit-limit");
  const remaining = intHeader(headers, "x-ratelimit-remaining");
  const resetAt = intHeader(headers, "x-ratelimit-reset");
  if (limit === null && remaining === null && resetAt === null) return null;
  return { limit, remaining, resetAt };
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // best effort
  }
}

/** Read the body as text, failing with LIMIT_EXCEEDED beyond `maxBytes` (JSON cannot be cut safely). */
async function readBounded(
  res: Response,
  maxBytes: number,
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
  timeoutMs: number,
  userSignal: AbortSignal | undefined,
): Promise<string> {
  const declared = intHeader(res.headers, "content-length");
  if (declared !== null && declared > maxBytes) {
    await discard(res);
    throw new AppError("LIMIT_EXCEEDED", `GitHub response exceeds the ${maxBytes}-byte limit; request a smaller page.`);
  }
  try {
    const { text, overflow } = await readText(res, maxBytes, signal);
    if (overflow) throw new AppError("LIMIT_EXCEEDED", `GitHub response exceeds the ${maxBytes}-byte limit; request a smaller page.`);
    return text;
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (userSignal?.aborted === true) throw new AppError("TIMEOUT", "The GitHub request was cancelled.");
    if (timeoutSignal.aborted) throw new AppError("TIMEOUT", `The GitHub request timed out after ${timeoutMs} ms.`);
    throw new AppError("INTEGRATION_UNAVAILABLE", "The GitHub response could not be read.");
  }
}

async function readText(res: Response, maxBytes: number, signal: AbortSignal): Promise<{ text: string; overflow: boolean }> {
  if (res.body === null) return { text: "", overflow: false };
  const reader = res.body.getReader();
  const onAbort = (): void => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new Error("aborted");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { text: "", overflow: true };
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), overflow: false };
}

/** Short, scrubbed excerpt of GitHub's own `message` field; never the raw body. */
function safeGithubMessage(raw: string, redactor: Redactor): string | null {
  let message: unknown;
  try {
    message = (JSON.parse(raw) as { message?: unknown } | null)?.message;
  } catch {
    return null;
  }
  if (typeof message !== "string") return null;
  const cleaned = redactor
    .redactString(message)
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return null;
  return cleaned.length > MAX_SAFE_MESSAGE ? `${cleaned.slice(0, MAX_SAFE_MESSAGE)}...` : cleaned;
}

function retryAfterSeconds(headers: Headers): number | null {
  const ra = intHeader(headers, "retry-after");
  if (ra !== null) return ra;
  const reset = intHeader(headers, "x-ratelimit-reset");
  if (reset !== null) return Math.max(0, reset - Math.floor(Date.now() / 1000));
  return null;
}

async function mapError(res: Response, redactor: Redactor, timeoutMs: number): Promise<AppError> {
  let raw = "";
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const r = await readText(res, MAX_ERROR_BODY_BYTES, timeout);
    raw = r.text;
  } catch {
    raw = "";
  }
  const status = res.status;
  const detail = safeGithubMessage(raw, redactor);
  const suffix = detail === null ? "" : ` GitHub said: ${detail}`;

  const rateLimited =
    status === 429 ||
    (status === 403 &&
      (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.get("retry-after") !== null || /rate limit/i.test(detail ?? "")));
  if (rateLimited) {
    return new AppError("RATE_LIMITED", `GitHub rate limit reached (HTTP ${status}).${suffix}`, {
      retryAfterSeconds: retryAfterSeconds(res.headers),
    });
  }
  if (status === 401) {
    return new AppError("INTEGRATION_UNAVAILABLE", "GitHub rejected the credentials (HTTP 401); check the token in the configured environment variable.", {
      retryable: false,
    });
  }
  if (status === 403 || status === 451) {
    return new AppError("PERMISSION_DENIED", `GitHub denied access (HTTP ${status}).${suffix}`);
  }
  if (status === 404 || status === 410) {
    return new AppError("NOT_FOUND", "GitHub resource not found or not accessible with the current credentials.");
  }
  if (status === 422) {
    return new AppError("INVALID_INPUT", `GitHub rejected the request parameters (HTTP 422).${suffix}`);
  }
  if (status >= 500) {
    return new AppError("UPSTREAM_ERROR", `GitHub is unavailable (HTTP ${status}).`, { retryable: true });
  }
  return new AppError("UPSTREAM_ERROR", `GitHub returned HTTP ${status}.`);
}

function mapRepo(r: z.infer<typeof rawRepoSchema>): GithubRepo {
  return {
    owner: r.owner.login,
    name: r.name,
    fullName: r.full_name,
    description: r.description ?? null,
    private: r.private,
    visibility: r.visibility ?? null,
    defaultBranch: r.default_branch,
    topics: r.topics ?? [],
    stars: r.stargazers_count ?? null,
    forks: r.forks_count ?? null,
    openIssues: r.open_issues_count ?? null,
    language: r.language ?? null,
    archived: r.archived ?? false,
    pushedAt: r.pushed_at ?? null,
    htmlUrl: r.html_url,
  };
}

function mapIssue(i: z.infer<typeof rawIssueSchema>): GithubIssue {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    body: i.body ?? null,
    author: i.user?.login ?? null,
    labels: i.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter((n) => n !== ""),
    assignees: (i.assignees ?? []).map((a) => a.login),
    commentsCount: i.comments ?? null,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    closedAt: i.closed_at ?? null,
    htmlUrl: i.html_url,
    isPullRequest: i.pull_request !== undefined && i.pull_request !== null,
  };
}

function mapPull(p: z.infer<typeof rawPullRequestSchema>): GithubPullRequest {
  return {
    number: p.number,
    title: p.title,
    state: p.state,
    draft: p.draft ?? false,
    merged: p.merged ?? null,
    mergedAt: p.merged_at ?? null,
    body: p.body ?? null,
    author: p.user?.login ?? null,
    headRef: p.head.ref,
    baseRef: p.base.ref,
    commentsCount: p.comments ?? null,
    changedFiles: p.changed_files ?? null,
    additions: p.additions ?? null,
    deletions: p.deletions ?? null,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    htmlUrl: p.html_url,
  };
}

function mapFile(f: z.infer<typeof rawFileSchema>): GithubChangedFile {
  return {
    filename: f.filename,
    status: f.status,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    changes: f.changes ?? (f.additions ?? 0) + (f.deletions ?? 0),
    previousFilename: f.previous_filename ?? null,
  };
}

function mapCommit(c: z.infer<typeof rawCommitSchema>): GithubCommit {
  return {
    sha: c.sha,
    message: c.commit.message,
    authorName: c.commit.author?.name ?? null,
    authorLogin: c.author?.login ?? null,
    authorDate: c.commit.author?.date ?? null,
    htmlUrl: c.html_url,
    additions: c.stats?.additions ?? null,
    deletions: c.stats?.deletions ?? null,
    files: c.files === undefined ? null : c.files.map(mapFile),
  };
}
