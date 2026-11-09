import { describe, expect, expectTypeOf, it } from "vitest";
import { parseConfigText } from "../../src/config/load-config.js";
import { createAuditLog, type AuditEntry } from "../../src/core/audit.js";
import { AppError } from "../../src/core/errors.js";
import { DEFAULT_LIMITS } from "../../src/core/limits.js";
import { createLogger } from "../../src/core/logger.js";
import { createRedactor } from "../../src/core/redact.js";
import { ok } from "../../src/core/response.js";
import type { ApiService } from "../../src/integrations/custom-api/api.service.js";
import type { DatabaseRegistry } from "../../src/integrations/database/database.registry.js";
import type { FilesystemService, TreeNode } from "../../src/integrations/filesystem/filesystem.service.js";
import type { GithubService } from "../../src/integrations/github/github.service.js";
import { createGithubService } from "../../src/integrations/github/github.service.js";
import type { LocalGit } from "../../src/integrations/git/local-git.js";
import { runTool, type ServerDeps } from "../../src/server/register-tools.js";
import { buildWorkspaceActivityTool } from "../../src/tools/workflows/workspace-activity.js";
import { buildWorkspaceOverviewTool, type OverviewServices } from "../../src/tools/workflows/workspace-overview.js";
import type { ActivityGithubPort } from "../../src/workflows/activity-summary.js";
import { analyzeTree, type OverviewApiPort, type OverviewDatabaseRegistryPort, type OverviewFsPort, type OverviewGithubPort } from "../../src/workflows/workspace-overview.js";

// Compile-time: the Ports accept the real services (wave 2 passes them without adapters).
expectTypeOf<FilesystemService>().toMatchTypeOf<OverviewFsPort>();
expectTypeOf<GithubService>().toMatchTypeOf<OverviewGithubPort>();
expectTypeOf<GithubService>().toMatchTypeOf<ActivityGithubPort>();
expectTypeOf<DatabaseRegistry>().toMatchTypeOf<OverviewDatabaseRegistryPort>();
expectTypeOf<ApiService>().toMatchTypeOf<OverviewApiPort>();

const TREE: TreeNode = {
  name: ".",
  type: "dir",
  children: [
    { name: "README.md", type: "file" },
    { name: "package.json", type: "file" },
    { name: "vite.config.ts", type: "file" },
    { name: "Dockerfile", type: "file" },
    { name: "main.ts", type: "file" },
    { name: "Makefile", type: "file" },
    { name: "db", type: "dir", children: [{ name: "migrations", type: "dir", depthLimited: true }, { name: "x.sql", type: "file" }] },
    { name: "src", type: "dir", children: [{ name: "a.ts", type: "file" }, { name: "b.ts", type: "file" }] },
  ],
};

const fsPort: OverviewFsPort = {
  getDirectoryTree: async () => ok({ root: TREE, counts: { files: 10, directories: 3, symlinks: 0 } }, { source: "filesystem" }),
};

function config(extra: Record<string, unknown> = {}) {
  return parseConfigText(
    JSON.stringify({
      filesystem: { enabled: true, allowedRoots: ["/tmp"] },
      github: { enabled: true, allowedRepositories: ["acme/widgets"] },
      databases: [
        { name: "main-db", type: "sqlite", enabled: true, databasePath: "/tmp/x.db" },
        { name: "off-db", type: "sqlite", enabled: false, databasePath: "/tmp/y.db" },
      ],
      customApis: [],
      workspaces: [{ id: "w1", name: "W", rootPath: "/tmp", github: "acme/widgets", databases: ["main-db", "off-db"], apis: [] }, { id: "w2", name: "W2", rootPath: "/tmp" }],
      ...extra,
    }),
  );
}

