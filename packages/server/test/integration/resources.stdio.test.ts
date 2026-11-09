import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENV_CANARY, makeWorkspace, tmpDir, workflowConfig } from "../fixtures/workflow-harness.js";

/** Resources over the real BUILT server (dist/index.js) on stdio (P6-01). Run `pnpm build` first. */

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../..");
const entry = path.join(pkgRoot, "dist/index.js");

let tmp: string;
let ws: string;
const children: ChildProcessWithoutNullStreams[] = [];

beforeAll(() => {
  if (!existsSync(entry)) throw new Error("dist/index.js missing: run `pnpm build` before this test");
  tmp = tmpDir("dwmcp-ress-");
  ws = makeWorkspace(tmp);
  writeFileSync(path.join(tmp, "fs.json"), JSON.stringify(workflowConfig({ tmp, ws })));
  writeFileSync(path.join(tmp, "none.json"), JSON.stringify(workflowConfig({ tmp, ws, fs: false })));
});
afterAll(() => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
});

async function session(cfg: string, requests: { method: string; params?: unknown }[]): Promise<{ responses: Record<string, unknown>[]; stdoutLines: string[]; stderr: string }> {
  const child = spawn(process.execPath, [entry, "--config", path.join(tmp, cfg)], {
    cwd: pkgRoot,
    env: { ...process.env, DEVWORKSPACE_CONFIG: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const lines: string[] = [];
  let buf = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  const send = (m: unknown): void => void child.stdin.write(JSON.stringify(m) + "\n");
  const wait = async (id: number): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 400; i++) {
      const hit = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((m) => m["id"] === id);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timeout id ${id}; stderr=${stderr}`);
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  await wait(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const responses: Record<string, unknown>[] = [];
  let id = 2;
  for (const r of requests) {
    send({ jsonrpc: "2.0", id, method: r.method, ...(r.params !== undefined ? { params: r.params } : {}) });
    responses.push(await wait(id++));
  }
  child.stdin.end();
  return { responses, stdoutLines: lines, stderr };
}

describe("resources over stdio", () => {
  it("lists, reads, keeps stdout JSON-RPC only and leaks nothing", async () => {
    const s = await session("fs.json", [
      { method: "resources/list" },
      { method: "resources/templates/list" },
      { method: "resources/read", params: { uri: "workspace://list" } },
      { method: "resources/read", params: { uri: "filesystem://main/tree" } },
      { method: "resources/read", params: { uri: "filesystem://nope/tree" } },
    ]);
    const [list, templates, wl, tree, bad] = s.responses as { result?: Record<string, any>; error?: unknown }[]; // eslint-disable-line @typescript-eslint/no-explicit-any -- test-only
    expect(list?.result?.["resources"].map((r: { uri: string }) => r.uri)).toContain("workspace://list");
    expect(templates?.result?.["resourceTemplates"].length).toBe(2);
    expect(JSON.parse(wl?.result?.["contents"][0].text).data.workspaces[0].id).toBe("main");
    expect(tree?.result?.["contents"][0].text).toContain("orders.ts");
    expect(bad?.error).toBeDefined();
    for (const l of s.stdoutLines) expect(() => JSON.parse(l)).not.toThrow();
    const all = s.stdoutLines.join("\n") + s.stderr;
    expect(all).not.toContain(ws);
    expect(all).not.toContain(ENV_CANARY);
  });

  it("registers no resources when no pack is enabled", async () => {
    const s = await session("none.json", [{ method: "resources/list" }]);
    expect((s.responses[0] as { error?: unknown }).error).toBeDefined();
  });
});
