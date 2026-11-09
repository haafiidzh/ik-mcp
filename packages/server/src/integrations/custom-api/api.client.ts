/**
 * Custom API HTTP client (doc 05 sections 1 and 5, PRD 7.3). MCP-free.
 *
 * Executes ONLY a request prepared by `prepareApiRequest` (url-guard): the URL was built from the
 * profile baseUrl + endpoint template and the DNS answer was checked. This client then
 *  - uses node:http / node:https (not global fetch) so it can pass the PINNED `lookup`: the socket
 *    connects to the already-validated address while Host and TLS SNI keep the original hostname;
 *  - uses `agent: false` (one fresh socket per request, never a pooled one that was pinned for
 *    another address);
 *  - never follows redirects (S14): a 3xx is returned as data;
 *  - injects auth from the env var NAMED in the profile; callers cannot supply headers;
 *  - enforces a timeout and a streaming size cap (S15), asks for `identity` encoding (no decompression bombs);
 *  - returns only the `content-type` response header;
 *  - maps failures to AppError with scrubbed messages (no URL, no address, no secret, no stack).
 */
import http from "node:http";
import https from "node:https";
import { AppError } from "../../core/errors.js";
import type { PreparedApiRequest } from "./url-guard.js";

export const API_USER_AGENT = "devworkspace-mcp";
/** Headers a profile may never use for `auth.type = header` (the client owns them). */
export const RESERVED_HEADER_NAMES: ReadonlySet<string> = new Set([
  "host", "content-length", "content-type", "transfer-encoding", "connection", "accept", "accept-encoding", "user-agent", "upgrade", "te", "trailer", "expect",
]);

export type ApiAuth =
  | { type: "none" }
  | { type: "bearer"; tokenEnv: string }
  | { type: "header"; headerName: string; valueEnv: string };

export interface ApiRuntimeProfile {
  auth: ApiAuth;
  /** Already bounded by core limits by the caller. */
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface ApiClientOptions {
  /** Env getter (defaults to process.env). Used only for the names in `auth`. Test seam via ServerDeps. */
  getEnv?: (name: string) => string | undefined;
  signal?: AbortSignal;
}

export interface ApiRawResponse {
  status: number;
  /** Allowlisted response headers: `content-type` only. */
  headers: Record<string, string>;
  kind: "empty" | "json" | "text" | "other";
  /** Decoded text for json/text (may be cut at the size cap). */
  text: string;
  /** Bytes received (up to the cap). */
  bytesRead: number;
  /** Declared content-length when the body was not read (kind `other`). */
  declaredLength: number | null;
  truncated: boolean;
  /** Response Content-Encoding when it is not identity (body not read, never decompressed; P4-06). */
  encoding?: string;
  /** Parsed JSON when kind is json and not truncated and valid. */
  json?: unknown;
}

function authHeader(auth: ApiAuth, getEnv: (n: string) => string | undefined): [string, string] | null {
  if (auth.type === "none") return null;
  const envName = auth.type === "bearer" ? auth.tokenEnv : auth.valueEnv;
  const value = getEnv(envName);
  if (value === undefined || value === "" || /[\r\n\0]/.test(value)) {
    throw new AppError("INTEGRATION_UNAVAILABLE", "Credentials for this API profile are not available (the configured environment variable is unset or invalid).");
  }
  return auth.type === "bearer" ? ["authorization", `Bearer ${value}`] : [auth.headerName.toLowerCase(), value];
}

function classify(contentType: string): "json" | "text" | "other" {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime === "application/json" || mime.endsWith("+json")) return "json";
  if (mime.startsWith("text/") || mime === "application/xml" || mime.endsWith("+xml") || mime === "application/x-www-form-urlencoded") return "text";
  return "other";
}

function mapNetworkError(err: unknown): AppError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code ?? "";
  if (err instanceof AppError) return err;
  if (code === "ENOTFOUND") return new AppError("PERMISSION_DENIED", "The connection was refused: the host is not the validated API host.");
  if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH") return new AppError("INTEGRATION_UNAVAILABLE", "The API host refused or could not be reached.");
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ETIMEDOUT") return new AppError("INTEGRATION_UNAVAILABLE", "The connection to the API host was lost.");
  if (code.startsWith("ERR_TLS") || code.startsWith("CERT_") || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "ERR_SSL_WRONG_VERSION_NUMBER") {
    return new AppError("INTEGRATION_UNAVAILABLE", "The TLS connection to the API host failed.");
  }
  if (code.startsWith("HPE_") || code === "ERR_HTTP_INVALID_HEADER_VALUE") return new AppError("UPSTREAM_ERROR", "The API returned a malformed HTTP response.");
  return new AppError("INTEGRATION_UNAVAILABLE", "The API request failed.");
}

