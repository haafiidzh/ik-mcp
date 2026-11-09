/* eslint-disable @typescript-eslint/no-explicit-any -- test-only navigation of the JSON result */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_LIMITS } from "../../src/core/limits.js";
import { createAuditLog } from "../../src/core/audit.js";
import { createLogger } from "../../src/core/logger.js";
import { createRedactor } from "../../src/core/redact.js";
import { ok } from "../../src/core/response.js";
import { createFilesystemService, type FilesystemService } from "../../src/integrations/filesystem/filesystem.service.js";
import type { DatabaseRegistry } from "../../src/integrations/database/database.registry.js";
import type { DatabaseAdapter, TableRef } from "../../src/integrations/database/database.types.js";
import { runTool, type ServerDeps } from "../../src/server/register-tools.js";
import { buildWorkspaceDataFlowTool } from "../../src/tools/workflows/workspace-data-flow.js";
import {
  hasWordBoundaryMatch,
  inspectDataFlow,
  isSearchableName,
  type DataFlowDbPort,
  type DataFlowDeps,
  type DataFlowFsPort,
  type ApiEndpointMeta,
} from "../../src/workflows/data-flow.js";

// Compile-time assignability: the real services satisfy the Ports without adapters.
const _fs: (s: FilesystemService) => DataFlowFsPort = (s) => s;
const _db: (r: DatabaseRegistry) => DataFlowDbPort = (r) => r;
void _fs;
void _db;

let root: string;
let fsSvc: FilesystemService;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "dwmcp-df-")));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "repo.ts"), "const q = 'SELECT * FROM orders';\n// customers table\nconst orders2 = 1;\nreorders();\n");
  writeFileSync(path.join(root, "src", "api.ts"), "fetch('/orders/' + id);\nconst u = '/orders/{id}';\nget('/v1/items')\n");
  writeFileSync(path.join(root, "README.md"), "Uses the orders table.\nA star: x* and a.b and ../etc and drop table here\n");
  writeFileSync(path.join(root, ".env"), "SECRETTABLE=1\nsecret_table=orders\n");
  fsSvc = await createFilesystemService({ workspaces: [{ id: "main", rootPath: root }], blockedNames: [".env"] });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fakeDb(tables: TableRef[], truncated = false) {
  const query = vi.fn();
  const adapter = { listTablesPage: vi.fn(async () => ({ items: tables, truncated })), query } as unknown as DatabaseAdapter;
  const port: DataFlowDbPort = { names: () => ["shop"], get: async () => adapter };
  return { port, query, adapter };
}
const T = (name: string, kind: "table" | "view" = "table"): TableRef => ({ schema: null, name, kind });

const EPS: ApiEndpointMeta[] = [
  { name: "get_order", method: "GET", path: "/orders/{id}", permission: "read", writeGated: false },
  { name: "create_order", method: "POST", path: "/orders", permission: "write", writeGated: true },
  { name: "never_used", method: "GET", path: "/zzz/none/{x}", permission: "read", writeGated: false },
];

function mkDeps(over: Partial<DataFlowDeps> = {}): DataFlowDeps {
  return {
    workspaces: [
      { id: "main", databases: ["shop"], apis: ["billing"] },
      { id: "other", databases: ["secretdb"], apis: [] },
    ],
    fs: fsSvc,
    db: fakeDb([T("orders"), T("customers"), T("unused_tbl")]).port,
    api: { listEndpoints: (p) => (p === "billing" ? EPS : undefined) },
    ...over,
  };
}

type Sec = { id: string; status: string; data?: any; error?: { code: string; message: string } };
function sections(r: any): Sec[] {
  expect(r.success).toBe(true);
  return r.data.sections;
}
const sec = (r: any, id: string): Sec => sections(r).find((s) => s.id === id) as Sec;

