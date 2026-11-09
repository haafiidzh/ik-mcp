import { describe, expect, it } from "vitest";
import { fitToBudget, ok, wireSize } from "./response.js";

const sec = (id: string, size: number, status = "ok") => ({
  id,
  title: id,
  status,
  source: { type: "filesystem", name: "w" },
  data: { text: "x".repeat(size) },
});

describe("fitToBudget with workflow {sections} (P5-06, ADR-104)", () => {
  it("truncates over-budget sections with meta instead of LIMIT_EXCEEDED", () => {
    const r = ok({ sections: [sec("a", 200), sec("b", 5000), sec("c", 5000)], extra: 1 }, { source: "workflow" });
    const out = fitToBudget(r, 3000);
    expect(out.success).toBe(true);
    if (!out.success) return;
    expect(wireSize(out)).toBeLessThanOrEqual(3000);
    expect(out.meta.truncated).toBe(true);
    expect(out.meta.partial).toBe(true);
    const s = (out.data as { sections: Array<Record<string, unknown>>; extra: number }).sections;
    expect(s.map((x) => x["id"])).toEqual(["a", "b", "c"]);
    expect(s[0]?.["data"]).toBeDefined();
    expect(s[2]?.["data"]).toBeUndefined();
    expect(s[2]).toMatchObject({ truncated: true, dataOmitted: true, status: "partial" });
  });

  it("leaves in-budget results alone and keeps non-ok statuses", () => {
    const r = ok({ sections: [sec("a", 10)] }, { source: "workflow" });
    expect(fitToBudget(r, 100000)).toBe(r);
    const big = ok({ sections: [sec("a", 10), sec("b", 9000, "unavailable")] }, { source: "workflow" });
    const out = fitToBudget(big, 2500);
    expect(out.success).toBe(true);
    if (out.success) expect((out.data as { sections: Array<{ status: string }> }).sections[1]?.status).toBe("unavailable");
  });

  it("fails closed when even the stubs do not fit", () => {
    const r = ok({ sections: [sec("a", 10), sec("b", 10)] }, { source: "workflow" });
    const out = fitToBudget(r, 50);
    expect(out.success).toBe(false);
  });
});
