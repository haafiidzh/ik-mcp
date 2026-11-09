import { chmodSync, rmSync, writeFileSync, existsSync, symlinkSync, mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalGit, GIT_REASONS, hardenedPrefix, sanitizedEnv, type ExecFileFn, type ExecFileOptions } from "../../src/integrations/git/local-git.js";
import { git, makeRepo, tmpRoot } from "../fixtures/git-repo.js";

const roots: string[] = [];
function root(): string {
  const r = tmpRoot();
  roots.push(r);
  return r;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("local git (real repositories)", () => {
  it("happy path: branch, last commit, clean tree", async () => {
    const r = root();
    const repo = makeRepo(r);
    const res = await createLocalGit({ allowedRoots: [r] }).inspect(repo);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.data.branch).toBe("main");
    expect(res.data.detachedHead).toBe(false);
    expect(res.data.empty).toBe(false);
    expect(res.data.lastCommit?.subject).toBe("first commit");
    expect(res.data.lastCommit?.shortHash).toMatch(/^[0-9a-f]{4,}$/);
    expect(res.data.workingTree).toEqual({ clean: true, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
    expect(res.partial).toBe(false);
  });

  it("dirty tree: staged, unstaged, untracked and renames are counted once", async () => {
    const r = root();
    const repo = makeRepo(r);
    writeFileSync(path.join(repo, "a.txt"), "changed\n");
    writeFileSync(path.join(repo, "new.txt"), "n\n");
    writeFileSync(path.join(repo, "b.txt"), "b\n");
    git(repo, "add", "b.txt");
    git(repo, "mv", "a.txt", "c.txt");
    writeFileSync(path.join(repo, "u.txt"), "u\n");
    const res = await createLocalGit({ allowedRoots: [r] }).inspect(repo);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    const w = res.data.workingTree;
    expect(w?.clean).toBe(false);
    expect(w?.untracked).toBe(2); // new.txt, u.txt
    expect(w?.staged).toBe(2); // b.txt added, a.txt renamed to c.txt
    expect(w?.conflicted).toBe(0);
  });

  it("empty repository (no commits) is ok with empty=true and the unborn branch", async () => {
    const r = root();
    const repo = makeRepo(r, { commit: false });
    const res = await createLocalGit({ allowedRoots: [r] }).inspect(repo);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.data.empty).toBe(true);
    expect(res.data.branch).toBe("main");
    expect(res.data.lastCommit).toBeNull();
  });

  it("detached HEAD: branch null, detachedHead true", async () => {
    const r = root();
    const repo = makeRepo(r);
    git(repo, "checkout", "-q", "--detach");
    const res = await createLocalGit({ allowedRoots: [r] }).inspect(repo);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.data.detachedHead).toBe(true);
    expect(res.data.branch).toBeNull();
    expect(res.data.lastCommit).not.toBeNull();
  });

  it("not a repository is unavailable without paths", async () => {
    const r = root();
    const dir = path.join(r, "plain");
    mkdirSync(dir);
    const res = await createLocalGit({ allowedRoots: [r] }).inspect(dir);
    expect(res).toEqual({ status: "unavailable", reason: GIT_REASONS.notRepo });
  });

  it("a repository above the workspace root is not discovered (ceiling)", async () => {
    const r = root();
    const repo = makeRepo(r);
    const sub = path.join(repo, "sub");
    mkdirSync(sub);
    const res = await createLocalGit({ allowedRoots: [r] }).inspect(sub);
    expect(res.status).toBe("unavailable");
  });

  it("a root outside the allowed roots or a symlinked .git is refused", async () => {
    const r = root();
    const other = root();
    const repo = makeRepo(other);
    expect(await createLocalGit({ allowedRoots: [r] }).inspect(repo)).toEqual({ status: "unavailable", reason: GIT_REASONS.outside });
    const linked = path.join(r, "linked");
    mkdirSync(linked);
    symlinkSync(path.join(repo, ".git"), path.join(linked, ".git"));
    expect(await createLocalGit({ allowedRoots: [r] }).inspect(linked)).toEqual({ status: "unavailable", reason: GIT_REASONS.notRepo });
  });

  it("non-UTF-8 commit subject does not break the result", async () => {
    const r = root();
    const repo = makeRepo(r);
    writeFileSync(path.join(repo, "x.txt"), "x\n");
    git(repo, "add", "x.txt");
    // Commit message bytes invalid as UTF-8, with i18n.commitEncoding left default.
    const msg = path.join(r, "msg.bin");
    writeFileSync(msg, Buffer.from([0x66, 0xe9, 0xff, 0x0a]));
    git(repo, "commit", "-q", "-F", msg);
    const res = await createLocalGit({ allowedRoots: [r] }).inspect(repo);
    expect(res.status).toBe("ok");
  });

  it("remotes are never exposed, even with credentials in the URL", async () => {
    const r = root();
    const repo = makeRepo(r);
    git(repo, "remote", "add", "origin", "https://user:s3cretpass@example.com/o/r.git");
    const res = await createLocalGit({ allowedRoots: [r] }).inspect(repo);
    const text = JSON.stringify(res);
    expect(text).not.toContain("s3cretpass");
    expect(text).not.toContain("example.com");
    expect(text).not.toContain(r);
  });
});

