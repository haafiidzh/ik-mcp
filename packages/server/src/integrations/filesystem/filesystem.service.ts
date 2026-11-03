import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../../core/errors.js";
import { clampLimit, DEFAULT_LIMITS, type Limits } from "../../core/limits.js";
import { ok, type SuccessResult } from "../../core/response.js";
import { BINARY_SNIFF_BYTES, checkFileSize, sniffBinary } from "./binary-detect.js";
import { createBlockMatcher, isIgnoredPath } from "./blocked-patterns.js";
import { escapeName, escapeSegments } from "./escape-name.js";
import { createPathGuard, isInside, type PathGuard } from "./path-guard.js";

/**
 * Filesystem pack service (P1-02). Plain TypeScript, no MCP imports.
 * Every call takes a workspace id plus a relative path; the path guard runs first.
 * Blocked (doc 05 S5) and ignored entries never appear in list/search/tree output.
 * Walks never follow symlinks. Audit logging is left to the tool layer (doc 02 call flow).
 */

const SOURCE = "filesystem";
type EntryType = "file" | "dir" | "symlink" | "other";

export interface FsWorkspace {
  id: string;
  /** Absolute workspace root (already resolved by config). It is the containment root for every call. */
  rootPath: string;
}

export interface FilesystemServiceOptions {
  workspaces: readonly FsWorkspace[];
  blockedNames?: readonly string[];
  unblock?: readonly string[];
  ignoreDirs?: readonly string[];
  /** null/undefined = any text file. Entries with or without a leading dot, case-insensitive. */
  allowedExtensions?: readonly string[] | null;
  limits?: Partial<Limits>;
  /** Overall deadline for search walks. Defaults to limits.workflowTimeoutMs. */
  searchTimeoutMs?: number;
}

export interface ListEntry {
  name: string;
  type: EntryType;
  size?: number;
  mtime: string;
}
export interface FileInfo {
  name: string;
  relPath: string;
  type: EntryType;
  size: number;
  mtime: string;
  isText: boolean | null;
  extension: string;
}
export interface ReadData {
  content: string;
  encoding: "utf-8";
  lines: { start: number; end: number };
  totalLines: number | null;
  truncated: boolean;
}
export interface NameHit {
  relPath: string;
  type: EntryType;
  size: number;
}
export interface ContentHit {
  relPath: string;
  line: number;
  snippet: string;
}
export interface TreeNode {
  name: string;
  type: EntryType;
  children?: TreeNode[];
  /** True when a directory was not expanded because of the depth cap. */
  depthLimited?: boolean;
}
export interface TreeData {
  root: TreeNode;
  counts: { files: number; directories: number; symlinks: number };
}

export interface FilesystemService {
  listDirectory(workspace: string, relPath?: string, limit?: number): Promise<SuccessResult<ListEntry[]>>;
  getFileInfo(workspace: string, relPath: string): Promise<SuccessResult<FileInfo>>;
  readFile(workspace: string, relPath: string, startLine?: number, endLine?: number): Promise<SuccessResult<ReadData>>;
  searchFiles(workspace: string, pattern: string, relPath?: string, limit?: number): Promise<SuccessResult<NameHit[]>>;
  searchContent(
    workspace: string,
    query: string,
    opts?: { path?: string; caseSensitive?: boolean; extensions?: readonly string[]; limit?: number },
  ): Promise<SuccessResult<ContentHit[]>>;
  getDirectoryTree(workspace: string, relPath?: string, depth?: number): Promise<SuccessResult<TreeData>>;
}

function invalid(msg: string): AppError {
  return new AppError("INVALID_INPUT", msg);
}

function normExt(e: string): string {
  return e.trim().replace(/^\./, "").toLowerCase();
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

function typeOfDirent(d: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): EntryType {
  if (d.isSymbolicLink()) return "symlink";
  if (d.isDirectory()) return "dir";
  if (d.isFile()) return "file";
  return "other";
}

function osError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "EACCES" || code === "EPERM") return new AppError("PERMISSION_DENIED", "Access denied by the operating system.");
  if (code === "ENOENT" || code === "ENOTDIR") return new AppError("NOT_FOUND", "Path not found.");
  return new AppError("INTERNAL_ERROR", "Filesystem error.");
}

function requireString(v: unknown, what: string): string {
  if (typeof v !== "string" || v.trim().length === 0) throw invalid(`${what} must be a non-empty string.`);
  return v;
}

function optPositiveInt(v: number | undefined, what: string): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || v < 1) throw invalid(`${what} must be a positive integer.`);
  return v;
}

