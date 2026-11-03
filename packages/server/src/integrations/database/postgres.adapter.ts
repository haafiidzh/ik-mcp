import { Pool } from "pg";
import { z } from "zod";
import { AppError } from "../../core/errors.js";
import { DEFAULT_LIMITS, LIMIT_MAXIMA } from "../../core/limits.js";
import type { Logger } from "../../core/logger.js";
import type {
  AdapterCapabilities,
  CatalogPage,
  ColumnInfo,
  DatabaseAdapter,
  ExplainResult,
  ForeignKeyInfo,
  QueryOptions,
  QueryResult,
  RelationshipInfo,
  TableDescription,
  TableRef,
} from "./database.types.js";

/**
 * PostgreSQL adapter (doc 05 section 3 step 3, ADR-050).
 *
 * Layer 2 of the read-only defence, independent of sql-guard: every statement runs
 * inside `BEGIN READ ONLY` + `SET LOCAL statement_timeout` + `SET LOCAL
 * idle_in_transaction_session_timeout` and always ends with `ROLLBACK` (finally).
 * User SQL is sent with the extended query protocol (one statement only, server
 * enforced) with a parameterized row cap, so a `;`-chained second statement
 * (for example `COMMIT; INSERT ...`) cannot run even if the guard were bypassed.
 *
 * The connection string (or password) is read from the env var NAMED in config,
 * through an injected getter. It is never logged, returned or placed in an error:
 * every pg error is replaced by a fixed message chosen from the SQLSTATE / error code.
 * The `schemas` allowlist filters the catalog tools (search_path is not a security boundary).
 */

/** Rows returned by catalog tools are bounded too (no limit key in doc 03 section 5; constant like BINARY_SNIFF_BYTES). */
export const MAX_CATALOG_ROWS = 500;
/** EXPLAIN output cap (characters). */
export const MAX_PLAN_CHARS = 20_000;
/** Extra time granted to the server-side statement_timeout before the client destroys the connection. */
const BACKSTOP_GRACE_MS = 2_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_POOL_MAX = 3;

// ---- minimal pg surface (lets tests inject a fake; the real Pool is cast at the SDK boundary) ----

export interface PgQueryConfig {
  text: string;
  values?: unknown[];
  rowMode?: "array";
  /** pg 8.23 query option (typed as "TODO: document" upstream); forces the extended protocol. */
  queryMode?: "extended";
}

export interface PgResultLike {
  rows: unknown[];
  fields?: readonly { name: string }[];
}

export interface PgClientLike {
  query(config: PgQueryConfig): Promise<PgResultLike>;
  /** A truthy argument destroys the connection instead of returning it to the pool. */
  release(destroy?: boolean | Error): void;
}

export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
  on(event: "error", listener: (err: Error) => void): unknown;
}

/** Contains secrets (connectionString / password). Never log or serialize. */
export interface PgPoolConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  application_name: string;
}

/** Structural subset of the config entry (type `postgres`); config entries satisfy it. */
export interface PostgresConnectionConfig {
  name: string;
  connectionStringEnv?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
  database?: string | undefined;
  user?: string | undefined;
  passwordEnv?: string | undefined;
  schemas: readonly string[];
}

export interface PostgresAdapterOptions {
  /** Injected env getter (defaults to process.env). Used only for the vars named in config. */
  getEnv?: (name: string) => string | undefined;
  /** Pool factory (tests inject a fake). */
  createPool?: (config: PgPoolConfig) => PgPoolLike;
  poolMax?: number;
  /** Cell truncation (doc 03 section 5 maxCellChars). */
  maxCellChars?: number;
  /** Timeout for catalog queries and EXPLAIN (dbQueryTimeoutMs). */
  defaultTimeoutMs?: number;
  logger?: Logger;
}

/** Kept for compatibility: the truncation flag now lives on QueryResult (ADR-055). */
export type PostgresQueryResult = QueryResult;

export type { CatalogPage };

// ---- error mapping ----

const UNAVAILABLE = "Database is unavailable or refused the connection.";

function errorCode(e: unknown): string | undefined {
  if (typeof e === "object" && e !== null && "code" in e) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return undefined;
}

/**
 * Map any pg/driver error to an AppError with FIXED text. The driver message is never
 * copied (it can carry host, user, database or parts of the connection string; S19).
 */
