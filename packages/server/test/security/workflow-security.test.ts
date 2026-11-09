import { describe, expect, it } from "vitest";
import { AppError } from "../../src/core/errors.js";
import { createRedactor } from "../../src/core/redact.js";
import { runSections } from "../../src/workflows/workflow-core.js";
import { filesystemSource } from "../../src/workflows/source-ref.js";

const CANARY = "canary-secret-VALUE-9f8e7d";
const src = filesystemSource("main");

describe("workflow error scrubbing", () => {
  it("never leaks secrets, absolute paths or stacks from thrown errors", async () => {
    const redactor = createRedactor({ secretValues: [CANARY] });
    const err = new AppError("UPSTREAM_ERROR", `failed with ${CANARY} reading /home/alice/work/secret.txt and C:\\Users\\bob\\k.pem`, {
      cause: new Error(`cause ${CANARY}`),
    });
    const r = await runSections(
      [
        { id: "a", title: "A", source: src, run: async () => { throw err; } },
        { id: "b", title: "B", source: src, run: async () => { throw new Error(`${CANARY} /etc/passwd`); } },
        { id: "c", title: "C", source: src, availability: { state: "unavailable", reason: `down ${CANARY} /var/run/x` }, run: async () => 1 },
      ],
      { redactor },
    );
    const json = JSON.stringify(r);
    for (const bad of [CANARY, "alice", "bob", "/etc/passwd", "/var/run", "stack", " at ", "cause "]) {
      expect(json).not.toContain(bad);
    }
    expect(r.sections[0]?.error?.code).toBe("UPSTREAM_ERROR");
    expect(Object.keys(r.sections[0]?.error ?? {}).sort()).toEqual(["code", "message", "retryAfterSeconds", "retryable"]);
  });

  it("scrubs token patterns even without a configured redactor", async () => {
    const r = await runSections([
      { id: "a", title: "A", source: src, run: async () => { throw new AppError("UPSTREAM_ERROR", "bad ghp_abcdefghijklmnop123456 Bearer abcdef123456"); } },
    ]);
    expect(JSON.stringify(r)).not.toMatch(/ghp_abc|abcdef123456/);
  });
});
