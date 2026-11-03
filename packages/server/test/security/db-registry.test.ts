import { describe, expect, it } from "vitest";
import { AppError } from "../../src/core/errors.js";
import { createDatabaseRegistry } from "../../src/integrations/database/database.registry.js";
import type { ConnectionInfo, DatabaseAdapter } from "../../src/integrations/database/database.types.js";

function fakeAdapter(tag: string): DatabaseAdapter & { closed: boolean; tag: string } {
  return {
    tag,
    closed: false,
    capabilities: { explain: true },
    listTables: () => Promise.resolve([]),
    describeTable: () => Promise.reject(new Error("unused")),
    listRelationships: () => Promise.resolve([]),
    query: () => Promise.resolve({ columns: [], rows: [], rowCount: 0, truncated: false }),
    explain: () => Promise.resolve({ plan: "" }),
    close() {
      this.closed = true;
      return Promise.resolve();
    },
  };
}

interface Conn extends ConnectionInfo {
  databasePath?: string;
}
const conns: Conn[] = [
  { name: "local-sqlite", type: "sqlite", enabled: true, readOnly: true, databasePath: "/secret/place/app.db" },
  { name: "pg-main", type: "postgres", enabled: true, readOnly: true },
  { name: "off", type: "sqlite", enabled: false, readOnly: true, databasePath: "/secret/off.db" },
];

async function code(p: Promise<unknown> | (() => unknown)): Promise<{ code: string; message: string }> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    if (e instanceof AppError) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("expected rejection");
}

function make() {
  const made: ReturnType<typeof fakeAdapter>[] = [];
  const registry = createDatabaseRegistry(conns, {
    sqlite: (c) => {
      const a = fakeAdapter(c.name);
      made.push(a);
      return a;
    },
    postgres: (c) => {
      const a = fakeAdapter(c.name);
      made.push(a);
      return a;
    },
  });
  return { registry, made };
}

describe("S10 database registry", () => {
  it("lists only enabled connections and resolves them lazily, cached", async () => {
    const { registry, made } = make();
    expect(registry.names()).toEqual(["local-sqlite", "pg-main"]);
    expect(made).toHaveLength(0);
    const a = await registry.get("local-sqlite");
    expect(await registry.get("local-sqlite")).toBe(a);
    expect(made).toHaveLength(1);
    expect(registry.dialectOf("pg-main")).toBe("postgres");
  });

  it("unknown connection name -> NOT_FOUND without echoing input or config", async () => {
    const { registry } = make();
    const r = await code(registry.get("nope"));
    expect(r.code).toBe("NOT_FOUND");
    expect(r.message).not.toContain("nope");
    expect(r.message).not.toContain("/secret");
    expect((await code(() => registry.dialectOf("nope"))).code).toBe("NOT_FOUND");
  });

  it("disabled connection is not resolvable (NOT_FOUND, same as unknown)", async () => {
    const { registry, made } = make();
    const r = await code(registry.get("off"));
    expect(r.code).toBe("NOT_FOUND");
    expect(r.message).not.toContain("/secret");
    expect(made).toHaveLength(0);
    expect(registry.names()).not.toContain("off");
  });

  it.each([
    "postgres://user:hunter2@db.example.com:5432/app",
    "postgresql://localhost/app",
    "host=localhost user=a password=hunter2 dbname=x",
    "Server=db;User Id=a;Password=hunter2;",
    "/etc/passwd",
    "../app.db",
    "C:\\data\\app.db",
    "\\\\host\\share\\app.db",
    "./data/sample.db",
    "file:app.db?mode=rw",
    "sqlite:///tmp/app.db",
    "local-sqlite/../x",
    "local-sqlite ",
    "local-sqlite;",
    "",
    "x".repeat(5000),
  ])("connection string / path in args -> INVALID_INPUT: %j", async (input) => {
    const { registry } = make();
    const r = await code(registry.get(input));
    expect(r.code).toBe("INVALID_INPUT");
    expect(r.message).not.toContain("hunter2");
    expect(r.message).not.toContain("example.com");
    expect(r.message).not.toContain("passwd");
    expect((await code(() => registry.dialectOf(input))).code).toBe("INVALID_INPUT");
  });

  it.each([5, null, undefined, {}, ["local-sqlite"]])("non-string connection %j -> INVALID_INPUT", async (input) => {
    const { registry } = make();
    expect((await code(registry.get(input))).code).toBe("INVALID_INPUT");
  });

  it("factory failure is replaced with a fixed message (no host/path/credentials) and not cached", async () => {
    let n = 0;
    const registry = createDatabaseRegistry(conns, {
      sqlite: () => {
        n++;
        throw new Error("ECONNREFUSED postgres://u:hunter2@10.0.0.5/db at /secret/place/app.db");
      },
    });
    const r = await code(registry.get("local-sqlite"));
    expect(r.code).toBe("INTEGRATION_UNAVAILABLE");
    expect(r.message).not.toMatch(/hunter2|10\.0\.0\.5|\/secret/);
    await code(registry.get("local-sqlite"));
    expect(n).toBe(2);
  });

  it("missing factory for the dialect -> UNSUPPORTED", async () => {
    const registry = createDatabaseRegistry(conns, {});
    expect((await code(registry.get("pg-main"))).code).toBe("UNSUPPORTED");
  });

  it("closeAll closes created adapters", async () => {
    const { registry, made } = make();
    await registry.get("local-sqlite");
    await registry.get("pg-main");
    await registry.closeAll();
    expect(made.every((a) => a.closed)).toBe(true);
  });
});
