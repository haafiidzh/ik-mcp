import { afterEach, describe, expect, it, vi } from "vitest";
import { isAppError, toErrorPayload } from "../../src/core/errors.js";
import { createGithubClient } from "../../src/integrations/github/github.client.js";
import { issueJson, json, repoJson, startGithubMock, type GithubMock, type MockHandler } from "../fixtures/github-mock.js";

const CANARY = "ghp_CANARYtoken0123456789abcdefABCDEF";
let mock: GithubMock | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await mock?.close();
  mock = undefined;
});

async function setup(handler: MockHandler, opts: Parameters<typeof createGithubClient>[0] = {}) {
  mock = await startGithubMock(handler);
  return { client: createGithubClient({ fetch: mock.fetch, ...opts }), mock };
}

const authed = { tokenEnv: "GITHUB_TOKEN", getEnv: (n: string) => (n === "GITHUB_TOKEN" ? CANARY : undefined) };

describe("S19: token handling", () => {
  it("token goes only into the Authorization header", async () => {
    const { client, mock } = await setup((_q, r) => json(r, 200, repoJson()), authed);
    const res = await client.getRepository("octo", "hello");
    expect(res.authenticated).toBe(true);
    expect(mock.seen[0]?.headers.authorization).toBe(`Bearer ${CANARY}`);
    expect(mock.seen[0]?.url).not.toContain(CANARY);
    expect(JSON.stringify(res)).not.toContain(CANARY);
    for (const [k, v] of Object.entries(mock.seen[0]?.headers ?? {})) {
      if (k !== "authorization") expect(String(v)).not.toContain(CANARY);
    }
  });

  it("token never appears in errors, even when GitHub echoes it", async () => {
    const stderr = vi.spyOn(process.stderr, "write");
    const stdout = vi.spyOn(process.stdout, "write");
    for (const status of [401, 403, 404, 422, 429, 500]) {
      const { client, mock: m } = await setup(
        (_q, r) => json(r, status, { message: `Bad credentials for token ${CANARY} Bearer ${CANARY}`, documentation_url: CANARY }),
        authed,
      );
      const err = await client.getRepository("octo", "hello").catch((e: unknown) => e);
      expect(isAppError(err)).toBe(true);
      const dump = JSON.stringify([toErrorPayload(err), (err as Error).message, (err as Error).stack, String(err)]);
      expect(dump).not.toContain(CANARY);
      expect(dump).not.toMatch(/Bearer\s+(?!\[REDACTED\])\S/);
      await m.close();
      mock = undefined;
    }
    const written = [...stderr.mock.calls, ...stdout.mock.calls].map((c) => String(c[0])).join("");
    expect(written).not.toContain(CANARY);
  });

  it("network failure error does not carry the token or header", async () => {
    const client = createGithubClient({
      ...authed,
      fetch: (_u, init) => Promise.reject(new TypeError(`fetch failed ${JSON.stringify(init.headers)}`)),
    });
    const err = await client.getRepository("octo", "hello").catch((e: unknown) => e);
    expect(isAppError(err) && err.code).toBe("INTEGRATION_UNAVAILABLE");
    expect(JSON.stringify([(err as Error).message, toErrorPayload(err)])).not.toContain(CANARY);
    // internal cause is not attached either
    expect((err as Error).cause).toBeUndefined();
  });

  it("unauthenticated mode (no tokenEnv) sends no Authorization header", async () => {
    const { client, mock } = await setup((_q, r) => json(r, 200, repoJson()));
    const res = await client.getRepository("octo", "hello");
    expect(res.authenticated).toBe(false);
    expect(mock.seen[0]?.headers.authorization).toBeUndefined();
  });

  it("tokenEnv configured but variable unset/empty -> unauthenticated public read (no Authorization), not authenticated", async () => {
    for (const value of [undefined, "", "   "]) {
      const { client, mock: m } = await setup((_q, r) => json(r, 200, repoJson()), { tokenEnv: "GITHUB_TOKEN", getEnv: () => value });
      const res = await client.getRepository("octo", "hello");
      expect(res.authenticated).toBe(false);
      expect(client.tokenConfigured).toBe(true);
      expect(client.tokenAvailable()).toBe(false);
      expect(m.seen[0]?.headers.authorization).toBeUndefined();
      await m.close();
      mock = undefined;
    }
  });

  it("a token with whitespace/control characters is refused without echoing it (header injection)", async () => {
    const bad = `${CANARY}\r\nX-Evil: 1`;
    const { client, mock } = await setup((_q, r) => json(r, 200, repoJson()), { tokenEnv: "T", getEnv: () => bad });
    const err = await client.getRepository("octo", "hello").catch((e: unknown) => e);
    expect(isAppError(err) && err.code).toBe("INTEGRATION_UNAVAILABLE");
    expect((err as Error).message).not.toContain("CANARY");
    expect(mock.seen).toHaveLength(0);
  });

  it("the Authorization header is never sent on a refused cross-host redirect", async () => {
    const { client, mock } = await setup((_q, r) => {
      r.writeHead(301, { location: "https://evil.example/collect" });
      r.end();
    }, authed);
    await client.getRepository("octo", "hello").catch(() => undefined);
    expect(mock.fetched).toEqual(["https://api.github.com/repos/octo/hello"]);
  });
});

