import { createRequire } from "node:module";
import type { Parser as SqlParser } from "node-sql-parser";
import { AppError } from "../../core/errors.js";
import type { DatabaseDialect } from "./database.types.js";

/**
 * SQL guard (doc 05 section 3 steps 1, 2 and 5; layer 1 of the read-only
 * defense, layer 2 is the read-only connection/transaction).
 *
 *  - length cap, no rewriting of the user's SQL (only a trailing `;` is dropped
 *    when the statement is wrapped for the row cap);
 *  - parse with node-sql-parser for the connection dialect; exactly one
 *    statement whose top-level type is SELECT (WITH ... SELECT included);
 *  - the whole AST is walked: data-modifying CTEs, SELECT INTO, row locking and
 *    dangerous functions are rejected wherever they appear;
 *  - bare VALUES (not parsed by the library) goes through a strict lexical
 *    validator that only allows literals;
 *  - anything unparseable is rejected (fail closed).
 * Every rejection is QUERY_REJECTED with fixed text: the SQL is never echoed.
 */

/** Doc 03 has no key for this; a code constant like BINARY_SNIFF_BYTES (implementation-notes P2-01). */
export const MAX_SQL_CHARS = 10_000;

// node-sql-parser is CommonJS (no static named exports under Node ESM) and large: load it on first use,
// so a server that never runs a query does not pay for it at startup.
let parserCtor: (new () => SqlParser) | undefined;
function newParser(): SqlParser {
  parserCtor ??= (createRequire(import.meta.url)("node-sql-parser") as { Parser: new () => SqlParser }).Parser;
  return new parserCtor();
}

const MAX_AST_DEPTH = 200;

export interface ValidatedSql {
  readonly dialect: DatabaseDialect;
  /** The user's SQL, trimmed. Only branded values reach adapters, wrapper and EXPLAIN builder. */
  readonly statement: string;
  readonly kind: "select" | "values";
}

export interface SqlGuardOptions {
  dialect: DatabaseDialect;
  maxChars?: number;
}

const reject = (why: string): never => {
  throw new AppError("QUERY_REJECTED", `Query rejected: ${why}. Only a single read-only SELECT statement is allowed.`);
};

const PARSER_DIALECT: Record<DatabaseDialect, string> = { sqlite: "sqlite", postgres: "postgresql" };

/** AST node `type` values that mean something other than a read. */
const FORBIDDEN_NODE_TYPES = new Set([
  "insert", "update", "delete", "replace", "merge", "create", "drop", "alter", "truncate", "rename",
  "call", "set", "transaction", "begin", "commit", "rollback", "savepoint", "attach", "detach", "use",
  "grant", "revoke", "lock", "unlock", "load", "copy", "explain", "analyze", "vacuum", "pragma", "do",
  "declare", "exec", "execute", "prepare", "deallocate", "comment", "show", "desc", "describe", "kill",
]);

const FORBIDDEN_FUNCTIONS = new Set([
  "load_extension", "readfile", "writefile", "edit", "fts3_tokenizer", "zipfile",
  "set_config", "nextval", "setval",
  "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf", "pg_rotate_logfile",
  "pg_switch_wal", "pg_promote", "pg_import_system_collations", "txid_current",
]);

const FORBIDDEN_FUNCTION_PREFIXES = [
  "lo_", "dblink", "pg_read_", "pg_ls_", "pg_file_", "pg_stat_file", "pg_logical_", "pg_replication_",
  "pg_create_", "pg_drop_", "query_to_xml", "table_to_xml", "schema_to_xml", "database_to_xml", "cursor_to_xml",
  "pg_advisory_",
];

function isForbiddenFunction(raw: string): boolean {
  const name = raw.toLowerCase();
  return FORBIDDEN_FUNCTIONS.has(name) || FORBIDDEN_FUNCTION_PREFIXES.some((p) => name.startsWith(p));
}

function functionNames(node: Record<string, unknown>): string[] {
  const name = node["name"];
  if (typeof name === "string") return [name];
  if (typeof name === "object" && name !== null) {
    const parts = (name as Record<string, unknown>)["name"];
    if (Array.isArray(parts)) {
      return parts.flatMap((p) => {
        const v = typeof p === "object" && p !== null ? (p as Record<string, unknown>)["value"] : undefined;
        return typeof v === "string" ? [v] : [];
      });
    }
  }
  return [];
}

