import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../../core/errors.js";
import type { BlockMatcher } from "./blocked-patterns.js";

/**
 * Path guard (doc 05 section 2). Pure node:fs/node:path; no MCP imports.
 * Error messages never contain absolute paths or the user's raw input.
 *
 * Decisions:
 * - Percent-encoded input is NOT decoded; `%2e`, `%2f`, `%5c`, `%00` (any case) are rejected (S2).
 * - Case-insensitive containment compare only on win32/darwin (default volumes there are
 *   case-insensitive); exact compare on Linux. Blocked-name matching is always case-insensitive.
 * - Roots are realpath'd once at creation: a root that is itself a symlink is accepted
 *   (the operator chose it) and the boundary is its real target.
 * - Regular files with nlink > 1 are refused (hard-link escape, B1) in resolve() and on the opened handle.
 * - TOCTOU: residual risk remains between resolve() and a later open by path. openFile()
 *   narrows it: O_NOFOLLOW open, fstat identity check against the earlier stat, and a
 *   second realpath containment check. A hostile local process that swaps path components
 *   concurrently can still win a tiny window; accepted (local, read-only server).
 */

export const MAX_PATH_CHARS = 1024;
export const MAX_SEGMENT_CHARS = 255;

const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";
const ENCODED_TRAVERSAL = /%(2e|2f|5c|00)/i;

function invalid(msg: string): AppError {
  return new AppError("INVALID_INPUT", msg);
}

/** Validate a user path and return normalized segments ([] for the root). Throws INVALID_INPUT. */
export function parseRelativePath(input: unknown): string[] {
  if (typeof input !== "string") throw invalid("Path must be a string.");
  if (input.trim().length === 0) throw invalid("Path must not be empty.");
  if (input.length > MAX_PATH_CHARS) throw invalid(`Path exceeds ${MAX_PATH_CHARS} characters.`);
  if (/[\u0000-\u001f\u007f]/.test(input)) throw invalid("Path contains control or NUL characters.");
  if (input.includes("\\")) throw invalid("Backslashes are not allowed in paths.");
  if (input.includes(":")) throw invalid("Drive letters and stream names are not allowed in paths.");
  if (ENCODED_TRAVERSAL.test(input)) throw invalid("Encoded path separators or traversal are not allowed.");
  if (input.startsWith("/")) throw invalid("Absolute paths are not allowed; use a path relative to the workspace root.");
  if (input.startsWith("~")) throw invalid("Home-relative paths are not allowed.");

  const segments: string[] = [];
  for (const seg of input.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw invalid("Parent directory segments are not allowed.");
    if (/^\.+$/.test(seg)) throw invalid("Invalid path segment.");
    if (seg.length > MAX_SEGMENT_CHARS) throw invalid(`Path segment exceeds ${MAX_SEGMENT_CHARS} characters.`);
    segments.push(seg);
  }
  return segments;
}

