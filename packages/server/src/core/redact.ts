/** Redaction per doc 05 section 1. Applied to logs, errors, audit and API bodies. */
export const REDACTED = "[REDACTED]";

export const SENSITIVE_KEY_RE =
  /pass(word)?|secret|token|api[-_]?key|authorization|cookie|private[-_]?key|connection[-_]?string/i;

const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bgithub_pat_[A-Za-z0-9_]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/g,
];

const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;

const MIN_SECRET_LENGTH = 4;

export interface Redactor {
  redactString(input: string): string;
  redactValue(input: unknown): unknown;
}

export interface RedactorOptions {
  /** Actual secret values (already resolved from env) to scrub by exact match. */
  secretValues?: readonly string[];
  /** Extra sensitive key names (configured `sensitiveFields`), case-insensitive exact match. */
  sensitiveFields?: readonly string[];
}

/** Resolve secret values from named env vars. Names come from config; values are never stored elsewhere. */
export function collectSecretValues(
  envNames: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const out: string[] = [];
  for (const name of envNames) {
    const v = env[name];
    if (v !== undefined && v.length >= MIN_SECRET_LENGTH) out.push(v);
  }
  return out;
}

export function createRedactor(options: RedactorOptions = {}): Redactor {
  // Longest first so a secret containing another is scrubbed whole.
  const secrets = [...(options.secretValues ?? [])]
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  const extraKeys = new Set((options.sensitiveFields ?? []).map((k) => k.toLowerCase()));

  const isSensitiveKey = (key: string): boolean =>
    SENSITIVE_KEY_RE.test(key) || extraKeys.has(key.toLowerCase());

  function redactString(input: string): string {
    let out = input;
    for (const s of secrets) out = out.split(s).join(REDACTED);
    out = out.replace(URL_USERINFO_RE, `$1${REDACTED}@`);
    for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED);
    return out;
  }

  function walk(value: unknown, seen: WeakSet<object>, depth: number): unknown {
    if (typeof value === "string") return redactString(value);
    if (value === null || typeof value !== "object") return value;
    if (depth > 20) return "[TRUNCATED_DEPTH]";
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => walk(v, seen, depth + 1));
    if (value instanceof Error) {
      // Never expose stacks.
      return { name: value.name, message: redactString(value.message) };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) ? REDACTED : walk(v, seen, depth + 1);
    }
    return out;
  }

  return {
    redactString,
    redactValue: (input) => walk(input, new WeakSet<object>(), 0),
  };
}
