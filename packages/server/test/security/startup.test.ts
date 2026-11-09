import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pkgRoot = path.resolve(import.meta.dirname, "../..");
const CANARY = "ghp_CANARYsecret1234567890abcdefABCDEF";

function setup(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dwmcp-qa-"));
  mkdirSync(path.join(dir, "root"));
  const cfg = path.join(dir, "cfg.json");
  writeFileSync(
    cfg,
    JSON.stringify({
      workspaces: [{ id: "w", name: "W", rootPath: "./root" }],
      filesystem: { enabled: true, allowedRoots: ["./root"] },
      github: { enabled: false, tokenEnv: "QA_CANARY_TOKEN", allowedRepositories: ["o/r"] },
    }),
  );
  return cfg;
}

function run(cfg: string, how: "eof" | "sigterm"): Promise<{ code: number | null; signal: string | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "--config", cfg], {
      cwd: pkgRoot,
      env: { ...process.env, QA_CANARY_TOKEN: CANARY },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("process did not exit"));
    }, 30000);
    child.on("exit", (code, signal) => {
      clearTimeout(guard);
      resolve({ code, signal, out, err });
    });
    const send = (o: object): void => void child.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "qa", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "server_get_status", arguments: {} } });
    // Wait for readiness (id 2 response) instead of a fixed delay: tsx cold start
    // can be slow under load and SIGTERM before the handler is installed kills the child.
    let signalled = false;
    child.stdout.on("data", () => {
      if (signalled) return;
      const ready = out.split("\n").some((l) => {
        try {
          return (JSON.parse(l) as { id?: number }).id === 2;
        } catch {
          return false;
        }
      });
      if (!ready) return;
      signalled = true;
      if (how === "eof") child.stdin.end();
      else child.kill("SIGTERM");
    });
  });
}

describe("QA-01 startup/shutdown security", () => {
  for (const how of ["eof", "sigterm"] as const) {
    it(`exits cleanly on ${how}; stdout is JSON-RPC only; no canary/path leak (S19/S21)`, async () => {
      const cfg = setup();
      const r = await run(cfg, how);
      expect(r.code).toBe(0);
      const lines = r.out.split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const l of lines) expect((JSON.parse(l) as { jsonrpc: string }).jsonrpc).toBe("2.0");
      const all = r.out + r.err;
      expect(all).not.toContain(CANARY);
      expect(all).not.toContain("QA_CANARY_TOKEN");
      expect(r.out).not.toContain(path.dirname(cfg));
    }, 45000);
  }
});
