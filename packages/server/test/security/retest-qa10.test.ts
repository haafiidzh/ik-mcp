import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedactor } from "../../src/core/redact.js";
import { fitToBudget, ok, wireSize } from "../../src/core/response.js";
import { harness, makeWorkspace, tmpDir, workflowConfig } from "../fixtures/workflow-harness.js";

/** QA-10 retest of QA-07 fixes (F1, P5-06, P4-05). Needs `pnpm build` (stdio part uses dist). */

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../..");
const entry = path.join(pkgRoot, "dist/index.js");

// ---------------------------------------------------------------- P4-05
const SECRET = "Zx9/Qq+Lm_tok-en!AB=cd"; // has base64-hostile chars on purpose
const b64 = (s: string): string => Buffer.from(s).toString("base64");
const redact = (s: string): string => createRedactor({ secretValues: [SECRET] }).redactString(s);

describe("P4-05 encoded secret redaction: covered forms", () => {
  const std = b64(SECRET);
  const cases: Record<string, string> = {
    raw: SECRET,
    "base64 std": std,
    "base64 unpadded": std.replace(/=+$/, ""),
    "base64 url-safe": std.replace(/\+/g, "-").replace(/\//g, "_"),
    "base64 url-safe unpadded": std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    "percent (encodeURIComponent)": encodeURIComponent(SECRET),
    "hex lower": Buffer.from(SECRET).toString("hex"),
  };
  for (const [name, form] of Object.entries(cases)) {
    it(`redacts ${name} inside surrounding text`, () => {
      const out = redact(`before ${form} after`);
      expect(out).not.toContain(form);
      expect(out).toContain("[REDACTED]");
    });
  }
  it("redacts every occurrence and inside nested JSON values", () => {
    const v = createRedactor({ secretValues: [SECRET] }).redactValue({ a: [{ b: `x${std}y${std}` }] });
    expect(JSON.stringify(v)).not.toContain(std);
  });
});

// Realistic encodings NOT covered (documented limits of exact-match redaction). `it.fails` flips to a normal
// test when the redactor is extended; as long as these pass as `it.fails`, the limit is real and recorded.
describe("P4-05 KNOWN LIMITS (leaks; it.fails = bug still present)", () => {
  const leaks = (form: string): boolean => redact(`x ${form} y`).includes(form);
  it("hex upper-case", () => expect(leaks(Buffer.from(SECRET).toString("hex").toUpperCase())).toBe(false));
  it("percent-encoding with lower-case hex digits", () =>
    expect(leaks(encodeURIComponent(SECRET).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()))).toBe(false));
  it.fails("base64 of 'user:secret' (Basic-auth style, other alignment)", () => expect(leaks(b64(`user:${SECRET}`))).toBe(false));
  it.fails("base64 of 'Bearer secret'", () => expect(leaks(b64(`Bearer ${SECRET}`))).toBe(false));
  it.fails("double percent-encoding", () => expect(leaks(encodeURIComponent(encodeURIComponent(SECRET)))).toBe(false));
  it.fails("MIME line-wrapped base64 (newline inside)", () => {
    const s = b64(SECRET);
    expect(leaks(`${s.slice(0, 8)}\n${s.slice(8)}`.replace(/\n/g, "\n"))).toBe(false);
  });
  it.fails("JSON \\u escape of a character of the secret", () => expect(leaks(SECRET.replace("Z", "\\u005a"))).toBe(false));
  it.fails("secret with a separator inserted (chunked)", () => expect(leaks(`${SECRET.slice(0, 6)}-${SECRET.slice(6)}`)).toBe(false));
  it.fails("reversed", () => expect(leaks([...SECRET].reverse().join(""))).toBe(false));
  it.fails("lower-cased secret", () => expect(leaks(SECRET.toLowerCase())).toBe(false));
});

