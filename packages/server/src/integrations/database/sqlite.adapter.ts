import { fork, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { AppError } from "../../core/errors.js";
import { DEFAULT_LIMITS } from "../../core/limits.js";
import type {
  CatalogPage,
  ColumnInfo,
  ConnectionInfo,
  DatabaseAdapter,
  ExplainResult,
  ForeignKeyInfo,
  QueryOptions,
  QueryResult,
  RelationshipInfo,
  TableDescription,
  TableRef,
} from "./database.types.js";
import type { AdapterFactory } from "./database.registry.js";

/**
 * SQLite adapter (doc 05 section 3 step 3, ADR-050). Layer 2 of the read-only
 * defense, independent of sql-guard:
 *  - the file is opened with `readonly: true` + `fileMustExist: true` from the
 *    configured `databasePath` only (never from tool arguments);
 *  - `PRAGMA query_only = ON` and `PRAGMA trusted_schema = OFF`; better-sqlite3
 *    never enables extension loading for SQL (`load_extension()` fails) and we
 *    never call `loadExtension`;
 *  - a statement must be a read-only reader (`sqlite3_stmt_readonly`) and a
 *    single statement (better-sqlite3 refuses several), so ATTACH, PRAGMA writes
 *    and DML are refused before execution even if the guard were bypassed.
 *
 * TIMEOUT (S9, QA-03 F1): better-sqlite3 is synchronous and has no interrupt,
 * and Worker.terminate() cannot preempt a native step. query/explain therefore
 * run in a child process (sqlite.runner.ts) that this adapter SIGKILLs on
 * timeout or abort and recreates lazily. The catalog helpers stay in-process
 * (fixed, bounded statements). See implementation-notes "P2-07".
 *
 * Errors never carry the database path: open failures use fixed text, driver
 * messages are scrubbed of the path and length-capped.
 */

/** Hard bound on catalog listings (tables, relationships); exceeding it is LIMIT_EXCEEDED, never silent truncation. */
export const MAX_CATALOG_ENTRIES = 1000;

const MAX_ERROR_MESSAGE_CHARS = 200;
const BUSY_TIMEOUT_MS = 1000;
const TRUNCATION_MARK = "…";
const EXPLAIN_TIMEOUT_MS = 5000;
const RUNNER_START_TIMEOUT_MS = 10_000;

export interface SqliteConnection extends ConnectionInfo {
  type: "sqlite";
  /** Already resolved by config; never taken from tool arguments. */
  databasePath: string;
}

export interface SqliteAdapterOptions {
  /** Cell text longer than this is cut (doc 05 step 4). Default: limits.maxCellChars. */
  maxCellChars?: number;
  /** Override for the catalog bound (tests). */
  maxCatalogEntries?: number;
}

type Db = Database.Database;

/**
 * Open the configured file read-only. Exported so the S8 tests can attack the
 * exact connection the adapter uses without going through any SQL checks.
 * Throws AppError with fixed text (no path).
 */
export function openSqliteReadOnly(databasePath: string): Db {
  if (
    typeof databasePath !== "string" ||
    databasePath.length === 0 ||
    databasePath.includes("\u0000") ||
    databasePath === ":memory:" ||
    /^file:/i.test(databasePath)
  ) {
    throw new AppError("INTEGRATION_UNAVAILABLE", "SQLite database could not be opened.");
  }
  try {
    if (!statSync(databasePath).isFile()) throw new Error("not a regular file");
    const db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: BUSY_TIMEOUT_MS });
    try {
      db.pragma("query_only = ON");
      db.pragma("trusted_schema = OFF");
      // Force a real read so a non-database file fails here, not on the first tool call.
      db.prepare("SELECT count(*) FROM sqlite_schema").get();
    } catch (e) {
      db.close();
      throw e;
    }
    return db;
  } catch (e) {
    throw new AppError("INTEGRATION_UNAVAILABLE", "SQLite database could not be opened.", { cause: e });
  }
}

