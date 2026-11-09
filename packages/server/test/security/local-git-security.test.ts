import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalGit } from "../../src/integrations/git/local-git.js";
import { makeRepo, tmpRoot } from "../fixtures/git-repo.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A hostile .git/config must not get programs executed by the local git helper (Q6). */
describe("local git: repository-controlled command execution is neutralised", () => {
  it("core.fsmonitor, core.pager, core.hooksPath, core.sshCommand and diff drivers are not run", async () => {
    const r = tmpRoot();
    roots.push(r);
    const repo = makeRepo(r);
    const canary = path.join(r, "canary.txt");
    const script = path.join(r, "evil.sh");
    writeFileSync(script, `#!/bin/sh\necho ran >> "${canary}"\ncat\n`);
    chmodSync(script, 0o755);
    const hooks = path.join(r, "hooks");
    writeFileSync(path.join(r, "keep"), "");
    appendFileSync(
      path.join(repo, ".git", "config"),
      [
        "[core]",
        `\tfsmonitor = ${script}`,
        `\tpager = ${script}`,
        `\tsshCommand = ${script}`,
        `\thooksPath = ${hooks}`,
        `[diff "evil"]`,
        `\ttextconv = ${script}`,
        `\tcommand = ${script}`,
        `[alias]`,
        `\tstatus = !${script}`,
        `[log]`,
        `\tshowSignature = true`,
        `[gpg]`,
        `\tprogram = ${script}`,
        "",
      ].join("\n"),
    );
    writeFileSync(path.join(repo, ".gitattributes"), "*.txt diff=evil\n");
    writeFileSync(path.join(repo, "a.txt"), "changed\n");
    const res = await createLocalGit({ allowedRoots: [r] }).inspect(repo);
    expect(existsSync(canary) ? readFileSync(canary, "utf8") : "").toBe("");
    expect(res.status).toBe("ok");
    if (res.status === "ok") expect(res.data.workingTree?.unstaged).toBe(1);
  });

  it("results never contain absolute paths or the temp directory", async () => {
    const r = tmpRoot();
    roots.push(r);
    const repo = makeRepo(r);
    const text = JSON.stringify(await createLocalGit({ allowedRoots: [r] }).inspect(repo));
    expect(text).not.toContain(r);
    const bad = JSON.stringify(await createLocalGit({ allowedRoots: [r] }).inspect(path.join(r, "missing")));
    expect(bad).not.toContain(r);
  });
});