function serverDeps(cfg = config()): { deps: ServerDeps; audit: AuditEntry[] } {
  const audit: AuditEntry[] = [];
  const log = createAuditLog();
  const real = log.record.bind(log);
  log.record = (e) => (audit.push(e as AuditEntry), real(e));
  return {
    audit,
    deps: { config: cfg, limits: { ...DEFAULT_LIMITS }, logger: createLogger({ level: "error", write: () => undefined }), audit: log, redactor: createRedactor(), startedAtMs: Date.now() },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only loose JSON view
type Res = { success: boolean; data?: any; error?: { code: string; message: string }; meta?: Record<string, any> };
async function callTool(h: (a: never) => Promise<{ content: { text: string }[] }>, args: Record<string, unknown>): Promise<Res & { raw: string }> {
  const r = await h(args as never);
  const raw = r.content[0]?.text ?? "";
  return { ...(JSON.parse(raw) as Res), raw };
}

const repoData = { owner: "acme", name: "widgets", fullName: "acme/widgets", description: "d", private: false, visibility: "public", defaultBranch: "main", topics: ["a"], stars: 1, forks: 2, openIssues: 3, language: "TS", archived: false, pushedAt: null, htmlUrl: "https://github.com/acme/widgets" };
const outcome = <T>(data: T) => ({ data, nextPageAvailable: false, truncated: false, warnings: [] as string[] });

function overviewTool(services: Partial<OverviewServices>, cfg = config()) {
  const { deps, audit } = serverDeps(cfg);
  const tool = buildWorkspaceOverviewTool({ deps, runTool, services: async () => ({ fs: fsPort, ...services }) });
  return { tool, audit, call: (args: Record<string, unknown>) => callTool(tool.handler as never, args) };
}

describe("analyzeTree", () => {
  it("counts extensions and finds notable files deterministically", () => {
    const a = analyzeTree(TREE);
    expect(a.extensions[0]).toEqual({ extension: "ts", count: 4 });
    expect(a.extensions.some((e) => e.extension === "(none)" && e.count === 2)).toBe(true); // Dockerfile, Makefile
    expect(a.notableFiles.map((n) => `${n.kind}:${n.path}`)).toEqual([
      "dockerfile:Dockerfile",
      "readme:README.md",
      "migrations-dir:db/migrations",
      "package-json:package.json",
      "config:vite.config.ts",
    ]);
  });
});

describe("workspace_get_overview", () => {
  it("is read-only with strict input and no outputSchema", () => {
    const { tool } = overviewTool({});
    expect(tool.name).toBe("workspace_get_overview");
    expect(tool.config.annotations.readOnlyHint).toBe(true);
    expect(tool.config.inputSchema.safeParse({ workspace: "w1", path: "/etc" }).success).toBe(false);
    expect("outputSchema" in tool.config).toBe(false);
  });

  it("full overview with every source", async () => {
    const git: LocalGit = { inspect: async () => ({ status: "ok", partial: false, data: { branch: "main", detachedHead: false, empty: false, lastCommit: null, workingTree: { clean: true, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 } } }) };
    const registry: OverviewDatabaseRegistryPort = { names: () => ["main-db"], get: async () => ({ listTablesPage: async () => ({ items: [{ name: "t1" }, { name: "t2" }] as never, truncated: false }) }) };
    const { call, audit } = overviewTool({ github: { getRepository: async () => outcome(repoData) }, databaseRegistry: registry, git });
    const r = await call({ workspace: "w1" });
    expect(r.success).toBe(true);
    const by = Object.fromEntries((r.data.sections as { id: string; status: string; data?: unknown }[]).map((s) => [s.id, s]));
    expect(by["filesystem"].status).toBe("ok");
    expect(by["github"].status).toBe("ok");
    expect(by["github"].data.defaultBranch).toBe("main");
    expect(by["github"].data.htmlUrl).toBeUndefined();
    expect(by["database:main-db"].data).toMatchObject({ tableCount: 2, tableCountIsLowerBound: false, type: "sqlite" });
    expect(by["database:off-db"].status).toBe("disabled");
    expect(by["git"].status).toBe("ok");
    expect(r.meta?.["source"]).toBe("workflow:workspace_get_overview");
    expect(audit.at(-1)).toMatchObject({ tool: "workspace_get_overview", resourceRef: "w1", outcome: "success" });
  });

  it("disabled and unlinked sources are section statuses", async () => {
    const { call } = overviewTool({});
    const r = await call({ workspace: "w2" });
    expect(r.success).toBe(true);
    const by = Object.fromEntries((r.data.sections as { id: string; status: string }[]).map((s) => [s.id, s.status]));
    expect(by).toEqual({ filesystem: "ok", github: "disabled", git: "disabled" });
    const gh = r.data.sections.find((s: { id: string }) => s.id === "github");
    expect(gh.source).toEqual({ kind: "github", ref: "no-repo" });
    expect(JSON.stringify(r.data)).not.toContain("none/none");
    const linked = await overviewTool({ github: { getRepository: async () => outcome(repoData) } }).call({ workspace: "w2" });
    expect(linked.data.sections.find((s: { id: string }) => s.id === "github").status).toBe("unavailable");
  });

  it("git unavailable becomes an unavailable section with a fixed reason", async () => {
    const git: LocalGit = { inspect: async () => ({ status: "unavailable", reason: "git is not installed or not on PATH." }) };
    const r = await overviewTool({ git }).call({ workspace: "w1" });
    const g = r.data.sections.find((s: { id: string }) => s.id === "git");
    expect(g.status).toBe("unavailable");
    expect(g.data).toBeUndefined();
    expect(g.error.message).toContain("not installed");
    expect(r.meta?.["partial"]).toBe(true);
  });

  it("empty GitHub allowlist yields a PERMISSION_DENIED error section, not a crash", async () => {
    const svc = createGithubService({ config: { allowedRepositories: [], allowedOwners: [] }, limits: DEFAULT_LIMITS, client: {} as never });
    const r = await overviewTool({ github: svc }).call({ workspace: "w1" });
    expect(r.success).toBe(true);
    const g = r.data.sections.find((s: { id: string }) => s.id === "github");
    expect(g.status).toBe("error");
    expect(g.error.code).toBe("PERMISSION_DENIED");
    expect(r.data.sections.find((s: { id: string }) => s.id === "filesystem").status).toBe("ok");
  });

  it("a failing source does not reject the workflow and its message is scrubbed", async () => {
    const github: OverviewGithubPort = { getRepository: async () => { throw new AppError("INTEGRATION_UNAVAILABLE", "failed at /home/u/secret/dir/x token ghp_abcdefghijklmnopqrstuvwxyz0123456789"); } };
    const r = await overviewTool({ github }).call({ workspace: "w1" });
    expect(r.success).toBe(true);
    expect(r.raw).not.toContain("/home/u");
    expect(r.raw).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("API profile status makes no endpoint call", async () => {
    const cfg = config({ customApis: [{ name: "pay", enabled: true, baseUrl: "https://api.example.com" }, { name: "ghost", baseUrl: "https://ghost.example.com" }], workspaces: [{ id: "w1", name: "W", rootPath: "/tmp", apis: ["pay", "ghost"] }] });
    let calls = 0;
    const api: OverviewApiPort = { listProfiles: () => (calls++, [{ name: "pay", enabled: true, authType: "none", endpoints: 3 }]) };
    const r = await overviewTool({ api }, cfg).call({ workspace: "w1" });
    expect(calls).toBe(1);
    const by = Object.fromEntries((r.data.sections as { id: string; status: string; data?: { endpoints: number } }[]).map((s) => [s.id, s]));
    expect(by["api:pay"]?.data).toMatchObject({ endpoints: 3, checkedByCall: false });
    expect(by["api:ghost"]?.status).toBe("disabled");
    expect(r.raw).not.toContain("example.com");
  });

  it("unknown workspace is NOT_FOUND and never echoed to the audit log", async () => {
    const { call, audit } = overviewTool({});
    const r = await call({ workspace: "/etc/passwd" });
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe("NOT_FOUND");
    expect(audit.at(-1)?.resourceRef).toBe("unknown-workspace");
  });

  it("section source refs never contain paths or URLs", async () => {
    const r = await overviewTool({ github: { getRepository: async () => outcome(repoData) } }).call({ workspace: "w1" });
    for (const s of r.data.sections as { source: { ref: string } }[]) expect(s.source.ref).not.toMatch(/[\\]|:\/\/|^\//);
  });
});

describe("workspace_summarize_activity", () => {
  const issue = (n: number) => ({ number: n, title: `Issue ${n}`, state: "open", body: "x", author: "a", labels: ["bug"], assignees: [], commentsCount: 1, createdAt: "t", updatedAt: "u", closedAt: null, htmlUrl: "h", isPullRequest: false });
  const pr = (n: number, draft: boolean) => ({ number: n, title: `PR ${n}`, state: "open", draft, merged: null, mergedAt: null, body: "b", author: "a", headRef: "h", baseRef: "main", commentsCount: 0, changedFiles: null, additions: null, deletions: null, createdAt: "c", updatedAt: "u", htmlUrl: "h" });
  const commit = (s: string) => ({ sha: s.repeat(40).slice(0, 40), message: "subject line\n\nbody", authorName: "A", authorLogin: "al", authorDate: "d", htmlUrl: "h", additions: null, deletions: null, files: null });

  function tool(github: ActivityGithubPort | undefined, cfg = config()) {
    const { deps, audit } = serverDeps(cfg);
    const t = buildWorkspaceActivityTool({ deps, runTool, github: () => github });
    return { t, audit, call: (args: Record<string, unknown>) => callTool(t.handler as never, args) };
  }

  it("lists open issues, open PRs and commits with counts, default N=10 and clamping", async () => {
    const seen: unknown[] = [];
    const gh: ActivityGithubPort = {
      listIssues: async (_o, _r, a) => (seen.push(["issues", a]), outcome([issue(1), issue(2)])),
      listPullRequests: async (_o, _r, a) => (seen.push(["prs", a]), outcome([pr(3, true), pr(4, false)])),
      listCommits: async (_o, _r, a) => (seen.push(["commits", a]), outcome([commit("a"), commit("b")])),
    };
    const { call, t } = tool(gh);
    expect(t.name).toBe("workspace_summarize_activity");
    expect(t.config.annotations.readOnlyHint).toBe(true);
    const r = await call({ workspace: "w1" });
    expect(r.success).toBe(true);
    const by = Object.fromEntries((r.data.sections as { id: string; data: { items: unknown[]; counts: unknown } }[]).map((s) => [s.id, s.data]));
    expect(by["issues"]?.counts).toEqual({ byState: { open: 2 } });
    expect(by["pull_requests"]?.counts).toEqual({ byState: { open: 2 }, draft: 1, ready: 1 });
    expect(by["commits"]?.items[0]).toMatchObject({ message: "subject line", author: "al" });
    expect(seen).toContainEqual(["issues", { limit: 10, state: "open" }]);
    expect(seen).toContainEqual(["commits", { limit: 10 }]); // no branch argument: the default branch
    seen.length = 0;
    await call({ workspace: "w1", count: 5000 });
    expect(seen).toContainEqual(["issues", { limit: DEFAULT_LIMITS.maxResults, state: "open" }]);
  });

  it("one failing list does not fail the others; empty allowlist is PERMISSION_DENIED per section", async () => {
    const svc = createGithubService({ config: { allowedRepositories: [], allowedOwners: [] }, limits: DEFAULT_LIMITS, client: {} as never });
    const r = await tool(svc).call({ workspace: "w1" });
    expect(r.success).toBe(true);
    expect(r.data.sections.map((s: { error: { code: string } }) => s.error.code)).toEqual(["PERMISSION_DENIED", "PERMISSION_DENIED", "PERMISSION_DENIED"]);
    const mixed = await tool({
      listIssues: async () => { throw new AppError("RATE_LIMITED", "slow down"); },
      listPullRequests: async () => outcome([]),
      listCommits: async () => outcome([]),
    }).call({ workspace: "w1" });
    expect(mixed.data.sections.map((s: { status: string }) => s.status)).toEqual(["error", "ok", "ok"]);
    expect(mixed.meta?.["partial"]).toBe(true);
  });

  it("disabled GitHub, unlinked workspace, extra args and unknown workspace", async () => {
    expect((await tool(undefined).call({ workspace: "w1" })).data.sections.every((s: { status: string }) => s.status === "disabled")).toBe(true);
    const gh: ActivityGithubPort = { listIssues: async () => outcome([]), listPullRequests: async () => outcome([]), listCommits: async () => outcome([]) };
    expect((await tool(gh).call({ workspace: "w2" })).data.sections.every((s: { status: string }) => s.status === "unavailable")).toBe(true);
    expect(tool(gh).t.config.inputSchema.safeParse({ workspace: "w1", repo: "evil/repo" }).success).toBe(false);
    expect((await tool(gh).call({ workspace: "nope" })).error?.code).toBe("NOT_FOUND");
  });
});
