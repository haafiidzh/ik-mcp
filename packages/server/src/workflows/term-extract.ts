/**
 * Deterministic search-term extraction from an issue (doc 04 section 6, D20).
 * No model, no network. Issue text is UNTRUSTED DATA: it is only scanned for
 * literal candidates, never interpreted, never used as a regex or a path.
 * Every returned term is safe to pass as a LITERAL query to `fs_search_content`
 * / `fs_search_files`: no NUL/control chars, no `..`, no backslash, no absolute
 * path, "/" only inside a validated file-like token, length <= MAX_TERM_CHARS.
 *
 * Kinds and ranking (most specific first):
 *   1 file        file-like token: `foo/bar.ts`, `package.json`, `*.ext` (known extensions only)
 *   2 code        `code span` (a file-like span is classified as file)
 *   3 quote       "double-quoted" or curly-quoted error text, 4..80 chars
 *   4 identifier  camelCase, PascalCase (needs a 2nd capital) or snake_case, ASCII, 4..64 chars
 * Order of the result: kind rank, then first occurrence in `title + "\n" + body`.
 * De-duplication is case-insensitive: the most specific kind wins, then the earliest.
 * An identifier contained in a code-span term (`doWork()` -> doWork) is dropped as redundant.
 * At most MAX_TERMS (10). Stopwords (list below) are dropped for non-file kinds.
 *
 * Bounds / ReDoS: input is cut to MAX_TITLE_CHARS + MAX_BODY_CHARS BEFORE any scan
 * (`inputTruncated` reports it). All regexes are single character classes with
 * bounded repetition or are linear splits; token checks are manual loops. No nested
 * quantifiers, no backreferences.
 */

export const MAX_TERMS = 10;
export const MAX_TERM_CHARS = 80;
export const MAX_TITLE_CHARS = 300;
export const MAX_BODY_CHARS = 20000;
const MAX_TOKEN_CHARS = 200;

export type TermKind = "file" | "code" | "quote" | "identifier";
const RANK: Record<TermKind, number> = { file: 1, code: 2, quote: 3, identifier: 4 };

export interface ExtractedTerm {
  term: string;
  kind: TermKind;
  /** Where the first occurrence was found. */
  field: "title" | "body";
}

export interface TermExtraction {
  terms: ExtractedTerm[];
  meta: {
    inputTruncated: boolean;
    /** Distinct candidates before the MAX_TERMS cut. */
    candidates: number;
    /** True when more than MAX_TERMS distinct candidates existed. */
    truncated: boolean;
  };
}

/** Committed stopword list (lowercase). Common English words plus generic issue/code words. */
export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    "about above after again also always been before being below between both bug bugs but can cannot could " +
    "default did does doing done down during each else error errors expected fail failed fails false fix fixed " +
    "for from further get gets give going got had has have having help her here hers him his how however " +
    "into issue issues its just keep know like make many may might more most must need needs never new not now " +
    "null number only other our out over please problem problems really same see seems should since some " +
    "still such than that the their them then there these they thing this those through too true undefined " +
    "under until use used uses using very want was were what when where which while who will with without " +
    "would yes yet you your actual behavior behaviour steps reproduce expected result results version " +
    "string value values data file files code test tests todo none void"
  ).split(" "),
);

const KNOWN_EXTENSIONS: ReadonlySet<string> = new Set(
  (
    "ts tsx js jsx mjs cjs json md mdx py go rs java kt rb php cs c h cpp hpp css scss sass less html htm " +
    "yml yaml toml sql sh bash zsh ps1 vue svelte txt xml env lock ini cfg conf swift dart ex exs gradle " +
    "properties proto graphql prisma tf"
  ).split(" "),
);

