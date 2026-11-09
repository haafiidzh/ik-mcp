/**
 * Source attribution for workflow sections (doc 04 section 5).
 * `ref` is a configured NAME (workspace id, owner/repo, connection, profile),
 * never a host path or URL.
 */
export const SOURCE_KINDS = ["filesystem", "github", "database", "api"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface SourceRef {
  kind: SourceKind;
  ref: string;
}

const MAX_REF = 200;
/** Configured names only: letters, digits and . _ - (one "/" allowed for github owner/repo). */
const SAFE_REF_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/;

function make(kind: SourceKind, ref: string): SourceRef {
  const ok =
    ref.length > 0 &&
    ref.length <= MAX_REF &&
    SAFE_REF_RE.test(ref) &&
    !ref.includes("..") &&
    (kind === "github" || !ref.includes("/"));
  // Unsafe or unknown names are replaced rather than echoed (they may be paths or URLs).
  return { kind, ref: ok ? ref : "invalid-ref" };
}

export const filesystemSource = (workspaceId: string): SourceRef => make("filesystem", workspaceId);
export const githubSource = (owner: string, repo: string): SourceRef => make("github", `${owner}/${repo}`);
/** Neutral placeholder when no repository is linked (never a real owner/repo: those always contain "/"). */
export const githubNoRepoSource = (): SourceRef => ({ kind: "github", ref: "no-repo" });
export const databaseSource = (connection: string): SourceRef => make("database", connection);
export const apiSource = (profile: string): SourceRef => make("api", profile);

/** Display form `kind:ref`, e.g. `github:acme/widgets`. */
export function formatSourceRef(source: SourceRef): string {
  return `${source.kind}:${source.ref}`;
}
