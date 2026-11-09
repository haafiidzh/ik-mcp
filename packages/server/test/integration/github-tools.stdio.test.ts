import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * github_* over the real server on stdio (P3-02). No live network: every call here is decided
 * before any request (allowlist / input validation). Mocked-API behaviour is covered in
 * test/security/github-tools.test.ts (the server has no way to point at a mock by design).
 */

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const entry = path.join(pkgRoot, "src/index.ts");
const tsxBin = path.join(pkgRoot, "node_modules/.bin/tsx");
const CANARY = "ghp_STDIOCANARY1234567890abcdefABCDEF";
const EIGHT = [
  "github_get_commit",
  "github_get_issue",
  "github_get_pull_request",
  "github_get_repository",
  "github_list_commits",
  "github_list_issues",
  "github_list_pull_requests",
  "github_list_repositories",
];

let tmp: string;
let onCfg: string;
let offCfg: string;
let auditPath: string;
const children: ChildProcessWithoutNullStreams[] = [];

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "dwmcp-gh-")));
  auditPath = path.join(tmp, "audit.jsonl");
  const gh = { tokenEnv: "DEVWS_T_GH", allowedRepositories: ["octo/hello"] };
  onCfg = path.join(tmp, "on.json");
  writeFileSync(onCfg, JSON.stringify({ server: { logLevel: "debug", auditLogPath: auditPath }, github: { enabled: true, ...gh } }));
  offCfg = path.join(tmp, "off.json");
  writeFileSync(offCfg, JSON.stringify({ server: { logLevel: "debug" }, github: { enabled: false, ...gh } }));
});
afterAll(() => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
});

class Client {
  readonly out: string[] = [];
  readonly err: string[] = [];
  private nextId = 1;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<number | null>;
  constructor(cfg: string) {
    this.child = spawn(tsxBin, [entry, "--config", cfg], {
      cwd: pkgRoot,
      env: { ...process.env, DEVWORKSPACE_CONFIG: "", DEVWS_T_GH: CANARY },
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
    for (let i = 0; i < 400; i++) {
      for (const l of this.out) {
        const m = JSON.parse(l) as Record<string, unknown>;
        if (m["id"] === id) return m;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timeout on ${method}; stderr=${this.err.join("")}`);
  }
  async init(): Promise<void> {
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }
  async tools(): Promise<{ name: string; annotations?: Record<string, unknown>; outputSchema?: unknown }[]> {
    return ((await this.request("tools/list"))["result"] as { tools: never[] }).tools;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only loose JSON view
  async call(name: string, args: Record<string, unknown>): Promise<{ res: { success: boolean; data?: any; error?: { code: string; message: string } }; text: string }> {
    const r = (await this.request("tools/call", { name, arguments: args }))["result"] as { content: { text: string }[]; isError?: boolean };
    const text = r.content[0]?.text ?? "";
    try {
      return { res: JSON.parse(text), text };
    } catch {
      // SDK-level input validation errors are plain text with isError.
      return { res: { success: false, error: { code: "INVALID_INPUT", message: text } }, text };
    }
  }
  async close(): Promise<number | null> {
    this.child.stdin.end();
    return Promise.race([this.exited, new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
  }
}

const open = async (cfg: string): Promise<Client> => {
  const c = new Client(cfg);
  await c.init();
  return c;
};

describe("github_* over stdio", () => {
  it("github.enabled=false: no github tool listed, packs.github false", async () => {
    const c = await open(offCfg);
    expect((await c.tools()).filter((t) => t.name.startsWith("github_"))).toEqual([]);
    const s = await c.call("server_get_status", {});
    expect(JSON.stringify(s.res.data)).toMatch(/"github":false/);
    await c.close();
  }, 30000);

  it("github.enabled=true: exactly the eight read tools, readOnlyHint, no outputSchema, no write tool", async () => {
    const c = await open(onCfg);
    const gh = (await c.tools()).filter((t) => t.name.startsWith("github_"));
    expect(gh.map((t) => t.name).sort()).toEqual(EIGHT);
    for (const t of gh) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true });
      expect(t.outputSchema).toBeUndefined();
    }
    const s = await c.call("server_get_status", {});
    expect(JSON.stringify(s.res.data)).toMatch(/"github":true/);
    await c.close();
  }, 30000);

  it("S16/S19/S21: allowlist denial and bad input over stdio; canary token never on stdout/stderr/audit; stdout is JSON-RPC only", async () => {
    const c = await open(onCfg);
    const denied = await c.call("github_get_repository", { owner: "evil", repo: "secret" });
    expect(denied.res.error?.code).toBe("PERMISSION_DENIED");
    const mixed = await c.call("github_list_issues", { owner: "OCTO", repo: "other" });
    expect(mixed.res.error?.code).toBe("PERMISSION_DENIED");
    const bad = await c.call("github_list_issues", { owner: "octo", repo: "hello", page: 0 });
    expect(bad.res.success).toBe(false);
    const bad2 = await c.call("github_get_repository", { owner: "../x", repo: "y" });
    expect(bad2.res.success).toBe(false);
    const code = await c.close();
    expect(code).toBe(0);
    for (const l of c.out) expect((JSON.parse(l) as Record<string, unknown>)["jsonrpc"]).toBe("2.0");
    const audit = readFileSync(auditPath, "utf8");
    expect(audit).toContain("github_get_repository");
    for (const hay of [c.out.join("\n"), c.err.join(""), audit]) {
      expect(hay).not.toContain(CANARY);
      expect(hay).not.toContain("STDIOCANARY");
    }
  }, 30000);
});
