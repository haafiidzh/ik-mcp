import { z } from "zod";
import {
  DEFAULT_API_MAX_RESPONSE_BYTES,
  DEFAULT_API_TIMEOUT_MS,
  DEFAULT_GITHUB_API_BASE_URL,
  DEFAULT_IGNORE_DIRS,
  DEFAULT_SERVER_NAME,
} from "./defaults.js";
import { DEFAULT_LIMITS, LIMIT_MAXIMA, type Limits } from "../core/limits.js";

/**
 * Config schema (doc 03 §2). Every object is strict so a typo cannot silently
 * disable a safety setting. Secrets are env var NAMES only. Error messages in
 * this file never include the offending input value.
 */

const SECRET_VALUE_PREFIX = /^(ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|sk-|xox[bap]-|Bearer\s)/i;

/** An environment variable NAME (never a value). */
const envVarName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable NAME (letters, digits, underscore)")
  .refine((v) => !SECRET_VALUE_PREFIX.test(v), "must be an environment variable NAME, not a secret value");

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "must be 1-64 chars: letters, digits, '.', '_', '-'");
const nonEmpty = z.string().min(1, "must not be empty");
const posInt = z.number().int().positive();
const repoSlug = z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, "must look like 'owner/repo'");

/**
 * Limit overrides: every core Limits key, integer, bounded by LIMIT_MAXIMA
 * (overrides may only tighten defaults). Defaults themselves live in core.
 */
const limitsShape = Object.fromEntries(
  (Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]).map((key) => {
    const min = key === "maxRedirectsCustomApi" || key === "maxRedirectsGithub" ? 0 : 1;
    return [key, z.number().int().min(min).max(LIMIT_MAXIMA[key]).optional()];
  }),
) as { [K in keyof Limits]: z.ZodOptional<z.ZodNumber> };

const limitsSchema = z.strictObject(limitsShape);

const serverSchema = z.strictObject({
  name: nonEmpty.default(DEFAULT_SERVER_NAME),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  auditLogPath: nonEmpty.optional(),
});

const permissionsSchema = z.strictObject({
  defaultMode: z.literal("read-only").default("read-only"),
  allowWrites: z.boolean().default(false),
  writeOperations: z.array(nonEmpty).default([]),
});

const workspaceSchema = z.strictObject({
  id: name,
  name: nonEmpty,
  rootPath: nonEmpty,
  github: repoSlug.optional(),
  databases: z.array(name).default([]),
  apis: z.array(name).default([]),
});

const filesystemSchema = z.strictObject({
  enabled: z.boolean().default(false),
  allowedRoots: z.array(nonEmpty).default([]),
  blockedNames: z.array(nonEmpty).default([]),
  unblock: z.array(nonEmpty).default([]),
  ignoreDirs: z.array(nonEmpty).default([...DEFAULT_IGNORE_DIRS]),
  allowedExtensions: z.array(nonEmpty).nullable().default(null),
  maxFileBytes: posInt
    .max(DEFAULT_LIMITS.maxFileBytes, "must not exceed the default of 200000 (overrides may only tighten)")
    .default(DEFAULT_LIMITS.maxFileBytes),
});

const readOnlyTrue = z.literal(true, { error: "must be true: database writes are out of scope in the MVP" });

const sqliteSchema = z.strictObject({
  name,
  type: z.literal("sqlite"),
  enabled: z.boolean().default(false),
  databasePath: nonEmpty,
  readOnly: readOnlyTrue.default(true),
});

const postgresSchema = z
  .strictObject({
    name,
    type: z.literal("postgres"),
    enabled: z.boolean().default(false),
    connectionStringEnv: envVarName.optional(),
    host: nonEmpty.optional(),
    port: z.number().int().min(1).max(65535).optional(),
    database: nonEmpty.optional(),
    user: nonEmpty.optional(),
    passwordEnv: envVarName.optional(),
    readOnly: readOnlyTrue.default(true),
    schemas: z.array(nonEmpty).default(["public"]),
  })
  .superRefine((v, ctx) => {
    if (v.connectionStringEnv === undefined && (v.host === undefined || v.database === undefined || v.user === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "requires connectionStringEnv, or host + database + user (+ optional passwordEnv)",
      });
    }
  });

const databaseSchema = z.discriminatedUnion("type", [sqliteSchema, postgresSchema]);

const githubSchema = z.strictObject({
  enabled: z.boolean().default(false),
  tokenEnv: envVarName.optional(),
  apiBaseUrl: z.literal(DEFAULT_GITHUB_API_BASE_URL).default(DEFAULT_GITHUB_API_BASE_URL),
  allowedRepositories: z.array(repoSlug).default([]),
  allowedOwners: z.array(nonEmpty).default([]),
});

