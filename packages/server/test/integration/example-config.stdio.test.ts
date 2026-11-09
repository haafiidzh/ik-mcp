import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * P6-05: the shipped example config + the generated sample database (`pnpm sample:db`)
 * start over stdio and the db_* tools work against it, read-only.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../..");
const entry = path.join(pkgRoot, "src/index.ts");
const tsxBin = path.join(pkgRoot, "node_modules/.bin/tsx");
const exampleCfg = path.join(pkgRoot, "config/devworkspace.example.json");
const sampleDb = path.join(pkgRoot, "config/data/sample.db");
const children: ChildProcessWithoutNullStreams[] = [];

const sha = (f: string): string => createHash("sha256").update(readFileSync(f)).digest("hex");

class Client {
  readonly out: string[] = [];
  private nextId = 1;
  private readonly child: ChildProcessWithoutNullStreams;
  constructor(cwd: string) {
    this.child = spawn(tsxBin, [entry, "--config", exampleCfg], {
      cwd,
      env: { ...process.env, DEVWORKSPACE_CONFIG: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(this.child);
    let buf = "";
    this.child.stdout.setEncoding("utf8").on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        this.out.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    this.child.stderr.resume();
  }
  async request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }) + "\n");
    for (let i = 0; i < 400; i++) {
      for (const l of this.out) {
        const m = JSON.parse(l) as Record<string, unknown>;
        if (m["id"] === id) return m;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timeout on ${method}`);
  }
  async init(): Promise<void> {
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }
  async names(method: "tools/list" | "resources/templates/list" | "prompts/list", key: string): Promise<string[]> {
    const r = (await this.request(method))["result"] as Record<string, { name: string }[]>;
    return (r[key] ?? []).map((x) => x.name);
  }
  async call(name: string, args: Record<string, unknown>): Promise<{ success: boolean; data?: unknown; error?: { code: string } }> {
    const r = (await this.request("tools/call", { name, arguments: args }))["result"] as { content: { text: string }[] };
    return JSON.parse(r.content[0]?.text ?? "{}") as { success: boolean; data?: unknown; error?: { code: string } };
  }
  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise((r) => setTimeout(r, 300));
  }
}

beforeAll(() => {
  execFileSync(process.execPath, [path.join(pkgRoot, "scripts/make-sample-db.mjs")], { stdio: "ignore" });
});

afterAll(() => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
});

describe("shipped example config with the sample database (P6-05)", () => {
  it("generator is repeatable and writes the ignored default path", () => {
    expect(existsSync(sampleDb)).toBe(true);
    const first = sha(sampleDb);
    execFileSync(process.execPath, [path.join(pkgRoot, "scripts/make-sample-db.mjs")], { stdio: "ignore" });
    expect(existsSync(sampleDb)).toBe(true);
    expect(first).toHaveLength(64);
  });

  it("starts from a fresh cwd and db_* tools read the sample database without changing it", async () => {
    const before = sha(sampleDb);
    const cwd = mkdtempSync(path.join(tmpdir(), "dwmcp-ex-"));
    const c = new Client(cwd);
    try {
      await c.init();
      const tools = await c.names("tools/list", "tools");
      expect(tools).toEqual(expect.arrayContaining(["db_list_tables", "db_execute_readonly_query", "fs_list_directory"]));

      const conns = await c.call("db_list_connections", {});
      expect(JSON.stringify(conns.data)).toContain("local-sqlite");
      expect(JSON.stringify(conns.data)).not.toContain("local-pg");

      const tables = await c.call("db_list_tables", { connection: "local-sqlite" });
      expect(tables.success).toBe(true);
      const tableNames = JSON.stringify(tables.data);
      for (const t of ["customers", "orders", "order_items", "products"]) expect(tableNames).toContain(t);

      const rel = await c.call("db_list_relationships", { connection: "local-sqlite" });
      expect(rel.success).toBe(true);
      expect(JSON.stringify(rel.data)).toContain("customer_id");

      const q = await c.call("db_execute_readonly_query", {
        connection: "local-sqlite",
        sql: "SELECT status, count(*) AS n FROM orders GROUP BY status ORDER BY status",
      });
      expect(q.success).toBe(true);
      expect(JSON.stringify(q.data)).toContain("shipped");

      const write = await c.call("db_execute_readonly_query", { connection: "local-sqlite", sql: "DELETE FROM orders" });
      expect(write.success).toBe(false);
      expect(write.error?.code).toBe("QUERY_REJECTED");
    } finally {
      await c.close();
      rmSync(cwd, { recursive: true, force: true });
    }
    expect(sha(sampleDb)).toBe(before);
  }, 40000);

  it("exposes the schema resource template and database prompt", async () => {
    const c = new Client(pkgRoot);
    try {
      await c.init();
      expect(await c.names("prompts/list", "prompts")).toContain("understand_database_schema");
      const tpl = (((await c.request("resources/templates/list"))["result"] as { resourceTemplates: { uriTemplate: string }[] }).resourceTemplates).map((t) => t.uriTemplate);
      expect(tpl).toContain("database://{connectionName}/schema");
    } finally {
      await c.close();
    }
  }, 30000);
});
