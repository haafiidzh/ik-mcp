import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../..");
const entry = path.join(pkgRoot, "src/index.ts");
const tsxBin = path.join(pkgRoot, "node_modules/.bin/tsx");
const fixture = path.join(pkgRoot, "test/fixtures/sample-workspace");
const exampleCfg = path.join(pkgRoot, "config/devworkspace.example.json");
const CANARY = "FAKE-CANARY-DO-NOT-RETURN-0000";
const FS_TOOLS = [
  "fs_get_directory_tree",
  "fs_get_file_info",
  "fs_list_directory",
  "fs_read_file",
  "fs_search_content",
  "fs_search_files",
];

interface Res {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  meta?: Record<string, unknown>;
}
interface Call {
  res: Res;
  text: string;
  isError: boolean;
}

let tmp: string;
let ws: string;
let cfgPath: string;
let offCfgPath: string;
const children: ChildProcessWithoutNullStreams[] = [];

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "dwmcp-fst-")));
  ws = path.join(tmp, "ws");
  cpSync(fixture, ws, { recursive: true });
  // Things that cannot be committed (.git, symlinks, binaries, big files) are created at test time.
  // Ignored/secret-like paths are never committed (commit rules); build them in the temp copy.
  writeFileSync(path.join(ws, ".env"), `DEVWS_CANARY=${CANARY}\n`);
  mkdirSync(path.join(ws, "node_modules", "fake-lib"), { recursive: true });
  writeFileSync(path.join(ws, "node_modules", "fake-lib", "index.js"), "module.exports = 'fake-lib';\n");
  mkdirSync(path.join(ws, "dist"));
  writeFileSync(path.join(ws, "dist", "bundle.txt"), "built output, must be ignored\n");
  mkdirSync(path.join(ws, ".git"));
  writeFileSync(path.join(ws, ".git", "config"), "[core]\n\tGIT-CANARY=1\n");
  mkdirSync(path.join(ws, "deep", ".ssh"), { recursive: true });
  writeFileSync(path.join(ws, "deep", ".ssh", "authorized_keys"), "SSH-CANARY");
  writeFileSync(path.join(ws, "server.pem"), "PEM-CANARY");
  writeFileSync(path.join(ws, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x00, 0x02, 0x00]));
  writeFileSync(path.join(ws, "big.txt"), "line of text\n".repeat(400));
  for (let i = 0; i < 20; i++) writeFileSync(path.join(ws, "docs", `many-${i}.md`), `many ${i}\n`);
  const outside = path.join(tmp, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "payload.txt"), "OUTSIDE-CANARY");
  symlinkSync(path.join(outside, "payload.txt"), path.join(ws, "link-out.txt"));
  symlinkSync(outside, path.join(ws, "link-dir"));
  symlinkSync(path.join(ws, ".env"), path.join(ws, "env-alias.txt"));

  const base = (enabled: boolean): unknown => ({
    server: { name: "fs-test", logLevel: "info", auditLogPath: path.join(tmp, "audit.jsonl") },
    workspaces: [{ id: "w", name: "W", rootPath: ws }],
    filesystem: {
      enabled,
      allowedRoots: [ws],
      blockedNames: [".env", "id_rsa"],
      maxFileBytes: 1000,
    },
    limits: { maxResults: 15, maxTreeEntries: 8 },
  });
  cfgPath = path.join(tmp, "cfg.json");
  writeFileSync(cfgPath, JSON.stringify(base(true)));
  offCfgPath = path.join(tmp, "off.json");
  writeFileSync(offCfgPath, JSON.stringify(base(false)));
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
  constructor(args: string[], cwd: string) {
    this.child = spawn(tsxBin, [entry, ...args], {
      cwd,
      env: { ...process.env, DEVWORKSPACE_CONFIG: "" },
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
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }
  async tools(): Promise<{ name: string; description: string; annotations?: Record<string, unknown> }[]> {
    const r = await this.request("tools/list");
    return (r["result"] as { tools: { name: string; description: string }[] }).tools;
  }
  async call(name: string, args: Record<string, unknown>): Promise<Call> {
    const r = await this.request("tools/call", { name, arguments: args });
    const result = r["result"] as {
      content: { text: string }[];
      structuredContent?: Res;
      isError?: boolean;
    };
    const text = result.content[0]?.text ?? "";
    return { res: JSON.parse(text) as Res, text, isError: result.isError === true };
  }
  async close(): Promise<number | null> {
    this.child.stdin.end();
    return Promise.race([this.exited, new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
  }
  assertStdoutPure(): void {
    for (const l of this.out) expect((JSON.parse(l) as Record<string, unknown>)["jsonrpc"]).toBe("2.0");
  }
}

async function open(cfg: string, cwd = pkgRoot): Promise<Client> {
  const c = new Client(["--config", cfg], cwd);
  await c.init();
  return c;
}

describe("fs_* tools over stdio (P1-03)", () => {
  it("registers the six tools only when the filesystem pack is enabled", async () => {
    const on = await open(cfgPath);
    const tools = await on.tools();
    expect(tools.map((t) => t.name).sort()).toEqual(["server_get_status", ...FS_TOOLS, "workspace_get_overview"].sort()); // P5-05: the overview workflow needs only the filesystem pack
    for (const t of tools.filter((x) => x.name.startsWith("fs_"))) {
      expect(t.description).toMatch(/^Read-only\./);
      expect(t.annotations?.["readOnlyHint"]).toBe(true);
    }
    on.assertStdoutPure();
    expect(await on.close()).toBe(0);

    const off = await open(offCfgPath);
    expect((await off.tools()).map((t) => t.name)).toEqual(["server_get_status"]);
    const r = await off.call("fs_list_directory", { workspace: "w" }).catch(() => undefined);
    expect(r === undefined || r.isError).toBe(true);
    expect(await off.close()).toBe(0);
  }, 30000);

  it("happy paths: list, info, read, search, tree; blocked and ignored entries never appear (S5)", async () => {
    const c = await open(cfgPath);
    const list = await c.call("fs_list_directory", { workspace: "w" });
    expect(list.isError).toBe(false);
    const names = (list.res.data as { name: string }[]).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["README.md", "src", ".env.example"]));
    for (const hidden of [".env", ".git", "node_modules", "dist", "server.pem"]) expect(names).not.toContain(hidden);
    expect(list.text).not.toContain(CANARY);
    expect(list.text).not.toContain(tmp);

    const info = await c.call("fs_get_file_info", { workspace: "w", path: "src/greet.js" });
    expect(info.res.data).toMatchObject({ relPath: "src/greet.js", type: "file", extension: "js", isText: true });

    const read = await c.call("fs_read_file", { workspace: "w", path: "src/greet.js", startLine: 1, endLine: 1 });
    expect((read.res.data as { content: string }).content).toContain("export function greet");

    const byName = await c.call("fs_search_files", { workspace: "w", pattern: "greet" });
    expect((byName.res.data as { relPath: string }[]).map((h) => h.relPath)).toContain("src/greet.js");

    const byContent = await c.call("fs_search_content", { workspace: "w", query: "sample-needle-42" });
    expect(byContent.res.data).toEqual([expect.objectContaining({ relPath: "docs/notes.md" })]);
    const canarySearch = await c.call("fs_search_content", { workspace: "w", query: "CANARY" });
    expect(canarySearch.text).not.toContain(CANARY);
    expect(canarySearch.text).not.toContain("GIT-CANARY");
    expect(canarySearch.text).not.toContain("SSH-CANARY");
    expect(canarySearch.text).not.toContain("PEM-CANARY");
    expect(canarySearch.text).not.toContain("OUTSIDE-CANARY");

    const files = await c.call("fs_search_files", { workspace: "w", pattern: "env" });
    expect((files.res.data as { relPath: string }[]).map((h) => h.relPath)).not.toContain(".env");
    expect((files.res.data as { relPath: string }[]).map((h) => h.relPath)).not.toContain("env-alias.txt");

    const tree = await c.call("fs_get_directory_tree", { workspace: "w", depth: 3 });
    for (const bad of [".env\"", ".git\"", "node_modules", "authorized_keys", "server.pem", "link-dir"]) {
      if (bad === "link-dir") continue; // the link itself may be listed as a symlink; its target must not be followed
      expect(tree.text).not.toContain(bad);
    }
    expect(tree.text).not.toContain("OUTSIDE-CANARY");
    expect(tree.text).not.toContain("payload.txt");
    c.assertStdoutPure();
    await c.close();
  }, 40000);

  it("S1-S4: traversal, encoded, absolute and symlink escapes are denied without leaking content", async () => {
    const c = await open(cfgPath);
    const attempts: [string, Record<string, unknown>][] = [
      ["fs_read_file", { workspace: "w", path: "../outside/payload.txt" }],
      ["fs_read_file", { workspace: "w", path: "src/../../outside/payload.txt" }],
      ["fs_read_file", { workspace: "w", path: "..\\outside\\payload.txt" }],
      ["fs_read_file", { workspace: "w", path: "%2e%2e/outside/payload.txt" }],
      ["fs_read_file", { workspace: "w", path: "%2E%2E%2Foutside%2Fpayload.txt" }],
      ["fs_read_file", { workspace: "w", path: "..%2foutside/payload.txt" }],
      ["fs_read_file", { workspace: "w", path: "/etc/passwd" }],
      ["fs_read_file", { workspace: "w", path: "C:\\Windows\\win.ini" }],
      ["fs_read_file", { workspace: "w", path: "\\\\host\\share\\x" }],
      ["fs_read_file", { workspace: "w", path: path.join(tmp, "outside", "payload.txt") }],
      ["fs_get_file_info", { workspace: "w", path: "../outside" }],
      ["fs_list_directory", { workspace: "w", path: ".." }],
      ["fs_list_directory", { workspace: "w", path: "/" }],
      ["fs_get_directory_tree", { workspace: "w", path: "../outside" }],
      ["fs_search_files", { workspace: "w", pattern: "payload", path: "../outside" }],
      ["fs_search_content", { workspace: "w", query: "OUTSIDE", path: "/tmp" }],
      // S4 symlinks inside the workspace pointing outside
      ["fs_read_file", { workspace: "w", path: "link-out.txt" }],
      ["fs_read_file", { workspace: "w", path: "link-dir/payload.txt" }],
      ["fs_list_directory", { workspace: "w", path: "link-dir" }],
      ["fs_read_file", { workspace: "w", path: "env-alias.txt" }],
    ];
    for (const [tool, args] of attempts) {
      const r = await c.call(tool, args);
      const label = `${tool} ${JSON.stringify(args)}`;
      expect(r.isError, label).toBe(true);
      expect(r.res.success, label).toBe(false);
      expect(["PERMISSION_DENIED", "INVALID_INPUT", "NOT_FOUND"], label).toContain(r.res.error?.code);
      expect(r.text, label).not.toContain("OUTSIDE-CANARY");
      expect(r.text, label).not.toContain(CANARY);
      expect(r.text, label).not.toContain("root:");
      expect(r.text, label).not.toContain(tmp);
    }
    // unknown workspace is not authority to use a path
    const unknown = await c.call("fs_list_directory", { workspace: tmp });
    expect(unknown.res.error?.code).toBe("NOT_FOUND");
    c.assertStdoutPure();
    await c.close();
  }, 60000);

  it("S5: blocked files are denied with no content", async () => {
    const c = await open(cfgPath);
    for (const p of [".env", ".git/config", "server.pem", "deep/.ssh/authorized_keys"]) {
      const r = await c.call("fs_read_file", { workspace: "w", path: p });
      expect(r.isError, p).toBe(true);
      expect(["PERMISSION_DENIED", "NOT_FOUND"], p).toContain(r.res.error?.code);
      expect(r.text, p).not.toContain(CANARY);
      expect(r.text, p).not.toContain("GIT-CANARY");
      expect(r.text, p).not.toContain("SSH-CANARY");
      expect(r.text, p).not.toContain("PEM-CANARY");
    }
    await c.close();
  }, 30000);

  it("S6: binary file returns UNSUPPORTED", async () => {
    const c = await open(cfgPath);
    const r = await c.call("fs_read_file", { workspace: "w", path: "image.bin" });
    expect(r.isError).toBe(true);
    expect(r.res.error?.code).toBe("UNSUPPORTED");
    await c.close();
  }, 30000);

  it("S7: oversize read, tree, search and list are truncated with meta", async () => {
    const c = await open(cfgPath);
    const big = await c.call("fs_read_file", { workspace: "w", path: "big.txt" });
    expect(big.isError).toBe(false);
    const d = big.res.data as { content: string; truncated: boolean };
    expect(d.truncated).toBe(true);
    expect(Buffer.byteLength(d.content)).toBeLessThanOrEqual(1000);
    expect(big.res.meta?.["truncated"]).toBe(true);

    const list = await c.call("fs_list_directory", { workspace: "w", path: "docs" });
    expect((list.res.data as unknown[]).length).toBeLessThanOrEqual(15);
    expect(list.res.meta?.["truncated"]).toBe(true);

    const search = await c.call("fs_search_content", { workspace: "w", query: "many", limit: 1000 });
    expect((search.res.data as unknown[]).length).toBeLessThanOrEqual(15);
    expect(search.res.meta?.["truncated"]).toBe(true);

    const files = await c.call("fs_search_files", { workspace: "w", pattern: "many" });
    expect((files.res.data as unknown[]).length).toBeLessThanOrEqual(15);
    expect(files.res.meta?.["truncated"]).toBe(true);

    const tree = await c.call("fs_get_directory_tree", { workspace: "w", depth: 4 });
    expect(tree.res.meta?.["truncated"]).toBe(true);
    await c.close();
  }, 40000);

  it("rejects unknown keys and wrong types at the schema; audit holds metadata only", async () => {
    const c = await open(cfgPath);
    const extra = await c.call("fs_list_directory", { workspace: "w", rootPath: "/" }).catch(() => undefined);
    expect(extra === undefined || extra.isError).toBe(true);
    const wrong = await c.call("fs_read_file", { workspace: "w", path: 5 }).catch(() => undefined);
    expect(wrong === undefined || wrong.isError).toBe(true);
    await c.call("fs_read_file", { workspace: "w", path: "src/greet.js" });
    await c.call("fs_read_file", { workspace: "w", path: "../outside/payload.txt" });
    await c.close();
    const audit = readFileSync(path.join(tmp, "audit.jsonl"), "utf8");
    expect(audit).toContain("fs_read_file");
    expect(audit).toContain('"resourceRef":"w"');
    expect(audit).toContain("PERMISSION_DENIED");
    expect(audit).not.toContain("greet");
    expect(audit).not.toContain(tmp);
    expect(audit).not.toContain("outside");
    expect(audit).not.toContain(CANARY);
  }, 30000);

  it("the shipped example config starts from a fresh cwd and serves the committed fixture", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "dwmcp-cwd-"));
    const c = await open(exampleCfg, cwd);
    try {
      const names = (await c.tools()).map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["server_get_status", ...FS_TOOLS]));
      const list = await c.call("fs_list_directory", { workspace: "sample-project" });
      expect(list.isError).toBe(false);
      const entries = (list.res.data as { name: string }[]).map((e) => e.name);
      expect(entries).toEqual(expect.arrayContaining(["README.md", "src", "docs", ".env.example"]));
      expect(entries).not.toContain(".env");
      expect(entries).not.toContain("node_modules");
      const env = await c.call("fs_read_file", { workspace: "sample-project", path: ".env" });
      expect(env.isError).toBe(true);
      expect(env.text).not.toContain(CANARY);
    } finally {
      await c.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30000);
});
