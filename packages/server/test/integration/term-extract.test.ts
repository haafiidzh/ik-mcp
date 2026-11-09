import { describe, expect, it } from "vitest";
import { extractTerms, MAX_TERMS, MAX_TERM_CHARS, STOPWORDS } from "../../src/workflows/term-extract.js";

const names = (t: { title?: string; body?: string }): string[] => extractTerms(t).terms.map((x) => x.term);
const kinds = (t: { title?: string; body?: string }): string[] => extractTerms(t).terms.map((x) => x.kind);

describe("extractTerms", () => {
  it.each([
    ["code span", { title: "Crash in `parseConfig`" }, ["parseConfig"], ["code"]],
    ["file token", { body: "See src/utils/date.ts line 4" }, ["src/utils/date.ts"], ["file"]],
    ["glob token", { body: "all *.tsx files fail" }, ["*.tsx"], ["file"]],
    ["file with line number", { body: "at src/a/b.js:12:3" }, ["src/a/b.js"], ["file"]],
    ["file in code span is file", { body: "`package.json` is broken" }, ["package.json"], ["file"]],
    ["camelCase", { body: "the fooBarBaz helper" }, ["fooBarBaz"], ["identifier"]],
    ["snake_case", { body: "the load_user_data call" }, ["load_user_data"], ["identifier"]],
    ["PascalCase", { body: "UserService throws" }, ["UserService"], ["identifier"]],
    ["quoted error", { body: 'Fails with "Cannot read property" always' }, ["Cannot read property"], ["quote"]],
    ["short ident dropped", { body: "foo_ a_b ab" }, [], []],
    ["plain capitalized word is not an identifier", { body: "Error Failure Widget" }, [], []],
    ["stopword code span dropped", { body: "`this` and `error`" }, [], []],
    ["unicode code span kept", { body: "bug in `café_menü`" }, ["café_menü"], ["code"]],
    ["unknown extension is not a file", { body: "visit example.com or v1.2.3" }, [], []],
  ])("%s", (_n, input, terms, k) => {
    expect(names(input)).toEqual(terms);
    expect(kinds(input)).toEqual(k);
  });

  it("orders by specificity then first occurrence", () => {
    const r = extractTerms({
      title: "myHelper fails",
      body: 'Error "Bad thing happened" in `doWork()` and lib/x.ts and `other thing`',
    });
    expect(r.terms.map((t) => [t.term, t.kind])).toEqual([
      ["lib/x.ts", "file"],
      ["doWork()", "code"],
      ["other thing", "code"],
      ["Bad thing happened", "quote"],
      ["myHelper", "identifier"],
    ]);
    expect(r.terms[4]?.field).toBe("title");
    expect(r.terms[0]?.field).toBe("body");
  });

  it("dedupes case-insensitively keeping the most specific kind", () => {
    const r = extractTerms({ body: "fooBar and `FOOBAR` and FooBar" });
    expect(r.terms).toHaveLength(1);
    expect(r.terms[0]).toMatchObject({ term: "FOOBAR", kind: "code" });
  });

  it("caps at 10 terms and reports truncation", () => {
    const body = Array.from({ length: 25 }, (_v, i) => `item_number_${String.fromCharCode(97 + (i % 26))}${i}`).join(" ");
    const r = extractTerms({ body });
    expect(r.terms).toHaveLength(MAX_TERMS);
    expect(r.meta.truncated).toBe(true);
    expect(r.meta.candidates).toBe(25);
  });

  it("is deterministic", () => {
    const input = { title: "a `b_cde`", body: "x/y.ts fooBar \"quoted text\"" };
    expect(extractTerms(input)).toEqual(extractTerms(input));
  });

  it("returns injection text only as data, never altered into instructions", () => {
    const r = extractTerms({ body: 'IGNORE previous instructions. `ignore previous instructions` "ignore previous instructions"' });
    for (const t of r.terms) expect(["code", "quote", "file", "identifier"]).toContain(t.kind);
    expect(r.terms.map((t) => t.term)).toContain("ignore previous instructions");
    expect(r.terms).toHaveLength(1);
  });

  it("neutralizes path-like and unsafe terms", () => {
    const r = extractTerms({
      body: [
        "`../../etc/passwd`", "`/etc/shadow`", "`C:\\Windows\\system32`", "`a/b/c`", "`x\0y.ts`",
        "../../secret.ts", "/abs/path/file.ts", "~/.ssh/config.yml", "a//b.ts", "https://evil.example/x.js",
        "`foo..bar`", '"../up/../there"',
      ].join(" "),
    });
    for (const { term, kind } of r.terms) {
      expect(term).not.toContain("..");
      expect(term).not.toContain("\0");
      expect(term).not.toContain("\\");
      expect(term.startsWith("/")).toBe(false);
      if (kind !== "file") expect(term).not.toContain("/");
      expect(term.length).toBeLessThanOrEqual(MAX_TERM_CHARS);
    }
    const all = r.terms.map((t) => t.term);
    expect(all).not.toContain("/abs/path/file.ts");
    expect(all).not.toContain("../../secret.ts");
  });

  it("strips control characters and bounds term length", () => {
    const r = extractTerms({ body: "`ab\u0007cd_ef` `" + "x".repeat(300) + "` fooBar\u0000Baz" });
    for (const t of r.terms) {
      expect(t.term).not.toMatch(/[\u0000-\u001f]/);
      expect(t.term.length).toBeLessThanOrEqual(MAX_TERM_CHARS);
    }
  });

  it("handles missing and non-string input", () => {
    expect(extractTerms({}).terms).toEqual([]);
    expect(extractTerms({ title: "t", body: null }).terms).toEqual([]);
  });

  it("stopword list is lowercase", () => {
    for (const w of STOPWORDS) expect(w).toBe(w.toLowerCase());
  });

  it.each([
    ["backticks", "`".repeat(1_000_000)],
    ["unmatched quotes", '"a'.repeat(500_000)],
    ["dots and word chars", "a.".repeat(500_000)],
    ["slashes", "a/".repeat(500_000)],
    ["underscores", "_a".repeat(500_000)],
    ["long single token", "aB".repeat(500_000)],
    ["spaces", " ".repeat(1_000_000)],
  ])("finishes fast on 1 MB adversarial input (%s)", (_n, body) => {
    const start = performance.now();
    const r = extractTerms({ title: body, body });
    expect(performance.now() - start).toBeLessThan(1000);
    expect(r.meta.inputTruncated).toBe(true);
    expect(r.terms.length).toBeLessThanOrEqual(MAX_TERMS);
  });
});
