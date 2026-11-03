import { statSync } from "node:fs";
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
 * TIMEOUT (S9): better-sqlite3 is synchronous and exposes no interrupt or
 * progress handler, so a running native step cannot be preempted in-process.
 * The deadline is cooperative: it is checked between result rows and once more
 * when the statement finishes, so a slow query that streams rows is aborted
 * mid-way and a single long step is reported as TIMEOUT after it returns. The
 * event loop is blocked while a step runs. See implementation-notes "P2-02".
 *
 * Errors never carry the database path: open failures use fixed text, driver
 * messages are scrubbed of the path and length-capped.
 */

/** Hard bound on catalog listings (tables, relationships); exceeding it is LIMIT_EXCEEDED, never silent truncation. */
export const MAX_CATALOG_ENTRIES = 1000;

const MAX_ERROR_MESSAGE_CHARS = 200;
const BUSY_TIMEOUT_MS = 1000;
const TRUNCATION_MARK = "…";

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

export function createSqliteAdapter(connection: SqliteConnection, options: SqliteAdapterOptions = {}): DatabaseAdapter {
  const databasePath = connection.databasePath;
  const maxCellChars = positiveInt(options.maxCellChars ?? DEFAULT_LIMITS.maxCellChars, "maxCellChars");
  const maxCatalog = positiveInt(options.maxCatalogEntries ?? MAX_CATALOG_ENTRIES, "maxCatalogEntries");
  const db = openSqliteReadOnly(databasePath);
  let closed = false;

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

    query(sql: string, opts: QueryOptions) {
      return guarded((conn): QueryResult => {
        if (typeof sql !== "string" || sql.length === 0) throw new AppError("INVALID_INPUT", "sql must be a non-empty string.");
        const maxRows = positiveInt(opts.maxRows, "maxRows");
        const timeoutMs = positiveInt(opts.timeoutMs, "timeoutMs");
        const started = Date.now();
        const deadline = started + timeoutMs;
        const timedOut = (): AppError => new AppError("TIMEOUT", `Query exceeded the time limit of ${timeoutMs} ms.`);
        const aborted = (): AppError => new AppError("TIMEOUT", "Query was cancelled.");

        // better-sqlite3 refuses more than one statement here (TypeError -> INVALID_INPUT).
        const stmt = conn.prepare(sql);
        // Connection-level read-only (independent of sql-guard): only a reader that does not write may run.
        if (!stmt.reader || !stmt.readonly) throw new AppError("QUERY_REJECTED", "Query rejected: only read-only statements can run.");
        stmt.raw(true).safeIntegers(true);
        const columns = stmt.columns().map((c) => c.name);

        const rows: unknown[][] = [];
        let truncated = false;
        const cellFlags = { cut: false };
        const iterator = stmt.iterate() as IterableIterator<unknown>;
        try {
          for (;;) {
            if (opts.signal?.aborted === true) throw aborted();
            const step = iterator.next();
            if (Date.now() > deadline) throw timedOut();
            if (step.done === true) break;
            if (rows.length >= maxRows) {
              // The (maxRows + 1)th row proves truncation; it is not returned.
              truncated = true;
              break;
            }
            const row = step.value;
            if (!Array.isArray(row)) throw new AppError("INTERNAL_ERROR", "Unexpected row shape from the database.");
            rows.push(row.map((cell) => convertCell(cell, maxCellChars, cellFlags)));
          }
        } finally {
          iterator.return?.();
        }
        return { columns, rows, rowCount: rows.length, truncated, cellsTruncated: cellFlags.cut };
      });
    },

    explain(sql: string): Promise<ExplainResult> {
      return guarded((conn) => {
        if (typeof sql !== "string" || sql.length === 0) throw new AppError("INVALID_INPUT", "sql must be a non-empty string.");
        // The adapter owns the prefix: `sql` is the already-validated user statement. Never ANALYZE (SQLite has none).
        if (/^\s*explain\b/i.test(sql)) throw new AppError("QUERY_REJECTED", "Query rejected: pass the query itself, not an EXPLAIN statement.");
        const stmt = conn.prepare(`EXPLAIN QUERY PLAN\n${stripTrailingSemicolon(sql)}`);
        if (!stmt.reader || !stmt.readonly) throw new AppError("QUERY_REJECTED", "Query rejected: only read-only statements can run.");
        stmt.raw(true);
        const rows = stmt.all() as unknown[][];
        if (rows.length > 500) throw new AppError("LIMIT_EXCEEDED", "The query plan is too large to return.");
        // Columns: id, parent, notused, detail. Render the parent/child tree as indented text.
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
      });
    },

    close() {
      if (!closed) {
        closed = true;
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
