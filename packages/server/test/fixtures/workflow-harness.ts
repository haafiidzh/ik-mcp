import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { parseConfigText } from "../../src/config/load-config.js";
import { createAuditLog, type AuditEntry } from "../../src/core/audit.js";
import { DEFAULT_LIMITS } from "../../src/core/limits.js";
import { createLogger } from "../../src/core/logger.js";
import { createRedactor } from "../../src/core/redact.js";
import { registerTools, type ServerDeps } from "../../src/server/register-tools.js";
import { git } from "./git-repo.js";
import type { GithubMock } from "./github-mock.js";

/** Shared pieces of the P5-05 workflow end-to-end tests (in-process and stdio). */

export const ENV_CANARY = "SECRET-ENV-CANARY-DO-NOT-LEAK-7731";
export const GH_CANARY = "ghp_WFCANARYtoken1234567890abcdefABCDEF";
export const ROW_CANARY = "alice@example.com";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only loose JSON view of tool results
export type Res = { success: boolean; data?: any; error?: { code: string; message: string }; meta?: Record<string, any>; warnings?: string[] };

export interface Section {
  id: string;
  title: string;
  status: string;
  source: { kind: string; ref: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
  data?: any;
  error?: { code: string; message: string };
}

export const sectionsOf = (r: Res): Section[] => (r.data?.sections ?? []) as Section[];
export const byId = (r: Res, id: string): Section | undefined => sectionsOf(r).find((s) => s.id === id);

/** A workspace with a real git repo, source files, a blocked .env and a database file reference. */
export function makeWorkspace(root: string): string {
  const ws = path.join(root, "ws");
  mkdirSync(path.join(ws, "src"), { recursive: true });
  mkdirSync(path.join(ws, "docs"), { recursive: true });
  writeFileSync(path.join(ws, "README.md"), "# Sample\nOrder service.\n");
  writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "sample", version: "1.0.0" }));
  writeFileSync(
    path.join(ws, "src", "orders.ts"),
    "export function calculateTotal(items: number[]): number {\n  // reads the orders table and calls /health and /items\n  return items.reduce((a, b) => a + b, 0);\n}\nconst sql = 'SELECT * FROM orders';\n",
  );
  writeFileSync(path.join(ws, "src", "checkout.ts"), "import { calculateTotal } from './orders';\nexport const checkoutFlow = () => calculateTotal([1]);\n");
  writeFileSync(path.join(ws, "docs", "api.md"), "GET /health returns status. GET /items/{id} returns an item.\n");
  writeFileSync(path.join(ws, ".env"), `calculateTotal=${ENV_CANARY}\norders=${ENV_CANARY}\n`);
  git(ws, "init", "-q", "-b", "main");
  git(ws, "add", "README.md", "package.json", "src", "docs");
  git(ws, "commit", "-q", "-m", "initial commit");
  return ws;
}

export function tmpDir(prefix = "dwmcp-wf-"): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

/** Recursive content hash of a directory (all files, including .git), used to prove nothing was written. */
export function hashTree(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string): void => {
    for (const n of readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) {
        h.update(`D:${path.relative(dir, p)}\n`);
        walk(p);
      } else {
        h.update(`F:${path.relative(dir, p)}:${st.size}\n`).update(readFileSync(p));
      }
    }
  };
  walk(dir);
  return h.digest("hex");
}

