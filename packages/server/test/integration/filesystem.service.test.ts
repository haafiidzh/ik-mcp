import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFilesystemService, type FilesystemServiceOptions } from "../../src/integrations/filesystem/filesystem.service.js";
import { makeFsFixture, type FsFixture } from "../fixtures/fs-fixture.js";

let fx: FsFixture | undefined;
afterEach(() => {
  fx?.cleanup();
  fx = undefined;
});

function setup(extra: Partial<FilesystemServiceOptions> = {}) {
  fx = makeFsFixture();
  const r = fx.root;
  writeFileSync(path.join(r, "README.md"), "Hello World\nsecond line\nthird Line\n");
  writeFileSync(path.join(r, "src", "b.ts"), "export const Needle = 1;\nconst other = 2;\n");
  writeFileSync(path.join(r, ".env"), "API_KEY=SUPERSECRETVALUE\nNeedle=1\n");
  writeFileSync(path.join(r, "src", "secrets.txt"), "Needle hidden\n");
  writeFileSync(path.join(r, "id_rsa"), "Needle key\n");
  mkdirSync(path.join(r, "node_modules", "pkg"), { recursive: true });
  writeFileSync(path.join(r, "node_modules", "pkg", "index.js"), "Needle ignored\n");
  mkdirSync(path.join(r, ".git"));
  writeFileSync(path.join(r, ".git", "config"), "Needle git\n");
  writeFileSync(path.join(r, "image.bin"), Buffer.from([0x89, 0x50, 0, 1, 2, 3, 0, 0]));
  return createFilesystemService({
    workspaces: [{ id: "ws", rootPath: r }],
    ignoreDirs: ["node_modules", ".git"],
    ...extra,
  });
}

const names = (xs: { name: string }[]) => xs.map((x) => x.name);

