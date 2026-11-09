/* eslint-disable @typescript-eslint/no-explicit-any -- test-only navigation of the JSON result */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFilesystemService, type FilesystemService } from "../../src/integrations/filesystem/filesystem.service.js";
import type { DatabaseAdapter } from "../../src/integrations/database/database.types.js";
import { inspectDataFlow, type DataFlowDbPort } from "../../src/workflows/data-flow.js";

let root: string;
let outside: string;
let fsSvc: FilesystemService;

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "dwmcp-dfs-")));
  root = path.join(base, "ws");
  outside = path.join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  mkdirSync(path.join(root, "node_modules"));
  writeFileSync(path.join(root, ".env"), "ledger_entries=1\n");
  writeFileSync(path.join(root, "node_modules", "dep.js"), "ledger_entries\n");
  writeFileSync(path.join(outside, "x.txt"), "ledger_entries\n");
  symlinkSync(outside, path.join(root, "link"));
  writeFileSync(path.join(root, "code.ts"), "// ledger_entries used here\n");
  fsSvc = await createFilesystemService({ workspaces: [{ id: "main", rootPath: root }], blockedNames: [".env"], ignoreDirs: ["node_modules"] });
});
afterAll(() => rmSync(path.dirname(root), { recursive: true, force: true }));

describe("data flow security", () => {
  it("blocked, ignored and out-of-root files never contribute references; no row access", async () => {
    const query = vi.fn();
    const adapter = { listTablesPage: async () => ({ items: [{ schema: null, name: "ledger_entries", kind: "table" as const }], truncated: false }), query } as unknown as DatabaseAdapter;
    const db: DataFlowDbPort = { names: () => ["shop"], get: async () => adapter };
    const r: any = await inspectDataFlow(
      { workspaces: [{ id: "main", databases: ["shop"], apis: [] }], fs: fsSvc, db },
      { workspace: "main", connection: "shop" },
    );
    const refs = r.data.sections.find((s: any) => s.id === "references").data.entries[0];
    expect(refs.files.map((f: any) => f.path)).toEqual(["code.ts"]);
    expect(JSON.stringify(r)).not.toMatch(/\.env|node_modules|outside|link/);
    expect(query).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain(root);
  });
});
