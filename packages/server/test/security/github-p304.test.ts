import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfigText } from "../../src/config/load-config.js";
import { createAuditLog } from "../../src/core/audit.js";
import { DEFAULT_LIMITS } from "../../src/core/limits.js";
import { createLogger } from "../../src/core/logger.js";
import { createRedactor } from "../../src/core/redact.js";
import { createGithubService, truncateCodePoints } from "../../src/integrations/github/github.service.js";
import { registerTools, type ServerDeps } from "../../src/server/register-tools.js";
import { commitJson, issueJson, json, pullJson, repoJson, startGithubMock, type GithubMock, type MockHandler } from "../fixtures/github-mock.js";

/**
 * P3-04 (empty allowlist = fail-closed), P3-06 (code point truncation), P3-07 (per-field caps),
 * P3-08 (validate names, then compare case-insensitively).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON view of tool results
type Res = { success: boolean; data?: any; error?: { code: string; message: string }; meta?: Record<string, any>; warnings?: string[] };

let mocks: GithubMock[] = [];
afterEach(async () => {
  await Promise.all(mocks.map((m) => m.close()));
  mocks = [];
});

async function harness(handler: MockHandler, github: Record<string, unknown>) {
  const mock = await startGithubMock(handler);
  mocks.push(mock);
  type H = { schema: { safeParse(v: unknown): { success: boolean; data?: unknown } }; fn: (a: unknown) => Promise<{ content: { text: string }[] }> };
  const handlers = new Map<string, H>();
  const server = {
    server: {},
    registerTool: (name: string, cfg: { inputSchema?: H["schema"] }, fn: H["fn"]) => {
      handlers.set(name, { schema: cfg.inputSchema ?? { safeParse: (v) => ({ success: true, data: v }) }, fn });
    },
  } as unknown as McpServer;
  const logs: string[] = [];
  const redactor = createRedactor({ secretValues: [] });
  const deps: ServerDeps = {
    config: parseConfigText(JSON.stringify({ github: { enabled: true, ...github } })),
    limits: { ...DEFAULT_LIMITS },
    logger: createLogger({ level: "debug", redactor, write: (l) => logs.push(l) }),
    audit: createAuditLog(),
    redactor,
    startedAtMs: Date.now(),
    githubFetch: mock.fetch,
    githubGetEnv: () => undefined,
  };
  registerTools(server, deps);
  return {
    mock,
    logs,
    async call(tool: string, args: Record<string, unknown>): Promise<Res> {
      const h = handlers.get(tool);
      if (h === undefined) throw new Error(`not registered: ${tool}`);
      const parsed = h.schema.safeParse(args);
      if (!parsed.success) return { success: false, error: { code: "INVALID_INPUT", message: "schema" } };
      const r = await h.fn(parsed.data);
      return JSON.parse(r.content[0]?.text ?? "{}") as Res;
    },
  };
}

const everything: MockHandler = (_req, res) => json(res, 200, repoJson());
const R = { owner: "octo", repo: "hello" };
const ALL_TOOLS: [string, Record<string, unknown>][] = [
  ["github_list_repositories", {}],
  ["github_list_repositories", { owner: "octo" }],
  ["github_get_repository", R],
  ["github_list_issues", R],
  ["github_get_issue", { ...R, number: 1 }],
  ["github_list_pull_requests", R],
  ["github_get_pull_request", { ...R, number: 1 }],
  ["github_list_commits", R],
  ["github_get_commit", { ...R, sha: "abc1234" }],
];

describe("P3-04 empty allowlist is fail-closed", () => {
  it.each(ALL_TOOLS)("%s %j -> PERMISSION_DENIED, zero requests, no data", async (tool, args) => {
    const h = await harness(everything, {});
    const r = await h.call(tool, args);
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe("PERMISSION_DENIED");
    expect(r.error?.message).toMatch(/allowedRepositories or github\.allowedOwners/);
    expect(r.data).toBeUndefined();
    expect(h.mock.fetched).toHaveLength(0);
  });

  it("logs one startup warning (stderr logger) without secrets", async () => {
    const h = await harness(everything, { tokenEnv: "GITHUB_TOKEN" });
    expect(h.logs.filter((l) => /no allowlist/.test(l))).toHaveLength(1);
  });

  it("no startup warning when an allowlist exists", async () => {
    const h = await harness(everything, { allowedOwners: ["octo"] });
    expect(h.logs.filter((l) => /no allowlist/.test(l))).toHaveLength(0);
  });

  it("only allowedOwners: owner repos readable, other owners denied with zero requests", async () => {
    const h = await harness((req, res) => json(res, 200, req.url?.startsWith("/repos/octo/") ? repoJson("octo", "x") : repoJson("evil", "x")), { allowedOwners: ["octo"] });
    expect((await h.call("github_get_repository", { owner: "octo", repo: "x" })).success).toBe(true);
    const n = h.mock.fetched.length;
    expect((await h.call("github_get_repository", { owner: "evil", repo: "x" })).error?.code).toBe("PERMISSION_DENIED");
    expect(h.mock.fetched).toHaveLength(n);
  });

  it("only allowedRepositories: only the named repo is readable", async () => {
    const h = await harness(everything, { allowedRepositories: ["octo/hello"] });
    expect((await h.call("github_get_repository", R)).success).toBe(true);
    const n = h.mock.fetched.length;
    expect((await h.call("github_get_repository", { owner: "octo", repo: "other" })).error?.code).toBe("PERMISSION_DENIED");
    expect(h.mock.fetched).toHaveLength(n);
  });

  it("both lists: repo OR owner grants access", async () => {
    const h = await harness(everything, { allowedRepositories: ["octo/hello"], allowedOwners: ["team"] });
    expect((await h.call("github_get_repository", R)).success).toBe(true);
    expect((await h.call("github_get_repository", { owner: "team", repo: "z" })).success).toBe(true);
    expect((await h.call("github_get_repository", { owner: "nope", repo: "z" })).error?.code).toBe("PERMISSION_DENIED");
  });

  it("unset-token warning is kept (ADR-063)", async () => {
    const h = await harness(everything, { tokenEnv: "GH_T", allowedOwners: ["octo"] });
    const r = await h.call("github_get_repository", R);
    expect(r.warnings?.join(" ")).toMatch(/not set/);
  });
});

describe("P3-08 validate, then compare case-insensitively", () => {
  it("mixed-case valid names still match", async () => {
    const h = await harness(everything, { allowedRepositories: ["Octo/Hello"] });
    expect((await h.call("github_get_repository", { owner: "OCTO", repo: "hello" })).success).toBe(true);
  });

  it("service rejects invalid names (INVALID_INPUT) before comparing or requesting, even if they would match after folding", async () => {
    const mock = await startGithubMock(everything);
    mocks.push(mock);
    const svc = createGithubService({
      config: { allowedRepositories: [], allowedOwners: ["octo", ".."] },
      limits: DEFAULT_LIMITS,
      fetch: mock.fetch,
      getEnv: () => undefined,
    });
    for (const [o, r] of [["octo", "a/b"], ["octo", ".."], ["..", "x"], ["oc to", "x"], ["octo", "x".repeat(101)]] as const) {
      await expect(svc.getRepository(o, r)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(mock.fetched).toHaveLength(0);
  });
});

describe("P3-06 code point safe truncation", () => {
  it("never splits a surrogate pair at the cut", () => {
    const t = truncateCodePoints("ab\u{1F600}cd", 3);
    expect(t.truncated).toBe(true);
    expect(t.text).toBe("ab");
    expect(truncateCodePoints("ab\u{1F600}cd", 4).text).toBe("ab\u{1F600}");
    expect(truncateCodePoints("abc", 3)).toEqual({ text: "abc", truncated: false });
    expect(truncateCodePoints("abc", 0).text).toBe("");
  });

  it("issue body with emoji at the cap has no lone surrogate", async () => {
    const cap = DEFAULT_LIMITS.maxCellChars;
    const body = "x".repeat(cap - 1) + "\u{1F600}" + "tail";
    const h = await harness((_q, res) => json(res, 200, { ...issueJson(1), body }), { allowedOwners: ["octo"] });
    const r = await h.call("github_get_issue", { ...R, number: 1 });
    expect(r.meta?.["truncated"]).toBe(true);
    expect(r.data.body).toBe("x".repeat(cap - 1));
    expect(r.data.body.isWellFormed()).toBe(true);
  });
});

describe("P3-07 per-field caps", () => {
  it("titles, label count, label length are capped individually (get_issue)", async () => {
    const title = "T".repeat(2000);
    const labels = Array.from({ length: 150 }, () => "L".repeat(400));
    const h = await harness((_q, res) => json(res, 200, { ...issueJson(1), title, labels }), { allowedOwners: ["octo"] });
    const r = await h.call("github_get_issue", { ...R, number: 1 });
    expect(r.error).toBeUndefined();
    expect(r.data.title.length).toBe(DEFAULT_LIMITS.maxSnippetChars);
    expect(r.data.labels).toHaveLength(DEFAULT_LIMITS.maxResults);
    expect(r.data.labels.every((l: string) => l.length <= DEFAULT_LIMITS.maxSnippetChars)).toBe(true);
    expect(r.meta?.["truncated"]).toBe(true);
  });

  it("PR titles and changed-file names are capped", async () => {
    const title = "P".repeat(5000);
    const filename = "d/".repeat(5000);
    const h = await harness(
      (req, res) => {
        const p = new URL(req.url ?? "/", "http://x").pathname;
        if (p.endsWith("/files")) return json(res, 200, [{ filename, previous_filename: filename, status: "modified", additions: 1, deletions: 0, changes: 1 }]);
        json(res, 200, { ...pullJson(1), title });
      },
      { allowedOwners: ["octo"] },
    );
    const r = await h.call("github_get_pull_request", { ...R, number: 1 });
    expect(r.data.title.length).toBe(DEFAULT_LIMITS.maxSnippetChars);
    expect(r.data.files[0].filename.length).toBe(DEFAULT_LIMITS.maxSnippetChars);
    expect(r.data.files[0].previousFilename.length).toBe(DEFAULT_LIMITS.maxSnippetChars);
    expect(r.meta?.["truncated"]).toBe(true);
  });

  it("commit file names are capped", async () => {
    const filename = "f".repeat(5000);
    const h = await harness((_q, res) => json(res, 200, { ...commitJson("abc1234"), files: [{ filename, status: "added", additions: 1, deletions: 0, changes: 1 }] }), { allowedOwners: ["octo"] });
    const r = await h.call("github_get_commit", { ...R, sha: "abc1234" });
    expect(r.data.files[0].filename.length).toBe(DEFAULT_LIMITS.maxSnippetChars);
  });
});
