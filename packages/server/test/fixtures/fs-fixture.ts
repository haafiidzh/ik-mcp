import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface FsFixture {
  base: string;
  root: string;
  outside: string;
  cleanup(): void;
}

/** Builds <tmp>/root (the allowed root) and <tmp>/outside (a secret target) in a fresh temp dir. */
export function makeFsFixture(): FsFixture {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "dwmcp-fs-")));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(path.join(outside, "payload.txt"), "TOP-SECRET-OUTSIDE");
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "a.txt"), "hello");
  return { base, root, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export function link(target: string, at: string): void {
  symlinkSync(target, at);
}
