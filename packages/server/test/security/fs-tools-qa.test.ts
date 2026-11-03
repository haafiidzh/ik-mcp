import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** QA-02: end-to-end fs_* attacks through the real server over stdio (temp workspace only). */
const pkgRoot = path.resolve(import.meta.dirname, "../..");
const OUT_CANARY = "QA02_OUTSIDE_CANARY";
const ENV_CANARY = "QA02_ENV_CANARY";
let dir: string;
let child: ChildProcessWithoutNullStreams;
let raw = "";
let err = "";
let buf = "";
let nextId = 1;
const pending = new Map<number, (m: Record<string, unknown>) => void>();
const all: string[] = [];

function call(tool: string, args: Record<string, unknown>): Promise<{ text: string; ok: boolean; code?: string }> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => reject(new Error(`timeout ${tool}`)), 10000);
    pending.set(id, (m) => {
      clearTimeout(t);
      const text = JSON.stringify(m);
      all.push(text);
      const sc = (m.result as { structuredContent?: { success?: boolean; error?: { code: string } } } | undefined)?.structuredContent;
      resolve({ text, ok: sc?.success === true, code: sc?.error?.code ?? (m.error ? "RPC" : undefined) });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: { workspace: "w", ...args } } }) + "\n");
  });
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "dwmcp-qa02-"));
  const root = path.join(dir, "root");
  const outside = path.join(dir, "outside");
  mkdirSync(path.join(root, "a/.ssh"), { recursive: true });
  mkdirSync(path.join(outside, "d"), { recursive: true });
  writeFileSync(path.join(outside, "s.txt"), OUT_CANARY);
  writeFileSync(path.join(outside, "d/f.txt"), OUT_CANARY);
  writeFileSync(path.join(root, "ok.txt"), "hello\n");
  for (const n of [".env", ".ENV", ".env.local", "id_rsa", "x.pem", "a/.ssh/k", "my-secret.txt"]) writeFileSync(path.join(root, n), ENV_CANARY);
  symlinkSync(path.join(outside, "s.txt"), path.join(root, "lf"));
  symlinkSync(path.join(outside, "d"), path.join(root, "ld"));
  symlinkSync("loopb", path.join(root, "loopa"));
  symlinkSync("loopa", path.join(root, "loopb"));
  execSync(`mkfifo ${path.join(root, "fifo")}`);
  writeFileSync(path.join(root, "bin"), Buffer.from([0, 1, 2, 0, 255]));
  writeFileSync(path.join(root, "big.txt"), "B".repeat(5000));
  const cfg = path.join(dir, "cfg.json");
  writeFileSync(
    cfg,
    JSON.stringify({
      server: { auditLogPath: "./audit.jsonl" },
      workspaces: [{ id: "w", name: "W", rootPath: "./root" }],
      filesystem: { enabled: true, allowedRoots: ["./root"], maxFileBytes: 100 },
      limits: { maxResults: 3 },
    }),
  );
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "--config", cfg], {
    cwd: pkgRoot,
    env: { ...process.env, QA02_ENVVAL: "QA02_ENVVALUE_SECRET" },
  });
  child.stdout.on("data", (d: Buffer) => {
    raw += d.toString();
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const m = JSON.parse(line) as { id?: number };
      if (m.id !== undefined) pending.get(m.id)?.(m as Record<string, unknown>);
    }
  });
  child.stderr.on("data", (d: Buffer) => (err += d.toString()));
  await new Promise<void>((resolve) => {
    pending.set(0, () => resolve());
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "qa", version: "1" } } }) + "\n");
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
}, 20000);

afterAll(async () => {
  child.stdin.end();
  await new Promise((r) => child.on("exit", r));
  const audit = readFileSync(path.join(dir, "audit.jsonl"), "utf8");
  expect(audit).not.toContain(dir);
  expect(audit).not.toContain("ok.txt");
  expect(audit).not.toContain(OUT_CANARY);
  const everything = all.join("\n") + raw + err + audit;
  expect(everything).not.toContain(dir);
  expect(everything).not.toContain(ENV_CANARY);
  expect(everything).not.toContain(OUT_CANARY);
  expect(everything).not.toContain("QA02_ENVVALUE_SECRET");
  for (const l of raw.split("\n").filter(Boolean)) expect((JSON.parse(l) as { jsonrpc: string }).jsonrpc).toBe("2.0");
  rmSync(dir, { recursive: true, force: true });
});

describe("QA-02 fs_* through the real server", () => {
  it.each([
    "../outside/s.txt", "a/../../outside/s.txt", "..\\outside\\s.txt", "%2e%2e/outside/s.txt", "%2E%2E%2Foutside", "..%2foutside",
    "..%5coutside", "ok.txt%00", "ok.txt\u0000", "/etc/passwd", "C:\\Windows", "\\\\host\\s\\x", "~/x", "file:///etc/passwd",
  ])("rejects path %j", async (p) => {
    for (const tool of ["fs_read_file", "fs_get_file_info", "fs_list_directory"]) {
      const r = await call(tool, { path: p });
      expect(r.ok).toBe(false);
    }
  });

  it("denies symlink file/dir escape and survives loops and FIFOs without hanging", async () => {
    for (const p of ["lf", "ld", "ld/f.txt", "loopa"]) expect((await call("fs_read_file", { path: p })).ok).toBe(false);
    expect((await call("fs_list_directory", { path: "ld" })).ok).toBe(false);
    expect((await call("fs_read_file", { path: "fifo" })).code).toBe("INVALID_INPUT");
    expect((await call("fs_search_content", { query: "x" })).ok).toBe(true);
  });

  it("blocks sensitive names in any case/position and hides them from list/search/tree", async () => {
    for (const p of [".env", ".ENV", ".env.local", "id_rsa", "x.pem", "a/.ssh/k", "my-secret.txt"]) {
      expect((await call("fs_read_file", { path: p })).code).toBe("PERMISSION_DENIED");
    }
    const l = await call("fs_list_directory", {});
    const s = await call("fs_search_files", { pattern: "e" });
    const c = await call("fs_search_content", { query: "QA02" });
    const t = await call("fs_get_directory_tree", { depth: 4 });
    for (const r of [l, s, c, t]) for (const n of [".env", "id_rsa", "x.pem", ".ssh", "secret"]) expect(r.text).not.toContain(n);
  });

  it("binary -> UNSUPPORTED; resolved config limits tighten behaviour and cannot be exceeded via args", async () => {
    expect((await call("fs_read_file", { path: "bin" })).code).toBe("UNSUPPORTED");
    const big = await call("fs_read_file", { path: "big.txt" });
    expect(big.text).toContain('\\"truncated\\":true');
    expect(big.text).toContain('\\"limit\\":100');
    const lst = await call("fs_list_directory", { limit: 1000 });
    expect(lst.text).toContain('\\"limit\\":3');
  });

  it("tool args cannot expand configuration; no write tools", async () => {
    expect((await call("fs_list_directory", { workspace: "/etc" })).code).toBe("NOT_FOUND");
    expect((await call("fs_list_directory", { rootPath: "/etc" })).ok).toBe(false);
    expect((await call("fs_write_file", { path: "x", content: "y" })).code).toBe("RPC");
  });
});
