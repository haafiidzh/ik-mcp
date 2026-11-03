import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAppError } from "../../src/core/errors.js";
import { assertText, checkFileSize, sniffBinary } from "../../src/integrations/filesystem/binary-detect.js";
import { createBlockMatcher, isIgnoredPath } from "../../src/integrations/filesystem/blocked-patterns.js";
import { createPathGuard, parseRelativePath, type PathGuard } from "../../src/integrations/filesystem/path-guard.js";
import { link, makeFsFixture, type FsFixture } from "../fixtures/fs-fixture.js";

let fx: FsFixture;
let guard: PathGuard;

beforeEach(async () => {
  fx = makeFsFixture();
  guard = await createPathGuard([fx.root], createBlockMatcher());
});
afterEach(() => fx.cleanup());

async function code(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    if (isAppError(e)) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("expected rejection");
}

function codeSync(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (isAppError(e)) return e.code;
    throw e;
  }
  throw new Error("expected throw");
}

describe("S1 traversal", () => {
  it.each(["../x", "a/../../x", "..\\x", "src/..", "a/./../b", "...", "src/../../outside/payload.txt"])("rejects %s", async (p) => {
    const r = await code(guard.resolve(p));
    expect(["INVALID_INPUT", "PERMISSION_DENIED"]).toContain(r.code);
    expect(r.message).not.toContain(fx.base);
  });
  it("S1 rejects empty, whitespace, NUL, control chars, over-long path and segment", () => {
    for (const p of ["", "   ", "a\0b", "a\nb", "x".repeat(1025), `${"y".repeat(256)}/z`]) {
      expect(codeSync(() => parseRelativePath(p))).toBe("INVALID_INPUT");
    }
  });
  it("S1 rejects non-string input", () => {
    expect(codeSync(() => parseRelativePath(42))).toBe("INVALID_INPUT");
  });
  it("S1 accepts normal relative paths and the root", () => {
    expect(parseRelativePath("src//a.txt")).toEqual(["src", "a.txt"]);
    expect(parseRelativePath(".")).toEqual([]);
  });
});

describe("S2 encoded traversal", () => {
  it.each(["%2e%2e/x", "%2E%2E%2Fx", "..%2f", "a%5Cb", "a%5cb", "x%00"])("rejects %s", async (p) => {
    expect((await code(guard.resolve(p))).code).toBe("INVALID_INPUT");
  });
});

describe("S3 absolute paths", () => {
  it.each(["/etc/passwd", "C:\\Windows", "C:/Windows", "\\\\host\\s", "//host/s", "~", "~/x", "src/a.txt:stream"])("rejects %s", async (p) => {
    const r = await code(guard.resolve(p));
    expect(r.code).toBe("INVALID_INPUT");
    expect(r.message).not.toContain("passwd");
  });
  it("S3 absolute path to a real file inside the root is still rejected", async () => {
    expect((await code(guard.resolve(path.join(fx.root, "src", "a.txt")))).code).toBe("INVALID_INPUT");
  });
});

