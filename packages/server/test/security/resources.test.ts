import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { commitJson, issueJson, json, pullJson, repoJson, startGithubMock, type GithubMock } from "../fixtures/github-mock.js";
import { mockProfile, startMockApi, type MockApi } from "../fixtures/mock-api.js";
import { makeSqliteFixture, type SqliteFixture } from "../fixtures/sqlite-fixture.js";
import { resourceClient, type ResourceClient } from "../fixtures/resource-harness.js";
import { ENV_CANARY, GH_CANARY, hashTree, makeWorkspace, tmpDir, workflowConfig } from "../fixtures/workflow-harness.js";

/** P6-01 security rows: resources never expose secrets, env values, absolute paths, hosts or file contents, and never write. */

let tmp: string;
let ws: string;
let fx: SqliteFixture;
let api: MockApi;
let mock: GithubMock | undefined;
let client: ResourceClient | undefined;

beforeAll(async () => {
  tmp = tmpDir("dwmcp-ressec-");
  ws = makeWorkspace(tmp);
  writeFileSync(path.join(ws, "id_rsa"), `KEY ${ENV_CANARY}`);
  fx = makeSqliteFixture();
  api = await startMockApi();
});
afterAll(async () => {
  await api.close();
  fx.cleanup();
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(async () => {
  await client?.close();
  await mock?.close();
  client = undefined;
  mock = undefined;
});

const URIS = ["workspace://list", "workspace://main/overview", "filesystem://main/tree", "github://octo/hello/summary", "database://sample/schema"];

async function open(): Promise<ResourceClient> {
  mock = await startGithubMock((req, res) => {
    const p = (req.url ?? "").split("?")[0] ?? "";
    if (p === "/repos/octo/hello") return json(res, 200, repoJson());
    if (p.endsWith("/issues")) return json(res, 200, [issueJson(1)]);
    if (p.endsWith("/pulls")) return json(res, 200, [pullJson(3)]);
    if (p.endsWith("/commits")) return json(res, 200, [commitJson()]);
    return json(res, 404, {});
  });
  const cfg = workflowConfig({ tmp, ws, dbPath: fx.dbPath, api: mockProfile(api), github: {} });
  client = await resourceClient(cfg, { mock, env: { DEVWS_T_GH: GH_CANARY } });
  return client;
}

describe("resource content security", () => {
  it("never contains secrets, env values, absolute paths, hosts, env var names or file contents", async () => {
    const c = await open();
    const before = hashTree(ws);
    const bodies: string[] = [];
    for (const u of URIS) {
      const r = await c.read(u);
      if (!r.ok) throw new Error(`${u}: ${r.message}`);
      bodies.push(r.text);
    }
    const all = bodies.join("\n") + c.logs.join("\n") + JSON.stringify(c.audit);
    for (const forbidden of [GH_CANARY, ENV_CANARY, "DEVWS_T_GH", ws, tmp, fx.dbPath, `127.0.0.1:${api.port}`, "id_rsa"]) {
      expect(all, `leak: ${forbidden}`).not.toContain(forbidden);
    }
    expect(hashTree(ws)).toBe(before);
  });

  it("resource URIs cannot expand configuration (paths, URLs, traversal)", async () => {
    const c = await open();
    const bad = [
      "filesystem://%2Ftmp/tree",
      "filesystem://..%2F..%2Fetc/tree",
      `filesystem://${encodeURIComponent(ws)}/tree`,
      "workspace://..%2Fx/overview",
      "database://%2Ftmp%2Fx.db/schema",
      `database://${encodeURIComponent(`sqlite:${fx.dbPath}`)}/schema`,
      "github://evil/repo/summary",
      "github://octo%2F..%2Fother/hello/summary",
    ];
    for (const u of bad) {
      const r = await c.read(u);
      expect(r.ok, u).toBe(false);
    }
    expect(mock?.fetched.every((f) => f.includes("/repos/octo/hello"))).toBe(true);
  });

  it("is read-only: no resource mutates anything and none is subscribable or writable", async () => {
    const c = await open();
    const fp = hashTree(ws);
    for (const u of URIS) await c.read(u);
    expect(c.audit.filter((a) => a.tool.startsWith("resource:")).every((a) => a.write === false)).toBe(true);
    expect(hashTree(ws)).toBe(fp);
  });

  it("error messages stay generic (no stack, no paths)", async () => {
    const c = await open();
    const r = await c.read("filesystem://nope/tree");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).not.toMatch(/\bat \S+\.(ts|js):\d+/);
      expect(r.message).not.toContain(tmp);
    }
  });
});