/** Execute one prepared request. Bounded by `timeoutMs`, `maxResponseBytes` and the optional signal. */
export function executeApiRequest(prepared: PreparedApiRequest, profile: ApiRuntimeProfile, options: ApiClientOptions = {}): Promise<ApiRawResponse> {
  const getEnv = options.getEnv ?? ((n: string) => process.env[n]);
  const auth = authHeader(profile.auth, getEnv); // before any connection
  const url = prepared.url;
  const isTls = url.protocol === "https:";
  const payload = prepared.body === null ? null : Buffer.from(JSON.stringify(prepared.body), "utf8");

  const headers: Record<string, string> = {
    accept: "application/json, text/plain;q=0.9, */*;q=0.1",
    "accept-encoding": "identity",
    "user-agent": API_USER_AGENT,
    connection: "close",
  };
  if (payload !== null) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(payload.length);
  }
  if (auth !== null) headers[auth[0]] = auth[1];

  return new Promise<ApiRawResponse>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const requestFn = isTls ? https.request : http.request;
    const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    const req = requestFn({
      method: prepared.method,
      hostname,
      port: url.port === "" ? (isTls ? 443 : 80) : Number(url.port),
      path: `${url.pathname}${url.search}`,
      headers,
      agent: false,
      // The pinned lookup answers with the checked address and refuses any other name.
      lookup: prepared.lookup as unknown as http.RequestOptions["lookup"],
      ...(isTls ? { servername: hostname } : {}),
      setHost: true,
    });

    const onAbort = (): void => {
      req.destroy();
      done(() => reject(new AppError("TIMEOUT", "The API request was cancelled.")));
    };
    const timer = setTimeout(() => {
      req.destroy();
      done(() => reject(new AppError("TIMEOUT", `The API did not respond within ${profile.timeoutMs} ms.`)));
    }, profile.timeoutMs);
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    req.on("error", (err) => done(() => reject(mapNetworkError(err))));
    req.on("response", (res) => {
      const rawType = res.headers["content-type"];
      const contentType = typeof rawType === "string" ? rawType.slice(0, 200) : "";
      const outHeaders: Record<string, string> = contentType !== "" ? { "content-type": contentType } : {};
      const status = res.statusCode ?? 0;
      const lenHeader = res.headers["content-length"];
      const declared = typeof lenHeader === "string" && /^\d{1,15}$/.test(lenHeader) ? Number(lenHeader) : null;
      const noBody = prepared.method === "HEAD" || status === 204 || status === 304 || (declared === 0);
      const rawEnc = res.headers["content-encoding"];
      const encoding = typeof rawEnc === "string" ? rawEnc.trim().toLowerCase().replace(/[^a-z0-9,\s._-]/g, "").slice(0, 60) : "";
      const encoded = !noBody && encoding !== "" && encoding !== "identity";
      const kind = noBody ? "empty" : encoded ? "other" : contentType === "" ? "text" : classify(contentType);

      if (kind === "empty" || kind === "other") {
        // Not read: described by type and declared size only.
        res.destroy();
        done(() =>
          resolve({ status, headers: outHeaders, kind, text: "", bytesRead: 0, declaredLength: declared, truncated: false, ...(encoded ? { encoding } : {}) }),
        );
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      let truncated = false;
      res.on("data", (chunk: Buffer) => {
        if (truncated) return;
        const room = profile.maxResponseBytes - total;
        if (chunk.length > room) {
          if (room > 0) chunks.push(chunk.subarray(0, room));
          total += Math.max(room, 0);
          truncated = true;
          res.destroy(); // abort the connection (S15)
          finish();
          return;
        }
        chunks.push(chunk);
        total += chunk.length;
      });
      res.on("end", finish);
      res.on("error", (err) => {
        if (truncated) return;
        done(() => reject(mapNetworkError(err)));
      });
      res.on("close", () => {
        if (!res.complete && !truncated) done(() => reject(new AppError("INTEGRATION_UNAVAILABLE", "The connection to the API host was lost.")));
      });

      function finish(): void {
        const text = Buffer.concat(chunks).toString("utf8");
        const out: ApiRawResponse = { status, headers: outHeaders, kind, text, bytesRead: total, declaredLength: declared, truncated };
        if (kind === "json" && !truncated) {
          try {
            out.json = JSON.parse(text);
          } catch {
            out.kind = "text";
          }
        }
        done(() => resolve(out));
      }
    });

    if (payload !== null) req.write(payload);
    req.end();
  });
}