describe("hasWordBoundaryMatch / isSearchableName", () => {
  it("whole words only, literal", () => {
    expect(hasWordBoundaryMatch("FROM orders;", "orders")).toBe(true);
    expect(hasWordBoundaryMatch("reorders()", "orders")).toBe(false);
    expect(hasWordBoundaryMatch("orders2", "orders")).toBe(false);
    expect(hasWordBoundaryMatch("see x* here", "x*")).toBe(true);
    expect(hasWordBoundaryMatch("axx", "x*")).toBe(false);
    expect(hasWordBoundaryMatch("a.b", "a.b")).toBe(true);
    expect(hasWordBoundaryMatch("axb", "a.b")).toBe(false);
  });
  it("rejects unsafe names", () => {
    expect(isSearchableName("../etc")).toBe(false);
    expect(isSearchableName("a\nb")).toBe(false);
    expect(isSearchableName("a\\b")).toBe(false);
    expect(isSearchableName("x".repeat(10000))).toBe(false);
    expect(isSearchableName("drop table")).toBe(true);
    expect(isSearchableName("tabelé")).toBe(true);
  });
});

describe("inspectDataFlow database", () => {
  it("lists tables, finds referenced and unreferenced, never queries, skips .env", async () => {
    const db = fakeDb([T("orders"), T("customers"), T("unused_tbl")]);
    const r = await inspectDataFlow(mkDeps({ db: db.port }), { workspace: "main", connection: "shop" });
    expect(sections(r).map((s) => s.id)).toEqual(["target", "references", "unknowns"]);
    expect(sec(r, "target").data.tableCount).toBe(3);
    expect(sec(r, "target").data.tables.map((t: any) => t.name)).toEqual(["customers", "orders", "unused_tbl"]);
    const refs = sec(r, "references").data.entries as any[];
    const orders = refs.find((e) => e.name === "orders");
    expect(orders.referenced).toBe(true);
    expect(orders.files.map((f: any) => f.path)).toEqual(["src/api.ts", "README.md", "src/repo.ts"]);
    // "reorders()" and "orders2" are not word matches
    expect(orders.totalHits).toBe(4);
    expect(refs.find((e) => e.name === "unused_tbl").referenced).toBe(false);
    expect(JSON.stringify(r)).not.toContain(".env");
    expect(JSON.stringify(r)).not.toContain("secret_table");
    expect(db.query).not.toHaveBeenCalled();
    const unk = sec(r, "unknowns").data.items.map((i: any) => i.code);
    expect(unk).toContain("ZERO_REFERENCES");
    expect(sec(r, "target").data.workspaceLinks).toEqual({ databases: 1, apis: 1 });
  });

  it("hostile table names are listed, handled, never regex-interpreted", async () => {
    const names = ["a.b", "x*", "../etc", "drop table", "tabelé", "x".repeat(10000), "bad\nname", "(", "["];
    const db = fakeDb(names.map((n) => T(n)));
    const r = await inspectDataFlow(mkDeps({ db: db.port }), { workspace: "main", connection: "shop" });
    const refs = sec(r, "references").data.entries as any[];
    expect(refs).toHaveLength(names.length);
    const by = (n: string) => refs.find((e) => e.name === n);
    expect(by("a.b").referenced).toBe(true);
    expect(by("x*").referenced).toBe(true);
    expect(by("drop table").referenced).toBe(true);
    expect(by("../etc").searched).toBe(false);
    expect(by("../etc").skippedReason).toBe("unsafe-name");
    expect(refs.filter((e) => e.skippedReason === "unsafe-name").length).toBe(3);
    expect(sec(r, "target").data.tables.some((t: any) => t.name.length <= 201 && t.nameTruncated)).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/\n.*bad/);
    expect(sec(r, "unknowns").data.items.map((i: any) => i.code)).toContain("NAMES_SKIPPED");
    expect(r.success && r.meta.partial).toBe(true);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("is deterministic across runs and input order", async () => {
    const a = await inspectDataFlow(mkDeps({ db: fakeDb([T("orders"), T("customers"), T("unused_tbl")]).port }), { workspace: "main", connection: "shop" });
    const b = await inspectDataFlow(mkDeps({ db: fakeDb([T("unused_tbl"), T("customers"), T("orders")]).port }), { workspace: "main", connection: "shop" });
    expect((a as any).data).toEqual((b as any).data);
  });

  it("reports catalog truncation", async () => {
    const r = await inspectDataFlow(mkDeps({ db: fakeDb([T("orders")], true).port }), { workspace: "main", connection: "shop" });
    expect(sec(r, "target").status).toBe("partial");
    expect(sec(r, "unknowns").data.items.map((i: any) => i.code)).toContain("CATALOG_TRUNCATED");
  });

  it("caps searched tables and reports it", async () => {
    const many = Array.from({ length: 60 }, (_, i) => T(`t${String(i).padStart(2, "0")}`));
    const r = await inspectDataFlow(mkDeps({ db: fakeDb(many).port }), { workspace: "main", connection: "shop" });
    const refs = sec(r, "references").data.entries as any[];
    expect(refs.filter((e) => e.searched).length).toBe(50);
    expect(refs.filter((e) => e.skippedReason === "search-cap").length).toBe(10);
    expect(sec(r, "unknowns").data.items.map((i: any) => i.code)).toContain("NOT_SEARCHED");
  });

  it("partial result when the filesystem search is cut short", async () => {
    const fs: DataFlowFsPort = {
      searchContent: async () => ok([], { source: "filesystem", truncated: true, partial: true }, ["Search stopped at the time limit; results are partial."]),
    };
    const r = await inspectDataFlow(mkDeps({ fs }), { workspace: "main", connection: "shop" });
    expect(sec(r, "references").status).toBe("partial");
    expect(sec(r, "unknowns").data.items.map((i: any) => i.code)).toContain("SEARCH_TRUNCATED");
    expect((r as any).meta.partial).toBe(true);
  });

  it("stops searching at the time budget", async () => {
    let t = 0;
    const search = vi.fn(async () => {
      t += 20000;
      return ok([], { source: "filesystem" });
    });
    const r = await inspectDataFlow(mkDeps({ fs: { searchContent: search }, now: () => t }), { workspace: "main", connection: "shop" });
    const refs = sec(r, "references").data.entries as any[];
    expect(search).toHaveBeenCalledTimes(2);
    expect(refs.filter((e) => e.skippedReason === "time-budget").length).toBe(1);
    expect(sec(r, "references").status).toBe("partial");
  });

  it("filesystem disabled and database disabled become section statuses", async () => {
    const r1 = await inspectDataFlow(mkDeps({ fs: undefined }), { workspace: "main", connection: "shop" });
    expect(sec(r1, "target").status).toBe("ok");
    expect(sec(r1, "references").status).toBe("disabled");
    expect(sec(r1, "unknowns").data.items.map((i: any) => i.code)).toContain("FILESYSTEM_DISABLED");
    const r2 = await inspectDataFlow(mkDeps({ db: undefined }), { workspace: "main", connection: "shop" });
    expect(sec(r2, "target").status).toBe("disabled");
    expect(sec(r2, "references").status).toBe("unavailable");
    expect(sec(r2, "unknowns").data.items.map((i: any) => i.code)).toContain("DATABASE_DISABLED");
  });

  it("a failing catalog read is a section error with a fixed unknown", async () => {
    const db: DataFlowDbPort = { names: () => ["shop"], get: async () => { throw new Error("boom /home/x/secret.db"); } };
    const r = await inspectDataFlow(mkDeps({ db }), { workspace: "main", connection: "shop" });
    expect(sec(r, "target").status).toBe("error");
    expect(JSON.stringify(r)).not.toContain("/home/x");
    expect(sec(r, "unknowns").data.items.map((i: any) => i.code)).toContain("TARGET_FAILED");
  });
});

describe("inspectDataFlow api", () => {
  it("endpoint metadata plus files with path literals; no calls", async () => {
    const r = await inspectDataFlow(mkDeps(), { workspace: "main", profile: "billing" });
    const t = sec(r, "target").data;
    expect(t.endpoints.map((e: any) => e.name)).toEqual(["create_order", "get_order", "never_used"]);
    expect(t.endpoints[0]).toMatchObject({ method: "POST", permission: "write", writeGated: true });
    const refs = sec(r, "references").data.entries as any[];
    const get = refs.find((e) => e.name === "get_order");
    expect(get.files.map((f: any) => f.path)).toContain("src/api.ts");
    expect(get.files.find((f: any) => f.path === "src/api.ts").hits).toBe(2); // template line + prefix line
    expect(refs.find((e) => e.name === "never_used").referenced).toBe(false);
  });
});

describe("link validation", () => {
  it("rejects unlinked, unknown and malformed targets without leaking names", async () => {
    for (const a of [
      { workspace: "main", connection: "secretdb" },
      { workspace: "main", profile: "nope" },
      { workspace: "main", profile: "shop" },
      { workspace: "ghost", connection: "shop" },
    ]) {
      const r: any = await inspectDataFlow(mkDeps(), a);
      expect(r.success).toBe(false);
      expect(r.error.code).toBe("NOT_FOUND");
      expect(JSON.stringify(r)).not.toMatch(/secretdb|shop|billing|other/);
    }
    for (const a of [
      { workspace: "main" },
      { workspace: "main", connection: "shop", profile: "billing" },
      { workspace: "main", connection: "sqlite:///etc/passwd" },
      { workspace: "main", profile: "https://evil.example/x" },
      { workspace: "main", connection: "/etc/passwd" },
    ]) {
      const r: any = await inspectDataFlow(mkDeps(), a);
      expect(r.success).toBe(false);
      expect(r.error.code).toBe("INVALID_INPUT");
    }
  });
});

describe("tool factory", () => {
  function tool(over: Partial<DataFlowDeps> = {}) {
    const records: { resourceRef?: string }[] = [];
    const audit = createAuditLog();
    audit.record = (e) => void records.push({ ...(e.resourceRef !== undefined ? { resourceRef: e.resourceRef } : {}) });
    const deps = { limits: { ...DEFAULT_LIMITS }, logger: createLogger({ level: "error" }), audit, redactor: createRedactor() } as unknown as ServerDeps;
    return { t: buildWorkspaceDataFlowTool({ deps, runTool, workflow: mkDeps(over) }), records };
  }
  it("schema is strict and needs exactly one target; read-only annotations", () => {
    const { t } = tool();
    const s = t.definition.inputSchema;
    expect(s.safeParse({ workspace: "main", connection: "shop" }).success).toBe(true);
    expect(s.safeParse({ workspace: "main" }).success).toBe(false);
    expect(s.safeParse({ workspace: "main", connection: "a", profile: "b" }).success).toBe(false);
    expect(s.safeParse({ workspace: "main", connection: "a", path: "/x" }).success).toBe(false);
    expect(t.definition.annotations.readOnlyHint).toBe(true);
    expect(t.name).toBe("workspace_inspect_data_flow");
  });
  it("returns the MCP envelope and audits the workspace id only", async () => {
    const { t, records } = tool();
    const r = await t.handler({ workspace: "main", connection: "shop" });
    const body = JSON.parse(r.content[0]?.text ?? "{}");
    expect(body.success).toBe(true);
    expect(body.meta.source).toBe("workflow:inspect_data_flow");
    expect(records[0]?.resourceRef).toBe("main");
    const bad = await t.handler({ workspace: "../x", connection: "shop" });
    expect(bad.isError).toBe(true);
    expect(records[1]?.resourceRef).toBe("unknown-workspace");
  });
});