describe("S4 symlink escape", () => {
  it("S4 file symlink to outside is denied", async () => {
    link(path.join(fx.outside, "payload.txt"), path.join(fx.root, "lnk.txt"));
    const r = await code(guard.resolve("lnk.txt"));
    expect(r.code).toBe("PERMISSION_DENIED");
    expect(r.message).not.toContain(fx.base);
    expect((await code(guard.openFile("lnk.txt"))).code).toBe("PERMISSION_DENIED");
  });
  it("S4 directory symlink to outside is denied, including nested path through it", async () => {
    link(fx.outside, path.join(fx.root, "dirlink"));
    expect((await code(guard.resolve("dirlink"))).code).toBe("PERMISSION_DENIED");
    expect((await code(guard.resolve("dirlink/payload.txt"))).code).toBe("PERMISSION_DENIED");
  });
  it("S4 describeEntry reports symlinks without following them", async () => {
    link(fx.outside, path.join(fx.root, "dirlink"));
    link(path.join(fx.root, "src"), path.join(fx.root, "inlink"));
    expect(await guard.describeEntry(fx.root, "dirlink")).toEqual({ kind: "symlink", targetInside: false });
    expect(await guard.describeEntry(fx.root, "inlink")).toEqual({ kind: "symlink", targetInside: true });
    expect((await guard.describeEntry(fx.root, "src")).kind).toBe("directory");
    expect((await code(guard.describeEntry(fx.root, "../outside"))).code).toBe("INVALID_INPUT");
    expect((await code(guard.describeEntry(fx.outside, "payload.txt"))).code).toBe("PERMISSION_DENIED");
  });
  it("S4 symlink staying inside the root is allowed and reports the real relative path", async () => {
    link(path.join(fx.root, "src", "a.txt"), path.join(fx.root, "alias.txt"));
    const r = await guard.resolve("alias.txt");
    expect(r.relativePath).toBe("src/a.txt");
    expect(r.kind).toBe("file");
  });
  it("S4 symlink loop is INVALID_INPUT, broken symlink is NOT_FOUND", async () => {
    symlinkSync("b", path.join(fx.root, "a"));
    symlinkSync("a", path.join(fx.root, "b"));
    symlinkSync("missing-target", path.join(fx.root, "broken"));
    expect((await code(guard.resolve("a"))).code).toBe("INVALID_INPUT");
    expect((await code(guard.resolve("broken"))).code).toBe("NOT_FOUND");
  });
  it("S4 root that is itself a symlink: boundary is its real target, escapes still denied", async () => {
    const rootLink = path.join(fx.base, "rootlink");
    link(fx.root, rootLink);
    const g = await createPathGuard([rootLink], createBlockMatcher());
    expect((await g.resolve("src/a.txt")).kind).toBe("file");
    link(fx.outside, path.join(fx.root, "esc"));
    expect((await code(g.resolve("esc/payload.txt"))).code).toBe("PERMISSION_DENIED");
  });
  it("S4 sibling directory with a shared name prefix is not inside the root", async () => {
    mkdirSync(path.join(fx.base, "root-evil"));
    writeFileSync(path.join(fx.base, "root-evil", "f.txt"), "x");
    link(path.join(fx.base, "root-evil"), path.join(fx.root, "evil"));
    expect((await code(guard.resolve("evil/f.txt"))).code).toBe("PERMISSION_DENIED");
  });
  it("S4 swapped-in symlink between resolve and open is not followed (O_NOFOLLOW)", async () => {
    const resolved = await guard.resolve("src/a.txt");
    const fs = await import("node:fs");
    fs.rmSync(resolved.realPath);
    link(path.join(fx.outside, "payload.txt"), resolved.realPath);
    // openFile resolves again: the swap is caught by containment check.
    expect((await code(guard.openFile("src/a.txt"))).code).toBe("PERMISSION_DENIED");
  });
  it("S4 not found and not-a-file map to safe codes", async () => {
    expect((await code(guard.resolve("nope.txt"))).code).toBe("NOT_FOUND");
    expect((await code(guard.openFile("src"))).code).toBe("INVALID_INPUT");
  });
  it("S4 openFile returns a usable handle and size for a normal file", async () => {
    const f = await guard.openFile("src/a.txt");
    try {
      expect(f.size).toBe(5);
    } finally {
      await f.handle.close();
    }
  });
});

describe("S5 blocked names", () => {
  const blocked = [
    ".env", ".env.local", ".ENV", "x.pem", "a/b/server.key", "c.p12", "c.pfx", "id_rsa", "id_rsa.pub", "id_ed25519", "id_ecdsa",
    "db.kdbx", ".npmrc", ".pypirc", ".netrc", ".git-credentials", ".git/config", ".git/hooks/x", "app/.ssh/known_hosts",
    ".aws/credentials", ".gnupg/k", ".docker/config.json", "credentials-prod.json", "my_secret_notes.txt", "deep/.ssh/id_rsa",
  ];
  it.each(blocked)("S5 denies %s (before touching the disk)", async (p) => {
    expect((await code(guard.resolve(p))).code).toBe("PERMISSION_DENIED");
  });
  it("S5 allows .env.example and normal files", () => {
    const m = createBlockMatcher();
    expect(m.isBlocked([".env.example"])).toBe(false);
    expect(m.isBlocked(["src", "a.txt"])).toBe(false);
    expect(m.isBlocked([".gitignore"])).toBe(false);
    expect(m.isBlocked([".docker", "other.json"])).toBe(false);
  });
  it("S5 existing blocked file is denied via resolve and openFile", async () => {
    writeFileSync(path.join(fx.root, ".env"), "TOKEN=canary");
    expect((await code(guard.openFile(".env"))).code).toBe("PERMISSION_DENIED");
  });
  it("S5 harmless symlink name pointing at a blocked file inside the root is denied", async () => {
    writeFileSync(path.join(fx.root, ".env"), "TOKEN=canary");
    link(path.join(fx.root, ".env"), path.join(fx.root, "innocent.txt"));
    expect((await code(guard.resolve("innocent.txt"))).code).toBe("PERMISSION_DENIED");
  });
  it("S5 config blockedNames are merged; unblock removes a pattern or exempts a name", () => {
    const m = createBlockMatcher({ blockedNames: ["private.txt", "vault/*.db"], unblock: [".npmrc", "my_secret_notes.txt"] });
    expect(m.isBlocked(["private.txt"])).toBe(true);
    expect(m.isBlocked(["vault", "x.db"])).toBe(true);
    expect(m.isBlocked([".env"])).toBe(true);
    expect(m.isBlocked([".npmrc"])).toBe(false);
    expect(m.isBlocked(["my_secret_notes.txt"])).toBe(false);
    expect(m.isBlocked(["other_secret.txt"])).toBe(true);
    expect(m.unblocked).toEqual([".npmrc", "my_secret_notes.txt"]);
  });
  it("S5 isBlocked on the guard filters listing segments; ignoreDirs match any segment", () => {
    expect(guard.isBlocked(["x", ".ssh", "k"])).toBe(true);
    expect(isIgnoredPath(["a", "node_modules", "b"], ["node_modules", ".git", "dist", "vendor"])).toBe(true);
    expect(isIgnoredPath(["a", "b"], ["node_modules"])).toBe(false);
  });
});