const httpMethod = z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

const paramSpec = z.strictObject({
  type: z.enum(["string", "number", "integer", "boolean"]),
  description: z.string().optional(),
  required: z.boolean().optional(),
  enum: z.array(z.union([z.string(), z.number()])).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  maxLength: posInt.optional(),
});

const endpointSchema = z.strictObject({
  name,
  method: httpMethod,
  path: z.string().regex(/^\/[^?#\s]*$/, "must start with '/' and contain no query, fragment or whitespace"),
  description: nonEmpty,
  permission: z.enum(["read", "write"]).default("read"),
  pathParams: z.record(z.string(), paramSpec).default({}),
  query: z.record(z.string(), paramSpec).default({}),
  body: z.record(z.string(), paramSpec).nullable().default(null),
});

const baseUrl = z.string().superRefine((v, ctx) => {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    ctx.addIssue({ code: "custom", message: "must be a valid absolute URL" });
    return;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    ctx.addIssue({ code: "custom", message: "must use http or https" });
  }
  if (u.username !== "" || u.password !== "") {
    ctx.addIssue({ code: "custom", message: "must not contain credentials" });
  }
  if (u.search !== "" || u.hash !== "") {
    ctx.addIssue({ code: "custom", message: "must not contain a query or fragment" });
  }
});

const authSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("bearer"), tokenEnv: envVarName }),
  z.strictObject({
    type: z.literal("header"),
    headerName: z.string().regex(/^[A-Za-z0-9-]+$/, "must be a valid HTTP header name"),
    valueEnv: envVarName,
  }),
]);

const customApiSchema = z.strictObject({
  name,
  enabled: z.boolean().default(false),
  baseUrl,
  allowPrivateNetwork: z.boolean().default(false),
  auth: authSchema.default({ type: "none" }),
  allowedMethods: z.array(httpMethod).default(["GET"]),
  timeoutMs: posInt.default(DEFAULT_API_TIMEOUT_MS),
  maxResponseBytes: posInt.default(DEFAULT_API_MAX_RESPONSE_BYTES),
  sensitiveFields: z.array(nonEmpty).default([]),
  endpoints: z.array(endpointSchema).default([]),
});

function dupes(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) out.add(v);
    seen.add(v);
  }
  return [...out];
}

export const configSchema = z
  .strictObject({
    server: serverSchema.prefault({}),
    permissions: permissionsSchema.prefault({}),
    limits: limitsSchema.prefault({}),
    workspaces: z.array(workspaceSchema).default([]),
    filesystem: filesystemSchema.prefault({}),
    databases: z.array(databaseSchema).default([]),
    github: githubSchema.prefault({}),
    customApis: z.array(customApiSchema).default([]),
  })
  .superRefine((cfg, ctx) => {
    const add = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message });
    };
    cfg.workspaces.forEach((w, i) => {
      if (dupes(cfg.workspaces.map((x) => x.id)).includes(w.id)) add(["workspaces", i, "id"], "duplicate workspace id");
      w.databases.forEach((d, j) => {
        if (!cfg.databases.some((x) => x.name === d)) add(["workspaces", i, "databases", j], "references an unknown database connection");
      });
      w.apis.forEach((a, j) => {
        if (!cfg.customApis.some((x) => x.name === a)) add(["workspaces", i, "apis", j], "references an unknown custom API profile");
      });
    });
    cfg.databases.forEach((d, i) => {
      if (dupes(cfg.databases.map((x) => x.name)).includes(d.name)) add(["databases", i, "name"], "duplicate database connection name");
    });
    cfg.customApis.forEach((api, i) => {
      if (dupes(cfg.customApis.map((x) => x.name)).includes(api.name)) add(["customApis", i, "name"], "duplicate custom API profile name");
      api.endpoints.forEach((e, j) => {
        const p = ["customApis", i, "endpoints", j];
        if (dupes(api.endpoints.map((x) => x.name)).includes(e.name)) add([...p, "name"], "duplicate endpoint name within profile");
        if (!api.allowedMethods.includes(e.method)) add([...p, "method"], "method is not in the profile's allowedMethods");
        for (const m of e.path.matchAll(/\{([^}]*)\}/g)) {
          const param = m[1] ?? "";
          if (!Object.hasOwn(e.pathParams, param)) add([...p, "pathParams"], `path placeholder '{${param}}' is not declared in pathParams`);
        }
      });
    });
  });

export type Config = z.output<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;