interface DriverErrorLike {
  code: string;
  message: string;
}

function isDriverError(e: unknown): e is DriverErrorLike {
  return (
    e instanceof Error &&
    e.name === "SqliteError" &&
    typeof (e as { code?: unknown }).code === "string"
  );
}

function scrub(message: string, databasePath: string): string {
  let out = message;
  if (databasePath.length > 0) out = out.split(databasePath).join("<db>");
  const base = databasePath.split(/[\\/]/).pop() ?? "";
  if (base.length > 0) out = out.split(base).join("<db>");
  out = out.replace(/\s+/g, " ").trim();
  return out.length > MAX_ERROR_MESSAGE_CHARS ? `${out.slice(0, MAX_ERROR_MESSAGE_CHARS)}${TRUNCATION_MARK}` : out;
}

function mapError(e: unknown, databasePath: string): AppError {
  if (e instanceof AppError) return e;
  if (isDriverError(e)) {
    const code = e.code;
    if (code === "SQLITE_INTERRUPT") return new AppError("TIMEOUT", "Query was interrupted.", { cause: e });
    if (code.startsWith("SQLITE_READONLY") || code.startsWith("SQLITE_AUTH") || code === "SQLITE_PERM") {
      return new AppError("QUERY_REJECTED", "Query rejected: the connection is read-only.", { cause: e });
    }
    if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) {
      return new AppError("INTEGRATION_UNAVAILABLE", "The database is busy. Try again.", { cause: e });
    }
    if (code.startsWith("SQLITE_CANTOPEN") || code.startsWith("SQLITE_NOTADB") || code.startsWith("SQLITE_CORRUPT") || code.startsWith("SQLITE_IOERR")) {
      return new AppError("INTEGRATION_UNAVAILABLE", "The database could not be read.", { cause: e });
    }
    if (code.startsWith("SQLITE_NOMEM") || code.startsWith("SQLITE_TOOBIG") || code.startsWith("SQLITE_FULL")) {
      return new AppError("LIMIT_EXCEEDED", "The query exceeded a database resource limit.", { cause: e });
    }
    // SQLITE_ERROR and friends: syntax errors, unknown tables/columns, wrong parameter counts.
    return new AppError("INVALID_INPUT", `SQL error: ${scrub(e.message, databasePath)}`, { cause: e });
  }
  // better-sqlite3 TypeErrors / RangeErrors for bad statements ("more than one statement", "Too few parameter values", ...).
  if (e instanceof TypeError || e instanceof RangeError) {
    return new AppError("INVALID_INPUT", `SQL error: ${scrub(e.message, databasePath)}`, { cause: e });
  }
  return new AppError("INTERNAL_ERROR", "Unexpected database error.", { cause: e });
}

function positiveInt(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new AppError("INVALID_INPUT", `${name} must be a positive integer.`);
  return value;
}

function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/;\s*$/, "");
}

interface TableRow {
  name: string;
  type: string;
}
interface InfoRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}
interface FkRow {
  tbl: string;
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
}

/** The only schema SQLite exposes without ATTACH is `main`. */
function checkSchema(schema: string | undefined): void {
  if (schema !== undefined && schema !== "main") {
    throw new AppError("INVALID_INPUT", "SQLite connections have a single schema (main); omit schema.");
  }
}


interface RunSpec {
  op: "query" | "explain";
  sql: string;
  maxRows: number;
  maxCellChars: number;
  timeoutMs: number;
}

type RunnerError =
  | { kind: "app"; code: string; message: string }
  | { kind: "driver"; code: string; message: string }
  | { kind: "type"; message: string }
  | { kind: "other" };

type RunnerReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: RunnerError };

/** Children alive in this process; killed on exit so no runner outlives the server. */
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const c of liveChildren) c.kill("SIGKILL");
  });
}