describe("local git (fake execFile)", () => {
  interface Call { file: string; args: readonly string[]; options: ExecFileOptions }
  function fake(handler: (c: Call) => { stdout?: string; err?: Partial<NodeJS.ErrnoException> & { killed?: boolean; stderrBuf?: Buffer } }): { fn: ExecFileFn; calls: Call[] } {
    const calls: Call[] = [];
    const fn: ExecFileFn = async (file, args, options) => {
      const c = { file, args, options };
      calls.push(c);
      const r = handler(c);
      if (r.err) throw Object.assign(new Error("boom /secret/path"), r.err);
      return { stdout: Buffer.from(r.stdout ?? ""), stderr: Buffer.alloc(0) };
    };
    return { fn, calls };
  }

  it("missing git binary maps to unavailable", async () => {
    const r = root();
    const repo = makeRepo(r);
    const { fn } = fake(() => ({ err: { code: "ENOENT" } }));
    expect(await createLocalGit({ allowedRoots: [r], execFile: fn }).inspect(repo)).toEqual({ status: "unavailable", reason: GIT_REASONS.missing });
  });

  it("timeout maps to unavailable", async () => {
    const r = root();
    const repo = makeRepo(r);
    const { fn } = fake(() => ({ err: { killed: true, signal: "SIGTERM" } }));
    expect(await createLocalGit({ allowedRoots: [r], execFile: fn }).inspect(repo)).toEqual({ status: "unavailable", reason: GIT_REASONS.timeout });
  });

  it("dubious ownership maps to unavailable and no safe.directory override is tried", async () => {
    const r = root();
    const repo = makeRepo(r);
    const { fn, calls } = fake(() => ({ err: { code: "128" as unknown as string, stderrBuf: Buffer.from("fatal: detected dubious ownership in repository at '/x'") } }));
    expect(await createLocalGit({ allowedRoots: [r], execFile: fn }).inspect(repo)).toEqual({ status: "unavailable", reason: GIT_REASONS.ownership });
    expect(calls.some((c) => c.args.join(" ").includes("safe.directory"))).toBe(false);
  });

  it("status output over the cap gives a partial result, not a failure", async () => {
    const r = root();
    const repo = makeRepo(r);
    const { fn } = fake((c) => {
      if (c.args.includes("status")) return { err: { code: "ERR_CHILD_PROCESS_STDOUT_MAXBUFFER" } };
      if (c.args.includes("--abbrev-ref")) return { stdout: "main\n" };
      return { stdout: "abc1234\x1f2024-01-01T00:00:00+00:00\x1fsubject\n" };
    });
    const res = await createLocalGit({ allowedRoots: [r], execFile: fn }).inspect(repo);
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.partial).toBe(true);
      expect(res.data.workingTree).toBeNull();
    }
  });

  it("uses execFile with fixed argument arrays, a sanitized env and no shell", async () => {
    const r = root();
    const repo = makeRepo(r);
    process.env["DWMCP_SECRET_CANARY"] = "canary-value";
    try {
      const { fn, calls } = fake((c) => (c.args.includes("--abbrev-ref") ? { stdout: "main\n" } : { stdout: "" }));
      await createLocalGit({ allowedRoots: [r], execFile: fn }).inspect(repo);
      expect(calls.length).toBeGreaterThan(0);
      const allowedVerbs = new Set(["rev-parse", "symbolic-ref", "log", "status"]);
      for (const c of calls) {
        expect(c.file).toBe("git");
        expect(Array.isArray(c.args)).toBe(true);
        expect("shell" in c.options).toBe(false);
        expect(c.options.cwd).toBe(repo);
        expect(c.options.timeout).toBeGreaterThan(0);
        expect(c.options.maxBuffer).toBeGreaterThan(0);
        expect(c.args.slice(0, hardenedPrefix().length)).toEqual(hardenedPrefix());
        expect(allowedVerbs.has(c.args[hardenedPrefix().length] as string)).toBe(true);
        expect(c.options.env["GIT_TERMINAL_PROMPT"]).toBe("0");
        expect(c.options.env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
        expect(c.options.env["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
        expect(Object.keys(c.options.env)).not.toContain("DWMCP_SECRET_CANARY");
        for (const a of c.args.slice(hardenedPrefix().length)) expect(["remote", "get-url", "config", "diff", "show", "-p", "--patch", "--ext-diff", "--textconv"]).not.toContain(a);
      }
      expect(hardenedPrefix().join(" ")).toContain("core.fsmonitor=false");
      expect(hardenedPrefix().join(" ")).toContain("core.pager=cat");
      expect(sanitizedEnv(repo)["GIT_CEILING_DIRECTORIES"]).toBe(path.dirname(repo));
    } finally {
      delete process.env["DWMCP_SECRET_CANARY"];
    }
  });
});

// Keep unused imports honest for platforms without chmod semantics.
void chmodSync;
void existsSync;