export function mapPostgresError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const code = errorCode(e);
  const message = e instanceof Error ? e.message : "";
  if (code === "57014") return new AppError("TIMEOUT", "The query exceeded the time limit and was cancelled.");
  if (code === "25006") {
    return new AppError("QUERY_REJECTED", "The read-only database transaction rejected a statement that would change data.");
  }
  if (code === "42501") return new AppError("PERMISSION_DENIED", "The database role is not allowed to read this object.");
  if (code === "42P01") return new AppError("NOT_FOUND", "The referenced table or view does not exist.");
  if (
    code !== undefined &&
    (/^(28|08|53)/.test(code) ||
      code === "3D000" ||
      code === "25P03" ||
      /^57P0/.test(code) ||
      /^(ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|CERT_|DEPTH_ZERO|UNABLE_TO|SELF_SIGNED|ERR_TLS)/.test(code))
  ) {
    return new AppError("INTEGRATION_UNAVAILABLE", UNAVAILABLE);
  }
  if (code !== undefined && /^42/.test(code)) {
    return new AppError("INVALID_INPUT", "The database rejected the query (syntax error or unknown column, function or type).");
  }
  if (code !== undefined && /^22/.test(code)) {
    return new AppError("INVALID_INPUT", "The query failed with a data error (for example a value out of range or a division by zero).");
  }
  if (code !== undefined && /^[0-9A-Z]{5}$/.test(code)) {
    return new AppError("UPSTREAM_ERROR", `The database reported an error (SQLSTATE ${code}).`);
  }
  if (/connection|timeout exceeded|terminated|ssl|socket|econn/i.test(message)) {
    return new AppError("INTEGRATION_UNAVAILABLE", UNAVAILABLE);
  }
  return new AppError("INTERNAL_ERROR", "Database operation failed.");
}

// ---- cells ----

interface CellFlags {
  truncated: boolean;
}

function cutString(text: string, max: number, flags: CellFlags): string {
  if (text.length <= max) return text;
  flags.truncated = true;
  return text.slice(0, max);
}

function jsonReplacer(this: unknown, key: string, value: unknown): unknown {
  // Buffer#toJSON has already run when the replacer sees `value`; look at the original.
  const original: unknown = typeof this === "object" && this !== null ? (this as Record<string, unknown>)[key] : value;
  if (original instanceof Uint8Array) return `<binary ${original.byteLength} bytes>`;
  if (typeof value === "bigint") return value.toString();
  return value;
}

/** Normalize a driver value into something JSON-safe and bounded (doc 05 section 3 step 4). */
export function normalizeCell(value: unknown, maxCellChars: number, flags: CellFlags): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return cutString(value, maxCellChars, flags);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return cutString(value.toString(), maxCellChars, flags);
  if (value instanceof Uint8Array) return `<binary ${value.byteLength} bytes>`;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  try {
    return cutString(JSON.stringify(value, jsonReplacer) ?? "null", maxCellChars, flags);
  } catch {
    return "<unserializable value>";
  }
}

// ---- catalog row shapes (external data, validated with zod) ----

const tableRow = z.object({ oid: z.string(), schema: z.string(), name: z.string(), relkind: z.string() });
const columnRow = z.object({
  name: z.string(),
  type: z.string(),
  nullable: z.boolean(),
  default: z.string().nullable(),
});
const constraintRow = z.object({
  conname: z.string(),
  contype: z.string(),
  schema: z.string(),
  tbl: z.string(),
  cols: z.array(z.string()),
  ref_schema: z.string().nullable(),
  ref_table: z.string().nullable(),
  ref_cols: z.array(z.string()).nullable(),
});

function tableKind(relkind: string): "table" | "view" {
  return relkind === "v" || relkind === "m" ? "view" : "table";
}

const TABLE_FILTER = `n.nspname = ANY($1::text[]) AND c.relkind IN ('r','p','v','m','f')`;

const CONSTRAINT_SELECT = `
SELECT con.conname::text AS conname, con.contype::text AS contype,
       sn.nspname::text AS schema, sc.relname::text AS tbl,
       ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS cols,
       rn.nspname::text AS ref_schema, rc.relname::text AS ref_table,
       CASE WHEN con.confrelid = 0 THEN NULL ELSE
         ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord) END AS ref_cols
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class sc ON sc.oid = con.conrelid
JOIN pg_catalog.pg_namespace sn ON sn.oid = sc.relnamespace
LEFT JOIN pg_catalog.pg_class rc ON rc.oid = con.confrelid
LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace`;

// ---- adapter ----

export class PostgresAdapter implements DatabaseAdapter {
  readonly capabilities: AdapterCapabilities = { explain: true };
  private readonly pool: PgPoolLike;
  private readonly schemas: readonly string[];
  private readonly maxCellChars: number;
  private readonly defaultTimeoutMs: number;
  private readonly logger: Logger | undefined;
  private closed = false;

