/**
 * Database pack contracts (doc 04 section A). Pure types: no MCP imports, no drivers.
 * Real adapters (SQLite P2-02, PostgreSQL P2-03) implement DatabaseAdapter.
 */

export type DatabaseDialect = "sqlite" | "postgres";

export interface TableRef {
  schema: string | null;
  name: string;
  kind: "table" | "view";
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default?: string | null;
}

export interface ForeignKeyInfo {
  columns: string[];
  referencedSchema: string | null;
  referencedTable: string;
  referencedColumns: string[];
  name?: string;
}

export interface TableDescription {
  schema: string | null;
  name: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  foreignKeys: ForeignKeyInfo[];
}

export interface RelationshipInfo {
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
  name?: string;
}

export interface QueryOptions {
  /** Maximum rows to return. Adapters fetch maxRows + 1 to detect truncation. */
  maxRows: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  /** True when at least one cell was cut at maxCellChars (callers report it in meta). */
  cellsTruncated: boolean;
}

/** A catalog listing bounded by the adapter; `truncated` is true when more entries existed (ADR-055). */
export interface CatalogPage<T> {
  items: T[];
  truncated: boolean;
}

export interface ExplainResult {
  plan: string | unknown;
}

export interface AdapterCapabilities {
  explain: boolean;
}

/**
 * Adapters receive SQL that already passed sql-guard (a ValidatedSql statement);
 * the guard is the caller's duty, the connection-level read-only controls
 * (doc 05 section 3 step 3) are the adapter's duty.
 */
export interface DatabaseAdapter {
  readonly capabilities: AdapterCapabilities;
  listTables(options?: { schema?: string }): Promise<TableRef[]>;
  /** Bounded listing with a truncation flag (tools use this one; ADR-055). */
  listTablesPage(options?: { schema?: string }): Promise<CatalogPage<TableRef>>;
  describeTable(table: string, options?: { schema?: string }): Promise<TableDescription>;
  listRelationships(options?: { schema?: string }): Promise<RelationshipInfo[]>;
  listRelationshipsPage(options?: { schema?: string }): Promise<CatalogPage<RelationshipInfo>>;
  query(sql: string, options: QueryOptions): Promise<QueryResult>;
  explain(sql: string): Promise<ExplainResult>;
  close(): Promise<void>;
}

/** Minimal shape the registry needs from a configured connection (config entries satisfy it structurally). */
export interface ConnectionInfo {
  name: string;
  type: DatabaseDialect;
  enabled: boolean;
  readOnly: boolean;
}
