/**
 * Blocked-name and ignore-dir matching (doc 05 section 2, step 5). Pure: no I/O.
 *
 * Matching is case-insensitive on every platform (deliberate over-blocking: a
 * file named ".ENV" is treated as a secret file even on case-sensitive Linux).
 * Patterns support `*` (any run of characters except `/`). A pattern containing
 * `/` is matched against consecutive path segments (e.g. ".docker/config.json").
 * Every pattern is applied to EVERY segment of a path (so a blocked directory
 * hides its whole subtree) and thus also to the basename.
 *
 * Backup/editor variants (B2): each segment is also tested after stripping trailing `~`,
 * `#name#` wrappers, vim-style `.name.swp` and backup suffixes (.bak .orig .old .swp ...),
 * repeatedly. So `.env~`, `.env.bak`, `id_rsa~`, `x.pem.bak`, `#.env#`, `.x.pem.swp` are blocked
 * whenever the plain name is blocked, for built-in and configured patterns alike.
 */

const BACKUP_SUFFIX = /\.(bak|backup|orig|old|save|swp|swo|swx|tmp|temp|copy|rej)$/i;

/** The segment itself plus every name obtained by stripping backup/editor decorations. */
export function nameVariants(seg: string): string[] {
  const out = new Set<string>([seg]);
  let cur = seg;
  for (let i = 0; i < 8; i++) {
    let next = cur;
    if (next.length > 1 && next.endsWith("~")) next = next.slice(0, -1);
    else if (next.length > 2 && next.startsWith("#") && next.endsWith("#")) next = next.slice(1, -1);
    else if (BACKUP_SUFFIX.test(next) && next.replace(BACKUP_SUFFIX, "").length > 0) {
      const swap = /\.(swp|swo|swx)$/i.test(next);
      next = next.replace(BACKUP_SUFFIX, "");
      // vim swap files are ".<name>.swp": also try the name without the leading dot added by the editor.
      if (swap && next.startsWith(".") && next.length > 1) out.add(next.slice(1));
    } else break;
    if (next.length === 0) break;
    out.add(next);
    cur = next;
  }
  return [...out];
}

interface BuiltIn {
  pattern: string;
  /** Concrete names (case-insensitive) that the pattern does not block. */
  except?: readonly string[];
}

export const BUILTIN_BLOCKED: readonly BuiltIn[] = [
  { pattern: ".env" },
  { pattern: ".env.*", except: [".env.example"] },
  { pattern: "*.pem" },
  { pattern: "*.key" },
  { pattern: "*.p12" },
  { pattern: "*.pfx" },
  { pattern: "id_rsa*" },
  { pattern: "id_ed25519*" },
  { pattern: "id_ecdsa*" },
  { pattern: "*.kdbx" },
  { pattern: ".npmrc" },
  { pattern: ".pypirc" },
  { pattern: ".netrc" },
  { pattern: ".git-credentials" },
  { pattern: ".aws" },
  { pattern: ".ssh" },
  { pattern: ".gnupg" },
  { pattern: ".git" },
  { pattern: ".docker/config.json" },
  { pattern: "credentials*.json" },
  { pattern: "*secret*" },
];

interface CompiledPattern {
  source: string;
  parts: RegExp[];
  except: readonly string[];
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${escaped}$`, "i");
}

function compile(source: string, except: readonly string[] = []): CompiledPattern {
  const parts = source
    .split("/")
    .filter((p) => p.length > 0)
    .map(globToRegExp);
  return { source, parts, except: except.map((e) => e.toLowerCase()) };
}

export interface BlockOptions {
  /** Config `filesystem.blockedNames`: merged with the built-in list. */
  blockedNames?: readonly string[];
  /**
   * Config `filesystem.unblock`: deliberate operator exceptions. An entry that
   * equals an active pattern (case-insensitive) removes that pattern; any entry
   * also exempts a path segment with exactly that name from every pattern.
   */
  unblock?: readonly string[];
}

export interface BlockMatcher {
  /** Returns the matching pattern, or null when the segments are allowed. */
  match(segments: readonly string[]): string | null;
  isBlocked(segments: readonly string[]): boolean;
  /** Entries of `unblock` for operator-visible startup logging. */
  readonly unblocked: readonly string[];
}

export function createBlockMatcher(options: BlockOptions = {}): BlockMatcher {
  const unblock = (options.unblock ?? []).map((u) => u.trim().toLowerCase()).filter((u) => u.length > 0);
  const unblockSet = new Set(unblock);
  const compiled: CompiledPattern[] = [
    ...BUILTIN_BLOCKED.map((b) => compile(b.pattern, b.except)),
    ...(options.blockedNames ?? []).map((n) => n.trim()).filter((n) => n.length > 0).map((n) => compile(n)),
  ].filter((p) => !unblockSet.has(p.source.toLowerCase()));

  const match = (segments: readonly string[]): string | null => {
    for (const p of compiled) {
      const n = p.parts.length;
      if (n === 0) continue;
      for (let i = 0; i + n <= segments.length; i++) {
        let ok = true;
        for (let j = 0; j < n; j++) {
          const seg = segments[i + j] ?? "";
          const hit = nameVariants(seg).some((v) => {
            const lower = v.toLowerCase();
            return !unblockSet.has(lower) && !p.except.includes(lower) && (p.parts[j] as RegExp).test(v);
          });
          if (!hit) {
            ok = false;
            break;
          }
        }
        if (ok) return p.source;
      }
    }
    return null;
  };

  return { match, isBlocked: (s) => match(s) !== null, unblocked: unblock };
}

/** Ignore dirs (config `ignoreDirs`): exact segment names, skipped by tree/search walks. Not a security control. */
export function isIgnoredPath(segments: readonly string[], ignoreDirs: readonly string[]): boolean {
  const set = new Set(ignoreDirs.map((d) => d.toLowerCase()));
  return segments.some((s) => set.has(s.toLowerCase()));
}