export interface WorkflowConfigOptions {
  tmp: string;
  ws: string;
  fs?: boolean;
  dbPath?: string;
  api?: Record<string, unknown>;
  github?: Record<string, unknown>;
  linkGithub?: boolean;
  server?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export function workflowConfig(o: WorkflowConfigOptions): Record<string, unknown> {
  const databases = o.dbPath !== undefined ? [{ name: "sample", type: "sqlite", enabled: true, databasePath: o.dbPath, readOnly: true }] : [];
  const customApis = o.api !== undefined ? [o.api] : [];
  return {
    server: { logLevel: "debug", ...(o.server ?? {}) },
    filesystem: { enabled: o.fs !== false, allowedRoots: [o.tmp, ...(o.dbPath !== undefined ? [] : [])] },
    workspaces: [
      {
        id: "main",
        name: "Main",
        rootPath: o.ws,
        ...(o.linkGithub !== false && o.github !== undefined ? { github: "octo/hello" } : {}),
        databases: databases.map((d) => d.name),
        apis: customApis.map((a) => String(a["name"])),
      },
    ],
    databases,
    customApis,
    ...(o.github !== undefined ? { github: { enabled: true, tokenEnv: "DEVWS_T_GH", allowedRepositories: ["octo/hello"], ...o.github } } : {}),
    ...(o.extra ?? {}),
  };
}

export interface Harness {
  call(tool: string, args: Record<string, unknown>): Promise<Res & { raw: string }>;
  names: string[];
  audit: AuditEntry[];
  logs: string[];
  registered: Map<string, { annotations?: Record<string, unknown>; outputSchema?: unknown }>;
}

export function harness(
  cfg: Record<string, unknown>,
  opts: { mock?: GithubMock; env?: Record<string, string | undefined>; limits?: Partial<typeof DEFAULT_LIMITS> } = {},
): Harness {
  type Fn = (a: unknown, extra?: unknown) => Promise<{ content: { text: string }[] }>;
  const handlers = new Map<string, { schema: { safeParse(v: unknown): { success: boolean; data?: unknown } }; fn: Fn }>();
  const registered = new Map<string, { annotations?: Record<string, unknown>; outputSchema?: unknown }>();
  const server = {
    server: {},
    registerTool: (name: string, c: { inputSchema?: { safeParse(v: unknown): { success: boolean; data?: unknown } }; annotations?: Record<string, unknown>; outputSchema?: unknown }, fn: Fn) => {
      handlers.set(name, { schema: c.inputSchema ?? { safeParse: (v) => ({ success: true, data: v }) }, fn });
      registered.set(name, { annotations: c.annotations, outputSchema: c.outputSchema });
    },
  } as unknown as McpServer;
  const audit: AuditEntry[] = [];
  const auditLog = createAuditLog();
  const real = auditLog.record.bind(auditLog);
  auditLog.record = (e) => (audit.push(e as AuditEntry), real(e));
  const logs: string[] = [];
  const env = opts.env ?? {};
  const redactor = createRedactor({ secretValues: Object.values(env).filter((v): v is string => v !== undefined) });
  const deps: ServerDeps = {
    config: parseConfigText(JSON.stringify(cfg)),
    limits: { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) },
    logger: createLogger({ level: "debug", redactor, write: (l) => logs.push(l) }),
    audit: auditLog,
    redactor,
    startedAtMs: Date.now(),
    ...(opts.mock !== undefined ? { githubFetch: opts.mock.fetch } : {}),
    githubGetEnv: (n) => env[n],
  };
  const names = registerTools(server, deps);
  return {
    names,
    audit,
    logs,
    registered,
    async call(tool, args) {
      const h = handlers.get(tool);
      if (h === undefined) throw new Error(`not registered: ${tool}`);
      const parsed = h.schema.safeParse(args);
      if (!parsed.success) return { success: false, error: { code: "INVALID_INPUT", message: "schema" }, raw: "" };
      const r = await h.fn(parsed.data, {});
      const raw = r.content[0]?.text ?? "{}";
      return { ...(JSON.parse(raw) as Res), raw };
    },
  };
}

export const WORKFLOW_TOOLS = [
  "workspace_find_issue_context",
  "workspace_generate_change_plan",
  "workspace_get_overview",
  "workspace_inspect_data_flow",
  "workspace_summarize_activity",
];
export const workflowNames = (names: string[]): string[] => names.filter((n) => n.startsWith("workspace_")).sort();