function walk(node: unknown, depth: number): void {
  if (depth > MAX_AST_DEPTH) reject("query is nested too deeply");
  if (Array.isArray(node)) {
    for (const item of node) walk(item, depth + 1);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const obj = node as Record<string, unknown>;
  const type = obj["type"];
  if (typeof type === "string") {
    const t = type.toLowerCase();
    if (FORBIDDEN_NODE_TYPES.has(t)) reject("statement type is not allowed");
    if (t === "function" || t === "aggr_func" || t === "window_func") {
      if (functionNames(obj).some(isForbiddenFunction)) reject("function is not allowed");
    }
    if (t === "select") {
      const into = obj["into"];
      if (typeof into === "object" && into !== null) {
        const i = into as Record<string, unknown>;
        if (i["position"] != null || i["expr"] != null) reject("SELECT INTO is not allowed");
      }
    }
  }
  for (const key of ["for_update", "locking_read", "lock", "locking"]) {
    if (obj[key] != null) reject("row locking is not allowed");
  }
  for (const value of Object.values(obj)) walk(value, depth + 1);
}

/** Skip whitespace and comments at `i`; returns the new index or -1 for an unterminated comment. */
function skipTrivia(s: string, start: number): number {
  let i = start;
  for (;;) {
    while (i < s.length && /\s/.test(s.charAt(i))) i++;
    if (s.startsWith("--", i)) {
      const nl = s.indexOf("\n", i);
      i = nl === -1 ? s.length : nl + 1;
    } else if (s.startsWith("/*", i)) {
      const end = s.indexOf("*/", i + 2);
      if (end === -1) return -1;
      i = end + 2;
    } else return i;
  }
}

function startsWithValues(s: string): boolean {
  const i = skipTrivia(s, 0);
  return i >= 0 && /^values(?![A-Za-z0-9_$])/i.test(s.slice(i, i + 7));
}

/**
 * Strict lexical validator for a bare VALUES statement: VALUES, parentheses,
 * commas, signs, numeric/string literals and NULL/TRUE/FALSE only. Anything else
 * (identifiers, functions, operators, ORDER BY, nested comments, `$$`) is rejected.
 */
function validateValues(s: string): void {
  let i = skipTrivia(s, 0);
  if (i < 0 || !/^values/i.test(s.slice(i, i + 6))) return reject("could not be parsed");
  i += 6;
  let depth = 0;
  let sawTuple = false;
  let semicolon = false;
  while (i < s.length) {
    const next = skipTrivia(s, i);
    if (next < 0) return reject("could not be parsed");
    i = next;
    if (i >= s.length) break;
    const c = s.charAt(i);
    if (semicolon) return reject("multiple statements are not allowed");
    if (c === "(") { depth++; sawTuple = true; i++; }
    else if (c === ")") { depth--; if (depth < 0) return reject("could not be parsed"); i++; }
    else if (c === "," || c === "+" || c === "-") i++;
    else if (c === ";") { if (depth !== 0) return reject("could not be parsed"); semicolon = true; i++; }
    else if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= s.length) return reject("could not be parsed");
        if (s.charAt(j) === "'") {
          if (s.charAt(j + 1) === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      i = j + 1;
    } else {
      const m = /^(?:\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|null|true|false)(?![A-Za-z0-9_$])/i.exec(s.slice(i));
      if (m === null) return reject("only literal VALUES lists are allowed");
      i += m[0].length;
    }
  }
  if (depth !== 0 || !sawTuple) reject("could not be parsed");
}

/**
 * Independent lexical pass (second opinion next to the parser). The library does not
 * model every engine's quoting rules (for example it treats a backslash in '...' as an
 * escape for SQLite, and accepts nested comments and dollar quoting differently from
 * the engines), so any construct where parser and engine could disagree about where
 * a statement ends is rejected outright. Also rejects any `;` outside quotes and
 * comments except as trailing terminators.
 */
function lexicalCheck(s: string, dialect: DatabaseDialect): void {
  const n = s.length;
  let i = 0;
  let sawSemicolon = false;
  while (i < n) {
    const c = s.charAt(i);
    if (sawSemicolon && !/\s/.test(c) && !s.startsWith("--", i) && !s.startsWith("/*", i)) {
      return reject("multiple statements are not allowed");
    }
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      for (;;) {
        if (j >= n) return reject("unterminated quoted text");
        const d = s.charAt(j);
        if (d === "\\" && c === "'") return reject("backslash inside a string literal is not allowed");
        if (d === c) {
          if (s.charAt(j + 1) === c) { j += 2; continue; }
          break;
        }
        j++;
      }
      i = j + 1;
    } else if (c === "[" && dialect === "sqlite") {
      const end = s.indexOf("]", i + 1);
      if (end === -1) return reject("unterminated quoted text");
      i = end + 1;
    } else if (c === "-" && s.charAt(i + 1) === "-") {
      const nl = s.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
    } else if (c === "/" && s.charAt(i + 1) === "*") {
      if (s.charAt(i + 2) === "!") return reject("conditional comments are not allowed");
      const end = s.indexOf("*/", i + 2);
      if (end === -1) return reject("unterminated comment");
      if (s.slice(i + 2, end).includes("/*")) return reject("nested comments are not allowed");
      i = end + 2;
    } else if (c === "$" && /^\$[A-Za-z_0-9]*\$/.test(s.slice(i, i + 64))) {
      return reject("dollar quoting is not allowed");
    } else if (c === ";") {
      sawSemicolon = true;
      i++;
    } else i++;
  }
}

