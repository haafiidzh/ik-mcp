import { describe, expect, it } from "vitest";
import { AppError } from "../../src/core/errors.js";
import { compileEndpointSchema, compileParamSection, SCHEMA_CAPS } from "../../src/integrations/custom-api/endpoint-schema.js";
import { configSchema } from "../../src/config/schema.js";

function unsupported(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe("UNSUPPORTED");
    return (e as AppError).message;
  }
  throw new Error("expected failure");
}

describe("endpoint schema compiler", () => {
  const c = compileEndpointSchema({
    pathParams: { id: { type: "integer", minimum: 1, maximum: 1000 } },
    query: { state: { type: "string", enum: ["open", "closed"] }, tag: { type: "string", pattern: "^[a-z]+$", maxLength: 10, required: true }, flag: { type: "boolean" } },
    body: {
      title: { type: "string", required: true, minLength: 1, maxLength: 20 },
      n: { type: "number", minimum: 0 },
      labels: { type: "array", items: { type: "string", maxLength: 5 }, maxItems: 2 },
      meta: { type: "object", properties: { k: { type: "string" } } },
      level: { type: "integer", enum: [1, 2, 3] },
    },
  });

  it("accepts valid input and applies required/optional", () => {
    expect(c.pathParams.safeParse({ id: 5 }).success).toBe(true);
    expect(c.query.safeParse({ tag: "abc" }).success).toBe(true);
    expect(c.query.safeParse({ tag: "abc", state: "open", flag: true }).success).toBe(true);
    expect(c.body?.safeParse({ title: "t", labels: ["a"], meta: { k: "v" }, level: 2, n: 1.5 }).success).toBe(true);
  });
  it.each([
    ["missing required path param", () => c.pathParams.safeParse({})],
    ["integer given float", () => c.pathParams.safeParse({ id: 1.5 })],
    ["below minimum", () => c.pathParams.safeParse({ id: 0 })],
    ["above maximum", () => c.pathParams.safeParse({ id: 1001 })],
    ["string for integer (no coercion)", () => c.pathParams.safeParse({ id: "5" })],
    ["NaN", () => c.pathParams.safeParse({ id: NaN })],
    ["missing required query", () => c.query.safeParse({})],
    ["enum violation", () => c.query.safeParse({ tag: "a", state: "weird" })],
    ["pattern violation", () => c.query.safeParse({ tag: "A1" })],
    ["maxLength violation", () => c.query.safeParse({ tag: "abcdefghijk" })],
    ["body missing required", () => c.body!.safeParse({})],
    ["body minLength", () => c.body!.safeParse({ title: "" })],
    ["body array too long", () => c.body!.safeParse({ title: "t", labels: ["a", "b", "c"] })],
    ["body array item too long", () => c.body!.safeParse({ title: "t", labels: ["abcdefg"] })],
    ["numeric enum violation", () => c.body!.safeParse({ title: "t", level: 4 })],
    ["wrong boolean type", () => c.query.safeParse({ tag: "a", flag: "true" })],
  ])("rejects: %s", (_n, run) => {
    expect(run().success).toBe(false);
  });
  it("is strict: unknown keys rejected at every level, including __proto__", () => {
    expect(c.pathParams.safeParse({ id: 1, extra: 1 }).success).toBe(false);
    expect(c.query.safeParse({ tag: "a", other: 1 }).success).toBe(false);
    expect(c.body!.safeParse({ title: "t", extra: 1 }).success).toBe(false);
    expect(c.body!.safeParse({ title: "t", meta: { k: "v", z: 1 } }).success).toBe(false);
    expect(c.body!.safeParse(JSON.parse('{"title":"t","__proto__":{"x":1}}')).success).toBe(false);
  });
  it("null body definition compiles to no body; inputSchema describes the sections", () => {
    const e = compileEndpointSchema({ pathParams: {}, query: {}, body: null });
    expect(e.body).toBeNull();
    const props = (c.inputSchema["properties"] as Record<string, { required: string[] }>);
    expect(props["pathParams"]?.required).toEqual(["id"]);
    expect(props["query"]?.required).toEqual(["tag"]);
    expect(props["body"]?.required).toEqual(["title"]);
  });
  it("strings get a default maxLength cap", () => {
    const s = compileParamSection("query", { a: { type: "string" } });
    expect(s.safeParse({ a: "x".repeat(SCHEMA_CAPS.defaultMaxLength) }).success).toBe(true);
    expect(s.safeParse({ a: "x".repeat(SCHEMA_CAPS.defaultMaxLength + 1) }).success).toBe(false);
  });

  describe("fails closed with JSON paths", () => {
    it.each([
      ["unknown type", "query", { a: { type: "null" } }, "$.query.a.type"],
      ["missing type", "query", { a: {} }, "$.query.a.type"],
      ["$ref / unsupported keyword", "query", { a: { type: "string", $ref: "#/x" } }, "$.query.a.$ref"],
      ["oneOf", "body", { a: { type: "string", oneOf: [] } }, "$.body.a.oneOf"],
      ["format", "query", { a: { type: "string", format: "uri" } }, "$.query.a.format"],
      ["array in query", "query", { a: { type: "array", items: { type: "string" } } }, "$.query.a"],
      ["object in pathParams", "pathParams", { a: { type: "object" } }, "$.pathParams.a"],
      ["array without items", "body", { a: { type: "array" } }, "$.body.a.items"],
      ["minimum on string", "query", { a: { type: "string", minimum: 1 } }, "$.query.a.minimum"],
      ["min > max", "query", { a: { type: "number", minimum: 5, maximum: 1 } }, "$.query.a.minimum"],
      ["enum type mismatch", "query", { a: { type: "integer", enum: [1, "x"] } }, "$.query.a.enum[1]"],
      ["empty enum", "query", { a: { type: "string", enum: [] } }, "$.query.a.enum"],
      ["enum on boolean", "query", { a: { type: "boolean", enum: [true] } }, "$.query.a.enum"],
      ["bad regex", "query", { a: { type: "string", pattern: "([" } }, "$.query.a.pattern"],
      ["nested quantifier regex", "query", { a: { type: "string", pattern: "(a+)+$" } }, "$.query.a.pattern"],
      ["backreference regex", "query", { a: { type: "string", pattern: "(a)\\1" } }, "$.query.a.pattern"],
      ["huge pattern", "query", { a: { type: "string", pattern: "a".repeat(201) } }, "$.query.a.pattern"],
      ["maxLength too large", "query", { a: { type: "string", maxLength: 10_001 } }, "$.query.a.maxLength"],
      ["non-finite minimum", "query", { a: { type: "number", minimum: Infinity } }, "$.query.a.minimum"],
      ["bad param name", "query", { "a b": { type: "string" } }, "$.query.a b"],
      ["__proto__ name", "body", JSON.parse('{"__proto__":{"type":"string"}}'), "$.body.__proto__"],
      ["spec not an object", "query", { a: "string" }, "$.query.a"],
    ])("%s", (_n, section, defs, path) => {
      const msg = unsupported(() => compileParamSection(section as "query", defs));
      expect(msg).toContain(path);
    });
    it("depth cap", () => {
      let spec: Record<string, unknown> = { type: "string" };
      for (let i = 0; i < SCHEMA_CAPS.maxDepth + 1; i++) spec = { type: "object", properties: { x: spec } };
      expect(unsupported(() => compileParamSection("body", { root: spec }))).toMatch(/deeper/);
    });
    it("node cap and property cap", () => {
      const many = Object.fromEntries(Array.from({ length: SCHEMA_CAPS.maxPropertiesPerObject + 1 }, (_v, i) => [`p${i}`, { type: "string" }]));
      expect(unsupported(() => compileParamSection("query", many))).toMatch(/properties/);
      const nested = Object.fromEntries(
        Array.from({ length: 5 }, (_v, i) => [`o${i}`, { type: "object", properties: Object.fromEntries(Array.from({ length: 30 }, (_w, j) => [`k${j}`, { type: "string" }])) }]),
      );
      expect(unsupported(() => compileParamSection("body", nested))).toMatch(/nodes/);
    });
    it("enum value cap", () => {
      const values = Array.from({ length: SCHEMA_CAPS.maxEnumValues + 1 }, (_v, i) => `v${i}`);
      expect(unsupported(() => compileParamSection("query", { a: { type: "string", enum: values } }))).toContain("$.query.a.enum");
    });
    it("messages never contain input values", () => {
      const m = unsupported(() => compileParamSection("query", { a: { type: "string", pattern: "SECRETVALUE([" } }));
      expect(m).not.toContain("SECRETVALUE");
    });
  });

  describe("config integration", () => {
    const base = (endpoint: Record<string, unknown>): unknown => ({
      customApis: [{ name: "svc", baseUrl: "https://api.example.com", endpoints: [{ name: "e", method: "GET", path: "/x/{id}", description: "d", pathParams: { id: { type: "string" } }, ...endpoint }] }],
    });
    it("accepts the extended spec subset", () => {
      const r = configSchema.safeParse(base({ query: { a: { type: "string", pattern: "^a$", minLength: 1, maxLength: 5 } } }));
      expect(r.success).toBe(true);
    });
    it("still rejects unknown spec keys (strict)", () => {
      expect(configSchema.safeParse(base({ query: { a: { type: "string", format: "uri" } } })).success).toBe(false);
    });
    it("accepts nested array/object body", () => {
      const r = configSchema.safeParse(base({ method: "GET", body: { l: { type: "array", items: { type: "string" } } } }));
      expect(r.success).toBe(true);
    });
  });
});