/** `.js` next to this file in dist; `.ts` (Node type stripping) when running from src under tsx/vitest. */
function runnerEntry(): { file: string; execArgv: string[] } {
  const js = fileURLToPath(new URL("./sqlite.runner.js", import.meta.url));
  if (existsSync(js)) return { file: js, execArgv: [] };
  return { file: fileURLToPath(new URL("./sqlite.runner.ts", import.meta.url)), execArgv: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"] };
}

/**
 * Startup check (P2-11): when an enabled sqlite connection exists, the runner file must be present.
 * Returns true when usable (or nothing to check); otherwise calls `warn` with a fixed, path-free message
 * and returns false. Does not throw: other packs keep working and db_* keep returning INTEGRATION_UNAVAILABLE.
 */
export function checkSqliteRunner(
  connections: readonly { type: string; enabled: boolean }[],
  warn: (message: string) => void,
  exists: (file: string) => boolean = existsSync,
): boolean {
  if (!connections.some((c) => c.type === "sqlite" && c.enabled)) return true;
  if (exists(runnerEntry().file)) return true;
  warn("SQLite worker file is missing (incomplete build or install): db_* tools for sqlite connections will return INTEGRATION_UNAVAILABLE. Run the build.");
  return false;
}

function rebuildError(err: RunnerError): Error {
  switch (err.kind) {
    case "app": {
      const known = ["INTEGRATION_UNAVAILABLE", "QUERY_REJECTED", "LIMIT_EXCEEDED", "INTERNAL_ERROR"] as const;
      const code = known.find((k) => k === err.code) ?? "INTERNAL_ERROR";
      return new AppError(code, err.message);
    }
    case "driver": {
      const e = new Error(err.message);
      e.name = "SqliteError";
      (e as { code?: string }).code = err.code;
      return e;
    }
    case "type":
      return new TypeError(err.message);
    default:
      return new AppError("INTERNAL_ERROR", "Unexpected database error.");
  }
}

interface Runner {
  run<T>(spec: RunSpec, signal: AbortSignal | undefined): Promise<T>;
  dispose(): void;
}

/**
 * One lazily forked runner process per adapter, one request at a time (queued).
 * The deadline starts when the request is dispatched, not when it was queued.
 */
function createRunner(databasePath: string): Runner {
  let child: ChildProcess | undefined;
  let childReady: Promise<void> = Promise.resolve();
  let disposed = false;
  let tail: Promise<unknown> = Promise.resolve();
  let nextId = 1;
  let cancelCurrent: ((e: AppError) => void) | undefined;

  function spawnChild(): ChildProcess {
    const entry = runnerEntry();
    installExitHook();
    // stdio ignored: the runner can never write to our stdout/stderr. Empty env: no secrets inherited.
    const c = fork(entry.file, [], {
      execArgv: entry.execArgv,
      env: {},
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
    });
    liveChildren.add(c);
    childReady = new Promise<void>((resolve, reject) => {
      const startTimer = setTimeout(() => {
        kill(c);
        reject(new AppError("INTEGRATION_UNAVAILABLE", "The database worker could not be started."));
      }, RUNNER_START_TIMEOUT_MS);
      const onReady = (raw: unknown): void => {
        if (raw !== null && typeof raw === "object" && (raw as { ready?: unknown }).ready === true) {
          clearTimeout(startTimer);
          c.removeListener("message", onReady);
          resolve();
        }
      };
      c.on("message", onReady);
      c.once("exit", () => {
        clearTimeout(startTimer);
        reject(new AppError("INTEGRATION_UNAVAILABLE", "The database worker could not be started."));
      });
    });
    childReady.catch(() => undefined);
    c.once("exit", () => {
      liveChildren.delete(c);
      if (child === c) child = undefined;
    });
    return c;
  }

  function kill(c: ChildProcess): void {
    if (child === c) child = undefined;
    c.removeAllListeners("message");
    c.kill("SIGKILL");
  }

  async function dispatch<T>(spec: RunSpec, signal: AbortSignal | undefined): Promise<T> {
    if (disposed) throw new AppError("INTEGRATION_UNAVAILABLE", "The database connection is closed.");
    if (child === undefined) {
      try {
        child = spawnChild();
      } catch (e) {
        throw new AppError("INTERNAL_ERROR", "Unexpected database error.", { cause: e });
      }
    }
    await childReady;
    return new Promise<T>((resolve, reject) => {
      if (disposed) return reject(new AppError("INTEGRATION_UNAVAILABLE", "The database connection is closed."));
      if (signal?.aborted === true) return reject(new AppError("TIMEOUT", "Query was cancelled."));
      const c = child;
      if (c === undefined) return reject(new AppError("INTERNAL_ERROR", "Unexpected database error."));
      const id = nextId++;
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        c.removeListener("error", onGone);
        c.removeListener("exit", onGone);
        c.removeListener("message", onMessage);
        cancelCurrent = undefined;
        fn();
      };
      const fail = (e: AppError, killChild: boolean): void =>
        finish(() => {
          if (killChild) kill(c);
          reject(e);
        });
      const onAbort = (): void => fail(new AppError("TIMEOUT", "Query was cancelled."), true);
      const onGone = (): void => fail(new AppError("INTERNAL_ERROR", "Unexpected database error."), true);
      const onMessage = (raw: unknown): void => {
        const msg = raw as RunnerReply;
        if (msg === null || typeof msg !== "object" || msg.id !== id) return;
        finish(() => {
          if (msg.ok) resolve(msg.result as T);
          else reject(rebuildError(msg.error));
        });
      };
      const timer = setTimeout(
        () => fail(new AppError("TIMEOUT", `Query exceeded the time limit of ${spec.timeoutMs} ms.`), true),
        spec.timeoutMs,
      );
      cancelCurrent = (e) => fail(e, true);
      signal?.addEventListener("abort", onAbort, { once: true });
      c.on("message", onMessage);
      c.once("error", onGone);
      c.once("exit", onGone);
      try {
        c.send({ id, databasePath, ...spec });
      } catch {
        onGone();
      }
    });
  }

  return {
    run<T>(spec: RunSpec, signal: AbortSignal | undefined): Promise<T> {
      const result = tail.then(() => dispatch<T>(spec, signal));
      tail = result.catch(() => undefined);
      return result;
    },
    dispose() {
      disposed = true;
      cancelCurrent?.(new AppError("INTEGRATION_UNAVAILABLE", "The database connection is closed."));
      if (child !== undefined) kill(child);
    },
  };
}

