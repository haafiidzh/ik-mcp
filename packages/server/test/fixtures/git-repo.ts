import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Test helper: real temporary git repositories (no global config, fixed identity). */
export function tmpRoot(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "dwmcp-git-")));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
}

export function makeRepo(root: string, opts: { commit?: boolean } = { commit: true }): string {
  const dir = path.join(root, "repo");
  execFileSync("mkdir", ["-p", dir]);
  git(dir, "init", "-q", "-b", "main");
  if (opts.commit !== false) {
    writeFileSync(path.join(dir, "a.txt"), "a\n");
    git(dir, "add", "a.txt");
    git(dir, "commit", "-q", "-m", "first commit");
  }
  return dir;
}
