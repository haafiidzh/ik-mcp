import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ok, fitToBudget, toMcpResult, wireSize, type SuccessResult } from "../../src/core/response.js";
import { createBlockMatcher, nameVariants } from "../../src/integrations/filesystem/blocked-patterns.js";
import { escapeName } from "../../src/integrations/filesystem/escape-name.js";
import { createFilesystemService, type FilesystemService } from "../../src/integrations/filesystem/filesystem.service.js";

/** P1-08: B1 hardlinks, B2 backup names, B3 control-char names, B4 response budget. Temp dirs only. */
const CANARY = "P108_OUTSIDE_CANARY";
let base: string;
let root: string;
let svc: FilesystemService;

beforeAll(async () => {
  base = mkdtempSync(path.join(tmpdir(), "dwmcp-p108-"));
  root = path.join(base, "root");
  mkdirSync(root);
  mkdirSync(path.join(base, "outside"));
  writeFileSync(path.join(base, "outside", "secret.txt"), CANARY);
  writeFileSync(path.join(root, "ok.txt"), "fine\n");
  writeFileSync(path.join(root, "twin-a.txt"), "inroot-twin\n");
  linkSync(path.join(root, "twin-a.txt"), path.join(root, "twin-b.txt"));
  linkSync(path.join(base, "outside", "secret.txt"), path.join(root, "hard.txt"));
  for (const n of [".env~", ".env.bak", ".env.swp", "id_rsa~", "x.pem.bak", ".env.orig", ".env.old", "#.env#", ".x.pem.swp", "tail~"]) {
    writeFileSync(path.join(root, n), n === "tail~" ? "tail" : CANARY);
  }
  writeFileSync(path.join(root, ".env.example"), "EXAMPLE=1\n");
  writeFileSync(path.join(root, "line\nbreak.txt"), "x");
  writeFileSync(path.join(root, "esc\u001b[31m.txt"), "x");
  writeFileSync(path.join(root, "bidi‮gnp.txt"), "x");
  mkdirSync(path.join(root, "d​ir"));
  writeFileSync(path.join(root, "d​ir", "f.txt"), "x");
  svc = await createFilesystemService({ workspaces: [{ id: "w", rootPath: root }] });
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("B1 hard links (nlink > 1)", () => {
  it("refuses read and info with a non-leaking error", async () => {
    for (const p of ["hard.txt", "twin-a.txt", "twin-b.txt"]) {
      for (const op of [() => svc.readFile("w", p), () => svc.getFileInfo("w", p)]) {
        const err = await op().then(() => null, (e: unknown) => e as { code: string; message: string });
        expect(err?.code).toBe("PERMISSION_DENIED");
        expect(err?.message).not.toContain(base);
        expect(err?.message).not.toContain(CANARY);
      }
    }
  });
  it("hides hard-linked files from list, search_files, search_content and tree", async () => {
    const all = JSON.stringify([
      await svc.listDirectory("w"),
      await svc.searchFiles("w", "hard"),
      await svc.searchFiles("w", "twin"),
      await svc.searchContent("w", CANARY),
      await svc.searchContent("w", "inroot-twin"),
      await svc.getDirectoryTree("w"),
    ]);
    for (const n of ["hard.txt", "twin-a", "twin-b", CANARY, "inroot-twin"]) expect(all).not.toContain(n);
    expect(all).toContain("ok.txt");
  });
});

describe("B2 backup and editor variants of blocked names", () => {
  it.each([".env~", ".env.bak", ".env.swp", "id_rsa~", "x.pem.bak", ".env.orig", ".env.old", "#.env#", ".x.pem.swp", ".ENV~", "X.PEM.BAK"])(
    "denies read and hides %s",
    async (n) => {
      const m = createBlockMatcher();
      expect(m.isBlocked([n])).toBe(true);
      if (!n.includes("ENV~") && n !== "X.PEM.BAK") {
        await expect(svc.readFile("w", n)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      }
    },
  );
  it("hides them from list/search/tree and keeps .env.example", async () => {
    const out = JSON.stringify([await svc.listDirectory("w"), await svc.searchFiles("w", "e"), await svc.searchContent("w", CANARY), await svc.getDirectoryTree("w")]);
    for (const n of [".env~", ".env.bak", ".env.swp", "id_rsa", "x.pem", ".env.orig", ".env.old", "#.env#", CANARY]) expect(out).not.toContain(n);
    expect(out).toContain(".env.example");
    expect((await svc.readFile("w", ".env.example")).data.content).toContain("EXAMPLE");
  });
  it("applies to configured blockedNames and respects unblock", () => {
    const m = createBlockMatcher({ blockedNames: ["private.txt"] });
    for (const n of ["private.txt~", "private.txt.bak", ".private.txt.swp", "#private.txt#"]) expect(m.isBlocked([n])).toBe(true);
    expect(m.isBlocked(["private.txt.md"])).toBe(false);
    expect(m.isBlocked([".env.example"])).toBe(false);
    expect(createBlockMatcher({ unblock: [".env"] }).isBlocked([".env"])).toBe(false);
    expect(nameVariants("a.bak~")).toContain("a");
  });
});

describe("B3 control characters in names", () => {
  it("escapeName handles C0, DEL, C1, bidi, zero-width and backslash", () => {
    expect(escapeName("a\nb")).toBe("a\\u{A}b");
    expect(escapeName("\u001b[0m")).toBe("\\u{1B}[0m");
    expect(escapeName("x\u007f\u0085")).toBe("x\\u{7F}\\u{85}");
    expect(escapeName("a‮b​c")).toBe("a\\u{202E}b\\u{200B}c");
    expect(escapeName("a\\b")).toBe("a\\u{5C}b");
    expect(escapeName("plain-name.txt")).toBe("plain-name.txt");
  });
  it("returns no raw control characters from list, search and tree", async () => {
    const results = [await svc.listDirectory("w"), await svc.searchFiles("w", "r"), await svc.getDirectoryTree("w", ".", 3), await svc.searchContent("w", "x")];
    const text = JSON.stringify(results);
    // JSON.stringify would show raw controls as \n / \u001b; the escaped form is a literal backslash-u-brace.
    expect(text).not.toMatch(/\\n|\\u001b|\\u202e|\\u200b/i);
    expect(text).toContain("line\\\\u{A}break.txt");
    expect(text).toContain("esc\\\\u{1B}[31m.txt");
    expect(text).toContain("d\\\\u{200B}ir");
  });
  it("escaped names cannot be used as input and raw names stay guarded", async () => {
    await expect(svc.readFile("w", "line\\u{A}break.txt")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(svc.readFile("w", "line\nbreak.txt")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("B4 response budget (unit)", () => {
  const big = Array.from({ length: 5000 }, (_, i) => ({ name: `file-${i}-${"x".repeat(40)}` }));
  it("keeps small results untouched", () => {
    const r = ok([1, 2], { source: "t" });
    expect(fitToBudget(r, 100000)).toBe(r);
  });
  it("truncates arrays so the total of both copies fits and marks meta", () => {
    const res = toMcpResult(ok(big, { source: "t" }), undefined, 50000);
    const s = res.structuredContent as unknown as SuccessResult<unknown[]>;
    expect(Buffer.byteLength(JSON.stringify(res))).toBeLessThanOrEqual(50000);
    expect(s.meta.truncated).toBe(true);
    expect(s.meta.partial).toBe(true);
    expect(s.meta.returnedCount).toBe(s.data.length);
    expect(s.data.length).toBeGreaterThan(0);
    expect(s.data.length).toBeLessThan(5000);
    expect(JSON.parse(res.content[0]?.text ?? "")).toEqual(res.structuredContent);
  });
  it("truncates text content with quotes and newlines", () => {
    const content = '"q"\n\\'.repeat(60000);
    const r = ok({ content, lines: { start: 1, end: 1 }, truncated: false }, { source: "t" });
    const res = fitToBudget(r, 30000) as SuccessResult<{ content: string; truncated: boolean }>;
    expect(wireSize(res)).toBeLessThanOrEqual(30000);
    expect(res.data.truncated).toBe(true);
    expect(res.meta.truncated).toBe(true);
  });
  it("truncates trees and recomputes counts", () => {
    const children = Array.from({ length: 3000 }, (_, i) => ({ name: `f${i}${"y".repeat(30)}`, type: "file" }));
    const r = ok({ root: { name: ".", type: "dir", children }, counts: { files: 3000, directories: 0, symlinks: 0 } }, { source: "t" });
    const res = fitToBudget(r, 20000) as SuccessResult<{ root: { children: unknown[] }; counts: { files: number } }>;
    expect(wireSize(res)).toBeLessThanOrEqual(20000);
    expect(res.data.counts.files).toBe(res.data.root.children.length);
  });
});

describe("B4 response budget over stdio", () => {
  let child: ChildProcessWithoutNullStreams;
  let dir: string;
  let buf = "";
  const waiters = new Map<number, (line: string) => void>();
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "dwmcp-p108s-"));
    mkdirSync(path.join(dir, "root"));
    // quotes and newlines inflate the escaped text copy; 190000 bytes stays below maxFileBytes (200000).
    writeFileSync(path.join(dir, "root", "max.txt"), '"line with quotes"\n'.repeat(10000));
    const cfg = path.join(dir, "cfg.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        server: { auditLogPath: "./audit.jsonl" },
        workspaces: [{ id: "w", name: "W", rootPath: "./root" }],
        filesystem: { enabled: true, allowedRoots: ["./root"] },
      }),
    );
    child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "--config", cfg], { cwd: path.resolve(import.meta.dirname, "../..") });
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const id = (JSON.parse(line) as { id?: number }).id;
        if (id !== undefined) waiters.get(id)?.(line);
      }
    });
    const send = (id: number, method: string, params: unknown): Promise<string> =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout")), 15000);
        waiters.set(id, (l) => {
          clearTimeout(t);
          resolve(l);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    (globalThis as { __p108send?: typeof send }).__p108send = send;
    await send(0, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }, 30000);
  afterAll(async () => {
    child.stdin.end();
    await new Promise((r) => child.on("exit", r));
    rmSync(dir, { recursive: true, force: true });
  });

  it("a max-size read sends at most maxResponseBytes in total (both copies) and reports truncation", async () => {
    const send = (globalThis as unknown as { __p108send: (id: number, m: string, p: unknown) => Promise<string> }).__p108send;
    const line = await send(1, "tools/call", { name: "fs_read_file", arguments: { workspace: "w", path: "max.txt" } });
    expect(Buffer.byteLength(line) + 1).toBeLessThanOrEqual(200000);
    const msg = JSON.parse(line) as { result: { content: { text: string }[]; structuredContent: { success: boolean; data: { content: string; truncated: boolean }; meta: { truncated: boolean; responseBudgetBytes?: number } } } };
    const sc = msg.result.structuredContent;
    expect(sc.success).toBe(true);
    expect(sc.meta.truncated).toBe(true);
    expect(sc.data.truncated).toBe(true);
    expect(sc.data.content.length).toBeGreaterThan(1000);
    expect(JSON.parse(msg.result.content[0]?.text ?? "")).toEqual(sc);
  });
});
