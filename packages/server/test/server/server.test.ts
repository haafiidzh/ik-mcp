import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../..");
const entry = path.join(pkgRoot, "src/index.ts");
const tsxBin = path.join(pkgRoot, "node_modules/.bin/tsx");

let tmp: string;
let cfgPath: string;
const children: ChildProcessWithoutNullStreams[] = [];

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "dwmcp-"));
  cfgPath = path.join(tmp, "cfg.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      server: { name: "test-server", logLevel: "info", auditLogPath: path.join(tmp, "audit.jsonl") },
      filesystem: { enabled: true, allowedRoots: [tmp] },
      limits: { dbMaxRows: 7 },
    }),
  );
});

afterAll(() => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
});

interface Running {
  child: ChildProcessWithoutNullStreams;
  out: string[];
  err: string[];
  exited: Promise<number | null>;
  waitFor(id: number): Promise<Record<string, unknown>>;
  send(msg: unknown): void;
}

function start(args: string[], env: Record<string, string> = {}): Running {
  const child = spawn(tsxBin, [entry, ...args], {
    cwd: pkgRoot,
    env: { ...process.env, DEVWORKSPACE_CONFIG: "", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const out: string[] = [];
  const err: string[] = [];
  let buf = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      out.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  child.stderr.setEncoding("utf8").on("data", (d: string) => err.push(d));
  const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
  return {
    child,
    out,
    err,
    exited,
    send: (m) => void child.stdin.write(JSON.stringify(m) + "\n"),
    async waitFor(id) {
      for (let i = 0; i < 300; i++) {
        for (const l of out) {
          const m = JSON.parse(l) as Record<string, unknown>;
          if (m["id"] === id) return m;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`timeout waiting for id ${id}; stderr=${err.join("")}`);
    },
  };
}

async function handshake(s: Running): Promise<void> {
  s.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  });
  await s.waitFor(1);
  s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
}

describe("stdio server (P0-05)", () => {
  it("lists and calls server_get_status; stdout is JSON-RPC only (S21); shuts down on stdin close", async () => {
    const s = start(["--config", cfgPath]);
    await handshake(s);

    s.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = await s.waitFor(2);
    const tools = (list["result"] as { tools: { name: string; description: string }[] }).tools;
    const status = tools.find((t) => t.name === "server_get_status");
    expect(status).toBeDefined();
    expect(status?.description).toMatch(/^Read-only\./);
    // only the enabled pack (filesystem) registers tools; disabled packs register nothing
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "fs_get_directory_tree",
        "fs_get_file_info",
        "fs_list_directory",
        "fs_read_file",
        "fs_search_content",
        "fs_search_files",
        "server_get_status",
      ].sort(),
    );

    s.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "server_get_status", arguments: {} } });
    const call = await s.waitFor(3);
    const result = call["result"] as {
      content: { type: string; text: string }[];
      structuredContent: { success: boolean; data: { server: { name: string }; limits: { dbMaxRows: number }; [k: string]: unknown } };
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.type).toBe("text");
    const sc = result.structuredContent;
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(sc);
    expect(sc.success).toBe(true);
    expect(sc.data.server.name).toBe("test-server");
    expect(sc.data["allowWrites"]).toBe(false);
    expect(sc.data["packs"]).toEqual({
      database: false,
      github: false,
      customApi: false,
      filesystem: true,
      workflows: false,
    });
    expect(sc.data.limits.dbMaxRows).toBe(7);
    expect(typeof sc.data["uptimeSeconds"]).toBe("number");
    // no paths, no config contents
    const text = result.content[0]?.text ?? "";
    expect(text).not.toContain(tmp);
    expect(text).not.toContain("allowedRoots");
    expect(text).not.toContain("auditLogPath");

    // unknown tool: still a JSON-RPC message, no stray output
    s.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } });
    await s.waitFor(4);

    // S21: every stdout line is valid JSON-RPC
    for (const l of s.out) {
      const m = JSON.parse(l) as Record<string, unknown>;
      expect(m["jsonrpc"]).toBe("2.0");
    }

    // audit has metadata only
    const auditFile = path.join(tmp, "audit.jsonl");
    expect(existsSync(auditFile)).toBe(true);
    expect(readFileSync(auditFile, "utf8")).toContain("server_get_status");

    s.child.stdin.end();
    expect(await Promise.race([s.exited, new Promise((r) => setTimeout(() => r("hung"), 8000))])).toBe(0);
    for (const l of s.out) expect(() => JSON.parse(l)).not.toThrow();
    expect(s.err.join("")).toContain("devworkspace-mcp ready");
  }, 30000);

  it("answers server/discover (spec 2026-07-28) over stdio with modern versions only", async () => {
    const s = start(["--config", cfgPath]);
    s.send({
      jsonrpc: "2.0",
      id: 10,
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" },
        },
      },
    });
    const res = await s.waitFor(10);
    expect(res["error"]).toBeUndefined();
    const result = res["result"] as { supportedVersions: string[]; capabilities: Record<string, unknown> };
    expect(result.supportedVersions).toEqual(["2026-07-28"]);
    expect(result.capabilities).toHaveProperty("tools");
    for (const l of s.out) expect((JSON.parse(l) as Record<string, unknown>)["jsonrpc"]).toBe("2.0");
    s.child.stdin.end();
    expect(await Promise.race([s.exited, new Promise((r) => setTimeout(() => r("hung"), 8000))])).toBe(0);
  }, 30000);

  it("exits 1 with a stderr message and empty stdout on a missing config argument", async () => {
    const s = start([]);
    expect(await s.exited).toBe(1);
    expect(s.out).toEqual([]);
    expect(s.err.join("")).toMatch(/no config file specified/);
  }, 20000);

  it("exits 1 on an invalid config without leaking its contents", async () => {
    const bad = path.join(tmp, "bad.json");
    writeFileSync(bad, JSON.stringify({ permissions: { allowWrites: "SECRETVALUE1234" } }));
    const s = start(["--config", bad]);
    expect(await s.exited).toBe(1);
    expect(s.out).toEqual([]);
    expect(s.err.join("")).not.toContain("SECRETVALUE1234");
    expect(s.err.join("")).toMatch(/permissions/);
  }, 20000);

  it("exits 1 on an unreadable config path", async () => {
    const s = start(["--config", path.join(tmp, "missing.json")]);
    expect(await s.exited).toBe(1);
    expect(s.out).toEqual([]);
    expect(s.err.join("")).toMatch(/cannot read/);
  }, 20000);
});