describe("S6 binary files", () => {
  it("S6 NUL byte is binary and assertText throws UNSUPPORTED without a path", () => {
    const buf = Buffer.from([0x68, 0x69, 0x00, 0x21]);
    expect(sniffBinary(buf)).toMatchObject({ binary: true, reason: "nul-byte" });
    try {
      assertText(buf);
      throw new Error("should throw");
    } catch (e) {
      expect(isAppError(e) && e.code).toBe("UNSUPPORTED");
    }
  });
  it("S6 high control-byte ratio is binary; UTF-8 text and empty input are not", () => {
    expect(sniffBinary(Buffer.alloc(100, 0x01))).toMatchObject({ binary: true, reason: "non-text-ratio" });
    expect(sniffBinary(Buffer.from("héllo wörld ✓\n\ttext", "utf8")).binary).toBe(false);
    expect(sniffBinary(Buffer.alloc(0)).binary).toBe(false);
  });
  it("S6 only the first N bytes are sniffed", () => {
    const buf = Buffer.concat([Buffer.alloc(10, 0x61), Buffer.from([0])]);
    expect(sniffBinary(buf, 10).binary).toBe(false);
    expect(sniffBinary(buf, 11).binary).toBe(true);
  });
  it("S6 real binary file read through the guard is detected", async () => {
    writeFileSync(path.join(fx.root, "img.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const f = await guard.openFile("img.bin");
    try {
      const buf = Buffer.alloc(64);
      const { bytesRead } = await f.handle.read(buf, 0, 64, 0);
      expect(sniffBinary(buf.subarray(0, bytesRead)).binary).toBe(true);
    } finally {
      await f.handle.close();
    }
  });
});

describe("S7 size cap (size-check part)", () => {
  it("S7 reports truncation for files over maxFileBytes", () => {
    expect(checkFileSize(300_000, 200_000)).toEqual({ size: 300_000, limit: 200_000, exceeds: true, readBytes: 200_000 });
    expect(checkFileSize(10, 200_000)).toMatchObject({ exceeds: false, readBytes: 10 });
    expect(checkFileSize(200_000, 200_000).exceeds).toBe(false);
  });
});

describe("guard setup", () => {
  it("fails closed for missing, relative or file roots", async () => {
    const m = createBlockMatcher();
    for (const roots of [[], ["relative/dir"], [path.join(fx.base, "missing")], [path.join(fx.outside, "payload.txt")]]) {
      expect((await code(createPathGuard(roots, m))).code).toBe("INTEGRATION_UNAVAILABLE");
    }
  });
  it("multiple roots: each is its own boundary", async () => {
    const g = await createPathGuard([fx.root, fx.outside], createBlockMatcher());
    expect((await g.resolve("payload.txt", 1)).kind).toBe("file");
    expect((await code(g.resolve("payload.txt", 0))).code).toBe("NOT_FOUND");
    expect((await code(g.resolve("x", 5))).code).toBe("INVALID_INPUT");
  });
});
