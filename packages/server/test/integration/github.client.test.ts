import { afterEach, describe, expect, it } from "vitest";
import { isAppError } from "../../src/core/errors.js";
import { createGithubClient, GITHUB_API_VERSION } from "../../src/integrations/github/github.client.js";
import {
  commitJson,
  issueJson,
  json,
  pullJson,
  repoJson,
  startGithubMock,
  type GithubMock,
  type MockHandler,
} from "../fixtures/github-mock.js";

let mock: GithubMock | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function setup(handler: MockHandler, opts: Parameters<typeof createGithubClient>[0] = {}) {
  mock = await startGithubMock(handler);
  return { client: createGithubClient({ fetch: mock.fetch, ...opts }), mock };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return isAppError(e) ? e.code : `non-app:${String(e)}`;
  }
  return "no-error";
}

describe("github client: endpoint families", () => {
  it("getRepository maps the repo and strips unknown keys", async () => {
    const { client, mock } = await setup((_q, r) => json(r, 200, repoJson()));
    const res = await client.getRepository("octo", "hello");
    expect(res.data).toMatchObject({ owner: "octo", fullName: "octo/hello", defaultBranch: "main", stars: 3, topics: ["a"] });
    expect(res.redirected).toBe(false);
    expect(res.resolvedRepo).toEqual({ owner: "octo", repo: "hello" });
    expect(mock.seen[0]?.url).toBe("/repos/octo/hello");
    expect(mock.seen[0]?.method).toBe("GET");
    expect(JSON.stringify(res.data)).not.toContain("extra_unknown");
  });

  it("sends User-Agent, Accept and X-GitHub-Api-Version", async () => {
    const { client, mock } = await setup((_q, r) => json(r, 200, repoJson()));
    await client.getRepository("octo", "hello");
    const h = mock.seen[0]?.headers;
    expect(h?.["user-agent"]).toBe("devworkspace-mcp");
    expect(h?.["x-github-api-version"]).toBe(GITHUB_API_VERSION);
    expect(h?.accept).toBe("application/vnd.github+json");
  });

  it("listIssues keeps PRs but marks them; passes state and labels; reads Link next page and rate limit", async () => {
    const { client, mock } = await setup((_q, r) =>
      json(r, 200, [issueJson(1), issueJson(2, true)], {
        link: '<https://api.github.com/repositories/1/issues?per_page=30&page=2>; rel="next", <https://api.github.com/repositories/1/issues?page=9>; rel="last"',
        "x-ratelimit-limit": "60",
        "x-ratelimit-remaining": "59",
        "x-ratelimit-reset": "1893456000",
      }),
    );
    const res = await client.listIssues("octo", "hello", { state: "all", labels: "bug,help wanted", perPage: 10, page: 1 });
    expect(res.data.map((i) => [i.number, i.isPullRequest])).toEqual([[1, false], [2, true]]);
    expect(res.data[0]).toMatchObject({ labels: ["bug"], assignees: ["bob"], author: "alice", commentsCount: 2 });
    expect(res.nextPage).toBe(2);
    expect(res.rateLimit).toEqual({ limit: 60, remaining: 59, resetAt: 1893456000 });
    const u = new URL(`http://x${mock.seen[0]?.url ?? ""}`);
    expect(u.pathname).toBe("/repos/octo/hello/issues");
    expect(u.searchParams.get("state")).toBe("all");
    expect(u.searchParams.get("labels")).toBe("bug,help wanted");
    expect(u.searchParams.get("per_page")).toBe("10");
    expect(u.searchParams.get("page")).toBe("1");
  });

  it("getIssue, listPullRequests, getPullRequest", async () => {
    const { client } = await setup((q, r) => {
      if (q.url === "/repos/octo/hello/issues/7") return json(r, 200, issueJson(7));
      if (q.url?.startsWith("/repos/octo/hello/pulls?")) return json(r, 200, [pullJson(1)]);
      if (q.url === "/repos/octo/hello/pulls/1") return json(r, 200, pullJson(1));
      return json(r, 404, { message: "Not Found" });
    });
    expect((await client.getIssue("octo", "hello", 7)).data.title).toBe("Issue 7");
    const list = await client.listPullRequests("octo", "hello");
    expect(list.data[0]).toMatchObject({ headRef: "feature", baseRef: "main", merged: false });
    expect((await client.getPullRequest("octo", "hello", 1)).data).toMatchObject({ changedFiles: 2, additions: 5, deletions: 1 });
  });

  it("listPullRequestFiles returns a summary without patches", async () => {
    const { client } = await setup((_q, r) =>
      json(r, 200, [{ filename: "a.ts", status: "added", additions: 2, deletions: 0, changes: 2, patch: "SECRET PATCH" }]),
    );
    const res = await client.listPullRequestFiles("octo", "hello", 1, { perPage: 5 });
    expect(res.data).toEqual([{ filename: "a.ts", status: "added", additions: 2, deletions: 0, changes: 2, previousFilename: null }]);
  });

  it("listCommits (branch -> sha param) and getCommit (files summary, no patch)", async () => {
    const { client, mock } = await setup((q, r) =>
      q.url?.includes("/commits/") ? json(r, 200, commitJson()) : json(r, 200, [{ ...commitJson(), files: undefined }]),
    );
    const list = await client.listCommits("octo", "hello", { branch: "release/1.x" });
    expect(list.data[0]?.files).toBeNull();
    expect(new URL(`http://x${mock.seen[0]?.url ?? ""}`).searchParams.get("sha")).toBe("release/1.x");
    const one = await client.getCommit("octo", "hello", "abc1234def");
    expect(one.data.files).toEqual([{ filename: "a.ts", status: "modified", additions: 3, deletions: 1, changes: 4, previousFilename: null }]);
    expect(JSON.stringify(one.data)).not.toContain("SECRET PATCH");
    expect(one.data).toMatchObject({ authorLogin: "alice", additions: 3 });
  });

  it("listRepositories: by owner, and authenticated /user/repos; owner required without token", async () => {
    const { client, mock } = await setup((_q, r) => json(r, 200, [repoJson()]), { tokenEnv: "GH_T", getEnv: () => "tok-123456" });
    await client.listRepositories({ owner: "octo" });
    await client.listRepositories({});
    expect(mock.seen.map((s) => s.url.split("?")[0])).toEqual(["/users/octo/repos", "/user/repos"]);
    const anon = createGithubClient({ fetch: mock.fetch });
    expect(await codeOf(anon.listRepositories({}))).toBe("INVALID_INPUT");
  });

  it("getRepositoryById", async () => {
    const { client, mock } = await setup((_q, r) => json(r, 200, repoJson("neworg", "renamed")));
    const res = await client.getRepositoryById(42);
    expect(res.data.fullName).toBe("neworg/renamed");
    expect(mock.seen[0]?.url).toBe("/repositories/42");
  });

  it("rejects bad inputs before any request", async () => {
    const { client, mock } = await setup((_q, r) => json(r, 200, repoJson()));
    for (const p of [
      client.getRepository("..", "x"),
      client.getRepository("a/b", "x"),
      client.getRepository("octo", "he llo"),
      client.getIssue("octo", "hello", 0),
      client.getCommit("octo", "hello", "zz"),
      client.listIssues("octo", "hello", { state: "bogus" as "open" }),
      client.listIssues("octo", "hello", { page: 0 }),
      client.listCommits("octo", "hello", { branch: "a..b" }),
    ]) {
      expect(await codeOf(p)).toBe("INVALID_INPUT");
    }
    expect(mock.seen).toHaveLength(0);
  });

  it("response with an unexpected shape or invalid JSON is UPSTREAM_ERROR", async () => {
    const { client } = await setup((q, r) => {
      if (q.url?.includes("issues/1")) {
        r.writeHead(200);
        return r.end("<html>");
      }
      return json(r, 200, { nope: true });
    });
    expect(await codeOf(client.getRepository("octo", "hello"))).toBe("UPSTREAM_ERROR");
    expect(await codeOf(client.getIssue("octo", "hello", 1))).toBe("UPSTREAM_ERROR");
  });
});