// ---------------------------------------------------------------- P5-06
describe("P5-06 fitToBudget sections: property check", () => {
  const sec = (id: string, size: number) => ({ id, title: id, status: "ok", source: { kind: "filesystem", ref: "w" }, data: { t: "é😀".repeat(size) } });
  it("never exceeds the budget for many sizes; flags partial or fails closed", () => {
    for (const budget of [200, 400, 800, 1500, 3000, 6000, 20000]) {
      for (const n of [1, 3, 6]) {
        const r = ok({ sections: Array.from({ length: n }, (_, i) => sec(`s${i}`, 300 * (i + 1))) }, { source: "workflow" });
        const out = fitToBudget(r, budget);
        if (out.success) {
          expect(wireSize(out)).toBeLessThanOrEqual(budget);
          if (out !== r) {
            expect(out.meta.truncated).toBe(true);
            expect(out.meta.partial).toBe(true);
            expect(out.warnings.length).toBeGreaterThan(0);
          }
        } else {
          expect(out.error.code).toBe("LIMIT_EXCEEDED");
        }
      }
    }
  });
  it("a huge non-section top-level field cannot be cut: LIMIT_EXCEEDED", () => {
    const out = fitToBudget(ok({ sections: [sec("a", 1)], pad: "x".repeat(10000) }, { source: "workflow" }), 2000);
    expect(out.success).toBe(false);
    if (!out.success) expect(out.error.code).toBe("LIMIT_EXCEEDED");
  });
  it("real tool: workspace_get_overview with a tiny maxResponseBytes stays in budget or fails closed", async () => {
    const tmp = tmpDir("dwmcp-qa10-");
    const ws = makeWorkspace(tmp);
    try {
      for (const maxResponseBytes of [1500, 4000, 12000]) {
        const h = harness(workflowConfig({ tmp, ws }), { limits: { maxResponseBytes } });
        const r = await h.call("workspace_get_overview", { workspace: "main" });
        const total = Buffer.byteLength(r.raw, "utf8") * 2; // structured + text copy
        if (r.success) {
          expect(total).toBeLessThanOrEqual(maxResponseBytes + 64);
        } else {
          expect((r as { error: { code: string } }).error.code).toBe("LIMIT_EXCEEDED");
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- F1 over stdio
let tmp: string;
let ws: string;
const children: ChildProcessWithoutNullStreams[] = [];
beforeAll(() => {
  if (!existsSync(entry)) throw new Error("dist/index.js missing: run `pnpm build` first");
  tmp = tmpDir("dwmcp-qa10s-");
  ws = makeWorkspace(tmp);
  mkdirSync(path.join(tmp, "x"), { recursive: true });
  writeFileSync(path.join(tmp, "fs.json"), JSON.stringify(workflowConfig({ tmp, ws, github: {}, dbPath: path.join(tmp, "sample.db") })));
});
afterAll(() => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
});

async function readAll(uris: string[]): Promise<{ msgs: { error?: { message: string; code: number }; result?: unknown }[]; all: string }> {
  const child = spawn(process.execPath, [entry, "--config", path.join(tmp, "fs.json")], {
    cwd: pkgRoot,
    env: { ...process.env, DEVWORKSPACE_CONFIG: "", DEVWS_T_GH: "ghp_QA10canarytoken0123456789" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
  const send = (m: unknown): void => void child.stdin.write(JSON.stringify(m) + "\n");
  const get = async (id: number): Promise<{ error?: { message: string; code: number }; result?: unknown }> => {
    for (let i = 0; i < 300; i++) {
      const hit = out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id?: number }).find((m) => m.id === id);
      if (hit) return hit as never;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("timeout " + err);
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  await get(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const msgs = [];
  let id = 2;
  for (const uri of uris) {
    send({ jsonrpc: "2.0", id, method: "resources/read", params: { uri } });
    msgs.push(await get(id++));
  }
  child.stdin.end();
  return { msgs, all: out + err };
}

describe("F1 retest: resources/read errors are 'CODE: safe message'", () => {
  it("maps each failure class to its code, with no leak", async () => {
    const { msgs, all } = await readAll([
      "filesystem://nope/tree", // unknown workspace
      "filesystem://%2e%2e/tree", // encoded traversal in variable
      "database://nope/schema", // unknown connection
      "database://%2Ftmp%2Fx.db/schema", // path as connection
      "github://evil/other/summary", // not allowlisted
      "github://octo/hello/summary", // allowlisted but upstream unreachable / no mock
      "workspace://nope/overview",
      "filesystem://main/tree", // control: success
    ]);
    const m = msgs.map((x) => x.error?.message ?? "OK");
    expect(m[0]).toMatch(/^[A-Z_]+: /);
    expect(m[0]).toMatch(/^(NOT_FOUND|INVALID_INPUT|PERMISSION_DENIED)/);
    expect(m[2]).toMatch(/^NOT_FOUND: /);
    expect(m[4]).toMatch(/^PERMISSION_DENIED: /);
    expect(m[7]).toBe("OK");
    for (const x of m.slice(0, 7)) {
      expect(x).not.toMatch(/INTERNAL_ERROR: .*(\/home|\/tmp|at\s+\S+\s+\()/);
      expect(x).not.toContain(tmp);
    }
    expect(all).not.toContain("ghp_QA10canarytoken");
    expect(all).not.toContain(ws);
    // log the observed messages for the handoff
    writeFileSync(path.join(tmp, "observed.json"), JSON.stringify(m));
    console.error("QA10 F1 observed:", JSON.stringify(m));
  }, 60000);
});