  constructor(config: PostgresConnectionConfig, options: PostgresAdapterOptions = {}) {
    const getEnv = options.getEnv ?? ((n: string) => process.env[n]);
    this.schemas = [...config.schemas];
    this.maxCellChars = options.maxCellChars ?? DEFAULT_LIMITS.maxCellChars;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_LIMITS.dbQueryTimeoutMs;
    this.logger = options.logger;
    const poolConfig = buildPoolConfig(config, getEnv, options.poolMax ?? DEFAULT_POOL_MAX);
    const createPool = options.createPool ?? ((c: PgPoolConfig): PgPoolLike => new Pool(c) as unknown as PgPoolLike);
    try {
      this.pool = createPool(poolConfig);
    } catch {
      // pg-connection-string errors can quote the offending string: replace with fixed text.
      throw new AppError("INTEGRATION_UNAVAILABLE", "Database connection settings are invalid.");
    }
    // An idle client error must not crash the process (stdio server). Log the code only.
    this.pool.on("error", (err) => {
      this.logger?.warn("postgres idle client error", { connection: config.name, code: errorCode(err) ?? "unknown" });
    });
  }

  // ---- query / explain ----

  async query(sql: string, options: QueryOptions): Promise<PostgresQueryResult> {
    const inner = this.statementText(sql);
    const maxRows = this.rowLimit(options.maxRows);
    const timeoutMs = this.timeout(options.timeoutMs);
    // Parameterized LIMIT: the wrapper is an extended-protocol statement (one command only).
    const text = `SELECT * FROM (\n${inner}\n) AS _dw LIMIT $1`;
    const result = await this.withReadOnlyTx(timeoutMs, options.signal, (c) =>
      c.query({ text, values: [maxRows + 1], rowMode: "array", queryMode: "extended" }),
    );
    const flags: CellFlags = { truncated: false };
    const all = result.rows;
    const truncated = all.length > maxRows;
    const rows: unknown[][] = [];
    for (const raw of all.slice(0, maxRows)) {
      const row = Array.isArray(raw) ? (raw as unknown[]) : [];
      rows.push(row.map((cell) => normalizeCell(cell, this.maxCellChars, flags)));
    }
    return {
      columns: (result.fields ?? []).map((f) => f.name),
      rows,
      rowCount: rows.length,
      truncated,
      cellsTruncated: flags.truncated,
    };
  }

  async explain(sql: string): Promise<ExplainResult> {
    const inner = this.statementText(sql);
    // EXPLAIN cannot be wrapped or parameterized: refuse any remaining `;` (over-blocks `;` in literals, deliberate).
    if (inner.includes(";")) throw new AppError("QUERY_REJECTED", "Only a single statement can be explained.");
    const result = await this.withReadOnlyTx(this.defaultTimeoutMs, undefined, (c) =>
      c.query({ text: `EXPLAIN\n${inner}`, rowMode: "array", queryMode: "extended" }),
    );
    const lines = result.rows.map((r) => (Array.isArray(r) ? String((r as unknown[])[0] ?? "") : ""));
    let plan = lines.join("\n");
    if (plan.length > MAX_PLAN_CHARS) plan = `${plan.slice(0, MAX_PLAN_CHARS)}\n[plan truncated]`;
    return { plan };
  }

  // ---- catalog tools ----

  async listTables(options: { schema?: string } = {}): Promise<TableRef[]> {
    return (await this.listTablesPage(options)).items;
  }

  async listTablesPage(options: { schema?: string } = {}): Promise<CatalogPage<TableRef>> {
    const scope = this.schemaScope(options.schema);
    const rows = await this.catalog(
      `SELECT c.oid::text AS oid, n.nspname::text AS schema, c.relname::text AS name, c.relkind::text AS relkind
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE ${TABLE_FILTER} ORDER BY n.nspname, c.relname LIMIT $2`,
      [scope, MAX_CATALOG_ROWS + 1],
    );
    const parsed = z.array(tableRow).parse(rows);
    const truncated = parsed.length > MAX_CATALOG_ROWS;
    const items = parsed
      .slice(0, MAX_CATALOG_ROWS)
      .map((r): TableRef => ({ schema: r.schema, name: r.name, kind: tableKind(r.relkind) }));
    return { items, truncated };
  }

