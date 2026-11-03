import { AppError } from "../../core/errors.js";
import type { ConnectionInfo, DatabaseAdapter, DatabaseDialect } from "./database.types.js";

/**
 * Connection name -> adapter. Built from configured, enabled connections only
 * (doc 05 S10). Names are the only way to select a connection: connection
 * strings, URLs and paths in arguments are rejected, never interpreted.
 * Error messages never carry host, path or credentials (not even the offending input).
 */

export type AdapterFactory<C extends ConnectionInfo = ConnectionInfo> = (connection: C) => DatabaseAdapter | Promise<DatabaseAdapter>;

export type AdapterFactories<C extends ConnectionInfo = ConnectionInfo> = Partial<Record<DatabaseDialect, AdapterFactory<C>>>;

export interface DatabaseRegistry {
  /** Names of enabled connections, in config order. */
  names(): string[];
  /** Resolve a tool-supplied connection name to its adapter (created lazily, cached). */
  get(name: unknown): Promise<DatabaseAdapter>;
  /** Dialect of an enabled connection (needed by sql-guard). */
  dialectOf(name: unknown): DatabaseDialect;
  closeAll(): Promise<void>;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const INVALID = "Connection must be the name of a configured connection, not a connection string, URL or path.";

function checkName(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 2048) {
    throw new AppError("INVALID_INPUT", INVALID);
  }
  // Anything that is not a plain config-style name is treated as a smuggled
  // connection string / URL / path / DSN and refused without being echoed.
  if (!NAME_PATTERN.test(input)) throw new AppError("INVALID_INPUT", INVALID);
  return input;
}

export function createDatabaseRegistry<C extends ConnectionInfo>(
  connections: readonly C[],
  factories: AdapterFactories<C>,
): DatabaseRegistry {
  // Disabled connections are not resolvable at all: they look unknown.
  const enabled = new Map<string, C>();
  for (const c of connections) {
    if (c.enabled && !enabled.has(c.name)) enabled.set(c.name, c);
  }
  const cache = new Map<string, Promise<DatabaseAdapter>>();

  function lookup(input: unknown): C {
    const name = checkName(input);
    const conn = enabled.get(name);
    if (conn === undefined) throw new AppError("NOT_FOUND", "Unknown database connection. Use db_list_connections to see configured names.");
    return conn;
  }

  return {
    names: () => [...enabled.keys()],
    dialectOf: (name) => lookup(name).type,
    get(name) {
      let conn: C;
      try {
        conn = lookup(name);
      } catch (e) {
        return Promise.reject(e);
      }
      const existing = cache.get(conn.name);
      if (existing !== undefined) return existing;
      const factory = factories[conn.type];
      if (factory === undefined) {
        return Promise.reject(new AppError("UNSUPPORTED", "No adapter is available for this connection type."));
      }
      const created = (async (): Promise<DatabaseAdapter> => {
        try {
          return await factory(conn);
        } catch (e) {
          if (e instanceof AppError) throw e;
          // Driver errors may carry host/path/credentials: replace with fixed text.
          throw new AppError("INTEGRATION_UNAVAILABLE", "Database connection could not be opened.", { cause: e });
        }
      })();
      cache.set(conn.name, created);
      // A failed open is not cached, so a later call can retry.
      created.catch(() => {
        if (cache.get(conn.name) === created) cache.delete(conn.name);
      });
      return created;
    },
    async closeAll() {
      const pending = [...cache.values()];
      cache.clear();
      await Promise.allSettled(pending.map(async (p) => (await p).close()));
    },
  };
}