describe("S17: per_page clamp", () => {
  it("clamps to githubPerPageMax and defaults to githubPerPage", async () => {
    const { client, mock } = await setup((_q, r) => json(r, 200, [issueJson(1)]));
    await client.listIssues("octo", "hello", { perPage: 100000 });
    await client.listIssues("octo", "hello", { perPage: 0 });
    await client.listIssues("octo", "hello", { perPage: -5 });
    await client.listIssues("octo", "hello");
    await client.listIssues("octo", "hello", { perPage: Number.NaN });
    const pp = mock.seen.map((s) => new URL(`http://x${s.url}`).searchParams.get("per_page"));
    expect(pp).toEqual(["100", "30", "30", "30", "30"]);
  });

  it("a configured lower max applies to every list endpoint", async () => {
    const { client, mock } = await setup((_q, r) => json(r, 200, []), { limits: { githubPerPageMax: 20, githubPerPage: 10 } });
    await client.listIssues("o", "r", { perPage: 99 });
    await client.listPullRequests("o", "r", { perPage: 99 });
    await client.listCommits("o", "r", { perPage: 99 });
    await client.listPullRequestFiles("o", "r", 1, { perPage: 99 });
    await client.listRepositories({ owner: "o", perPage: 99 });
    await client.listRepositories({ owner: "o" });
    const pp = mock.seen.map((s) => new URL(`http://x${s.url}`).searchParams.get("per_page"));
    expect(pp).toEqual(["20", "20", "20", "20", "20", "10"]);
  });

  it("page above the cap is INVALID_INPUT", async () => {
    const { client } = await setup((_q, r) => json(r, 200, []));
    const err = await client.listIssues("o", "r", { page: 1_000_000 }).catch((e: unknown) => e);
    expect(isAppError(err) && err.code).toBe("INVALID_INPUT");
  });
});

describe("S16 (client part) and no-proxy guarantees", () => {
  it("renamed repo redirect is surfaced as resolvedRepo for the service allowlist re-check", async () => {
    const { client } = await setup((q, r) => {
      if (q.url === "/repos/allowed/repo") {
        r.writeHead(301, { location: "https://api.github.com/repos/other/secret-repo" });
        return r.end();
      }
      return json(r, 200, repoJson("other", "secret-repo"));
    });
    const res = await client.getRepository("allowed", "repo");
    expect(res.redirected).toBe(true);
    expect(res.resolvedRepo).toEqual({ owner: "other", repo: "secret-repo" });
  });

  it("path traversal and URL-ish owner/repo values cannot change the endpoint", async () => {
    const { client, mock } = await setup((_q, r) => json(r, 200, repoJson()));
    for (const [o, r] of [["..", "x"], ["x", ".."], [".", "x"], ["octo/../../admin", "x"], ["octo", "r?x=1"], ["https://evil.example", "x"], ["octo", "r#f"]] as const) {
      const err = await client.getRepository(o, r).catch((e: unknown) => e);
      expect(isAppError(err) && err.code, `${o}/${r}`).toBe("INVALID_INPUT");
    }
    expect(mock.seen).toHaveLength(0);
  });

  it("client exposes only read methods and always issues GET", async () => {
    const { client, mock } = await setup((_q, r) => json(r, 200, repoJson()));
    expect(Object.keys(client).sort()).toEqual(
      [
        "getCommit", "getIssue", "getPullRequest", "getRepository", "getRepositoryById", "listCommits", "listIssues",
        "listPullRequestFiles", "listPullRequests", "listRepositories", "tokenAvailable", "tokenConfigured",
      ].sort(),
    );
    await client.getRepository("octo", "hello");
    expect(mock.seen.every((s) => s.method === "GET")).toBe(true);
  });
});
