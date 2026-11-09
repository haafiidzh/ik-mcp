import { rmSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { commitJson, issueJson, json, pullJson, repoJson, startGithubMock, type GithubMock, type MockHandler } from "../fixtures/github-mock.js";
import { makeSqliteFixture, type SqliteFixture } from "../fixtures/sqlite-fixture.js";
import { resourceClient, type ResourceClient } from "../fixtures/resource-harness.js";
import { GH_CANARY, makeWorkspace, tmpDir, workflowConfig } from "../fixtures/workflow-harness.js";

/** P6-01: resources through the REAL createServer + SDK transport (in-memory), temp workspace, sqlite fixture, GitHub mock. */

let tmp: string;
let ws: string;
let fx: SqliteFixture;
const mocks: GithubMock[] = [];
const clients: ResourceClient[] = [];

beforeAll(() => {
  tmp = tmpDir("dwmcp-res-");
  ws = makeWorkspace(tmp);
  fx = makeSqliteFixture();
});
afterAll(() => {
  fx.cleanup();
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

const ghHandler: MockHandler = (req, res) => {
  const p = (req.url ?? "").split("?")[0] ?? "";
  if (p === "/repos/octo/hello") return json(res, 200, repoJson());
  if (p === "/repos/octo/hello/issues") return json(res, 200, [issueJson(1), issueJson(2)]);
  if (p === "/repos/octo/hello/pulls") return json(res, 200, [pullJson(3)]);
  if (p === "/repos/octo/hello/commits") return json(res, 200, [commitJson()]);
  return json(res, 404, { message: "Not Found" });
};

async function open(o: { fs?: boolean; db?: boolean; gh?: boolean }): Promise<ResourceClient> {
  const mock = o.gh === true ? await startGithubMock(ghHandler) : undefined;
  if (mock) mocks.push(mock);
  const cfg = workflowConfig({ tmp, ws, fs: o.fs !== false, ...(o.db ? { dbPath: fx.dbPath } : {}), ...(o.gh ? { github: {} } : {}) });
  const c = await resourceClient(cfg, { ...(mock ? { mock } : {}), env: { DEVWS_T_GH: GH_CANARY } });
  clients.push(c);
  return c;
}

describe("resource registration follows enabled packs", () => {
  it("registers nothing when no pack is enabled", async () => {
    const c = await open({ fs: false });
    expect((await c.rawRequest("resources/list"))["error"]).toBeDefined();
  });
  it("filesystem only", async () => {
    const c = await open({});
    expect((await c.list()).map((r) => r.uri)).toContain("workspace://list");
    expect((await c.templates()).map((t) => t.uriTemplate).sort()).toEqual(["filesystem://{workspaceId}/tree", "workspace://{workspaceId}/overview"]);
  });
  it("all packs", async () => {
    const c = await open({ db: true, gh: true });
    expect((await c.templates()).map((t) => t.uriTemplate).sort()).toEqual([
      "database://{connectionName}/schema",
      "filesystem://{workspaceId}/tree",
      "github://{owner}/{repository}/summary",
      "workspace://{workspaceId}/overview",
    ]);
    const listed = (await c.list()).map((r) => r.uri);
    expect(listed).toEqual(expect.arrayContaining(["workspace://list", "github://octo/hello/summary", "database://sample/schema", "filesystem://main/tree", "workspace://main/overview"]));
  });
  it("disabled github/database resources are unreadable", async () => {
    const c = await open({});
    expect((await c.read("github://octo/hello/summary")).ok).toBe(false);
    expect((await c.read("database://sample/schema")).ok).toBe(false);
  });
});

describe("resource reads", () => {
  it("workspace://list", async () => {
    const c = await open({ db: true, gh: true });
    const r = await c.read("workspace://list");
    expect(r.ok && r.mimeType).toBe("application/json");
    if (!r.ok) throw new Error(r.message);
    expect(r.json["success"]).toBe(true);
    expect(r.json["data"].workspaces).toEqual([{ id: "main", name: "Main", filesystem: true, github: "octo/hello", databases: ["sample"], apis: [] }]);
    expect(r.json["data"].writesAllowed).toBe(false);
  });
  it("filesystem tree is bounded and hides blocked files", async () => {
    const c = await open({});
    const r = await c.read("filesystem://main/tree");
    if (!r.ok) throw new Error(r.message);
    expect(r.text).toContain("orders.ts");
    expect(r.text).not.toContain(".env");
    expect(r.json["meta"].source).toBe("resource:filesystem_tree");
  });
  it("overview sections", async () => {
    const c = await open({ db: true, gh: true });
    const r = await c.read("workspace://main/overview");
    if (!r.ok) throw new Error(r.message);
    const ids = (r.json["data"].sections as { id: string }[]).map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["filesystem", "github", "database:sample", "git"]));
  });
  it("github summary", async () => {
    const c = await open({ gh: true });
    const r = await c.read("github://octo/hello/summary");
    if (!r.ok) throw new Error(r.message);
    expect(r.json["data"].repository.fullName).toBe("octo/hello");
    expect(r.json["data"].openIssues.items).toHaveLength(2);
    expect(r.json["data"].openPullRequests.items).toHaveLength(1);
    expect(r.json["data"].recentCommits.items).toHaveLength(1);
  });
  it("github summary of a non-allowlisted repository is denied and makes no request", async () => {
    const c = await open({ gh: true });
    const before = mocks[0]?.seen.length ?? 0;
    const r = await c.read("github://evil/other/summary");
    expect(r.ok).toBe(false);
    expect(mocks[0]?.seen.length).toBe(before);
  });
  it("database schema", async () => {
    const c = await open({ db: true });
    const r = await c.read("database://sample/schema");
    if (!r.ok) throw new Error(r.message);
    expect(r.json["data"].dialect).toBe("sqlite");
    expect(r.json["data"].tables.length).toBeGreaterThan(0);
    expect(r.json["data"].tables[0].columns.length).toBeGreaterThan(0);
  });
  it("unknown connection/workspace is an error", async () => {
    const c = await open({ db: true });
    expect((await c.read("database://nope/schema")).ok).toBe(false);
    expect((await c.read("filesystem://nope/tree")).ok).toBe(false);
    expect((await c.read("workspace://nope/overview")).ok).toBe(false);
  });
  it("audits metadata only, as read", async () => {
    const c = await open({});
    await c.read("filesystem://main/tree");
    const e = c.audit.find((a) => a.tool === "resource:filesystem_tree");
    expect(e).toMatchObject({ outcome: "success", write: false, resourceRef: "main" });
  });
});

describe("resource read errors carry the real code (P6-08/P6-11)", () => {
  it("NOT_FOUND for an unknown workspace, connection", async () => {
    const c = await open({ db: true });
    for (const uri of ["workspace://nope/overview", "filesystem://nope/tree", "database://nope/schema"]) {
      const r = await c.read(uri);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message, uri).toMatch(/^NOT_FOUND: /);
    }
  });
  it("PERMISSION_DENIED for a repository outside the allowlist, without any upstream request", async () => {
    const c = await open({ gh: true });
    const before = mocks[0]?.seen.length ?? 0;
    const r = await c.read("github://evil/other/summary");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/^PERMISSION_DENIED: /);
    expect(mocks[0]?.seen.length).toBe(before);
  });
  it("INVALID_INPUT for an over-long template variable", async () => {
    const c = await open({});
    const r = await c.read(`filesystem://${"a".repeat(101)}/tree`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/^INVALID_INPUT: /);
  });
  it("none of them is a generic INTERNAL_ERROR or leaks a stack", async () => {
    const c = await open({});
    const r = await c.read("workspace://nope/overview");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toMatch(/INTERNAL_ERROR|\bat .*\(|node_modules/);
  });
});
