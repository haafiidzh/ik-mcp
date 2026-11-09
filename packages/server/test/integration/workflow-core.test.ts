import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/core/errors.js";
import {
  runSections,
  sectionOutput,
  scrubMessage,
  type SectionSpec,
  type Timers,
} from "../../src/workflows/workflow-core.js";
import { apiSource, databaseSource, filesystemSource, formatSourceRef, githubSource } from "../../src/workflows/source-ref.js";

const fs = filesystemSource("main");

function spec<T>(id: string, run: SectionSpec<T>["run"], extra: Partial<SectionSpec<T>> = {}): SectionSpec<T> {
  return { id, title: id.toUpperCase(), source: fs, run, ...extra };
}

/** Manual timers: fire() runs the pending deadline callback. */
function fakeTimers(): Timers & { fire(): void; cleared: number; pending(): boolean } {
  let cb: (() => void) | undefined;
  const t = {
    cleared: 0,
    setTimeout(fn: () => void) {
      cb = fn;
      return 1;
    },
    clearTimeout() {
      t.cleared++;
      cb = undefined;
    },
    fire() {
      cb?.();
    },
    pending: () => cb !== undefined,
  };
  return t;
}

describe("runSections", () => {
  it("all ok, keeps spec order not completion order", async () => {
    const r = await runSections([
      spec("a", async () => {
        await new Promise((res) => setTimeout(res, 15));
        return { n: 1 };
      }),
      spec("b", async () => ({ n: 2 })),
      spec("c", () => Promise.resolve(3)),
    ]);
    expect(r.sections.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(r.sections.every((s) => s.status === "ok")).toBe(true);
    expect(r.sections[0]?.data).toEqual({ n: 1 });
    expect(r.meta.partial).toBe(false);
    expect(r.meta.sectionsSummary).toEqual({ total: 3, ok: 3, partial: 0, unavailable: 0, disabled: 0, error: 0 });
  });

  it("an AppError in one section does not affect the others", async () => {
    const r = await runSections([
      spec("a", async () => 1),
      spec("b", async () => {
        throw new AppError("NOT_FOUND", "Issue 12 not found.");
      }),
      spec("c", async () => 3),
    ]);
    expect(r.sections.map((s) => s.status)).toEqual(["ok", "error", "ok"]);
    expect(r.sections[1]?.error).toEqual({
      code: "NOT_FOUND",
      message: "Issue 12 not found.",
      retryable: false,
      retryAfterSeconds: null,
    });
    expect(r.sections[1]?.data).toBeUndefined();
    expect(r.meta.partial).toBe(true);
    expect(r.meta.sectionsSummary.error).toBe(1);
  });

  it("synchronous throws and non-Error rejections become safe errors", async () => {
    const r = await runSections([
      spec("a", (() => {
        throw new Error("boom /home/u/secret");
      }) as SectionSpec["run"]),
      spec("b", () => Promise.reject("plain string")),
      spec("c", () => Promise.reject(undefined)),
    ]);
    expect(r.sections.map((s) => s.error?.code)).toEqual(["INTERNAL_ERROR", "INTERNAL_ERROR", "INTERNAL_ERROR"]);
    expect(JSON.stringify(r)).not.toContain("boom");
    expect(JSON.stringify(r)).not.toContain("plain string");
  });

  it("hung section: deadline returns partial result and aborts its signal", async () => {
    const timers = fakeTimers();
    let signal: AbortSignal | undefined;
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const p = runSections(
      [
        spec("fast", async () => "done"),
        spec("hung", (ctx) => {
          signal = ctx.signal;
          return new Promise<never>((_res, rej) => {
            ctx.signal.addEventListener("abort", () => rej(new Error("aborted late")));
          });
        }),
        spec("ignores", () => new Promise<never>(() => undefined)),
      ],
      { deadlineMs: 50, timers },
    );
    await new Promise((res) => setImmediate(res));
    expect(timers.pending()).toBe(true);
    timers.fire();
    const r = await p;
    expect(r.sections.map((s) => s.status)).toEqual(["ok", "error", "error"]);
    expect(r.sections[1]?.error?.code).toBe("TIMEOUT");
    expect(r.sections[2]?.error?.code).toBe("TIMEOUT");
    expect(r.sections[1]?.error?.retryable).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(r.meta.deadlineHit).toBe(true);
    expect(r.meta.partial).toBe(true);
    await new Promise((res) => setImmediate(res));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain("aborted late");
  });

  it("works with the real timer: short deadline, hung section", async () => {
    const t0 = Date.now();
    const r = await runSections([spec("ok", async () => 1), spec("hung", () => new Promise<never>(() => undefined))], {
      deadlineMs: 20,
    });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.sections.map((s) => s.status)).toEqual(["ok", "error"]);
  });

  it("clears the deadline timer when everything finishes", async () => {
    const timers = fakeTimers();
    const r = await runSections([spec("a", async () => 1)], { timers });
    expect(timers.cleared).toBe(1);
    expect(r.meta.deadlineHit).toBe(false);
  });

  it("a result arriving after the deadline is discarded", async () => {
    const timers = fakeTimers();
    let resolveLate: (v: string) => void = () => undefined;
    const p = runSections(
      [spec("late", () => new Promise<string>((res) => (resolveLate = res)))],
      { timers },
    );
    await new Promise((res) => setImmediate(res));
    timers.fire();
    const r = await p;
    resolveLate("too late");
    await new Promise((res) => setImmediate(res));
    expect(r.sections[0]?.status).toBe("error");
    expect(JSON.stringify(r)).not.toContain("too late");
  });

  it("external abort cancels like a deadline", async () => {
    const ac = new AbortController();
    const p = runSections([spec("hung", () => new Promise<never>(() => undefined))], { signal: ac.signal, timers: fakeTimers() });
    await new Promise((res) => setImmediate(res));
    ac.abort();
    const r = await p;
    expect(r.sections[0]?.error?.code).toBe("TIMEOUT");
    expect(r.sections[0]?.error?.message).toMatch(/cancelled/);
    expect(r.meta.deadlineHit).toBe(false);
  });

  it("an already aborted signal runs nothing", async () => {
    const ac = new AbortController();
    ac.abort();
    const run = vi.fn(async () => 1);
    const r = await runSections([spec("a", run)], { signal: ac.signal });
    expect(run).not.toHaveBeenCalled();
    expect(r.sections[0]?.status).toBe("error");
  });

  it("disabled and unavailable sources are never called", async () => {
    const run = vi.fn(async () => "x");
    const r = await runSections([
      spec("g", run, { source: githubSource("o", "r"), availability: { state: "disabled" } }),
      spec("d", run, { source: databaseSource("main-db"), availability: { state: "unavailable", reason: "No connection configured." } }),
      spec("a", async () => 1, { source: apiSource("billing") }),
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(r.sections.map((s) => s.status)).toEqual(["disabled", "unavailable", "ok"]);
    expect(r.sections[0]?.error?.code).toBe("INTEGRATION_DISABLED");
    expect(r.sections[1]?.error).toMatchObject({ code: "INTEGRATION_UNAVAILABLE", message: "No connection configured." });
    expect(r.meta.partial).toBe(true);
    expect(r.meta.sectionsSummary).toMatchObject({ disabled: 1, unavailable: 1, ok: 1 });
  });

  it("partial and truncated flags propagate", async () => {
    const r = await runSections([
      spec("a", async () => sectionOutput([1, 2], { partial: true, truncated: true })),
      spec("b", async () => sectionOutput("x")),
      spec("c", async () => ({ data: "plain object with data key" })),
    ]);
    expect(r.sections.map((s) => s.status)).toEqual(["partial", "ok", "ok"]);
    expect(r.sections[0]).toMatchObject({ data: [1, 2], truncated: true });
    expect(r.sections[1]?.truncated).toBeUndefined();
    expect(r.sections[2]?.data).toEqual({ data: "plain object with data key" });
    expect(r.meta.truncated).toBe(true);
    expect(r.meta.partial).toBe(true);
  });

  it("uses the injected clock", async () => {
    let t = 1000;
    const r = await runSections([spec("a", async () => { t += 42; return 1; })], { now: () => t });
    expect(r.meta.elapsedMs).toBe(42);
  });

  it("empty spec list is fine", async () => {
    const r = await runSections([]);
    expect(r.sections).toEqual([]);
    expect(r.meta.partial).toBe(false);
  });

  it("section sources carry no paths or URLs", () => {
    expect(formatSourceRef(fs)).toBe("filesystem:main");
    expect(formatSourceRef(githubSource("acme", "widgets"))).toBe("github:acme/widgets");
    expect(formatSourceRef(databaseSource("db1"))).toBe("database:db1");
    expect(formatSourceRef(apiSource("p"))).toBe("api:p");
    expect(filesystemSource("/home/u/proj").ref).toBe("invalid-ref");
    expect(filesystemSource("a/b").ref).toBe("invalid-ref");
    expect(apiSource("https://x.example").ref).toBe("invalid-ref");
    expect(githubSource("..", "x").ref).toBe("invalid-ref");
    expect(databaseSource("").ref).toBe("invalid-ref");
  });
});

describe("scrubMessage", () => {
  it("removes absolute paths, tokens and control chars, and bounds length", () => {
    const s = scrubMessage("fail at /home/alice/proj/src/a.ts and C:\\Users\\bob\\x.txt token ghp_abcdefghij1234567890 \u0007 end");
    expect(s).not.toMatch(/alice|bob|ghp_/);
    expect(s).toContain("[path]");
    expect(s).not.toContain("\u0007");
    expect(scrubMessage("x".repeat(5000)).length).toBeLessThan(400);
  });

  it("is fast on adversarial input", () => {
    const t = performance.now();
    scrubMessage("/a".repeat(100000) + "a/".repeat(100000));
    expect(performance.now() - t).toBeLessThan(500);
  });
});
