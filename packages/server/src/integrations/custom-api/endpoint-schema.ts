import { z } from "zod";
import { AppError } from "../../core/errors.js";

/**
 * Endpoint schema compiler (doc 04 section C, doc 05 section 5). Compiles the
 * JSON-schema-like subset of an endpoint's `pathParams` / `query` / `body`
 * definitions into strict Zod objects. MCP-free. Fails closed: any unsupported
 * construct, unknown key in a spec, or exceeded cap throws `AppError("UNSUPPORTED")`
 * with a JSON path (never a value) so a bad config is caught at load/compile time.
 */

export const SCHEMA_CAPS = Object.freeze({
  maxDepth: 4,
  maxNodes: 100,
  maxPropertiesPerObject: 50,
  maxEnumValues: 100,
  maxPatternChars: 200,
  /** Default and hard cap for string length when the spec gives none / more. */
  defaultMaxLength: 1000,
  hardMaxLength: 10_000,
  defaultMaxItems: 100,
  hardMaxItems: 1000,
  maxNameChars: 64,
});

const SPEC_KEYS = new Set([
  "type",
  "description",
  "required",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "items",
  "properties",
]);
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const FORBIDDEN_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export type ParamSection = "pathParams" | "query" | "body";

function unsupported(path: string, why: string): never {
  throw new AppError("UNSUPPORTED", `Endpoint schema at ${path}: ${why}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

/** Reject patterns that are obviously catastrophic (nested quantifiers, backreferences). */
function checkPattern(path: string, pattern: string): RegExp {
  if (pattern.length > SCHEMA_CAPS.maxPatternChars) unsupported(path, "pattern is too long");
  if (/\\[1-9]|\\k</.test(pattern)) unsupported(path, "pattern must not use backreferences");
  if (/\([^)]*[+*}]\)[+*{]/.test(pattern) || /\([^)]*[+*]\)\{/.test(pattern)) {
    unsupported(path, "pattern has nested quantifiers");
  }
  try {
    return new RegExp(pattern, "u");
  } catch {
    return unsupported(path, "pattern is not a valid regular expression");
  }
}

interface Ctx {
  nodes: number;
  section: ParamSection;
}

function num(path: string, key: string, v: unknown, int: boolean): number {
  if (typeof v !== "number" || !Number.isFinite(v) || (int && !Number.isSafeInteger(v))) {
    return unsupported(`${path}.${key}`, "must be a finite number");
  }
  return v;
}

function compileNode(spec: unknown, path: string, depth: number, ctx: Ctx): z.ZodType {
  if (depth > SCHEMA_CAPS.maxDepth) unsupported(path, `nesting deeper than ${SCHEMA_CAPS.maxDepth}`);
  if (++ctx.nodes > SCHEMA_CAPS.maxNodes) unsupported(path, `more than ${SCHEMA_CAPS.maxNodes} schema nodes`);
  if (!isPlainObject(spec)) return unsupported(path, "must be an object");
  for (const k of Object.keys(spec)) {
    if (!SPEC_KEYS.has(k)) unsupported(`${path}.${k}`, "unsupported keyword");
  }
  const type = spec["type"];
  if (typeof type !== "string") return unsupported(`${path}.type`, "is required");
  const enumValues = spec["enum"];

  if (enumValues !== undefined) {
    if (!Array.isArray(enumValues) || enumValues.length === 0 || enumValues.length > SCHEMA_CAPS.maxEnumValues) {
      unsupported(`${path}.enum`, `must be a non-empty array of at most ${SCHEMA_CAPS.maxEnumValues} values`);
    }
    if (type !== "string" && type !== "number" && type !== "integer") unsupported(`${path}.enum`, "only allowed on string, number or integer");
    const values = enumValues as unknown[];
    values.forEach((v, i) => {
      const ok = type === "string" ? typeof v === "string" : typeof v === "number" && Number.isFinite(v) && (type === "number" || Number.isInteger(v));
      if (!ok) unsupported(`${path}.enum[${i}]`, `does not match type ${type}`);
    });
    const lits = values.map((v) => z.literal(v as string | number));
    const first = lits[0] as z.ZodLiteral<string | number>;
    return lits.length === 1 ? first : z.union(lits as unknown as [z.ZodLiteral<string | number>, z.ZodLiteral<string | number>]);
  }

  switch (type) {
    case "string": {
      for (const k of ["minimum", "maximum", "minItems", "maxItems", "items", "properties"]) {
        if (spec[k] !== undefined) unsupported(`${path}.${k}`, "not valid for type string");
      }
      const max = spec["maxLength"] === undefined ? SCHEMA_CAPS.defaultMaxLength : num(path, "maxLength", spec["maxLength"], true);
      if (max < 1 || max > SCHEMA_CAPS.hardMaxLength) unsupported(`${path}.maxLength`, `must be 1..${SCHEMA_CAPS.hardMaxLength}`);
      let s = z.string().max(max);
      if (spec["minLength"] !== undefined) {
        const min = num(path, "minLength", spec["minLength"], true);
        if (min < 0 || min > max) unsupported(`${path}.minLength`, "must be 0..maxLength");
        s = s.min(min);
      }
      if (spec["pattern"] !== undefined) {
        if (typeof spec["pattern"] !== "string") unsupported(`${path}.pattern`, "must be a string");
        s = s.regex(checkPattern(`${path}.pattern`, spec["pattern"] as string));
      }
      return s;
    }
    case "number":
    case "integer": {
      for (const k of ["minLength", "maxLength", "pattern", "minItems", "maxItems", "items", "properties"]) {
        if (spec[k] !== undefined) unsupported(`${path}.${k}`, `not valid for type ${type}`);
      }
      let n = type === "integer" ? z.number().int() : z.number().finite();
      if (type === "integer") n = n.safe();
      const min = spec["minimum"] === undefined ? undefined : num(path, "minimum", spec["minimum"], false);
      const max = spec["maximum"] === undefined ? undefined : num(path, "maximum", spec["maximum"], false);
      if (min !== undefined && max !== undefined && min > max) unsupported(`${path}.minimum`, "must not exceed maximum");
      if (min !== undefined) n = n.min(min);
      if (max !== undefined) n = n.max(max);
      return n;
    }
    case "boolean": {
      for (const k of ["minimum", "maximum", "minLength", "maxLength", "pattern", "minItems", "maxItems", "items", "properties"]) {
        if (spec[k] !== undefined) unsupported(`${path}.${k}`, "not valid for type boolean");
      }
      return z.boolean();
    }
    case "array": {
      if (ctx.section !== "body") unsupported(path, "arrays are only supported in body");
      for (const k of ["minimum", "maximum", "minLength", "maxLength", "pattern", "properties"]) {
        if (spec[k] !== undefined) unsupported(`${path}.${k}`, "not valid for type array");
      }
      if (spec["items"] === undefined) unsupported(`${path}.items`, "is required for type array");
      const item = compileNode(spec["items"], `${path}.items`, depth + 1, ctx);
      const max = spec["maxItems"] === undefined ? SCHEMA_CAPS.defaultMaxItems : num(path, "maxItems", spec["maxItems"], true);
      if (max < 1 || max > SCHEMA_CAPS.hardMaxItems) unsupported(`${path}.maxItems`, `must be 1..${SCHEMA_CAPS.hardMaxItems}`);
      let a = z.array(item).max(max);
      if (spec["minItems"] !== undefined) {
        const min = num(path, "minItems", spec["minItems"], true);
        if (min < 0 || min > max) unsupported(`${path}.minItems`, "must be 0..maxItems");
        a = a.min(min);
      }
      return a;
    }
    case "object": {
      if (ctx.section !== "body") unsupported(path, "objects are only supported in body");
      for (const k of ["minimum", "maximum", "minLength", "maxLength", "pattern", "minItems", "maxItems", "items"]) {
        if (spec[k] !== undefined) unsupported(`${path}.${k}`, "not valid for type object");
      }
      return compileProperties(spec["properties"], `${path}.properties`, depth + 1, ctx);
    }
    default:
      return unsupported(`${path}.type`, "unsupported type (allowed: string, number, integer, boolean, array, object, or enum)");
  }
}

function compileProperties(props: unknown, path: string, depth: number, ctx: Ctx): z.ZodObject {
  if (props === undefined || props === null) return z.strictObject({});
  if (!isPlainObject(props)) return unsupported(path, "must be an object");
  const names = Object.keys(props);
  if (names.length > SCHEMA_CAPS.maxPropertiesPerObject) unsupported(path, `more than ${SCHEMA_CAPS.maxPropertiesPerObject} properties`);
  const shape: Record<string, z.ZodType> = {};
  for (const n of names) {
    if (!PARAM_NAME.test(n) || FORBIDDEN_NAMES.has(n)) unsupported(`${path}.${n}`, "invalid parameter name");
    const child = props[n];
    const node = compileNode(child, `${path}.${n}`, depth, ctx);
    const required = isPlainObject(child) ? child["required"] : undefined;
    if (required !== undefined && typeof required !== "boolean") unsupported(`${path}.${n}.required`, "must be a boolean");
    const mustHave = ctx.section === "pathParams" ? required !== false : required === true;
    shape[n] = mustHave ? node : node.optional();
  }
  return z.strictObject(shape);
}

export interface CompiledEndpointSchema {
  pathParams: z.ZodObject;
  query: z.ZodObject;
  /** null when the endpoint declares no body. */
  body: z.ZodObject | null;
  /** JSON-schema-like description of the call input, for `api_get_endpoint_info`. */
  inputSchema: Record<string, unknown>;
}

export interface EndpointSchemaDefinition {
  pathParams?: unknown;
  query?: unknown;
  body?: unknown;
}

/** Compile one section. `section` decides required defaults and what types are allowed. */
export function compileParamSection(section: ParamSection, defs: unknown, basePath = section): z.ZodObject {
  const ctx: Ctx = { nodes: 0, section };
  return compileProperties(defs, `$.${basePath}`, 1, ctx);
}

function describe(spec: unknown, section: ParamSection): Record<string, unknown> {
  if (!isPlainObject(spec)) return {};
  const out: Record<string, unknown> = {};
  for (const k of ["type", "description", "enum", "minimum", "maximum", "minLength", "maxLength", "pattern", "minItems", "maxItems"]) {
    if (spec[k] !== undefined) out[k] = spec[k];
  }
  if (spec["items"] !== undefined) out["items"] = describe(spec["items"], "body");
  if (spec["properties"] !== undefined) out["properties"] = describeProps(spec["properties"], "body");
  void section;
  return out;
}

function describeProps(props: unknown, section: ParamSection): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isPlainObject(props)) return out;
  for (const [k, v] of Object.entries(props)) out[k] = describe(v, section);
  return out;
}

function describeSection(props: unknown, section: ParamSection): Record<string, unknown> {
  const required: string[] = [];
  if (isPlainObject(props)) {
    for (const [k, v] of Object.entries(props)) {
      const r = isPlainObject(v) ? v["required"] : undefined;
      if (section === "pathParams" ? r !== false : r === true) required.push(k);
    }
  }
  return { type: "object", additionalProperties: false, properties: describeProps(props, section), required };
}

/** Compile every section of an endpoint. Throws `AppError("UNSUPPORTED")` with a JSON path on any problem. */
export function compileEndpointSchema(def: EndpointSchemaDefinition): CompiledEndpointSchema {
  const pathParams = compileParamSection("pathParams", def.pathParams ?? {});
  const query = compileParamSection("query", def.query ?? {});
  const hasBody = def.body !== undefined && def.body !== null;
  const body = hasBody ? compileParamSection("body", def.body) : null;
  const inputSchema: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    properties: {
      pathParams: describeSection(def.pathParams, "pathParams"),
      query: describeSection(def.query, "query"),
      ...(hasBody ? { body: describeSection(def.body, "body") } : {}),
    },
  };
  return { pathParams, query, body, inputSchema };
}

/** Parse with a section schema; failures become `INVALID_INPUT` listing paths and reasons, never values. */
export function parseSection(schema: z.ZodObject, value: unknown, label: ParamSection): Record<string, unknown> {
  const r = schema.safeParse(value ?? {});
  if (r.success) return r.data as Record<string, unknown>;
  const parts = r.error.issues.slice(0, 5).map((i) => {
    const where = [label, ...i.path.map(String)].join(".");
    return `${where}: ${i.code === "unrecognized_keys" ? "unknown parameter" : i.message}`;
  });
  throw new AppError("INVALID_INPUT", `Invalid ${label}: ${parts.join("; ")}`);
}
