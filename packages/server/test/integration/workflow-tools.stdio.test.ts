import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mockProfile, startMockApi, type MockApi } from "../fixtures/mock-api.js";
import { fileFingerprint, makeSqliteFixture, type SqliteFixture } from "../fixtures/sqlite-fixture.js";
import { byId, ENV_CANARY, GH_CANARY, hashTree, makeWorkspace, sectionsOf, tmpDir, workflowConfig, workflowNames, WORKFLOW_TOOLS, type Res } from "../fixtures/workflow-harness.js";

/**
 * The five workflow tools over the real BUILT server (dist/index.js) on stdio (P5-05). No GitHub
 * network: the workspace links octo/hello while the allowlist names another repository, so every
 * GitHub-backed section is decided (PERMISSION_DENIED) before any request. Mocked GitHub behaviour is
 * covered in workflow-tools.e2e.test.ts. Run `pnpm build` first.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../..");
const entry = path.join(pkgRoot, "dist/index.js");

let tmp: string;
let ws: string;
let fx: SqliteFixture;
let api: MockApi;
let auditPath: string;
const cfgs = new Map<string, string>();
const children: ChildProcessWithoutNullStreams[] = [];

beforeAll(async () => {
  if (!existsSync(entry)) throw new Error("dist/index.js missing: run `pnpm build` before this test");
  tmp = tmpDir("dwmcp-wfs-");
  ws = makeWorkspace(tmp);
  fx = makeSqliteFixture();
  api = await startMockApi();
  auditPath = path.join(tmp, "audit.jsonl");
  const write = (name: string, o: Record<string, unknown>): void => {
    const p = path.join(tmp, `${name}.json`);
    writeFileSync(p, JSON.stringify(workflowConfig({ tmp, ws, server: { auditLogPath: auditPath }, ...o } as Parameters<typeof workflowConfig>[0])));
    cfgs.set(name, p);
  };
  const gh = { allowedRepositories: ["other/thing"] };
  write("none", { fs: false });
  write("fs", {});
  write("fsdb", { dbPath: fx.dbPath });
  write("fsapi", { api: mockProfile(api) });
  write("fsgh", { github: gh });
  write("all", { dbPath: fx.dbPath, api: mockProfile(api), github: gh });
  const slow = path.join(tmp, "slow.json");
  writeFileSync(slow, JSON.stringify({ ...workflowConfig({ tmp, ws, dbPath: fx.dbPath, api: mockProfile(api), github: gh }), limits: { workflowTimeoutMs: 1 } }));
  cfgs.set("slow", slow);
});
afterAll(async () => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  await api.close();
  fx.cleanup();
  rmSync(tmp, { recursive: true, force: true });
});

class Client {
  readonly out: string[] = [];
  readonly err: string[] = [];
  private nextId = 1;
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<number | null>;
  constructor(cfg: string) {
    this.child = spawn(process.execPath, [entry, "--config", cfg], {
      cwd: pkgRoot,
      env: { ...process.env, DEVWORKSPACE_CONFIG: "", DEVWS_T_GH: GH_CANARY },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(this.child);
    let buf = "";
    this.child.stdout.setEncoding("utf8").on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        this.out.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    this.child.stderr.setEncoding("utf8").on("data", (d: string) => this.err.push(d));
    this.exited = new Promise((res) => this.child.on("exit", (c) => res(c)));
  }
  private async request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }) + "\n");
    return this.waitFor(id, method);
  }
  /** Poll until the response with this id arrives (no fixed pre-sleep; fails with stderr after 20 s). */
  private async waitFor(id: number, what: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 400; i++) {
      for (const l of this.out) {
        const m = JSON.parse(l) as Record<string, unknown>;
        if (m["id"] === id) return m;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timeout on ${what}; stderr=${this.err.join("")}`);
  }
  /** The initialize response is the readiness signal. */
  async init(): Promise<void> {
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }
  async tools(): Promise<{ name: string; annotations?: Record<string, unknown>; outputSchema?: unknown }[]> {
    return ((await this.request("tools/list"))["result"] as { tools: never[] }).tools;
  }
  async call(name: string, args: Record<string, unknown>): Promise<{ res: Res; text: string }> {
    const r = (await this.request("tools/call", { name, arguments: args }))["result"] as { content: { text: string }[] };
    const text = r.content[0]?.text ?? "";
    try {
      return { res: JSON.parse(text) as Res, text };
    } catch {
      return { res: { success: false, error: { code: "INVALID_INPUT", message: text } }, text };
    }
  }
  sendCall(name: string, args: Record<string, unknown>): void {
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  }
  async close(): Promise<number | null> {
    this.child.stdin.end();
    return Promise.race([this.exited, new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
  }
}

const open = async (cfg: string): Promise<Client> => {
  const c = new Client(cfgs.get(cfg) ?? cfg);
  await c.init();
  return c;
};

describe("workflow tool registration over stdio", () => {
  const cases: [string, string[]][] = [
    ["none", []],
    ["fs", ["workspace_get_overview"]],
    ["fsdb", ["workspace_get_overview", "workspace_inspect_data_flow"]],
    ["fsapi", ["workspace_get_overview", "workspace_inspect_data_flow"]],
    ["fsgh", ["workspace_find_issue_context", "workspace_generate_change_plan", "workspace_get_overview", "workspace_summarize_activity"]],
    ["all", WORKFLOW_TOOLS],
  ];
  for (const [cfg, expected] of cases) {
    it(`${cfg}: ${expected.length} workflow tool(s), readOnlyHint, no outputSchema, packs.workflows matches`, async () => {
      const c = await open(cfg);
      const wf = (await c.tools()).filter((t) => t.name.startsWith("workspace_"));
      expect(workflowNames(wf.map((t) => t.name))).toEqual([...expected].sort());
      for (const t of wf) {
        expect(t.annotations).toMatchObject({ readOnlyHint: true });
        expect(t.outputSchema).toBeUndefined();
      }
      const st = await c.call("server_get_status", {});
      expect((st.res.data as { packs: { workflows: boolean } }).packs.workflows).toBe(expected.length > 0);
      expect(await c.close()).toBe(0);
    }, 30000);
  }
});

describe("workflow tools over stdio", () => {
  it("overview, data flow (sqlite and api), github denied, S19, S21, no writes", async () => {
    const wsBefore = hashTree(ws);
    const dbBefore = fileFingerprint(fx.dbPath);
    const c = await open("all");
    const apiSeen = api.seen.length;
    const overview = await c.call("workspace_get_overview", { workspace: "main" });
    expect(overview.res.success).toBe(true);
    expect(byId(overview.res, "git") ?? sectionsOf(overview.res).find((s) => /git/i.test(s.id))).toBeDefined();
    const gh = sectionsOf(overview.res).find((s) => s.source.kind === "github");
    expect(gh?.error?.code).toBe("PERMISSION_DENIED");
    expect(overview.res.meta?.["partial"]).toBe(true);

    const flowDb = await c.call("workspace_inspect_data_flow", { workspace: "main", connection: "sample" });
    expect(flowDb.res.success).toBe(true);
    expect(JSON.stringify(byId(flowDb.res, "target")?.data)).toContain("customers");
    expect(JSON.stringify(byId(flowDb.res, "references")?.data)).toContain("src/orders.ts");
    const flowApi = await c.call("workspace_inspect_data_flow", { workspace: "main", profile: "mock" });
    expect(flowApi.res.success).toBe(true);
    expect(JSON.stringify(byId(flowApi.res, "references")?.data)).toContain("docs/api.md");

    const act = await c.call("workspace_summarize_activity", { workspace: "main" });
    const ctx = await c.call("workspace_find_issue_context", { workspace: "main", number: 12 });
    const plan = await c.call("workspace_generate_change_plan", { workspace: "main", number: 12 });
    for (const r of [act, ctx, plan]) {
      expect(r.res.success).toBe(true);
      expect(sectionsOf(r.res).filter((s) => s.source.kind === "github").every((s) => s.error?.code === "PERMISSION_DENIED")).toBe(true);
    }
    expect(JSON.stringify(plan.res.data)).toMatch(/not applied/i);

    const code = await c.close();
    expect(code).toBe(0);
    expect(api.seen.length).toBe(apiSeen);
    expect(hashTree(ws)).toBe(wsBefore);
    expect(fileFingerprint(fx.dbPath)).toEqual(dbBefore);
    // S21: stdout carries JSON-RPC only.
    for (const l of c.out) expect((JSON.parse(l) as Record<string, unknown>)["jsonrpc"]).toBe("2.0");
    // S19 / S5: canaries never on stdout, stderr or in the audit file.
    const audit = readFileSync(auditPath, "utf8");
    expect(audit).toContain("workspace_get_overview");
    for (const hay of [c.out.join("\n"), c.err.join(""), audit]) {
      expect(hay).not.toContain(GH_CANARY);
      expect(hay).not.toContain("WFCANARY");
      expect(hay).not.toContain(ENV_CANARY);
    }
  }, 60000);

  it("deadline: workflowTimeoutMs=1 still returns a structured result and the process exits 0 on SIGTERM", async () => {
    const c = await open("slow");
    const r = await c.call("workspace_get_overview", { workspace: "main" });
    expect(r.res.success).toBe(true);
    if (r.res.meta?.["deadlineHit"] === true) expect(r.res.meta?.["partial"]).toBe(true);
    c.child.kill("SIGTERM");
    expect(await Promise.race([c.exited, new Promise<null>((res) => setTimeout(() => res(null), 8000))])).toBe(0);
  }, 30000);

  it("SIGTERM with a request in flight exits 0 without a stray stdout line", async () => {
    const c = await open("all");
    c.sendCall("workspace_get_overview", { workspace: "main" });
    c.child.kill("SIGTERM");
    expect(await Promise.race([c.exited, new Promise<null>((res) => setTimeout(() => res(null), 8000))])).toBe(0);
    for (const l of c.out) expect((JSON.parse(l) as Record<string, unknown>)["jsonrpc"]).toBe("2.0");
  }, 30000);
});