  async describeTable(table: string, options: { schema?: string } = {}): Promise<TableDescription> {
    if (typeof table !== "string" || table.length === 0 || table.length > 255 || table.includes("\u0000")) {
      throw new AppError("INVALID_INPUT", "table must be a non-empty table or view name.");
    }
    const scope = this.schemaScope(options.schema);
    return this.withReadOnlyTx(this.defaultTimeoutMs, undefined, async (c) => {
      // Identifier is looked up in the catalog (bound parameter), never concatenated.
      const found = z
        .array(tableRow)
        .parse(
          (
            await c.query({
              text: `SELECT c.oid::text AS oid, n.nspname::text AS schema, c.relname::text AS name, c.relkind::text AS relkind
                     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                     WHERE ${TABLE_FILTER} AND c.relname = $2
                     ORDER BY array_position($1::text[], n.nspname::text) LIMIT 1`,
              values: [scope, table],
              queryMode: "extended",
            })
          ).rows,
        );
      const t = found[0];
      if (t === undefined) throw new AppError("NOT_FOUND", "Table or view not found in the configured schemas.");
      const columns = z.array(columnRow).parse(
        (
          await c.query({
            text: `SELECT a.attname::text AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
                          NOT a.attnotnull AS nullable, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS "default"
                   FROM pg_catalog.pg_attribute a
                   LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                   WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum LIMIT 1600`,
            values: [t.oid],
            queryMode: "extended",
          })
        ).rows,
      );
      const constraints = z.array(constraintRow).parse(
        (
          await c.query({
            text: `${CONSTRAINT_SELECT} WHERE con.conrelid = $1::oid AND con.contype IN ('p','f') ORDER BY con.conname LIMIT $2`,
            values: [t.oid, MAX_CATALOG_ROWS],
            queryMode: "extended",
          })
        ).rows,
      );
      const primaryKey = constraints.find((k) => k.contype === "p")?.cols ?? [];
      const foreignKeys = constraints.filter((k) => k.contype === "f").map(toForeignKey);
      return {
        schema: t.schema,
        name: t.name,
        columns: columns.map(
          (col): ColumnInfo => ({ name: col.name, type: col.type, nullable: col.nullable, default: col.default }),
        ),
        primaryKey,
        foreignKeys,
      };
    });
  }

  async listRelationships(options: { schema?: string } = {}): Promise<RelationshipInfo[]> {
    return (await this.listRelationshipsPage(options)).items;
  }

