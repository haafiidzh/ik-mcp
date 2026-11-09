/** Default limits per doc 03 section 5. Takes plain values; does not import config. */
export interface Limits {
  networkTimeoutMs: number;
  dbQueryTimeoutMs: number;
  dbMaxRows: number;
  maxFileBytes: number;
  maxResults: number;
  workflowTimeoutMs: number;
  maxResponseBytes: number;
  maxTreeDepth: number;
  maxTreeEntries: number;
  maxSearchDepth: number;
  maxFilesScanned: number;
  maxSnippetChars: number;
  githubPerPage: number;
  githubPerPageMax: number;
  maxRedirectsCustomApi: number;
  maxRedirectsGithub: number;
  maxCellChars: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  networkTimeoutMs: 15000,
  dbQueryTimeoutMs: 10000,
  dbMaxRows: 100,
  maxFileBytes: 200000,
  maxResults: 100,
  workflowTimeoutMs: 30000,
  maxResponseBytes: 200000,
  maxTreeDepth: 4,
  maxTreeEntries: 500,
  maxSearchDepth: 10,
  maxFilesScanned: 5000,
  maxSnippetChars: 300,
  githubPerPage: 30,
  githubPerPageMax: 100,
  maxRedirectsCustomApi: 0,
  maxRedirectsGithub: 3,
  maxCellChars: 1000,
});

/**
 * Upper bounds for config overrides: overrides may only tighten defaults.
 * githubPerPage is bounded by githubPerPageMax (doc 03 §5); redirects stay at
 * the stricter documented values (custom API 0, GitHub same-host 3; D19).
 */
export const LIMIT_MAXIMA: Readonly<Limits> = Object.freeze({
  ...DEFAULT_LIMITS,
  githubPerPage: DEFAULT_LIMITS.githubPerPageMax,
});

/** Merge overrides over defaults; ignores undefined and non-finite/negative values. */
export function resolveLimits(overrides: Partial<Limits> = {}): Limits {
  const out: Limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
    const v = overrides[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[key] = Math.floor(v);
  }
  return out;
}

export interface TruncationMeta {
  truncated: boolean;
  limit?: number;
}

/** Clamp a requested count to a hard cap (default when undefined). */
export function clampLimit(requested: number | undefined, cap: number, fallback = cap): number {
  const r = requested ?? fallback;
  if (!Number.isFinite(r) || r < 1) return Math.min(fallback, cap);
  return Math.min(Math.floor(r), cap);
}

export interface Bounded<T> {
  items: T[];
  meta: TruncationMeta;
}

/** Cut a list to `limit` items and report truncation (never silent). */
export function truncateList<T>(items: readonly T[], limit: number): Bounded<T> {
  if (items.length > limit) {
    return { items: items.slice(0, limit), meta: { truncated: true, limit } };
  }
  return { items: [...items], meta: { truncated: false } };
}

/** Truncate a string to at most maxChars UTF-16 units (code point boundary) and report truncation. */
export function truncateString(
  text: string,
  maxChars: number,
): { text: string; meta: TruncationMeta } {
  if (text.length > maxChars) {
    // Never leave a lone high surrogate: drop it when the cut falls inside a pair.
    let end = Math.max(0, maxChars);
    if (end > 0 && end < text.length) {
      const last = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    }
    return { text: text.slice(0, end), meta: { truncated: true, limit: maxChars } };
  }
  return { text, meta: { truncated: false } };
}

/** Truncate by UTF-8 byte length without splitting a code point. */
export function truncateBytes(
  text: string,
  maxBytes: number,
): { text: string; meta: TruncationMeta } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, meta: { truncated: false } };
  let cut = maxBytes;
  while (cut > 0 && ((buf[cut] ?? 0) & 0xc0) === 0x80) cut--;
  return { text: buf.subarray(0, cut).toString("utf8"), meta: { truncated: true, limit: maxBytes } };
}
