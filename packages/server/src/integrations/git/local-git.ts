import { execFile as nodeExecFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";
import { isInside } from "../filesystem/path-guard.js";

/**
 * Local git helper (P5-02, human decision Q6, 2026-11-03). Read-only, fixed commands only.
 *
 * - `execFile("git", fixedArgs)` only: never a shell, never `exec`, no `shell` option, no
 *   caller-supplied arguments, refs or paths. `cwd` is the workspace root after a realpath
 *   containment check against the allowed roots.
 * - Environment is rebuilt from scratch (PATH and a few fixed variables); the server env is never
 *   passed. System and global git config are disabled.
 * - A repository-controlled `.git/config` can run programs. Every command runs with
 *   `-c core.fsmonitor=false -c core.hooksPath=<null device> -c core.pager=cat
 *   -c log.showSignature=false -c protocol.ext.allow=never --no-optional-locks`, and only
 *   commands that never invoke diff/textconv drivers are used (rev-parse, symbolic-ref, log -1
 *   without a patch, status with submodules ignored).
 * - Dubious ownership (safe.directory) yields "unavailable"; no override is ever added.
 * - Remotes are NOT exposed (URLs can embed credentials).
 * - Messages are fixed strings: no absolute paths, no stderr echo.
 * - `.git` must be a real directory inside the workspace root (no symlink, no gitfile), and
 *   GIT_CEILING_DIRECTORIES stops discovery of a repository above the workspace root.
 */

export interface ExecFileOptions {
  cwd: string;
  env: Record<string, string>;
  timeout: number;
  maxBuffer: number;
  encoding: "buffer";
  windowsHide: true;
}
export type ExecFileFn = (file: string, args: readonly string[], options: ExecFileOptions) => Promise<{ stdout: Buffer; stderr: Buffer }>;

const defaultExecFile: ExecFileFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    nodeExecFile(file, [...args], options, (err, stdout, stderr) => {
      if (err) {
        // Attach captured stderr for classification only; it is never returned to callers.
        (err as Error & { stderrBuf?: Buffer }).stderrBuf = Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr ?? ""));
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });

export interface LocalGitOptions {
  /** Resolved allowed roots (config). The workspace root must realpath inside one of them. */
  allowedRoots: readonly string[];
  /** Test seam; production uses node:child_process execFile. */
  execFile?: ExecFileFn;
  /** Per-command timeout, default 5000 ms. */
  timeoutMs?: number;
  /** Per-command stdout cap, default 262144 bytes. */
  maxBuffer?: number;
  /** Cap for the last commit subject, default 300 characters. */
  maxSubjectChars?: number;
}

export interface LocalGitData {
  branch: string | null;
  detachedHead: boolean;
  /** True for a repository with no commits yet. */
  empty: boolean;
  lastCommit: { shortHash: string; date: string; subject: string; subjectTruncated: boolean } | null;
  /** Null when the status output exceeded the output cap. */
  workingTree: { clean: boolean; staged: number; unstaged: number; untracked: number; conflicted: number } | null;
}

export type LocalGitResult =
  | { status: "ok"; data: LocalGitData; partial: boolean }
  | { status: "unavailable"; reason: string };

export interface LocalGit {
  inspect(rootPath: string): Promise<LocalGitResult>;
}

export const GIT_REASONS = {
  missing: "git is not installed or not on PATH.",
  notRepo: "The workspace root is not a git repository.",
  outside: "The workspace root is not inside the allowed roots.",
  ownership: "git refused the repository (unsafe ownership); no override is applied.",
  timeout: "git timed out.",
  failed: "git could not read the repository.",
} as const;

class GitUnavailable extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
class OutputTooLarge extends Error {}

