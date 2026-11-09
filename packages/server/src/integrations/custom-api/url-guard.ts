import dns from "node:dns";
import net from "node:net";
import { AppError } from "../../core/errors.js";
import { canWrite, type PermissionsConfig } from "../../core/permissions.js";
import { compileEndpointSchema, parseSection, type CompiledEndpointSchema } from "./endpoint-schema.js";

/**
 * Custom API URL guard (doc 05 section 5, PRD 7.3). MCP-free and pure apart from
 * the injectable `resolve` function. The only way to obtain a request target is
 * `prepareApiRequest`, which builds the URL from the profile baseUrl plus the
 * configured endpoint path template, validates every input against the endpoint's
 * compiled schema, resolves DNS, rejects blocked addresses and returns the checked
 * address for a PINNED connection (`pinnedLookup`).
 */

/** S14 / doc 05 section 5.4: redirects are off, a 3xx is returned as data. Consumed by the P4-02 client. */
export const API_REDIRECT_POLICY = Object.freeze({ followRedirects: false, maxRedirects: 0 } as const);

const SAFE_METHODS = new Set(["GET", "HEAD"]);
const DNS_TIMEOUT_MS = 5000;
const ARBITRARY_URL_KEYS = new Set([
  "url", "uri", "href", "baseurl", "base_url", "endpointurl", "host", "hostname", "origin", "proxy", "headers", "header", "auth", "authorization",
]);

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type ResolveFn = (hostname: string) => Promise<ResolvedAddress[]>;

/** Default resolver: system DNS, all answers, no reordering. Tests inject their own. */
export const defaultResolve: ResolveFn = async (hostname) => {
  const answers = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

// ---------------------------------------------------------------------------
// Address classification

export type AddressClass =
  | "public"
  | "loopback"
  | "private"
  | "link-local"
  | "cgnat"
  | "metadata"
  | "unspecified"
  | "multicast"
  | "reserved";

/** Cloud metadata endpoints: blocked even with allowPrivateNetwork (decision recorded in implementation-notes). */
const METADATA_V4 = new Set(["169.254.169.254", "169.254.170.2", "100.100.100.200"]);

/**
 * Parse an IPv4 literal in any legacy form accepted by inet_aton: 1-4 parts, each
 * decimal, octal (leading 0) or hex (0x). Returns the 32-bit value or null.
 */
export function parseLegacyIPv4(host: string): number | null {
  if (host === "" || host.length > 64) return null;
  const parts = host.split(".");
  if (parts.length > 4 || parts.some((p) => p === "")) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let v: number;
    if (/^0x[0-9a-f]+$/i.test(p)) v = parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) v = parseInt(p, 8);
    else if (/^(0|[1-9][0-9]*)$/.test(p)) v = parseInt(p, 10);
    else return null;
    if (!Number.isSafeInteger(v)) return null;
    nums.push(v);
  }
  const last = nums[nums.length - 1] as number;
  const lead = nums.slice(0, -1);
  if (lead.some((n) => n > 255)) return null;
  if (last >= 256 ** (4 - lead.length)) return null;
  let out = last;
  lead.forEach((n, i) => {
    out += n * 256 ** (3 - i);
  });
  return out >>> 0;
}

