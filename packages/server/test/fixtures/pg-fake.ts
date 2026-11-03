import type { PgClientLike, PgPoolConfig, PgPoolLike, PgQueryConfig, PgResultLike } from "../../src/integrations/database/postgres.adapter.js";

/** Scripted fake of the pg Pool/Client used by the Docker-free adapter tests. */
export type FakeHandler = (config: PgQueryConfig) => PgResultLike | Promise<PgResultLike>;

export interface FakePg {
  pool: PgPoolLike;
  /** Every statement text sent, in order, across all clients. */
  texts: string[];
  /** Every query config sent. */
  calls: PgQueryConfig[];
  releases: (boolean | Error | undefined)[];
  poolConfigs: PgPoolConfig[];
  ended: () => boolean;
  idleErrorListeners: ((e: Error) => void)[];
}

const OK: PgResultLike = { rows: [], fields: [] };

/** `handler` answers only non-control statements; BEGIN/SET/ROLLBACK are answered OK unless `control` says otherwise. */
export function makeFakePg(handler: FakeHandler, control?: FakeHandler, connectError?: unknown): FakePg {
  const texts: string[] = [];
  const calls: PgQueryConfig[] = [];
  const releases: (boolean | Error | undefined)[] = [];
  const poolConfigs: PgPoolConfig[] = [];
  const idleErrorListeners: ((e: Error) => void)[] = [];
  let ended = false;
  const client: PgClientLike = {
    async query(config) {
      texts.push(config.text);
      calls.push(config);
      const isControl = /^(BEGIN READ ONLY|SET LOCAL |ROLLBACK)/.test(config.text);
      if (isControl) return control ? control(config) : OK;
      return handler(config);
    },
    release(destroy) {
      releases.push(destroy);
    },
  };
  const pool: PgPoolLike = {
    async connect() {
      if (connectError !== undefined) throw connectError;
      return client;
    },
    async end() {
      ended = true;
    },
    on(_event, listener) {
      idleErrorListeners.push(listener);
    },
  };
  return { pool, texts, calls, releases, poolConfigs, ended: () => ended, idleErrorListeners };
}

export function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