function fold(p: string): string {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

/** True when `target` is `root` or below it. Both must be absolute and normalized (realpath output). */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(fold(root), fold(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export type EntryKind = "file" | "directory" | "symlink" | "other";

export interface ResolvedPath {
  rootIndex: number;
  /** Real absolute root. Internal use only; never put in messages or results. */
  rootReal: string;
  /** Real absolute target. Internal use only. */
  realPath: string;
  /** POSIX-style path of the real target relative to the root ("" = root). Safe to return. */
  relativePath: string;
  segments: string[];
  kind: "file" | "directory" | "other";
  dev: number;
  ino: number;
}

export interface EntryInfo {
  kind: EntryKind;
  /** For symlinks: whether the target resolves inside the root (null for non-symlinks). */
  targetInside: boolean | null;
}

export interface OpenedFile {
  handle: FileHandle;
  size: number;
  resolved: ResolvedPath;
}

export interface PathGuard {
  readonly roots: readonly string[];
  resolve(userPath: string, rootIndex?: number): Promise<ResolvedPath>;
  /** Classify a directory entry WITHOUT following symlinks (walks must not descend into `symlink`). */
  describeEntry(dirRealPath: string, name: string, rootIndex?: number): Promise<EntryInfo>;
  /** Resolve, open (O_NOFOLLOW) and re-verify. Caller must close `handle`. */
  openFile(userPath: string, rootIndex?: number): Promise<OpenedFile>;
  /** Whether segments of a real relative path are blocked (for filtering list/search/tree output). */
  isBlocked(segments: readonly string[]): boolean;
}

function mapFsError(err: unknown): AppError {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  switch (code) {
    case "ENOENT":
    case "ENOTDIR":
      return new AppError("NOT_FOUND", "Path not found.");
    case "ELOOP":
      return new AppError("INVALID_INPUT", "Too many levels of symbolic links (possible loop).");
    case "EACCES":
    case "EPERM":
      return new AppError("PERMISSION_DENIED", "Access to the path is denied by the operating system.");
    case "ENAMETOOLONG":
      return invalid("Path is too long.");
    default:
      return new AppError("INTERNAL_ERROR", "Filesystem error.");
  }
}

const HARDLINK_MSG = "File has multiple hard links and is refused by policy.";

function denied(msg: string): AppError {
  return new AppError("PERMISSION_DENIED", msg);
}

export async function createPathGuard(allowedRoots: readonly string[], blocklist: BlockMatcher): Promise<PathGuard> {
  if (allowedRoots.length === 0) throw new AppError("INTEGRATION_UNAVAILABLE", "No allowed filesystem roots configured.");
  const roots: string[] = [];
  for (const r of allowedRoots) {
    if (!path.isAbsolute(r)) throw new AppError("INTEGRATION_UNAVAILABLE", "Allowed roots must be absolute (resolve config first).");
    try {
      const real = await realpath(r);
      if (!(await stat(real)).isDirectory()) throw new AppError("INTEGRATION_UNAVAILABLE", "Allowed root is not a directory.");
      roots.push(real);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError("INTEGRATION_UNAVAILABLE", "Allowed root is not accessible.");
    }
  }

  const rootAt = (i: number): string => {
    const r = roots[i];
    if (r === undefined) throw invalid("Unknown root.");
    return r;
  };

  const relSegments = (root: string, real: string): string[] =>
    path.relative(root, real).split(path.sep).filter((s) => s.length > 0);

  const resolve = async (userPath: string, rootIndex = 0): Promise<ResolvedPath> => {
    const rootReal = rootAt(rootIndex);
    const segments = parseRelativePath(userPath);
    if (blocklist.isBlocked(segments)) throw denied("Path is blocked by the sensitive-file policy.");

    let real: string;
    try {
      real = await realpath(path.join(rootReal, ...segments));
    } catch (err) {
      throw mapFsError(err);
    }
    if (!isInside(rootReal, real)) throw denied("Path resolves outside the allowed root.");
    const realSegs = relSegments(rootReal, real);
    // A harmless-looking symlink name may point at a sensitive file.
    if (blocklist.isBlocked(realSegs)) throw denied("Path is blocked by the sensitive-file policy.");

    let st;
    try {
      st = await stat(real);
    } catch (err) {
      throw mapFsError(err);
    }
    // B1: a hard link may alias a file outside the root and realpath cannot see it. Refuse every
    // regular file with more than one link (also refuses legitimate in-root hard links).
    if (st.isFile() && st.nlink > 1) throw denied(HARDLINK_MSG);
    return {
      rootIndex,
      rootReal,
      realPath: real,
      relativePath: realSegs.join("/"),
      segments,
      kind: st.isFile() ? "file" : st.isDirectory() ? "directory" : "other",
      dev: st.dev,
      ino: st.ino,
    };
  };

  const describeEntry = async (dirRealPath: string, name: string, rootIndex = 0): Promise<EntryInfo> => {
    const rootReal = rootAt(rootIndex);
    if (name.includes("/") || name.includes("\\") || name === ".." || name === "." || name.includes("\0")) {
      throw invalid("Invalid entry name.");
    }
    if (!isInside(rootReal, dirRealPath)) throw denied("Directory is outside the allowed root.");
    const full = path.join(dirRealPath, name);
    let l;
    try {
      l = await lstat(full);
    } catch (err) {
      throw mapFsError(err);
    }
    if (l.isSymbolicLink()) {
      try {
        return { kind: "symlink", targetInside: isInside(rootReal, await realpath(full)) };
      } catch {
        return { kind: "symlink", targetInside: false }; // broken or looping: treat as not followable
      }
    }
    return { kind: l.isFile() ? "file" : l.isDirectory() ? "directory" : "other", targetInside: null };
  };

  const openFile = async (userPath: string, rootIndex = 0): Promise<OpenedFile> => {
    const resolved = await resolve(userPath, rootIndex);
    if (resolved.kind !== "file") throw new AppError("INVALID_INPUT", "Path is not a regular file.");
    // O_NOFOLLOW is undefined on Windows; the realpath re-check below still applies.
    const noFollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    let handle: FileHandle;
    try {
      handle = await open(resolved.realPath, fsConstants.O_RDONLY | noFollow);
    } catch (err) {
      throw mapFsError(err);
    }
    try {
      const st = await handle.stat();
      if (!st.isFile()) throw new AppError("INVALID_INPUT", "Path is not a regular file.");
      if (st.nlink > 1) throw denied(HARDLINK_MSG);
      if (st.ino !== resolved.ino || st.dev !== resolved.dev) throw denied("File changed during access.");
      const again = await realpath(resolved.realPath).catch((e: unknown) => {
        throw mapFsError(e);
      });
      if (again !== resolved.realPath || !isInside(resolved.rootReal, again)) throw denied("File changed during access.");
      return { handle, size: st.size, resolved };
    } catch (err) {
      await handle.close().catch(() => undefined);
      throw err;
    }
  };

  return { roots, resolve, describeEntry, openFile, isBlocked: (s) => blocklist.isBlocked(s) };
}
