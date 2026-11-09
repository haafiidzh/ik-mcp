/**
 * Custom API service (doc 04 section C). MCP-free. Validates the call with the endpoint's compiled
 * schema (via `prepareApiRequest`), runs the pinned client, redacts and bounds the result.
 * Test seams (`resolve`, `getEnv`, `request`) are constructor options set only by code that builds
 * ServerDeps (tests); they are not reachable from config or tool arguments (ADR-070 style).
 */
import { AppError } from "../../core/errors.js";
import { canWrite, type PermissionsConfig } from "../../core/permissions.js";
import type { Limits } from "../../core/limits.js";
import { collectSecretValues, createRedactor, type Redactor } from "../../core/redact.js";
import { wireSize, type ToolResult } from "../../core/response.js";
import { executeApiRequest, RESERVED_HEADER_NAMES, type ApiAuth, type ApiClientOptions, type ApiRawResponse, type ApiRuntimeProfile } from "./api.client.js";
import { compileEndpointSchema } from "./endpoint-schema.js";
import { prepareApiRequest, resolveProfileEndpoint, type GuardEndpoint, type GuardProfile, type PreparedApiRequest, type ResolveFn } from "./url-guard.js";

export interface ApiEndpointConfig extends GuardEndpoint {
  description: string;
  permission: "read" | "write";
}
export interface ApiProfileConfig extends GuardProfile {
  allowPrivateNetwork: boolean;
  auth: ApiAuth;
  timeoutMs: number;
  maxResponseBytes: number;
  sensitiveFields: readonly string[];
  endpoints: readonly ApiEndpointConfig[];
}

export type ApiRequestFn = (prepared: PreparedApiRequest, profile: ApiRuntimeProfile, options?: ApiClientOptions) => Promise<ApiRawResponse>;

export interface ApiServiceOptions {
  profiles: readonly ApiProfileConfig[];
  permissions: Partial<PermissionsConfig>;
  limits: Pick<Limits, "networkTimeoutMs" | "maxResponseBytes">;
  /** Seams (tests only). */
  resolve?: ResolveFn;
  getEnv?: (name: string) => string | undefined;
  request?: ApiRequestFn;
  dnsTimeoutMs?: number;
}

export interface ProfileSummary {
  name: string;
  enabled: boolean;
  /** Omitted for disabled profiles (internal hostnames of profiles the operator turned off; ADR-092). */
  baseHost?: string;
  authType: ApiAuth["type"];
  endpoints: number;
}

export interface CallOutput {
  data: { status: number; headers: Record<string, string>; body: unknown };
  truncated: boolean;
  limit?: number;
  warnings: string[];
}

const SAFE = new Set(["GET", "HEAD"]);
export function isWriteEndpoint(e: Pick<GuardEndpoint, "method" | "permission">): boolean {
  return e.permission === "write" || !SAFE.has(e.method);
}

/** Whether any enabled profile defines a write-capable endpoint (decides tool annotations). */
export function hasWriteEndpoints(profiles: readonly ApiProfileConfig[]): boolean {
  return profiles.some((p) => p.enabled && p.endpoints.some(isWriteEndpoint));
}

/**
 * Startup validation: compile every enabled endpoint's schema and check auth headers. Fails closed with
 * a message naming the JSON path (profile name and endpoint index/name only; never a value or secret).
 */
export function validateApiProfiles(profiles: readonly ApiProfileConfig[]): void {
  profiles.forEach((p, i) => {
    if (!p.enabled) return;
    if (p.auth.type === "header" && RESERVED_HEADER_NAMES.has(p.auth.headerName.toLowerCase())) {
      throw new AppError("UNSUPPORTED", `customApis[${i}].auth.headerName: this header name is reserved and cannot carry credentials.`);
    }
    p.endpoints.forEach((e, j) => {
      try {
        compileEndpointSchema({ pathParams: e.pathParams, query: e.query, body: e.body });
      } catch (err) {
        const base = `customApis[${i}].endpoints[${j}]`;
        const detail = err instanceof AppError ? err.message : "invalid schema";
        throw new AppError("UNSUPPORTED", `${base}: ${detail.replace(/^Endpoint schema at \$\./, "")}`);
      }
    });
  });
}

function authEnvName(auth: ApiAuth): string | undefined {
  return auth.type === "bearer" ? auth.tokenEnv : auth.type === "header" ? auth.valueEnv : undefined;
}

export interface ApiService {
  listProfiles(): ProfileSummary[];
  getEndpointInfo(profile: string, endpoint: string): Record<string, unknown>;
  /** True when the CONFIGURED endpoint is a write (method/permission). False if it cannot be resolved. */
  isWriteEndpoint(profile: unknown, endpoint: unknown): boolean;
  callEndpoint(args: { profile: string; endpoint: string; pathParams?: unknown; query?: unknown; body?: unknown; extraArgs?: Record<string, unknown> }, signal?: AbortSignal): Promise<CallOutput>;
}

