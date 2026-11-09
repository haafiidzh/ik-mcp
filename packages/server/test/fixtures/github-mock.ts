import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FetchLike } from "../../src/integrations/github/github.client.js";

export interface SeenRequest {
  method: string;
  /** Path and query as received by the mock. */
  url: string;
  headers: IncomingMessage["headers"];
}

export interface GithubMock {
  /** Fetch that sends every api.github.com request to the local mock; refuses any other host. */
  fetch: FetchLike;
  /** Every URL the client asked fetch for (original, before rewriting). */
  fetched: string[];
  seen: SeenRequest[];
  close(): Promise<void>;
}

export type MockHandler = (req: IncomingMessage, res: ServerResponse) => void;

export async function startGithubMock(handler: MockHandler): Promise<GithubMock> {
  const seen: SeenRequest[] = [];
  const fetched: string[] = [];
  const server: Server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const fakeFetch: FetchLike = (input, init) => {
    fetched.push(input);
    const u = new URL(input);
    if (u.hostname !== "api.github.com" || u.protocol !== "https:") {
      return Promise.reject(new Error("mock refuses non-api.github.com host"));
    }
    return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
  };
  return {
    fetch: fakeFetch,
    fetched,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export const repoJson = (owner = "octo", name = "hello") => ({
  name,
  full_name: `${owner}/${name}`,
  owner: { login: owner },
  description: "demo",
  private: false,
  visibility: "public",
  default_branch: "main",
  topics: ["a"],
  stargazers_count: 3,
  forks_count: 1,
  open_issues_count: 2,
  language: "TypeScript",
  archived: false,
  pushed_at: "2026-01-01T00:00:00Z",
  html_url: `https://github.com/${owner}/${name}`,
  extra_unknown: { x: 1 },
});

export const issueJson = (n: number, pr = false) => ({
  number: n,
  title: `Issue ${n}`,
  state: "open",
  body: "text",
  user: { login: "alice" },
  labels: [{ name: "bug" }],
  assignees: [{ login: "bob" }],
  comments: 2,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  closed_at: null,
  html_url: `https://github.com/octo/hello/issues/${n}`,
  ...(pr ? { pull_request: { url: "x" } } : {}),
});

export const pullJson = (n: number) => ({
  number: n,
  title: `PR ${n}`,
  state: "open",
  draft: false,
  merged: false,
  merged_at: null,
  body: null,
  user: { login: "alice" },
  head: { ref: "feature", sha: "abc1234" },
  base: { ref: "main" },
  changed_files: 2,
  additions: 5,
  deletions: 1,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  html_url: `https://github.com/octo/hello/pull/${n}`,
});

export const commitJson = (sha = "abc1234def") => ({
  sha,
  html_url: `https://github.com/octo/hello/commit/${sha}`,
  author: { login: "alice" },
  commit: { message: "feat: x", author: { name: "Alice", date: "2026-01-01T00:00:00Z" } },
  stats: { additions: 3, deletions: 1, total: 4 },
  files: [{ filename: "a.ts", status: "modified", additions: 3, deletions: 1, changes: 4, patch: "SECRET PATCH" }],
});