  async listRelationshipsPage(options: { schema?: string } = {}): Promise<CatalogPage<RelationshipInfo>> {
    const scope = this.schemaScope(options.schema);
    const rows = await this.catalog(
      `${CONSTRAINT_SELECT} WHERE con.contype = 'f' AND sn.nspname = ANY($1::text[])
       ORDER BY sn.nspname, sc.relname, con.conname LIMIT $2`,
      [scope, MAX_CATALOG_ROWS + 1],
    );
    const parsed = z.array(constraintRow).parse(rows);
    const truncated = parsed.length > MAX_CATALOG_ROWS;
    const items = parsed.slice(0, MAX_CATALOG_ROWS).map(
      (r): RelationshipInfo => ({
        fromTable: `${r.schema}.${r.tbl}`,
        fromColumns: r.cols,
        toTable: `${r.ref_schema ?? ""}.${r.ref_table ?? ""}`,
        toColumns: r.ref_cols ?? [],
        name: r.conname,
      }),
    );
    return { items, truncated };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.pool.end();
    } catch (e) {
      // Closing is best effort; never surface driver text.
      this.logger?.warn("postgres pool close failed", { code: errorCode(e) ?? "unknown" });
    }
  }

  // ---- internals ----

  private schemaScope(schema: string | undefined): string[] {
    if (schema === undefined) return [...this.schemas];
    if (typeof schema !== "string" || !this.schemas.includes(schema)) {
      throw new AppError("PERMISSION_DENIED", "Schema is not in the configured schemas for this connection.");
    }
    return [schema];
  }

  private statementText(sql: unknown): string {
    if (typeof sql !== "string") throw new AppError("INVALID_INPUT", "sql must be a string.");
    const inner = sql.trim().replace(/;\s*$/, "").trimEnd();
    if (inner.length === 0) throw new AppError("INVALID_INPUT", "sql must not be empty.");
    if (inner.includes("\u0000")) throw new AppError("QUERY_REJECTED", "SQL contains control characters.");
    return inner;
  }

  private rowLimit(maxRows: number): number {
    if (!Number.isInteger(maxRows) || maxRows < 1) throw new AppError("INVALID_INPUT", "maxRows must be a positive integer.");
    return Math.min(maxRows, LIMIT_MAXIMA.dbMaxRows);
  }

  private timeout(timeoutMs: number): number {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new AppError("INVALID_INPUT", "timeoutMs must be a positive number.");
    return Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS);
  }

  private async catalog(text: string, values: unknown[]): Promise<unknown[]> {
    const result = await this.withReadOnlyTx(this.defaultTimeoutMs, undefined, (c) =>
      c.query({ text, values, queryMode: "extended" }),
    );
    return result.rows;
  }

  /**
   * BEGIN READ ONLY -> SET LOCAL timeouts -> work -> ROLLBACK (always, in finally).
   * The connection is destroyed instead of reused when the rollback fails or the
   * client-side backstop (timeout + grace, or abort signal) fires.
   */
  private async withReadOnlyTx<T>(timeoutMs: number, signal: AbortSignal | undefined, work: (c: PgClientLike) => Promise<T>): Promise<T> {
    if (this.closed) throw new AppError("INTEGRATION_UNAVAILABLE", UNAVAILABLE);
    if (signal?.aborted) throw new AppError("TIMEOUT", "The query was cancelled before it started.");
    let client: PgClientLike;
    try {
      client = await this.pool.connect();
    } catch (e) {
      this.logger?.debug("postgres connect failed", { code: errorCode(e) ?? "unknown" });
      throw mapPostgresError(e);
    }
    let broken = false;
    let cleanup: () => void = () => undefined;
    try {
      const run = (async (): Promise<T> => {
        await client.query({ text: "BEGIN READ ONLY" });
        await client.query({ text: `SET LOCAL statement_timeout = ${timeoutMs}` });
        await client.query({ text: `SET LOCAL idle_in_transaction_session_timeout = ${timeoutMs + BACKSTOP_GRACE_MS * 2}` });
        return work(client);
      })();
      run.catch(() => undefined); // a raced-away rejection must not become unhandled
      const backstop = new Promise<never>((_resolve, reject) => {
        const fire = (message: string): void => {
          broken = true;
          reject(new AppError("TIMEOUT", message));
        };
        const timer = setTimeout(() => fire("The query exceeded the time limit and was cancelled."), timeoutMs + BACKSTOP_GRACE_MS);
        const onAbort = (): void => fire("The query was cancelled.");
        signal?.addEventListener("abort", onAbort, { once: true });
        cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
      });
      backstop.catch(() => undefined);
      return await Promise.race([run, backstop]);
    } catch (e) {
      if (!(e instanceof AppError)) this.logger?.debug("postgres query failed", { code: errorCode(e) ?? "unknown" });
      throw mapPostgresError(e);
    } finally {
      cleanup();
      if (broken) {
        client.release(true);
      } else {
        let rolledBack = true;
        try {
          await client.query({ text: "ROLLBACK" });
        } catch {
          rolledBack = false;
        }
        client.release(rolledBack ? undefined : true);
      }
    }
  }
}

function toForeignKey(r: z.infer<typeof constraintRow>): ForeignKeyInfo {
  return {
    columns: r.cols,
    referencedSchema: r.ref_schema,
    referencedTable: r.ref_table ?? "",
    referencedColumns: r.ref_cols ?? [],
    name: r.conname,
  };
}

function buildPoolConfig(config: PostgresConnectionConfig, getEnv: (name: string) => string | undefined, max: number): PgPoolConfig {
  const base = {
    max: Math.max(1, Math.min(Math.floor(max), 10)),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    application_name: "devworkspace-mcp",
  };
  if (config.connectionStringEnv !== undefined) {
    const value = getEnv(config.connectionStringEnv);
    if (value === undefined || value.length === 0) {
      // Env var NAMES are config, not secrets; the value is never part of any message.
      throw new AppError("INTEGRATION_UNAVAILABLE", `Environment variable ${config.connectionStringEnv} for this database connection is not set.`);
    }
    return { ...base, connectionString: value };
  }
  if (config.host === undefined || config.database === undefined || config.user === undefined) {
    throw new AppError("INTEGRATION_UNAVAILABLE", "Database connection settings are incomplete.");
  }
  let password: string | undefined;
  if (config.passwordEnv !== undefined) {
    password = getEnv(config.passwordEnv);
    if (password === undefined || password.length === 0) {
      throw new AppError("INTEGRATION_UNAVAILABLE", `Environment variable ${config.passwordEnv} for this database connection is not set.`);
    }
  }
  return {
    ...base,
    host: config.host,
    ...(config.port !== undefined ? { port: config.port } : {}),
    database: config.database,
    user: config.user,
    ...(password !== undefined ? { password } : {}),
  };
}

/** Factory shaped for `createDatabaseRegistry` (`factories.postgres`). */
export function createPostgresAdapter(config: PostgresConnectionConfig, options: PostgresAdapterOptions = {}): PostgresAdapter {
  return new PostgresAdapter(config, options);
}
