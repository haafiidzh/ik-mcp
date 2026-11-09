import { describe, expect, it } from "vitest";
import { checkSqliteRunner } from "../../src/integrations/database/sqlite.adapter.js";

describe("P2-11 sqlite runner startup check", () => {
  it("passes with the real runner file present", () => {
    const warns: string[] = [];
    expect(checkSqliteRunner([{ type: "sqlite", enabled: true }], (m) => warns.push(m))).toBe(true);
    expect(warns).toEqual([]);
  });
  it("warns (no path in the message) when the file is missing", () => {
    const warns: string[] = [];
    expect(checkSqliteRunner([{ type: "sqlite", enabled: true }], (m) => warns.push(m), () => false)).toBe(false);
    expect(warns).toHaveLength(1);
    expect(warns[0]).not.toMatch(/\//);
  });
  it("skips the check without an enabled sqlite connection", () => {
    const warns: string[] = [];
    expect(checkSqliteRunner([{ type: "sqlite", enabled: false }, { type: "postgres", enabled: true }], (m) => warns.push(m), () => false)).toBe(true);
    expect(warns).toEqual([]);
  });
});