describe("listDirectory", () => {
  it("lists entries, hides blocked and ignored (S5)", async () => {
    const svc = await setup();
    const res = await svc.listDirectory("ws");
    const n = names(res.data);
    expect(n).toContain("README.md");
    expect(n).toContain("src");
    for (const bad of [".env", "id_rsa", "node_modules", ".git"]) expect(n).not.toContain(bad);
    expect(res.meta.source).toBe("filesystem");
    expect(res.data.find((e) => e.name === "README.md")?.size).toBeGreaterThan(0);
  });

  it("hides a symlink aliasing a blocked file and an outside target", async () => {
    const svc = await setup();
    symlinkSync(path.join(fx!.root, ".env"), path.join(fx!.root, "alias.txt"));
    symlinkSync(fx!.outside, path.join(fx!.root, "escape"));
    const n = names((await svc.listDirectory("ws")).data);
    expect(n).not.toContain("alias.txt");
    expect(n).not.toContain("escape");
  });

  it("shows an in-root symlink as type symlink", async () => {
    const svc = await setup();
    symlinkSync(path.join(fx!.root, "src"), path.join(fx!.root, "srclink"));
    const e = (await svc.listDirectory("ws")).data.find((x) => x.name === "srclink");
    expect(e?.type).toBe("symlink");
  });

  it("empty directory and limit truncation", async () => {
    const svc = await setup();
    mkdirSync(path.join(fx!.root, "empty"));
    const empty = await svc.listDirectory("ws", "empty");
    expect(empty.data).toEqual([]);
    expect(empty.meta.truncated).toBe(false);
    const lim = await svc.listDirectory("ws", ".", 2);
    expect(lim.data).toHaveLength(2);
    expect(lim.meta.truncated).toBe(true);
    expect(lim.meta.limit).toBe(2);
  });

  it("rejects traversal, files, blocked and ignored dirs, unknown workspace", async () => {
    const svc = await setup();
    await expect(svc.listDirectory("ws", "../outside")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(svc.listDirectory("ws", "README.md")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(svc.listDirectory("ws", "node_modules")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(svc.listDirectory("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(svc.listDirectory("ws", "src", 0)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("large directory stays fast and capped", async () => {
    const svc = await setup();
    const big = path.join(fx!.root, "big");
    mkdirSync(big);
    for (let i = 0; i < 3000; i++) writeFileSync(path.join(big, `f${String(i).padStart(5, "0")}.txt`), "x");
    const t = Date.now();
    const res = await svc.listDirectory("ws", "big");
    expect(Date.now() - t).toBeLessThan(2500);
    expect(res.data).toHaveLength(100);
    expect(res.meta.truncated).toBe(true);
    const tree = await svc.getDirectoryTree("ws", "big");
    expect(tree.meta.returnedCount).toBe(500);
    expect(tree.meta.truncated).toBe(true);
  });
});

describe("getFileInfo", () => {
  it("returns info without absolute paths", async () => {
    const svc = await setup();
    const res = await svc.getFileInfo("ws", "src/b.ts");
    expect(res.data).toMatchObject({ name: "b.ts", relPath: "src/b.ts", type: "file", isText: true, extension: "ts" });
    expect(JSON.stringify(res)).not.toContain(fx!.base);
    expect((await svc.getFileInfo("ws", "image.bin")).data.isText).toBe(false);
    expect((await svc.getFileInfo("ws", "src")).data.type).toBe("dir");
  });
  it("blocked file is denied", async () => {
    const svc = await setup();
    await expect(svc.getFileInfo("ws", ".env")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});

describe("readFile", () => {
  it("reads text and line ranges", async () => {
    const svc = await setup();
    const all = await svc.readFile("ws", "README.md");
    expect(all.data.content).toBe("Hello World\nsecond line\nthird Line");
    expect(all.data.totalLines).toBe(3);
    expect(all.data.truncated).toBe(false);
    const part = await svc.readFile("ws", "README.md", 2, 3);
    expect(part.data.content).toBe("second line\nthird Line");
    expect(part.data.lines).toEqual({ start: 2, end: 3 });
    const past = await svc.readFile("ws", "README.md", 50);
    expect(past.data.content).toBe("");
    await expect(svc.readFile("ws", "README.md", 3, 2)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("binary -> UNSUPPORTED, blocked -> PERMISSION_DENIED with no content (S5/S6)", async () => {
    const svc = await setup();
    await expect(svc.readFile("ws", "image.bin")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    const err = await svc.readFile("ws", ".env").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "PERMISSION_DENIED" });
    expect(String((err as Error).message)).not.toContain("SUPERSECRET");
    await expect(svc.readFile("ws", "src/secrets.txt")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(svc.readFile("ws", "node_modules/pkg/index.js")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("oversize file is truncated with meta (S7), multibyte not split", async () => {
    const svc = await setup({ limits: { maxFileBytes: 1000 } });
    writeFileSync(path.join(fx!.root, "big.txt"), "é".repeat(2000) + "\n");
    const res = await svc.readFile("ws", "big.txt");
    expect(res.data.truncated).toBe(true);
    expect(res.meta).toMatchObject({ truncated: true, limit: 1000, partial: true });
    expect(Buffer.byteLength(res.data.content)).toBeLessThanOrEqual(1000);
    expect(res.data.content).not.toContain("�");
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it("limit overrides cannot exceed defaults", async () => {
    const svc = await setup({ limits: { maxFileBytes: 999_999_999 } });
    writeFileSync(path.join(fx!.root, "huge.txt"), "a".repeat(250_000));
    const res = await svc.readFile("ws", "huge.txt");
    expect(res.meta.limit).toBe(200000);
    expect(res.data.truncated).toBe(true);
  });

  it("non-UTF8 text is decoded with a warning", async () => {
    const svc = await setup();
    writeFileSync(path.join(fx!.root, "latin.txt"), Buffer.from("caf\xe9 au lait\n", "latin1"));
    const res = await svc.readFile("ws", "latin.txt");
    expect(res.data.content).toContain("caf");
    expect(res.warnings.join(" ")).toMatch(/UTF-8/);
  });

  it("very long line is bounded by the byte cap", async () => {
    const svc = await setup();
    writeFileSync(path.join(fx!.root, "long.txt"), "x".repeat(500_000));
    const res = await svc.readFile("ws", "long.txt");
    expect(res.data.content.length).toBe(200000);
    expect(res.meta.truncated).toBe(true);
  });

  it("unreadable file gives PERMISSION_DENIED", async (ctx) => {
    if (process.getuid?.() === 0 || process.platform === "win32") ctx.skip();
    const svc = await setup();
    const p = path.join(fx!.root, "locked.txt");
    writeFileSync(p, "nope");
    chmodSync(p, 0o000);
    await expect(svc.readFile("ws", "locked.txt")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("allowedExtensions restricts reads", async () => {
    const svc = await setup({ allowedExtensions: [".md"] });
    expect((await svc.readFile("ws", "README.md")).data.truncated).toBe(false);
    await expect(svc.readFile("ws", "src/b.ts")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(names((await svc.listDirectory("ws", "src")).data)).not.toContain("b.ts");
  });
});

describe("searchFiles", () => {
  it("finds by substring, case-insensitive; blocked and ignored absent (S5)", async () => {
    const svc = await setup();
    const res = await svc.searchFiles("ws", "READ");
    expect(res.data.map((h) => h.relPath)).toEqual(["README.md"]);
    const all = await svc.searchFiles("ws", "e");
    const paths = all.data.map((h) => h.relPath);
    for (const p of paths) {
      expect(p).not.toMatch(/\.env|id_rsa|secrets|node_modules|\.git/);
    }
    expect((await svc.searchFiles("ws", "id_rsa")).data).toEqual([]);
    expect((await svc.searchFiles("ws", "index.js")).data).toEqual([]);
  });

  it("truncates above the limit (S7)", async () => {
    const svc = await setup();
    mkdirSync(path.join(fx!.root, "many"));
    for (let i = 0; i < 150; i++) writeFileSync(path.join(fx!.root, "many", `m${i}.txt`), "x");
    const res = await svc.searchFiles("ws", "m");
    expect(res.data).toHaveLength(100);
    expect(res.meta).toMatchObject({ truncated: true, limit: 100 });
    const two = await svc.searchFiles("ws", "m", "many", 5);
    expect(two.data).toHaveLength(5);
    expect(two.meta.truncated).toBe(true);
  });

  it("does not follow symlinked dirs", async () => {
    const svc = await setup();
    symlinkSync(fx!.outside, path.join(fx!.root, "link"));
    expect((await svc.searchFiles("ws", "payload")).data).toEqual([]);
  });
});

describe("searchContent", () => {
  it("literal, case-insensitive by default, skips blocked/ignored/binary (S5)", async () => {
    const svc = await setup();
    const res = await svc.searchContent("ws", "needle");
    expect(res.data.map((h) => h.relPath)).toEqual(["src/b.ts"]);
    expect(res.data[0]).toMatchObject({ line: 1 });
    expect(JSON.stringify(res)).not.toContain("SUPERSECRET");
  });

  it("case-sensitive option and extension filter", async () => {
    const svc = await setup();
    expect((await svc.searchContent("ws", "needle", { caseSensitive: true })).data).toEqual([]);
    expect((await svc.searchContent("ws", "Needle", { caseSensitive: true })).data).toHaveLength(1);
    expect((await svc.searchContent("ws", "Hello", { extensions: ["ts"] })).data).toEqual([]);
    expect((await svc.searchContent("ws", "Hello", { extensions: [".md"] })).data).toHaveLength(1);
  });

  it("treats regex metacharacters literally", async () => {
    const svc = await setup();
    writeFileSync(path.join(fx!.root, "re.txt"), "a.*b\naxxb\n");
    const res = await svc.searchContent("ws", "a.*b");
    expect(res.data).toHaveLength(1);
    expect(res.data[0]?.line).toBe(1);
  });

  it("truncates above result limit (S7) and bounds snippets", async () => {
    const svc = await setup();
    writeFileSync(path.join(fx!.root, "lines.txt"), "match here\n".repeat(150));
    writeFileSync(path.join(fx!.root, "wide.txt"), "y".repeat(5000) + " WIDE " + "y".repeat(5000));
    const res = await svc.searchContent("ws", "match");
    expect(res.data).toHaveLength(100);
    expect(res.meta).toMatchObject({ truncated: true, limit: 100 });
    const wide = await svc.searchContent("ws", "WIDE");
    expect(wide.data[0]?.snippet.length).toBeLessThanOrEqual(302);
    expect(wide.data[0]?.snippet).toContain("WIDE");
  });

  it("stops at maxFilesScanned and reports it", async () => {
    const svc = await setup({ limits: { maxFilesScanned: 3 } });
    const res = await svc.searchContent("ws", "zzz-no-match");
    expect(res.meta).toMatchObject({ truncated: true, partial: true });
  });

  it("rejects empty and multi-line queries", async () => {
    const svc = await setup();
    await expect(svc.searchContent("ws", "")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(svc.searchContent("ws", "a\nb")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("does not search through symlinked dirs", async () => {
    const svc = await setup();
    symlinkSync(fx!.outside, path.join(fx!.root, "link"));
    expect((await svc.searchContent("ws", "TOP-SECRET-OUTSIDE")).data).toEqual([]);
  });
});

describe("getDirectoryTree", () => {
  it("builds a tree omitting blocked and ignored, with counts (S5)", async () => {
    const svc = await setup();
    const res = await svc.getDirectoryTree("ws");
    const top = names(res.data.root.children ?? []);
    expect(top).toContain("src");
    for (const bad of [".env", "id_rsa", "node_modules", ".git"]) expect(top).not.toContain(bad);
    const src = res.data.root.children?.find((c) => c.name === "src");
    expect(names(src?.children ?? [])).not.toContain("secrets.txt");
    expect(res.data.counts.files).toBeGreaterThan(0);
    expect(res.meta.truncated).toBe(false);
    expect(JSON.stringify(res)).not.toContain(fx!.base);
  });

  it("caps depth", async () => {
    const svc = await setup();
    mkdirSync(path.join(fx!.root, "a", "b", "c"), { recursive: true });
    const res = await svc.getDirectoryTree("ws", ".", 1);
    const a = res.data.root.children?.find((c) => c.name === "a");
    expect(a?.depthLimited).toBe(true);
    expect(a?.children).toBeUndefined();
    const deep = await svc.getDirectoryTree("ws", ".", 99);
    expect(deep.meta.maxDepth).toBe(4);
  });

  it("does not follow symlinked dirs (S4)", async () => {
    const svc = await setup();
    symlinkSync(fx!.outside, path.join(fx!.root, "link"));
    symlinkSync(fx!.root, path.join(fx!.root, "src", "loop"));
    const res = await svc.getDirectoryTree("ws");
    expect(JSON.stringify(res)).not.toContain("payload.txt");
    expect(names(res.data.root.children ?? [])).not.toContain("link");
    const src = res.data.root.children?.find((c) => c.name === "src");
    const loop = src?.children?.find((c) => c.name === "loop");
    expect(loop?.type).toBe("symlink");
    expect(loop?.children).toBeUndefined();
  });

  it("truncates above the entry cap (S7)", async () => {
    const svc = await setup({ limits: { maxTreeEntries: 3 } });
    const res = await svc.getDirectoryTree("ws");
    expect(res.meta).toMatchObject({ truncated: true, returnedCount: 3, limit: 3 });
  });
});