function v4ToString(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function classifyV4(n: number): AddressClass {
  const a = n >>> 24;
  const b = (n >>> 16) & 255;
  const c = (n >>> 8) & 255;
  if (METADATA_V4.has(v4ToString(n))) return "metadata";
  if (n === 0 || a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "link-local";
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return "reserved";
  if (a === 192 && b === 88 && c === 99) return "reserved";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  if (a === 198 && b === 51 && c === 100) return "reserved";
  if (a === 203 && b === 0 && c === 113) return "reserved";
  return "public";
}

/** Parse an IPv6 literal (no brackets, no zone) into 8 16-bit groups, or null. */
export function parseIPv6(host: string): number[] | null {
  if (!net.isIPv6(host) || host.includes("%")) return null;
  let h = host;
  const lastColon = h.lastIndexOf(":");
  const tail = h.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!net.isIPv4(tail)) return null;
    const p = tail.split(".").map(Number) as [number, number, number, number];
    h = `${h.slice(0, lastColon + 1)}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const dbl = h.indexOf("::");
  const head = (dbl === -1 ? h : h.slice(0, dbl)).split(":").filter((x) => x !== "");
  const rest = dbl === -1 ? [] : h.slice(dbl + 2).split(":").filter((x) => x !== "");
  const missing = 8 - head.length - rest.length;
  if (dbl === -1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array<string>(dbl === -1 ? 0 : missing).fill("0"), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const WORSE: AddressClass[] = ["metadata", "unspecified", "multicast", "reserved", "loopback", "link-local", "private", "cgnat", "public"];
function worst(a: AddressClass, b: AddressClass): AddressClass {
  return WORSE.indexOf(a) <= WORSE.indexOf(b) ? a : b;
}

function classifyV6(g: number[]): AddressClass {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const embedded = (hi: number, lo: number): number => ((hi << 16) | lo) >>> 0;
  const allZero = (from: number, to: number): boolean => g.slice(from, to).every((x) => x === 0);
  if (allZero(0, 8)) return "unspecified";
  if (allZero(0, 7) && g7 === 1) return "loopback";
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d (deprecated): judge by the embedded v4, never "public".
  if (allZero(0, 5) && (g5 === 0xffff || g5 === 0)) {
    const c = classifyV4(embedded(g6, g7));
    return c === "public" ? "reserved" : c;
  }
  // NAT64 64:ff9b::/96 and 6to4 2002::/16: the embedded v4 decides.
  if (g0 === 0x64 && g1 === 0xff9b && allZero(2, 6)) return worst(classifyV4(embedded(g6, g7)), "public");
  if (g0 === 0x2002) return worst(classifyV4(embedded(g1, g2)), "public");
  if (g0 === 0xfd00 && g1 === 0x0ec2 && g7 === 0x254 && allZero(2, 7)) return "metadata";
  if ((g0 & 0xfe00) === 0xfc00) return "private";
  if ((g0 & 0xffc0) === 0xfe80) return "link-local";
  if ((g0 & 0xffc0) === 0xfec0) return "private"; // deprecated site-local
  if ((g0 & 0xff00) === 0xff00) return "multicast";
  if (g0 === 0x2001 && g1 === 0x0db8) return "reserved";
  if (g0 === 0x2001 && g1 === 0) return "reserved"; // Teredo
  if (g0 === 0x100 && allZero(1, 4)) return "reserved"; // discard-only
  if ((g0 & 0xe000) !== 0x2000) return "reserved"; // outside global unicast 2000::/3
  void g3; void g4;
  return "public";
}

/** Classify one address string (IPv4 in any legacy form, or IPv6). Unparseable input is "reserved" (fail closed). */
export function classifyAddress(address: string): AddressClass {
  const raw = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  if (raw.includes(":")) {
    const g = parseIPv6(raw);
    return g === null ? "reserved" : classifyV6(g);
  }
  const v4 = parseLegacyIPv4(raw);
  return v4 === null ? "reserved" : classifyV4(v4);
}

/** Whether the class may be connected to. Metadata, unspecified, multicast, reserved are never allowed. */
export function isAddressAllowed(cls: AddressClass, allowPrivateNetwork: boolean): boolean {
  if (cls === "public") return true;
  if (!allowPrivateNetwork) return false;
  return cls === "loopback" || cls === "private" || cls === "link-local" || cls === "cgnat";
}

// ---------------------------------------------------------------------------
// Profile / endpoint lookup (S11)

export interface GuardEndpoint {
  name: string;
  method: string;
  path: string;
  permission?: "read" | "write";
  pathParams?: unknown;
  query?: unknown;
  body?: unknown;
}
export interface GuardProfile {
  name: string;
  enabled: boolean;
  baseUrl: string;
  allowPrivateNetwork?: boolean;
  allowedMethods: readonly string[];
  endpoints: readonly GuardEndpoint[];
}

/** Unknown or disabled profile / unknown endpoint -> NOT_FOUND (no hint which). */
export function resolveProfileEndpoint(
  profiles: readonly GuardProfile[],
  profileName: unknown,
  endpointName: unknown,
): { profile: GuardProfile; endpoint: GuardEndpoint } {
  if (typeof profileName !== "string" || typeof endpointName !== "string") {
    throw new AppError("INVALID_INPUT", "profile and endpoint must be strings.");
  }
  if (profileName.includes("://") || endpointName.includes("://")) {
    throw new AppError("INVALID_INPUT", "URLs are not accepted; use a configured profile and endpoint name.");
  }
  const profile = profiles.find((p) => p.name === profileName && p.enabled);
  const endpoint = profile?.endpoints.find((e) => e.name === endpointName);
  if (profile === undefined || endpoint === undefined) {
    throw new AppError("NOT_FOUND", "Unknown API profile or endpoint.");
  }
  return { profile, endpoint };
}

/** S11: tool arguments may never carry a URL, host, headers or auth. Rejects by key name only (never echoes values). */
export function assertNoArbitraryTargetArgs(args: Record<string, unknown>): void {
  for (const key of Object.keys(args)) {
    if (ARBITRARY_URL_KEYS.has(key.toLowerCase())) {
      throw new AppError("INVALID_INPUT", "Arbitrary URLs, hosts, headers and auth are not accepted; only configured profiles and endpoints.");
    }
  }
}

/** Method must equal the endpoint's, be in allowedMethods, and non-GET/HEAD or `write` endpoints need `canWrite` (doc 03 section 4). */
export function assertMethodAllowed(
  profile: GuardProfile,
  endpoint: GuardEndpoint,
  permissions: Partial<PermissionsConfig> | undefined,
  requestedMethod?: string,
): void {
  if (requestedMethod !== undefined && requestedMethod.toUpperCase() !== endpoint.method) {
    throw new AppError("PERMISSION_DENIED", "The HTTP method is fixed by the endpoint configuration.");
  }
  if (!profile.allowedMethods.includes(endpoint.method)) {
    throw new AppError("PERMISSION_DENIED", "This method is not allowed for the API profile.");
  }
  const isWrite = endpoint.permission === "write" || !SAFE_METHODS.has(endpoint.method);
  if (isWrite && !canWrite(permissions, `api:${profile.name}/${endpoint.name}`, true)) {
    throw new AppError("PERMISSION_DENIED", "Write endpoints are disabled; they need permissions.allowWrites and an exact writeOperations entry.");
  }
}

// ---------------------------------------------------------------------------
// URL building (S12)

const BAD_SEGMENT_CHARS = /[\u0000-\u001f\u007f/\\]/;

function assertSafePathValue(value: string): void {
  let cur = value;
  for (let round = 0; round < 3; round++) {
    if (cur === "" || cur === "." || cur === ".." || cur.includes("..") || BAD_SEGMENT_CHARS.test(cur)) {
      throw new AppError("INVALID_INPUT", "A path parameter contains forbidden characters.");
    }
    if (!/%[0-9a-f]{2}/i.test(cur)) return;
    if (/%(2e|2f|5c|00)/i.test(cur)) throw new AppError("INVALID_INPUT", "A path parameter contains forbidden characters.");
    try {
      cur = decodeURIComponent(cur);
    } catch {
      throw new AppError("INVALID_INPUT", "A path parameter is not valid.");
    }
  }
}

function enc(v: string): string {
  try {
    return encodeURIComponent(v);
  } catch {
    throw new AppError("INVALID_INPUT", "A parameter is not valid text.");
  }
}

function scalarToString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  throw new AppError("INVALID_INPUT", "A parameter has an unsupported type.");
}

/** baseUrl path without trailing slash ("" for root). */
function basePathOf(base: URL): string {
  return base.pathname.replace(/\/+$/, "");
}

/**
 * Build the request URL from baseUrl + endpoint path template. `pathParams` and `query`
 * must already be validated (use `prepareApiRequest`); this re-checks every invariant.
 */
export function buildRequestUrl(
  profile: Pick<GuardProfile, "baseUrl">,
  endpoint: Pick<GuardEndpoint, "path">,
  pathParams: Record<string, unknown>,
  query: Record<string, unknown>,
  declared: { pathParams: readonly string[]; query: readonly string[] },
): URL {
  const base = new URL(profile.baseUrl);
  if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username !== "" || base.password !== "" || base.hash !== "" || base.search !== "") {
    throw new AppError("INTERNAL_ERROR", "The API profile base URL is not acceptable.");
  }
  const basePath = basePathOf(base);
  const used = new Set<string>();
  const template = endpoint.path;
  if (!template.startsWith("/")) throw new AppError("INTERNAL_ERROR", "Endpoint path template is invalid.");
  const path = template.replace(/\{([^{}]*)\}/g, (_m, key: string) => {
    if (!declared.pathParams.includes(key) || !Object.hasOwn(pathParams, key)) {
      throw new AppError("INVALID_INPUT", "A path placeholder has no declared value.");
    }
    used.add(key);
    const text = scalarToString(pathParams[key]);
    assertSafePathValue(text);
    return enc(text);
  });
  if (/[{}]/.test(path)) throw new AppError("INTERNAL_ERROR", "Endpoint path template is invalid.");
  for (const k of Object.keys(pathParams)) {
    if (!used.has(k)) throw new AppError("INVALID_INPUT", "An undeclared path parameter was supplied.");
  }

  const pairs: string[] = [];
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (!declared.query.includes(k) || seen.has(k)) throw new AppError("INVALID_INPUT", "An undeclared or duplicate query parameter was supplied.");
    seen.add(k);
    pairs.push(`${enc(k)}=${enc(scalarToString(v))}`);
  }

  const expectedPath = `${basePath}${path}`;
  const urlText = `${base.origin}${expectedPath}${pairs.length > 0 ? `?${pairs.join("&")}` : ""}`;
  const url = new URL(urlText);
  const pathOk =
    url.pathname === expectedPath && (url.pathname === basePath || url.pathname.startsWith(`${basePath}/`));
  if (
    url.origin !== base.origin ||
    !pathOk ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.search !== (pairs.length > 0 ? `?${pairs.join("&")}` : "")
  ) {
    throw new AppError("INVALID_INPUT", "The request URL escaped the configured base URL.");
  }
  return url;
}

// ---------------------------------------------------------------------------
// SSRF + pinning (S13)

export interface CheckedTarget {
  hostname: string;
  address: string;
  family: 4 | 6;
  /** Every address the name resolved to (all were checked). */
  addresses: ResolvedAddress[];
}

function hostLiteral(url: URL): string | null {
  const h = url.hostname;
  if (h.startsWith("[")) return h.slice(1, -1);
  if (net.isIP(h) !== 0) return h;
  const legacy = parseLegacyIPv4(h);
  return legacy === null ? null : v4ToString(legacy);
}

async function resolveBounded(resolve: ResolveFn, hostname: string, timeoutMs: number): Promise<ResolvedAddress[]> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_r, reject) => {
    timer = setTimeout(() => reject(new AppError("TIMEOUT", "DNS resolution timed out.")), timeoutMs);
  });
  try {
    return await Promise.race([resolve(hostname), timeout]);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("INTEGRATION_UNAVAILABLE", "The API host could not be resolved.");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Resolve the URL's host, reject if ANY answer is blocked, and return the address to connect to.
 * IP literals (including numeric legacy forms, which WHATWG URL already normalizes) skip DNS.
 */
export async function checkTarget(
  url: URL,
  allowPrivateNetwork: boolean,
  resolve: ResolveFn = defaultResolve,
  dnsTimeoutMs = DNS_TIMEOUT_MS,
): Promise<CheckedTarget> {
  const literal = hostLiteral(url);
  const answers: ResolvedAddress[] =
    literal !== null
      ? [{ address: literal, family: literal.includes(":") ? 6 : 4 }]
      : await resolveBounded(resolve, url.hostname, dnsTimeoutMs);
  if (answers.length === 0 || answers.length > 64) {
    throw new AppError("INTEGRATION_UNAVAILABLE", "The API host could not be resolved.");
  }
  for (const a of answers) {
    if (!isAddressAllowed(classifyAddress(a.address), allowPrivateNetwork)) {
      throw new AppError("PERMISSION_DENIED", "The API host resolves to a blocked network address.");
    }
  }
  const first = answers[0] as ResolvedAddress;
  return { hostname: url.hostname, address: first.address, family: first.family, addresses: answers };
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;

/**
 * A `lookup` for `net.connect` / undici `connect: { lookup }` / `https.Agent`. It always answers
 * with the already-checked address and never touches DNS, so a rebinding answer cannot be used.
 * It refuses any other hostname (e.g. after a redirect). TLS SNI / Host stay the original name
 * because the caller connects by name; only the socket address is pinned.
 */
export function createPinnedLookup(target: Pick<CheckedTarget, "hostname" | "address" | "family">) {
  return (hostname: string, options: unknown, callback?: LookupCallback): void => {
    const cb = (typeof options === "function" ? options : callback) as LookupCallback;
    const opts = (typeof options === "object" && options !== null ? options : {}) as { all?: boolean };
    if (hostname !== target.hostname && hostname !== `[${target.hostname}]`) {
      const err: NodeJS.ErrnoException = Object.assign(new Error("Host is not the pinned API host."), { code: "ENOTFOUND" });
      cb(err, "", 0);
      return;
    }
    if (opts.all === true) cb(null, [{ address: target.address, family: target.family }]);
    else cb(null, target.address, target.family);
  };
}

// ---------------------------------------------------------------------------
// Entry point for P4-02

export interface PrepareInput {
  profiles: readonly GuardProfile[];
  profile: unknown;
  endpoint: unknown;
  pathParams?: unknown;
  query?: unknown;
  body?: unknown;
  /** Any extra top-level tool arguments, checked for url/host/header keys (S11). */
  extraArgs?: Record<string, unknown>;
  permissions?: Partial<PermissionsConfig> | undefined;
  requestedMethod?: string;
  resolve?: ResolveFn;
  dnsTimeoutMs?: number;
}

export interface PreparedApiRequest {
  profileName: string;
  endpointName: string;
  method: string;
  url: URL;
  /** Original host name (Host header and TLS SNI stay this). */
  hostname: string;
  /** The checked address the connection must use. */
  pinnedAddress: string;
  pinnedFamily: 4 | 6;
  /** Pass as `lookup` to the connect options of the HTTP client. */
  lookup: ReturnType<typeof createPinnedLookup>;
  /** Validated body (null when the endpoint has none). */
  body: Record<string, unknown> | null;
  maxRedirects: 0;
  followRedirects: false;
}

const compiledCache = new WeakMap<object, CompiledEndpointSchema>();
export function compiledFor(endpoint: GuardEndpoint): CompiledEndpointSchema {
  let c = compiledCache.get(endpoint);
  if (c === undefined) {
    c = compileEndpointSchema({ pathParams: endpoint.pathParams, query: endpoint.query, body: endpoint.body });
    compiledCache.set(endpoint, c);
  }
  return c;
}

export async function prepareApiRequest(input: PrepareInput): Promise<PreparedApiRequest> {
  if (input.extraArgs !== undefined) assertNoArbitraryTargetArgs(input.extraArgs);
  const { profile, endpoint } = resolveProfileEndpoint(input.profiles, input.profile, input.endpoint);
  assertMethodAllowed(profile, endpoint, input.permissions, input.requestedMethod);

  const compiled = compiledFor(endpoint);
  const pathParams = parseSection(compiled.pathParams, input.pathParams, "pathParams");
  const query = parseSection(compiled.query, input.query, "query");
  let body: Record<string, unknown> | null = null;
  if (compiled.body === null) {
    if (input.body !== undefined && input.body !== null) throw new AppError("INVALID_INPUT", "This endpoint does not accept a body.");
  } else {
    if (SAFE_METHODS.has(endpoint.method)) throw new AppError("INVALID_INPUT", "This endpoint does not accept a body.");
    body = parseSection(compiled.body, input.body, "body");
  }

  const declaredPath = Object.keys(compiled.pathParams.shape);
  const declaredQuery = Object.keys(compiled.query.shape);
  const url = buildRequestUrl(profile, endpoint, pathParams, query, { pathParams: declaredPath, query: declaredQuery });
  const target = await checkTarget(url, profile.allowPrivateNetwork === true, input.resolve ?? defaultResolve, input.dnsTimeoutMs);
  return {
    profileName: profile.name,
    endpointName: endpoint.name,
    method: endpoint.method,
    url,
    hostname: target.hostname,
    pinnedAddress: target.address,
    pinnedFamily: target.family,
    lookup: createPinnedLookup(target),
    body,
    maxRedirects: API_REDIRECT_POLICY.maxRedirects,
    followRedirects: API_REDIRECT_POLICY.followRedirects,
  };
}