/** Fixed prefix applied to every invocation (neutralises repository-controlled execution). */
export function hardenedPrefix(): string[] {
  return [
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${devNull}`,
    "-c", "core.pager=cat",
    "-c", "log.showSignature=false",
    "-c", "protocol.ext.allow=never",
    "--no-optional-locks",
  ];
}

export function sanitizedEnv(root: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CEILING_DIRECTORIES: path.dirname(root),
    LC_ALL: "C",
  };
  if (process.platform === "win32" && process.env["SystemRoot"] !== undefined) env["SystemRoot"] = process.env["SystemRoot"];
  return env;
}

const DUBIOUS = /dubious ownership|safe\.directory/i;
const decoder = new TextDecoder("utf-8");

export function createLocalGit(options: LocalGitOptions): LocalGit {
  const exec = options.execFile ?? defaultExecFile;
  const timeout = options.timeoutMs ?? 5000;
  const maxBuffer = options.maxBuffer ?? 262144;
  const maxSubject = options.maxSubjectChars ?? 300;

  async function git(cwd: string, args: readonly string[]): Promise<{ ok: true; out: string } | { ok: false; stderr: string }> {
    try {
      const r = await exec("git", [...hardenedPrefix(), ...args], {
        cwd,
        env: sanitizedEnv(cwd),
        timeout,
        maxBuffer,
        encoding: "buffer",
        windowsHide: true,
      });
      return { ok: true, out: decoder.decode(r.stdout) };
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; stderrBuf?: Buffer };
      if (err.code === "ENOENT") throw new GitUnavailable(GIT_REASONS.missing);
      if (err.code === "ERR_CHILD_PROCESS_STDOUT_MAXBUFFER") throw new OutputTooLarge();
      if (err.killed === true || err.code === "ETIMEDOUT" || err.signal === "SIGTERM") throw new GitUnavailable(GIT_REASONS.timeout);
      const stderr = err.stderrBuf !== undefined ? decoder.decode(err.stderrBuf) : "";
      if (DUBIOUS.test(stderr)) throw new GitUnavailable(GIT_REASONS.ownership);
      return { ok: false, stderr };
    }
  }

  async function validateRoot(rootPath: string): Promise<string> {
    let real: string;
    try {
      real = await realpath(rootPath);
    } catch {
      throw new GitUnavailable(GIT_REASONS.outside);
    }
    let inside = false;
    for (const r of options.allowedRoots) {
      let realRoot: string;
      try {
        realRoot = await realpath(r);
      } catch {
        continue;
      }
      if (isInside(realRoot, real)) inside = true;
    }
    if (!inside) throw new GitUnavailable(GIT_REASONS.outside);
    try {
      const st = await lstat(path.join(real, ".git"));
      if (!st.isDirectory()) throw new GitUnavailable(GIT_REASONS.notRepo);
    } catch (e) {
      if (e instanceof GitUnavailable) throw e;
      throw new GitUnavailable(GIT_REASONS.notRepo);
    }
    return real;
  }

  /** Count porcelain v1 -z entries. Rename/copy entries carry one extra NUL-separated path. */
  function parseStatus(out: string): NonNullable<LocalGitData["workingTree"]> {
    const tokens = out.split("\0");
    let staged = 0;
    let unstaged = 0;
    let untracked = 0;
    let conflicted = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i] as string;
      if (t.length < 3) continue;
      const x = t[0] as string;
      const y = t[1] as string;
      if (x === "R" || x === "C") i++;
      if (x === "?" && y === "?") untracked++;
      else if (x === "!" ) continue;
      else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) conflicted++;
      else {
        if (x !== " ") staged++;
        if (y !== " ") unstaged++;
      }
    }
    return { clean: staged + unstaged + untracked + conflicted === 0, staged, unstaged, untracked, conflicted };
  }

  return {
    async inspect(rootPath) {
      try {
        const cwd = await validateRoot(rootPath);

        let branch: string | null = null;
        let detachedHead = false;
        let empty = false;
        const head = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
        if (head.ok) {
          const name = head.out.trim();
          if (name === "HEAD") detachedHead = true;
          else branch = name.length > 0 ? name : null;
        } else {
          // Either not a repository, or a repository without commits.
          const probe = await git(cwd, ["rev-parse", "--git-dir"]);
          if (!probe.ok) return { status: "unavailable", reason: GIT_REASONS.notRepo };
          const sym = await git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
          empty = true;
          if (sym.ok) branch = sym.out.trim() || null;
          else detachedHead = true;
        }

        let lastCommit: LocalGitData["lastCommit"] = null;
        if (!empty) {
          const log = await git(cwd, ["log", "-1", "--no-show-signature", "--no-color", "--format=%h%x1f%cI%x1f%s"]);
          if (log.ok) {
            const [shortHash, date, ...rest] = log.out.replace(/\n$/, "").split("\x1f");
            if (shortHash !== undefined && date !== undefined && /^[0-9a-f]{4,64}$/.test(shortHash)) {
              const subject = rest.join(" ").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
              const cut = [...subject].length > maxSubject;
              lastCommit = {
                shortHash,
                date: date.slice(0, 40),
                subject: cut ? [...subject].slice(0, maxSubject).join("") : subject,
                subjectTruncated: cut,
              };
            }
          }
        }

        let workingTree: LocalGitData["workingTree"] = null;
        let partial = false;
        try {
          const st = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all"]);
          if (st.ok) workingTree = parseStatus(st.out);
          else partial = true;
        } catch (e) {
          if (e instanceof OutputTooLarge) partial = true;
          else throw e;
        }
        if (workingTree === null) partial = true;

        return { status: "ok", data: { branch, detachedHead, empty, lastCommit, workingTree }, partial };
      } catch (e) {
        if (e instanceof GitUnavailable) return { status: "unavailable", reason: e.reason };
        if (e instanceof OutputTooLarge) return { status: "unavailable", reason: GIT_REASONS.failed };
        return { status: "unavailable", reason: GIT_REASONS.failed };
      }
    },
  };
}