describe("github client: errors, bounds, redirects", () => {
  it("maps statuses to AppError codes", async () => {
    const cases: [number, Record<string, string>, string][] = [
      [401, {}, "INTEGRATION_UNAVAILABLE"],
      [403, {}, "PERMISSION_DENIED"],
      [404, {}, "NOT_FOUND"],
      [410, {}, "NOT_FOUND"],
      [422, {}, "INVALID_INPUT"],
      [500, {}, "UPSTREAM_ERROR"],
      [503, {}, "UPSTREAM_ERROR"],
      [418, {}, "UPSTREAM_ERROR"],
      [429, {}, "RATE_LIMITED"],
      [403, { "x-ratelimit-remaining": "0" }, "RATE_LIMITED"],
      [403, { "retry-after": "30" }, "RATE_LIMITED"],
    ];
    for (const [status, headers, code] of cases) {
      const { client } = await setup((_q, r) => json(r, status, { message: "boom" }, headers));
      expect(await codeOf(client.getRepository("octo", "hello")), `${status} ${JSON.stringify(headers)}`).toBe(code);
      await mock?.close();
      mock = undefined;
    }
  });

  it("rate limit: retry-after wins, else x-ratelimit-reset; secondary-limit message without headers", async () => {
    const reset = Math.floor(Date.now() / 1000) + 120;
    const { client } = await setup((q, r) => {
      if (q.url === "/repos/octo/a") return json(r, 429, { message: "slow down" }, { "retry-after": "17" });
      if (q.url === "/repos/octo/b") return json(r, 403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) });
      return json(r, 403, { message: "You have exceeded a secondary rate limit." });
    });
    const a = await client.getRepository("octo", "a").catch((e: unknown) => e);
    expect(isAppError(a) && a.code === "RATE_LIMITED" && a.retryAfterSeconds === 17 && a.retryable).toBe(true);
    const b = await client.getRepository("octo", "b").catch((e: unknown) => e);
    expect(isAppError(b) && b.code === "RATE_LIMITED" && (b.retryAfterSeconds ?? 0) > 100).toBe(true);
    expect(await codeOf(client.getRepository("octo", "c"))).toBe("RATE_LIMITED");
  });

  it("error messages carry only a short safe GitHub message (no urls, bounded, no body echo)", async () => {
    const long = "x".repeat(500);
    const { client } = await setup((_q, r) =>
      json(r, 422, { message: `Validation failed see https://docs.github.com/secret ${long}`, errors: [{ code: "LEAK_ME" }] }),
    );
    const err = await client.listIssues("octo", "hello").catch((e: unknown) => e);
    expect(isAppError(err)).toBe(true);
    const msg = (err as Error).message;
    expect(msg).toContain("Validation failed");
    expect(msg).not.toContain("docs.github.com");
    expect(msg).not.toContain("LEAK_ME");
    expect(msg.length).toBeLessThan(260);
  });

  it("response over the size cap -> LIMIT_EXCEEDED (streamed and content-length)", async () => {
    const big = JSON.stringify([{ pad: "y".repeat(5000) }]);
    const { client } = await setup((q, r) => {
      if (q.url === "/repos/octo/chunked") {
        r.writeHead(200, { "content-type": "application/json" }); // no content-length: chunked
        r.write(big.slice(0, 2500));
        return r.end(big.slice(2500));
      }
      return json(r, 200, JSON.parse(big));
    }, { limits: { maxResponseBytes: 1000 } });
    expect(await codeOf(client.getRepository("octo", "chunked"))).toBe("LIMIT_EXCEEDED");
    expect(await codeOf(client.getRepository("octo", "declared"))).toBe("LIMIT_EXCEEDED");
  });

  it("times out on a hung server (TIMEOUT) and honours AbortSignal", async () => {
    const { client } = await setup(() => undefined, { limits: { networkTimeoutMs: 150 } });
    expect(await codeOf(client.getRepository("octo", "hello"))).toBe("TIMEOUT");
    const ac = new AbortController();
    const p = createGithubClient({ fetch: mock!.fetch }).getRepository("octo", "hello", { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    expect(await codeOf(p)).toBe("TIMEOUT");
    const pre = new AbortController();
    pre.abort();
    expect(await codeOf(client.getRepository("octo", "hello", { signal: pre.signal }))).toBe("TIMEOUT");
  });

  it("times out while the body stalls", async () => {
    const { client } = await setup((_q, r) => {
      r.writeHead(200, { "content-type": "application/json" });
      r.write("[");
    }, { limits: { networkTimeoutMs: 200 } });
    expect(await codeOf(client.listIssues("octo", "hello"))).toBe("TIMEOUT");
  });

  it("network failure -> INTEGRATION_UNAVAILABLE", async () => {
    const client = createGithubClient({ fetch: () => Promise.reject(new TypeError("fetch failed ECONNREFUSED")) });
    const err = await client.getRepository("octo", "hello").catch((e: unknown) => e);
    expect(isAppError(err) && err.code === "INTEGRATION_UNAVAILABLE").toBe(true);
    expect((err as Error).message).not.toContain("ECONNREFUSED");
  });

  it("same-host redirect is followed and the new owner/repo is surfaced", async () => {
    const { client, mock } = await setup((q, r) => {
      if (q.url === "/repos/octo/old") {
        r.writeHead(301, { location: "https://api.github.com/repos/neworg/renamed" });
        return r.end();
      }
      return json(r, 200, repoJson("neworg", "renamed"));
    });
    const res = await client.getRepository("octo", "old");
    expect(res).toMatchObject({ redirected: true, redirectCount: 1, resolvedRepo: { owner: "neworg", repo: "renamed" }, finalPath: "/repos/neworg/renamed" });
    expect(mock.fetched).toHaveLength(2);
  });

  it("redirect to /repositories/{id} surfaces the id; relative location works; query is kept", async () => {
    const { client } = await setup((q, r) => {
      if (q.url?.startsWith("/repos/octo/old/issues")) {
        r.writeHead(301, { location: "/repositories/99/issues?per_page=5" });
        return r.end();
      }
      return json(r, 200, [issueJson(1)]);
    });
    const res = await client.listIssues("octo", "old", { perPage: 5 });
    expect(res).toMatchObject({ redirected: true, resolvedRepo: null, resolvedRepositoryId: 99 });
  });

  it("allows 3 redirects, refuses the 4th", async () => {
    let hops = 0;
    const { client } = await setup((_q, r) => {
      hops++;
      if (hops <= 3) {
        r.writeHead(307, { location: `https://api.github.com/repos/o/h${hops}` });
        return r.end();
      }
      return json(r, 200, repoJson("o", "h3"));
    });
    expect((await client.getRepository("o", "h0")).redirectCount).toBe(3);
    hops = -1; // 5 hops needed now
    const err = await client.getRepository("o", "h0").catch((e: unknown) => e);
    expect(isAppError(err) && err.code === "UPSTREAM_ERROR").toBe(true);
  });

  it("redirect to another host is not followed", async () => {
    for (const location of [
      "https://evil.example/steal",
      "http://api.github.com/repos/a/b",
      "https://api.github.com.evil.example/x",
      "https://user:pw@api.github.com/repos/a/b",
      "https://api.github.com:8443/repos/a/b",
      "//evil.example/x",
    ]) {
      const { client, mock: m } = await setup((_q, r) => {
        r.writeHead(302, { location });
        r.end();
      }, { tokenEnv: "GH_T", getEnv: () => "tok-canary-9999" });
      const err = await client.getRepository("octo", "hello").catch((e: unknown) => e);
      expect(isAppError(err) && err.code === "UPSTREAM_ERROR", location).toBe(true);
      expect(m.fetched, location).toHaveLength(1);
      await m.close();
      mock = undefined;
    }
  });
});