export function createApiService(options: ApiServiceOptions): ApiService {
  const getEnv = options.getEnv ?? ((n: string) => process.env[n]);
  const request = options.request ?? executeApiRequest;

  function redactorFor(p: ApiProfileConfig): Redactor {
    const env = authEnvName(p.auth);
    return createRedactor({
      secretValues: env === undefined ? [] : collectSecretValues([env], { [env]: getEnv(env) }),
      sensitiveFields: p.sensitiveFields,
    });
  }

  return {
    listProfiles() {
      return options.profiles.map((p) => ({
        name: p.name,
        enabled: p.enabled,
        ...(p.enabled ? { baseHost: new URL(p.baseUrl).host } : {}),
        authType: p.auth.type,
        endpoints: p.endpoints.length,
      }));
    },

    getEndpointInfo(profileName, endpointName) {
      const { profile, endpoint } = resolveProfileEndpoint(options.profiles, profileName, endpointName);
      const e = endpoint as ApiEndpointConfig;
      const write = isWriteEndpoint(e);
      const enabled = !write || canWrite(options.permissions, `api:${profile.name}/${e.name}`, true);
      const compiled = compileEndpointSchema({ pathParams: e.pathParams, query: e.query, body: e.body });
      return {
        profile: profile.name,
        endpoint: e.name,
        description: e.description,
        method: e.method,
        pathTemplate: e.path,
        permission: write ? "write" : "read",
        callable: enabled,
        ...(write && !enabled ? { writeGated: true, note: "Disabled: needs permissions.allowWrites and an exact writeOperations entry." } : {}),
        inputSchema: compiled.inputSchema,
      };
    },

    isWriteEndpoint(profileName, endpointName) {
      try {
        return isWriteEndpoint(resolveProfileEndpoint(options.profiles, profileName, endpointName).endpoint);
      } catch {
        return false;
      }
    },

    async callEndpoint(args, signal) {
      const prepared = await prepareApiRequest({
        profiles: options.profiles,
        profile: args.profile,
        endpoint: args.endpoint,
        pathParams: args.pathParams,
        query: args.query,
        body: args.body,
        ...(args.extraArgs !== undefined ? { extraArgs: args.extraArgs } : {}),
        permissions: options.permissions,
        ...(options.resolve !== undefined ? { resolve: options.resolve } : {}),
        ...(options.dnsTimeoutMs !== undefined ? { dnsTimeoutMs: options.dnsTimeoutMs } : {}),
      });
      const profile = options.profiles.find((p) => p.name === prepared.profileName) as ApiProfileConfig;
      const runtime: ApiRuntimeProfile = {
        auth: profile.auth,
        timeoutMs: Math.max(1, Math.min(profile.timeoutMs, options.limits.networkTimeoutMs)),
        maxResponseBytes: Math.max(1, Math.min(profile.maxResponseBytes, options.limits.maxResponseBytes)),
      };
      const raw = await request(prepared, runtime, { getEnv, ...(signal !== undefined ? { signal } : {}) });
      return shape(raw, runtime, redactorFor(profile), options.limits.maxResponseBytes);
    },
  };
}

/** Parse/describe, redact, and make sure the final wire size (two copies) fits the response budget. */
function shape(raw: ApiRawResponse, runtime: ApiRuntimeProfile, redactor: Redactor, budget: number): CallOutput {
  const warnings: string[] = [];
  let truncated = raw.truncated;
  let body: unknown;
  if (raw.kind === "empty") body = null;
  else if (raw.kind === "other" && raw.encoding !== undefined) {
    body = { omitted: "Encoded response body not returned (no decompression).", contentType: raw.headers["content-type"] ?? "unknown", encoding: raw.encoding };
    warnings.push("Response has a Content-Encoding other than identity; the body was not read or decompressed.");
  } else if (raw.kind === "other") {
    body = { omitted: "Non-text response body not returned.", contentType: raw.headers["content-type"] ?? "unknown", ...(raw.declaredLength !== null ? { bytes: raw.declaredLength } : {}) };
    warnings.push("Response content type is not JSON or text; the body was not read.");
  } else if (raw.kind === "json" && raw.json !== undefined) body = redactor.redactValue(raw.json);
  else body = redactor.redactString(raw.text);
  if (raw.truncated) warnings.push(`Response exceeded ${runtime.maxResponseBytes} bytes; it was cut and the connection aborted.`);
  if (raw.status >= 300 && raw.status < 400) warnings.push("Redirect response returned as data; redirects are never followed.");

  const headers = Object.fromEntries(Object.entries(raw.headers).map(([k, v]) => [k, redactor.redactString(v)]));
  const build = (b: unknown): ToolResult => ({
    success: true,
    data: { status: raw.status, headers, body: b },
    meta: { source: "custom-api", partial: truncated, returnedCount: 0, nextPageAvailable: false, truncated, ...(truncated ? { limit: runtime.maxResponseBytes } : {}) },
    warnings,
  });
  if (wireSize(build(body)) > budget) {
    // Fit the budget: fall back to a (cut) text rendition of the body.
    const text = typeof body === "string" ? body : JSON.stringify(body);
    truncated = true;
    warnings.push("Response was cut to fit the maximum response size (sent twice: structured and text).");
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (wireSize(build(text.slice(0, mid))) + 128 <= budget) lo = mid;
      else hi = mid - 1;
    }
    body = text.slice(0, lo);
  }
  return {
    data: { status: raw.status, headers, body },
    truncated,
    ...(truncated ? { limit: runtime.maxResponseBytes } : {}),
    warnings,
  };
}