export function createSqliteAdapter(connection: SqliteConnection, options: SqliteAdapterOptions = {}): DatabaseAdapter {
  const databasePath = connection.databasePath;
  const maxCellChars = positiveInt(options.maxCellChars ?? DEFAULT_LIMITS.maxCellChars, "maxCellChars");
  const maxCatalog = positiveInt(options.maxCatalogEntries ?? MAX_CATALOG_ENTRIES, "maxCatalogEntries");
  const db = openSqliteReadOnly(databasePath);
  let closed = false;
  const rawRunner = createRunner(databasePath);
  const runner: Runner = {
    run: <T>(spec: RunSpec, signal: AbortSignal | undefined): Promise<T> =>
      rawRunner.run<T>(spec, signal).catch((e: unknown) => {
        throw mapError(e, databasePath);
      }),
    dispose: () => rawRunner.dispose(),
  };

  function live(): Db {
    if (closed || !db.open) throw new AppError("INTEGRATION_UNAVAILABLE", "The database connection is closed.");
    return db;
  }

  function guarded<T>(fn: (conn: Db) => T): Promise<T> {
    try {
      return Promise.resolve(fn(live()));
    } catch (e) {
      return Promise.reject(mapError(e, databasePath));
    }
  }

  /** User-visible tables and views, never sqlite_ internals. Name is parameter-free: nothing is interpolated. */
  const CATALOG_SQL =
    "SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') AND substr(name, 1, 7) <> 'sqlite_' ORDER BY name LIMIT ?";

  function catalogLookup(conn: Db, table: string): TableRow | undefined {
    // Identifier is validated against the catalog; the value is bound, never concatenated.
    return conn
      .prepare<[string], TableRow>("SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') AND substr(name, 1, 7) <> 'sqlite_' AND name = ?")
      .get(table);
  }

  function foreignKeysOf(conn: Db, table: string): ForeignKeyInfo[] {
    const rows = conn
      .prepare<[string, string], FkRow>('SELECT ? AS tbl, id, seq, "table", "from", "to" FROM pragma_foreign_key_list(?) ORDER BY id, seq')
      .all(table, table);
    return groupForeignKeys(conn, rows).map((g) => ({
      columns: g.columns,
      referencedSchema: null,
      referencedTable: g.referencedTable,
      referencedColumns: g.referencedColumns,
    }));
  }

  interface FkGroup {
    table: string;
    columns: string[];
    referencedTable: string;
    referencedColumns: string[];
  }

  function groupForeignKeys(conn: Db, rows: FkRow[]): FkGroup[] {
    const groups = new Map<string, FkGroup & { implicit: boolean }>();
    for (const r of rows) {
      const key = `${r.tbl}\u0000${r.id}`;
      let g = groups.get(key);
      if (g === undefined) {
        g = { table: r.tbl, columns: [], referencedTable: r.table, referencedColumns: [], implicit: false };
        groups.set(key, g);
      }
      g.columns.push(r.from);
      if (r.to === null) g.implicit = true;
      else g.referencedColumns.push(r.to);
    }
    const out: FkGroup[] = [];
    for (const g of groups.values()) {
      if (g.implicit) {
        // REFERENCES parent without a column list means the parent's primary key.
        g.referencedColumns = primaryKeyOf(conn, g.referencedTable);
      }
      out.push({ table: g.table, columns: g.columns, referencedTable: g.referencedTable, referencedColumns: g.referencedColumns });
    }
    return out;
  }

  function primaryKeyOf(conn: Db, table: string): string[] {
    return conn
      .prepare<[string], InfoRow>("SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk")
      .all(table)
      .map((r) => r.name);
  }

  const adapter: DatabaseAdapter = {
    capabilities: { explain: true },

    async listTables(opts) {
      const page = await adapter.listTablesPage(opts);
      if (page.truncated) throw new AppError("LIMIT_EXCEEDED", "The database has too many tables to list.");
      return page.items;
    },

    listTablesPage(opts): Promise<CatalogPage<TableRef>> {
      return guarded((conn) => {
        checkSchema(opts?.schema);
        const rows = conn.prepare<[number], TableRow>(CATALOG_SQL).all(maxCatalog + 1);
        const items = rows
          .slice(0, maxCatalog)
          .map((r): TableRef => ({ schema: null, name: r.name, kind: r.type === "view" ? "view" : "table" }));
        return { items, truncated: rows.length > maxCatalog };
      });
    },

    describeTable(table, opts) {
      return guarded((conn) => {
        checkSchema(opts?.schema);
        if (typeof table !== "string" || table.length === 0 || table.length > 256) {
          throw new AppError("INVALID_INPUT", "table must be a table or view name.");
        }
        const found = catalogLookup(conn, table);
        if (found === undefined) throw new AppError("NOT_FOUND", "Unknown table or view.");
        const info = conn
          .prepare<[string], InfoRow>('SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid')
          .all(found.name);
        const columns: ColumnInfo[] = info.map((r) => ({
          name: r.name,
          type: r.type,
          nullable: r.notnull === 0,
          default: r.dflt_value,
        }));
        const primaryKey = info
          .filter((r) => r.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((r) => r.name);
        const description: TableDescription = {
          schema: null,
          name: found.name,
          columns,
          primaryKey,
          foreignKeys: found.type === "view" ? [] : foreignKeysOf(conn, found.name),
        };
        return description;
      });
    },

    async listRelationships(opts) {
      const page = await adapter.listRelationshipsPage(opts);
      if (page.truncated) throw new AppError("LIMIT_EXCEEDED", "The database has too many relationships to list.");
      return page.items;
    },

    listRelationshipsPage(opts): Promise<CatalogPage<RelationshipInfo>> {
      return guarded((conn) => {
        checkSchema(opts?.schema);
        const rowCap = maxCatalog * 8;
        const rows = conn
          .prepare<[number], FkRow>(
            `SELECT m.name AS tbl, f.id AS id, f.seq AS seq, f."table" AS "table", f."from" AS "from", f."to" AS "to"
             FROM sqlite_schema AS m, pragma_foreign_key_list(m.name) AS f
             WHERE m.type = 'table' AND substr(m.name, 1, 7) <> 'sqlite_'
             ORDER BY m.name, f.id, f.seq LIMIT ?`,
          )
          .all(rowCap + 1);
        const rowsCut = rows.length > rowCap;
        let groups = groupForeignKeys(conn, rowsCut ? rows.slice(0, rowCap) : rows);
        // The last group of a cut row set may be incomplete: drop it.
        if (rowsCut) groups = groups.slice(0, -1);
        const truncated = rowsCut || groups.length > maxCatalog;
        const items = groups.slice(0, maxCatalog).map(
          (g): RelationshipInfo => ({
            fromTable: g.table,
            fromColumns: g.columns,
            toTable: g.referencedTable,
            toColumns: g.referencedColumns,
          }),
        );
        return { items, truncated };
      });
    },

    query(sql: string, opts: QueryOptions): Promise<QueryResult> {
      try {
        live();
        if (typeof sql !== "string" || sql.length === 0) throw new AppError("INVALID_INPUT", "sql must be a non-empty string.");
        const maxRows = positiveInt(opts.maxRows, "maxRows");
        const timeoutMs = positiveInt(opts.timeoutMs, "timeoutMs");
        return runner.run<QueryResult>({ op: "query", sql, maxRows, maxCellChars, timeoutMs }, opts.signal);
      } catch (e) {
        return Promise.reject(mapError(e, databasePath));
      }
    },

    explain(sql: string): Promise<ExplainResult> {
      try {
        live();
        if (typeof sql !== "string" || sql.length === 0) throw new AppError("INVALID_INPUT", "sql must be a non-empty string.");
        // The adapter owns the prefix: `sql` is the already-validated user statement. Never ANALYZE (SQLite has none).
        if (/^\s*explain\b/i.test(sql)) throw new AppError("QUERY_REJECTED", "Query rejected: pass the query itself, not an EXPLAIN statement.");
        return runner.run<ExplainResult>(
          { op: "explain", sql: stripTrailingSemicolon(sql), maxRows: 1, maxCellChars, timeoutMs: EXPLAIN_TIMEOUT_MS },
          undefined,
        );
      } catch (e) {
        return Promise.reject(mapError(e, databasePath));
      }
    },

    close() {
      if (!closed) {
        closed = true;
        runner.dispose();
        try {
          db.close();
        } catch {
          // Closing twice or on a broken handle is not an error for the caller.
        }
      }
      return Promise.resolve();
    },
  };
  return adapter;
}

/**
 * Registry factory for the `sqlite` dialect: `createDatabaseRegistry(conns, { sqlite: createSqliteAdapterFactory({...}) })`.
 * Generic over the config's connection union; anything that is not a sqlite
 * connection with a string databasePath is refused with fixed text.
 */
export function createSqliteAdapterFactory<C extends ConnectionInfo>(options: SqliteAdapterOptions = {}): AdapterFactory<C> {
  return (connection: C) => {
    const path = (connection as { databasePath?: unknown }).databasePath;
    if (connection.type !== "sqlite" || typeof path !== "string" || connection.readOnly !== true) {
      throw new AppError("INTEGRATION_UNAVAILABLE", "SQLite database could not be opened.");
    }
    return createSqliteAdapter({ name: connection.name, type: "sqlite", enabled: connection.enabled, readOnly: connection.readOnly, databasePath: path }, options);
  };
}