export async function createFilesystemService(options: FilesystemServiceOptions): Promise<FilesystemService> {
  const limits: Limits = { ...DEFAULT_LIMITS };
  // Overrides may only tighten defaults (doc 03 section 5); config already enforces it, re-clamp defensively.
  for (const k of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
    const v = options.limits?.[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) limits[k] = Math.min(Math.floor(v), DEFAULT_LIMITS[k]);
  }
  const ignoreDirs = options.ignoreDirs ?? [];
  const allowedExt = options.allowedExtensions ? new Set(options.allowedExtensions.map(normExt)) : null;
  const searchTimeoutMs = options.searchTimeoutMs ?? limits.workflowTimeoutMs;

  const blocklist = createBlockMatcher({ blockedNames: options.blockedNames, unblock: options.unblock });
  const wsIndex = new Map<string, number>();
  options.workspaces.forEach((w, i) => wsIndex.set(w.id, i));
  const guard: PathGuard = await createPathGuard(
    options.workspaces.map((w) => w.rootPath),
    blocklist,
  );

  const rootOf = (workspace: string): number => {
    const i = wsIndex.get(workspace);
    if (i === undefined) throw new AppError("NOT_FOUND", "Unknown workspace.");
    return i;
  };
  const extAllowed = (name: string): boolean => allowedExt === null || allowedExt.has(extOf(name));
  const hidden = (segs: readonly string[]): boolean => guard.isBlocked(segs) || isIgnoredPath(segs, ignoreDirs);

  const resolveDir = async (ws: number, rel: string | undefined) => {
    const r = await guard.resolve(rel ?? ".", ws);
    if (r.kind !== "directory") throw invalid("Path is not a directory.");
    if (isIgnoredPath(r.segments, ignoreDirs) && r.segments.length > 0) throw new AppError("NOT_FOUND", "Path not found.");
    return r;
  };

  interface Visit {
    relSegs: string[];
    name: string;
    type: EntryType;
    realDir: string;
  }

  /** Sorted, filtered children of a real directory. Blocked and ignored entries are dropped here. */
  async function children(realDir: string, relSegs: string[]): Promise<Visit[]> {
    let dirents;
    try {
      dirents = await readdir(realDir, { withFileTypes: true });
    } catch (err) {
      throw osError(err);
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const out: Visit[] = [];
    for (const d of dirents) {
      const segs = [...relSegs, d.name];
      if (hidden(segs)) continue;
      if (d.isFile()) {
        // B1: hard-linked regular files (nlink > 1) are hidden like blocked ones.
        const l = await lstat(path.join(realDir, d.name)).catch(() => null);
        if (l === null || l.nlink > 1) continue;
      }
      out.push({ relSegs: segs, name: d.name, type: typeOfDirent(d), realDir });
    }
    return out;
  }

  /** Symlinks may alias blocked targets; hide them when the target is blocked or outside. */
  async function symlinkVisible(ws: number, v: Visit): Promise<boolean> {
    const info = await guard.describeEntry(v.realDir, v.name, ws).catch(() => null);
    if (!info || info.targetInside !== true) return false;
    try {
      const root = guard.roots[ws] as string;
      const real = await realpath(path.join(v.realDir, v.name));
      const segs = path.relative(root, real).split(path.sep).filter((s) => s.length > 0);
      return isInside(root, real) && !hidden(segs);
    } catch {
      return false;
    }
  }

  interface WalkCtx {
    deadline: number;
    scanned: number;
    timedOut: boolean;
    scanCapped: boolean;
  }

  /** Depth-first, name-sorted walk. Symlinks are never followed or visited. Return false from visit to stop. */
  async function walk(
    ws: number,
    start: { realPath: string; segments: string[] },
    maxDepth: number,
    ctx: WalkCtx,
    visit: (v: Visit) => Promise<boolean>,
  ): Promise<boolean> {
    const rec = async (realDir: string, relSegs: string[], depth: number): Promise<boolean> => {
      if (Date.now() > ctx.deadline) {
        ctx.timedOut = true;
        return false;
      }
      let kids: Visit[];
      try {
        kids = await children(realDir, relSegs);
      } catch {
        return true; // unreadable directory: skip
      }
      for (const k of kids) {
        if (k.type === "symlink" || k.type === "other") continue;
        if (!(await visit(k))) return false;
        if (k.type === "dir" && depth < maxDepth) {
          if (!(await rec(path.join(realDir, k.name), k.relSegs, depth + 1))) return false;
        }
      }
      return true;
    };
    void ws;
    return rec(start.realPath, start.segments, 1);
  }

  const toIso = (d: Date): string => d.toISOString();

  async function sniffFile(ws: number, rel: string): Promise<{ binary: boolean; size: number; mtime: Date }> {
    const f = await guard.openFile(rel, ws);
    try {
      const buf = Buffer.alloc(Math.min(f.size, BINARY_SNIFF_BYTES));
      const { bytesRead } = await f.handle.read(buf, 0, buf.length, 0);
      const st = await f.handle.stat();
      return { binary: sniffBinary(buf.subarray(0, bytesRead)).binary, size: f.size, mtime: st.mtime };
    } finally {
      await f.handle.close().catch(() => undefined);
    }
  }

  return {
    async listDirectory(workspace, relPath, limit) {
      const ws = rootOf(workspace);
      const cap = clampLimit(optPositiveInt(limit, "limit"), limits.maxResults, limits.maxResults);
      const listCap = Math.min(cap, limits.maxResults);
      const dir = await resolveDir(ws, relPath);
      const kids = await children(dir.realPath, dir.relativePath === "" ? [] : dir.relativePath.split("/"));
      const entries: ListEntry[] = [];
      let truncated = false;
      for (const k of kids) {
        if (k.type === "file" && !extAllowed(k.name)) continue;
        if (k.type === "symlink" && !(await symlinkVisible(ws, k))) continue;
        if (entries.length >= listCap || entries.length >= limits.maxResults) {
          truncated = true;
          break;
        }
        let st;
        try {
          st = await lstat(path.join(k.realDir, k.name));
        } catch {
          continue;
        }
        const e: ListEntry = { name: escapeName(k.name), type: k.type, mtime: toIso(st.mtime) };
        if (k.type === "file") e.size = st.size;
        entries.push(e);
      }
      return ok(entries, { source: SOURCE, returnedCount: entries.length, truncated, partial: truncated, nextPageAvailable: false, limit: listCap });
    },

    async getFileInfo(workspace, relPath) {
      const ws = rootOf(workspace);
      const r = await guard.resolve(requireString(relPath, "path"), ws);
      if (isIgnoredPath(r.segments, ignoreDirs)) throw new AppError("NOT_FOUND", "Path not found.");
      const st = await lstat(r.realPath).catch((e: unknown) => {
        throw osError(e);
      });
      let isText: boolean | null = null;
      if (r.kind === "file") {
        const s = await sniffFile(ws, relPath);
        isText = !s.binary;
      }
      const name = r.relativePath === "" ? "." : (r.relativePath.split("/").pop() as string);
      const data: FileInfo = {
        name: escapeName(name),
        relPath: r.relativePath === "" ? "." : escapeSegments(r.relativePath.split("/")),
        type: r.kind === "file" ? "file" : r.kind === "directory" ? "dir" : "other",
        size: st.size,
        mtime: toIso(st.mtime),
        isText,
        extension: r.kind === "file" ? extOf(name) : "",
      };
      return ok(data, { source: SOURCE, returnedCount: 1 });
    },

    async readFile(workspace, relPath, startLine, endLine) {
      const ws = rootOf(workspace);
      requireString(relPath, "path");
      const start = optPositiveInt(startLine, "startLine");
      const end = optPositiveInt(endLine, "endLine");
      if (start !== undefined && end !== undefined && end < start) throw invalid("endLine must be >= startLine.");
      const f = await guard.openFile(relPath, ws);
      try {
        if (isIgnoredPath(f.resolved.segments, ignoreDirs)) throw new AppError("NOT_FOUND", "Path not found.");
        if (!extAllowed(path.basename(f.resolved.realPath))) {
          throw new AppError("PERMISSION_DENIED", "File extension is not allowed.");
        }
        const verdict = checkFileSize(f.size, limits.maxFileBytes);
        const buf = Buffer.alloc(verdict.readBytes);
        let got = 0;
        while (got < buf.length) {
          const { bytesRead } = await f.handle.read(buf, got, buf.length - got, got);
          if (bytesRead === 0) break;
          got += bytesRead;
        }
        const bytes = buf.subarray(0, got);
        if (sniffBinary(bytes).binary) throw new AppError("UNSUPPORTED", "Binary file not supported.");
        const warnings: string[] = [];
        let text: string;
        try {
          // stream:true holds back a code point split by the byte cap instead of failing on it.
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
        } catch {
          text = new TextDecoder("utf-8", { fatal: false }).decode(bytes, { stream: true });
          warnings.push("File is not valid UTF-8; invalid bytes were replaced.");
        }
        const lines = text.split("\n");
        if (lines.length > 1 && lines[lines.length - 1] === "" && !verdict.exceeds) lines.pop();
        const total = lines.length;
        const s = start ?? 1;
        const e = Math.min(end ?? total, total);
        const slice = s > total ? [] : lines.slice(s - 1, e);
        const content = slice.join("\n");
        if (verdict.exceeds) warnings.push(`File is ${verdict.size} bytes; only the first ${verdict.limit} bytes were read.`);
        const data: ReadData = {
          content,
          encoding: "utf-8",
          lines: { start: s, end: slice.length === 0 ? s - 1 : s + slice.length - 1 },
          totalLines: verdict.exceeds ? null : total,
          truncated: verdict.exceeds,
        };
        return ok(
          data,
          {
            source: SOURCE,
            returnedCount: slice.length,
            truncated: verdict.exceeds,
            partial: verdict.exceeds,
            limit: limits.maxFileBytes,
            sizeBytes: verdict.size,
          },
          warnings,
        );
      } finally {
        await f.handle.close().catch(() => undefined);
      }
    },

    async searchFiles(workspace, pattern, relPath, limit) {
      const ws = rootOf(workspace);
      const needle = requireString(pattern, "pattern").toLowerCase();
      if (needle.length > 255) throw invalid("pattern is too long.");
      const cap = clampLimit(optPositiveInt(limit, "limit"), limits.maxResults, limits.maxResults);
      const dir = await resolveDir(ws, relPath);
      const hits: NameHit[] = [];
      const ctx: WalkCtx = { deadline: Date.now() + searchTimeoutMs, scanned: 0, timedOut: false, scanCapped: false };
      let truncated = false;
      await walk(ws, { realPath: dir.realPath, segments: dir.relativePath === "" ? [] : dir.relativePath.split("/") }, limits.maxSearchDepth, ctx, async (v) => {
        if (++ctx.scanned > limits.maxFilesScanned) {
          ctx.scanCapped = true;
          return false;
        }
        if (v.type === "file" && !extAllowed(v.name)) return true;
        if (!v.name.toLowerCase().includes(needle)) return true;
        if (hits.length >= cap) {
          truncated = true;
          return false;
        }
        const st = await lstat(path.join(v.realDir, v.name)).catch(() => null);
        hits.push({ relPath: escapeSegments(v.relSegs), type: v.type, size: st?.size ?? 0 });
        return true;
      });
      const warnings: string[] = [];
      if (ctx.timedOut) warnings.push("Search stopped at the time limit; results are partial.");
      if (ctx.scanCapped) warnings.push(`Search stopped after scanning ${limits.maxFilesScanned} entries; results are partial.`);
      const partial = truncated || ctx.timedOut || ctx.scanCapped;
      return ok(hits, { source: SOURCE, returnedCount: hits.length, truncated: partial, partial, limit: cap }, warnings);
    },

    async searchContent(workspace, query, opts = {}) {
      const ws = rootOf(workspace);
      requireString(query, "query");
      if (query.length > 500) throw invalid("query is too long.");
      if (query.includes("\n") || query.includes("\0")) throw invalid("query must be a single line of text.");
      const caseSensitive = opts.caseSensitive === true;
      const needle = caseSensitive ? query : query.toLowerCase();
      const exts = opts.extensions ? new Set(opts.extensions.map(normExt)) : null;
      const cap = clampLimit(optPositiveInt(opts.limit, "limit"), limits.maxResults, limits.maxResults);
      const dir = await resolveDir(ws, opts.path);
      const hits: ContentHit[] = [];
      const ctx: WalkCtx = { deadline: Date.now() + searchTimeoutMs, scanned: 0, timedOut: false, scanCapped: false };
      let truncated = false;
      let skippedBinary = 0;
      let skippedUnreadable = 0;
      let oversize = 0;

      await walk(ws, { realPath: dir.realPath, segments: dir.relativePath === "" ? [] : dir.relativePath.split("/") }, limits.maxSearchDepth, ctx, async (v) => {
        if (v.type !== "file") return true;
        const ext = extOf(v.name);
        if (!extAllowed(v.name) || (exts !== null && !exts.has(ext))) return true;
        if (++ctx.scanned > limits.maxFilesScanned) {
          ctx.scanCapped = true;
          return false;
        }
        if (Date.now() > ctx.deadline) {
          ctx.timedOut = true;
          return false;
        }
        let f;
        try {
          f = await guard.openFile(v.relSegs.join("/"), ws);
        } catch {
          skippedUnreadable++;
          return true;
        }
        try {
          const verdict = checkFileSize(f.size, limits.maxFileBytes);
          if (verdict.exceeds) oversize++;
          const buf = Buffer.alloc(verdict.readBytes);
          let got = 0;
          while (got < buf.length) {
            const { bytesRead } = await f.handle.read(buf, got, buf.length - got, got);
            if (bytesRead === 0) break;
            got += bytesRead;
          }
          const bytes = buf.subarray(0, got);
          if (sniffBinary(bytes).binary) {
            skippedBinary++;
            return true;
          }
          const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes, { stream: true });
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const raw = (lines[i] as string).replace(/\r$/, "");
            const hay = caseSensitive ? raw : raw.toLowerCase();
            const at = hay.indexOf(needle);
            if (at < 0) continue;
            if (hits.length >= cap) {
              truncated = true;
              return false;
            }
            hits.push({ relPath: escapeSegments(f.resolved.relativePath.split("/")), line: i + 1, snippet: snippet(raw, at, needle.length, limits.maxSnippetChars) });
          }
          return true;
        } catch {
          skippedUnreadable++;
          return true;
        } finally {
          await f.handle.close().catch(() => undefined);
        }
      });

      const warnings: string[] = [];
      if (ctx.timedOut) warnings.push("Search stopped at the time limit; results are partial.");
      if (ctx.scanCapped) warnings.push(`Search stopped after scanning ${limits.maxFilesScanned} files; results are partial.`);
      if (oversize > 0) warnings.push(`${oversize} file(s) larger than ${limits.maxFileBytes} bytes were searched only in their first ${limits.maxFileBytes} bytes.`);
      if (skippedBinary > 0) warnings.push(`${skippedBinary} binary file(s) skipped.`);
      if (skippedUnreadable > 0) warnings.push(`${skippedUnreadable} unreadable file(s) skipped.`);
      const partial = truncated || ctx.timedOut || ctx.scanCapped || oversize > 0;
      return ok(
        hits,
        { source: SOURCE, returnedCount: hits.length, truncated: truncated || ctx.timedOut || ctx.scanCapped, partial, limit: cap, filesScanned: Math.min(ctx.scanned, limits.maxFilesScanned) },
        warnings,
      );
    },

    async getDirectoryTree(workspace, relPath, depth) {
      const ws = rootOf(workspace);
      const maxDepth = clampLimit(optPositiveInt(depth, "depth"), limits.maxTreeDepth, limits.maxTreeDepth);
      const dir = await resolveDir(ws, relPath);
      const startSegs = dir.relativePath === "" ? [] : dir.relativePath.split("/");
      const counts = { files: 0, directories: 0, symlinks: 0 };
      let entries = 0;
      let truncated = false;
      const rootNode: TreeNode = { name: startSegs.length === 0 ? "." : escapeName(startSegs[startSegs.length - 1] as string), type: "dir", children: [] };

      const build = async (node: TreeNode, realDir: string, segs: string[], level: number): Promise<void> => {
        let kids: Visit[];
        try {
          kids = await children(realDir, segs);
        } catch {
          return;
        }
        for (const k of kids) {
          if (k.type === "file" && !extAllowed(k.name)) continue;
          if (k.type === "symlink" && !(await symlinkVisible(ws, k))) continue;
          if (k.type === "other") continue;
          if (entries >= limits.maxTreeEntries) {
            truncated = true;
            return;
          }
          entries++;
          const child: TreeNode = { name: escapeName(k.name), type: k.type };
          (node.children as TreeNode[]).push(child);
          if (k.type === "file") counts.files++;
          else if (k.type === "symlink") counts.symlinks++;
          else {
            counts.directories++;
            if (level < maxDepth) {
              child.children = [];
              await build(child, path.join(realDir, k.name), k.relSegs, level + 1);
              if (truncated) return;
            } else {
              child.depthLimited = true;
            }
          }
        }
      };
      await build(rootNode, dir.realPath, startSegs, 1);
      return ok({ root: rootNode, counts }, { source: SOURCE, returnedCount: entries, truncated, partial: truncated, limit: limits.maxTreeEntries, maxDepth });
    },
  };
}

function snippet(line: string, at: number, len: number, max: number): string {
  if (line.length <= max) return line;
  const room = Math.max(0, max - len);
  let from = Math.max(0, at - Math.floor(room / 2));
  const to = Math.min(line.length, from + max);
  from = Math.max(0, to - max);
  return (from > 0 ? "…" : "") + line.slice(from, to) + (to < line.length ? "…" : "");
}