const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const SPLIT_TOKEN_RE = /[\s"'`()[\]{},;:<>|!?=#&^$%\\]+/;
const CODE_SPAN_RE = /`([^`\n]{1,100})`/g;
const QUOTE_RE = /["“]([^"“”\n]{4,80})["”]/g;
const FILE_CHARS_RE = /^[A-Za-z0-9_@.+\-/]+$/;
const NON_ALNUM_SPLIT_RE = /[^A-Za-z0-9_]+/;

function isLower(c: string): boolean {
  return c >= "a" && c <= "z";
}
function isUpper(c: string): boolean {
  return c >= "A" && c <= "Z";
}

/** Validate a file-like token; returns the normalized token or undefined. */
export function asFileToken(raw: string): string | undefined {
  let t = raw;
  while (t.startsWith("./")) t = t.slice(2);
  // trailing sentence punctuation
  while (t.length > 0 && (t.endsWith(".") || t.endsWith("-") || t.endsWith("+"))) t = t.slice(0, -1);
  if (t.length < 3 || t.length > MAX_TERM_CHARS) return undefined;
  if (t.startsWith("*.")) {
    const e = t.slice(2).toLowerCase();
    return /^[a-z0-9]{1,10}$/.test(e) && KNOWN_EXTENSIONS.has(e) ? t : undefined;
  }
  if (!FILE_CHARS_RE.test(t) || t.startsWith("/") || t.includes("//") || t.includes("..")) return undefined;
  const dot = t.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = t.slice(dot + 1).toLowerCase();
  if (!KNOWN_EXTENSIONS.has(ext)) return undefined;
  const base = t.slice(0, dot);
  if (base.length === 0) return undefined;
  for (const seg of t.split("/")) if (seg === "" || seg === "." || seg === "..") return undefined;
  return t;
}

/** Plain (non-file) terms must not look like paths or carry unsafe characters. */
function isSafePlain(term: string): boolean {
  return (
    term.length >= 2 &&
    term.length <= MAX_TERM_CHARS &&
    !term.includes("/") &&
    !term.includes("\\") &&
    !term.includes("..") &&
    !term.includes("\0") &&
    /[\p{L}\p{N}]/u.test(term)
  );
}

function isIdentifier(tok: string): boolean {
  if (tok.length < 4 || tok.length > 64) return false;
  const first = tok.charAt(0);
  if (!isLower(first) && !isUpper(first) && first !== "_") return false;
  let hasLetter = false;
  let underscoreInside = false;
  let upperAfterFirst = false;
  let lower = false;
  for (let i = 0; i < tok.length; i++) {
    const c = tok.charAt(i);
    if (isLower(c)) {
      hasLetter = true;
      lower = true;
    } else if (isUpper(c)) {
      hasLetter = true;
      if (i > 0) upperAfterFirst = true;
    } else if (c === "_" && i > 0 && i < tok.length - 1) underscoreInside = true;
  }
  if (!hasLetter) return false;
  if (underscoreInside) return true; // snake_case / SCREAMING_SNAKE
  if (isLower(first)) return upperAfterFirst; // camelCase
  return isUpper(first) && lower && upperAfterFirst; // PascalCase
}

interface Candidate {
  term: string;
  kind: TermKind;
  pos: number;
}

function sanitizeInput(s: string, max: number): { text: string; truncated: boolean } {
  const truncated = s.length > max;
  // cut first, then strip control chars; newlines/tabs become spaces
  const text = s.slice(0, max).replace(/[\n\r\t]/g, (m) => (m === "\t" ? " " : "\n")).replace(CONTROL_RE, " ");
  return { text, truncated };
}

/** Extract up to MAX_TERMS literal search terms from an issue title and body. */
export function extractTerms(input: { title?: string; body?: string | null }): TermExtraction {
  const t = sanitizeInput(typeof input.title === "string" ? input.title : "", MAX_TITLE_CHARS);
  const b = sanitizeInput(typeof input.body === "string" ? input.body : "", MAX_BODY_CHARS);
  const titleLen = t.text.length;
  const text = `${t.text}\n${b.text}`;
  const cands: Candidate[] = [];

  // 1+2: code spans (file-like spans count as file)
  for (const m of text.matchAll(CODE_SPAN_RE)) {
    const inner = (m[1] ?? "").trim().replace(/\s+/g, " ");
    const pos = m.index ?? 0;
    const file = asFileToken(inner);
    if (file) cands.push({ term: file, kind: "file", pos });
    else if (isSafePlain(inner) && !STOPWORDS.has(inner.toLowerCase())) cands.push({ term: inner, kind: "code", pos });
  }

  // 3: quoted error text
  for (const m of text.matchAll(QUOTE_RE)) {
    const inner = (m[1] ?? "").trim().replace(/\s+/g, " ");
    const pos = m.index ?? 0;
    if (inner.length >= 4 && isSafePlain(inner) && !STOPWORDS.has(inner.toLowerCase())) {
      cands.push({ term: inner, kind: "quote", pos });
    }
  }

  // 1: bare file-like tokens, 4: identifiers (single linear pass over whitespace/punct tokens)
  let offset = 0;
  for (const raw of text.split(SPLIT_TOKEN_RE)) {
    const pos = text.indexOf(raw, offset);
    if (raw.length === 0) continue;
    if (pos >= 0) offset = pos + raw.length;
    if (raw.length > MAX_TOKEN_CHARS) continue;
    const file = asFileToken(raw);
    if (file) {
      cands.push({ term: file, kind: "file", pos: Math.max(pos, 0) });
      continue;
    }
    for (const part of raw.split(NON_ALNUM_SPLIT_RE)) {
      if (isIdentifier(part) && !STOPWORDS.has(part.toLowerCase())) {
        cands.push({ term: part, kind: "identifier", pos: Math.max(pos, 0) });
      }
    }
  }

  // dedupe case-insensitively: best rank, then earliest position
  const best = new Map<string, Candidate>();
  for (const c of cands) {
    const key = c.term.toLowerCase();
    const cur = best.get(key);
    if (!cur || RANK[c.kind] < RANK[cur.kind] || (c.kind === cur.kind && c.pos < cur.pos)) best.set(key, c);
  }
  // An identifier already contained in a code-span term is redundant for literal search.
  const codeTerms = [...best.values()].filter((c) => c.kind === "code").map((c) => c.term.toLowerCase());
  const kept = [...best.values()].filter(
    (c) => c.kind !== "identifier" || !codeTerms.some((ct) => ct.includes(c.term.toLowerCase())),
  );
  const ordered = kept.sort(
    (a, z) => RANK[a.kind] - RANK[z.kind] || a.pos - z.pos || (a.term < z.term ? -1 : a.term > z.term ? 1 : 0),
  );
  const terms: ExtractedTerm[] = ordered.slice(0, MAX_TERMS).map((c) => ({
    term: c.term,
    kind: c.kind,
    field: c.pos < titleLen ? "title" : "body",
  }));
  return {
    terms,
    meta: {
      inputTruncated: t.truncated || b.truncated,
      candidates: ordered.length,
      truncated: ordered.length > MAX_TERMS,
    },
  };
}