function parseOne(sql: string, dialect: DatabaseDialect): unknown {
  let ast: unknown;
  try {
    ast = newParser().astify(sql, { database: PARSER_DIALECT[dialect] });
  } catch {
    return reject("SQL could not be parsed");
  }
  const list: unknown[] = Array.isArray(ast) ? ast : [ast];
  if (list.length !== 1) return reject("multiple statements are not allowed");
  return list[0];
}

/** Steps 1-2: validate, or throw QUERY_REJECTED. */
export function assertReadOnlySql(sql: unknown, options: SqlGuardOptions): ValidatedSql {
  if (typeof sql !== "string") throw new AppError("INVALID_INPUT", "sql must be a string.");
  const max = options.maxChars ?? MAX_SQL_CHARS;
  if (sql.length > max) reject(`SQL is longer than ${max} characters`);
  // NUL truncates statements in some engines; other control characters have no place in a query.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(sql)) reject("SQL contains control characters");
  const statement = sql.trim();
  if (statement.length === 0) throw new AppError("INVALID_INPUT", "sql must not be empty.");

  if (startsWithValues(statement)) {
    validateValues(statement);
    return { dialect: options.dialect, statement, kind: "values" };
  }
  lexicalCheck(statement, options.dialect);
  const root = parseOne(statement, options.dialect);
  const top = typeof root === "object" && root !== null ? (root as Record<string, unknown>)["type"] : undefined;
  if (typeof top !== "string" || top.toLowerCase() !== "select") reject("only SELECT statements are allowed");
  walk(root, 0);
  return { dialect: options.dialect, statement, kind: "select" };
}

/** Step 4 wrapper: `SELECT * FROM (<q>) AS _dw LIMIT n` (newlines keep a trailing `--` comment from eating the wrapper). */
export function wrapWithRowCap(validated: ValidatedSql, limit: number): string {
  if (!Number.isInteger(limit) || limit < 1) throw new AppError("INVALID_INPUT", "Row limit must be a positive integer.");
  const inner = validated.statement.replace(/;\s*$/, "");
  const wrapped = `SELECT * FROM (\n${inner}\n) AS _dw LIMIT ${limit}`;
  if (validated.kind === "select") {
    // Re-validate the exact text that will run (wrapper + user SQL parse as one safe statement).
    lexicalCheck(wrapped, validated.dialect);
    const root = parseOne(wrapped, validated.dialect);
    walk(root, 0);
  } else {
    validateValues(inner);
  }
  return wrapped;
}

/** Step 5: plain EXPLAIN (postgres) / EXPLAIN QUERY PLAN (sqlite). Never ANALYZE. */
export function buildExplainSql(validated: ValidatedSql): string {
  const inner = validated.statement.replace(/;\s*$/, "");
  const prefix = validated.dialect === "sqlite" ? "EXPLAIN QUERY PLAN" : "EXPLAIN";
  return `${prefix}\n${inner}`;
}
