/** Error codes per doc 04 section 3. Messages must be safe: no stacks, secrets or raw upstream bodies. */
export const ERROR_CODES = [
  "INVALID_INPUT",
  "NOT_FOUND",
  "PERMISSION_DENIED",
  "QUERY_REJECTED",
  "UNSUPPORTED",
  "LIMIT_EXCEEDED",
  "INTEGRATION_DISABLED",
  "INTEGRATION_UNAVAILABLE",
  "TIMEOUT",
  "RATE_LIMITED",
  "UPSTREAM_ERROR",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Default retryability per code. UPSTREAM_ERROR is "maybe"; callers may override. */
export const DEFAULT_RETRYABLE: Readonly<Record<ErrorCode, boolean>> = {
  INVALID_INPUT: false,
  NOT_FOUND: false,
  PERMISSION_DENIED: false,
  QUERY_REJECTED: false,
  UNSUPPORTED: false,
  LIMIT_EXCEEDED: false,
  INTEGRATION_DISABLED: false,
  INTEGRATION_UNAVAILABLE: true,
  TIMEOUT: true,
  RATE_LIMITED: true,
  UPSTREAM_ERROR: false,
  INTERNAL_ERROR: false,
};

export interface AppErrorOptions {
  retryable?: boolean;
  retryAfterSeconds?: number | null;
  /** Internal-only cause; never serialized into results. */
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[code];
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  retryAfterSeconds: number | null;
}

/**
 * Convert any thrown value to a safe payload. Unknown errors become a generic
 * INTERNAL_ERROR; their details belong only in the (redacted) stderr log.
 * The caller applies redaction to AppError messages via response.ts.
 */
export function toErrorPayload(err: unknown): ErrorPayload {
  if (isAppError(err)) {
    return {
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      retryAfterSeconds: err.retryAfterSeconds,
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "An internal error occurred.",
    retryable: false,
    retryAfterSeconds: null,
  };
}
