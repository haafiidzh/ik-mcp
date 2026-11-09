/**
 * SQLite runner: executes ONE statement at a time for sqlite.adapter.ts inside a
 * separate child process (QA-03 F1, implementation-notes "P2-07").
 *
 * Why a process and not a worker thread: better-sqlite3 runs sqlite3_step()
 * synchronously and exposes no interrupt. Worker.terminate() cannot preempt a
 * native call (verified: the thread keeps spinning and blocks process exit),
 * whereas SIGKILL on a child process always works.
 *
 * Self-contained on purpose: it is loaded as `.js` from dist and as `.ts`
 * (Node type stripping) under tsx/vitest, so it imports only better-sqlite3
 * and node: built-ins, and uses `import type` for types. It must never write to
 * stdout/stderr (the parent starts it with stdio ignored; results travel over
 * IPC only) and never exposes the database path in error text.
 *
 * Defense in depth: the same open hardening as the adapter (readonly,
 * fileMustExist, query_only, trusted_schema OFF, stmt.reader && stmt.readonly).
 * A watchdog thread kills this process if the parent disappears or a request
 * overruns its deadline by more than a grace period, so an orphaned runaway
 * query cannot keep burning CPU.
 */
import { statSync } from "node:fs";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";

interface RunRequest {
  id: number;
  op: "query" | "explain";
  databasePath: string;
  sql: string;
  maxRows: number;
  maxCellChars: number;
  timeoutMs: number;
}

type RunError =
  | { kind: "app"; code: string; message: string }
  | { kind: "driver"; code: string; message: string }
  | { kind: "type"; message: string }
  | { kind: "other" };

const TRUNCATION_MARK = "…";
const BUSY_TIMEOUT_MS = 1000;
const WATCHDOG_GRACE_MS = 1500;

const WATCHDOG_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
let deadline = 0;
parentPort.on("message", (ms) => { deadline = ms === 0 ? 0 : Date.now() + ms; });
setInterval(() => {
  let alive = true;
  try { process.kill(workerData.ppid, 0); } catch { alive = false; }
  if (!alive || (deadline !== 0 && Date.now() > deadline)) process.kill(process.pid, "SIGKILL");
}, 250);
`;

class RunnerAppError extends Error {
  readonly appCode: string;
  constructor(appCode: string, message: string) {
    super(message);
    this.appCode = appCode;
  }
}

let db: Database.Database | undefined;
let openedPath: string | undefined;

function open(databasePath: string): Database.Database {
  if (db !== undefined && openedPath === databasePath && db.open) return db;
  try {
    if (typeof databasePath !== "string" || databasePath.length === 0 || databasePath === ":memory:" || databasePath.includes("\u0000") || /^file:/i.test(databasePath)) {
      throw new Error("bad path");
    }
    if (!statSync(databasePath).isFile()) throw new Error("not a regular file");
    const conn = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: BUSY_TIMEOUT_MS });
    try {
      conn.pragma("query_only = ON");
      conn.pragma("trusted_schema = OFF");
    } catch (e) {
      conn.close();
      throw e;
    }
    db = conn;
    openedPath = databasePath;
    return conn;
  } catch {
    throw new RunnerAppError("INTEGRATION_UNAVAILABLE", "SQLite database could not be opened.");
  }
}

function convertCell(value: unknown, maxCellChars: number, flags: { cut: boolean }): unknown {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "number":
      return value;
    case "bigint":
      return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
    case "string":
      if (value.length > maxCellChars) {
        flags.cut = true;
        return `${value.slice(0, Math.max(0, maxCellChars - 1))}${TRUNCATION_MARK}`;
      }
      return value;
    default:
      if (value instanceof Uint8Array) return `<binary ${value.byteLength} bytes>`;
      return `<unsupported ${typeof value}>`;
  }
}

function runQuery(conn: Database.Database, req: RunRequest): unknown {
  const stmt = conn.prepare(req.sql);
  if (!stmt.reader || !stmt.readonly) throw new RunnerAppError("QUERY_REJECTED", "Query rejected: only read-only statements can run.");
  stmt.raw(true).safeIntegers(true);
  const columns = stmt.columns().map((c) => c.name);
  const rows: unknown[][] = [];
  let truncated = false;
  const flags = { cut: false };
  const iterator = stmt.iterate() as IterableIterator<unknown>;
  try {
    for (;;) {
      const step = iterator.next();
      if (step.done === true) break;
      if (rows.length >= req.maxRows) {
        truncated = true;
        break;
      }
      const row = step.value;
      if (!Array.isArray(row)) throw new RunnerAppError("INTERNAL_ERROR", "Unexpected row shape from the database.");
      rows.push(row.map((cell) => convertCell(cell, req.maxCellChars, flags)));
    }
  } finally {
    iterator.return?.();
  }
  return { columns, rows, rowCount: rows.length, truncated, cellsTruncated: flags.cut };
}

function runExplain(conn: Database.Database, req: RunRequest): unknown {
  const stmt = conn.prepare(`EXPLAIN QUERY PLAN\n${req.sql}`);
  if (!stmt.reader || !stmt.readonly) throw new RunnerAppError("QUERY_REJECTED", "Query rejected: only read-only statements can run.");
  stmt.raw(true);
  const rows = stmt.all() as unknown[][];
  if (rows.length > 500) throw new RunnerAppError("LIMIT_EXCEEDED", "The query plan is too large to return.");
  const depth = new Map<number, number>([[0, -1]]);
  const lines: string[] = [];
  for (const r of rows) {
    const id = Number(r[0]);
    const parent = Number(r[1]);
    const detail = typeof r[3] === "string" ? r[3] : "";
    const level = (depth.get(parent) ?? -1) + 1;
    depth.set(id, level);
    lines.push(`${"  ".repeat(level)}${detail}`);
  }
  return { plan: lines.join("\n") };
}

function describeError(e: unknown): RunError {
  if (e instanceof RunnerAppError) return { kind: "app", code: e.appCode, message: e.message };
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    if (e.name === "SqliteError" && typeof code === "string") return { kind: "driver", code, message: e.message };
    if (e instanceof TypeError || e instanceof RangeError) return { kind: "type", message: e.message };
  }
  return { kind: "other" };
}

if (typeof process.send === "function" && typeof process.ppid === "number") {
  const watchdog = new Worker(WATCHDOG_SOURCE, { eval: true, workerData: { ppid: process.ppid } });
  watchdog.unref();
  process.on("disconnect", () => process.exit(0));
  process.on("message", (raw: unknown) => {
    const req = raw as RunRequest;
    watchdog.postMessage(req.timeoutMs + WATCHDOG_GRACE_MS);
    let reply: { id: number; ok: true; result: unknown } | { id: number; ok: false; error: RunError };
    try {
      const conn = open(req.databasePath);
      reply = { id: req.id, ok: true, result: req.op === "query" ? runQuery(conn, req) : runExplain(conn, req) };
    } catch (e) {
      reply = { id: req.id, ok: false, error: describeError(e) };
    }
    watchdog.postMessage(0);
    process.send?.(reply);
  });
  // Tells the parent the process is up, so process start-up never counts against the query deadline.
  process.send({ ready: true });
}
