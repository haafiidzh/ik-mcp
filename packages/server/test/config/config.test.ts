import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfigText } from "../../src/config/load-config.js";
import { DEFAULT_LIMITS, resolveLimits } from "../../src/core/limits.js";

const examplePath = path.resolve(import.meta.dirname, "../../config/devworkspace.example.json");
const example = (): Record<string, unknown> => JSON.parse(readFileSync(examplePath, "utf8")) as Record<string, unknown>;

function issuesOf(raw: unknown): string {
  try {
    parseConfigText(JSON.stringify(raw));
  } catch (e) {
    if (e instanceof ConfigError) return e.message;
    throw e;
  }
  return "";
}

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "dwmcp-cfg-")));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeCfg(dir: string, raw: unknown, file = "devworkspace.json"): string {
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, file);
  writeFileSync(p, JSON.stringify(raw));
  return p;
}

describe("example config", () => {
  it("validates and enables only the filesystem pack", () => {
    const c = parseConfigText(readFileSync(examplePath, "utf8"));
    expect(c.filesystem.enabled).toBe(true);
    expect(c.databases.filter((d) => d.enabled).map((d) => d.name)).toEqual([]);
    expect(c.workspaces.map((w) => w.id)).toEqual(["sample-project"]);
    expect(c.github.enabled).toBe(false);
    expect(c.customApis.every((a) => !a.enabled)).toBe(true);
    expect(c.permissions.allowWrites).toBe(false);
  });
});

describe("defaults", () => {
  it("empty config is valid, everything disabled, writes off", () => {
    const c = parseConfigText("{}");
    expect(c.permissions).toEqual({ defaultMode: "read-only", allowWrites: false, writeOperations: [] });
    expect(c.filesystem.enabled).toBe(false);
    expect(c.github.enabled).toBe(false);
    expect(c.databases).toEqual([]);
  });
  it("entries default to enabled=false", () => {
    const c = parseConfigText(
      JSON.stringify({
        databases: [{ name: "a", type: "sqlite", databasePath: "x.db" }],
        customApis: [{ name: "b", baseUrl: "https://example.com" }],
      }),
    );
    expect(c.databases[0]?.enabled).toBe(false);
    expect(c.customApis[0]?.enabled).toBe(false);
    expect(c.customApis[0]?.allowPrivateNetwork).toBe(false);
  });
});

describe("required fields name a JSON path", () => {
  const cases: [string, (c: Record<string, unknown[]>) => void, string][] = [
    ["sqlite databasePath", (c) => delete (c["databases"]?.[0] as Record<string, unknown>)["databasePath"], "$.databases[0].databasePath"],
    ["database name", (c) => delete (c["databases"]?.[0] as Record<string, unknown>)["name"], "$.databases[0].name"],
    ["database type", (c) => delete (c["databases"]?.[0] as Record<string, unknown>)["type"], "$.databases[0]"],
    ["workspace id", (c) => delete (c["workspaces"]?.[0] as Record<string, unknown>)["id"], "$.workspaces[0].id"],
    ["workspace rootPath", (c) => delete (c["workspaces"]?.[0] as Record<string, unknown>)["rootPath"], "$.workspaces[0].rootPath"],
    ["api baseUrl", (c) => delete (c["customApis"]?.[0] as Record<string, unknown>)["baseUrl"], "$.customApis[0].baseUrl"],
    ["endpoint path", (c) => delete ((c["customApis"]?.[0] as { endpoints: Record<string, unknown>[] }).endpoints[0] as Record<string, unknown>)["path"], "$.customApis[0].endpoints[0].path"],
  ];
  it.each(cases)("%s", (_label, mutate, expected) => {
    const c = example() as Record<string, unknown[]>;
    mutate(c);
    expect(issuesOf(c)).toContain(expected);
  });
});

describe("strictness and rules", () => {
  it("rejects unknown keys at every level", () => {
    const top = { ...example(), allowWrite: true };
    expect(issuesOf(top)).toContain("allowWrite");
    const nested = example();
    (nested["permissions"] as Record<string, unknown>)["allowWrties"] = true;
    expect(issuesOf(nested)).toContain("$.permissions");
  });
  it("rejects readOnly:false", () => {
    const c = example();
    (c["databases"] as Record<string, unknown>[])[0]!["readOnly"] = false;
    expect(issuesOf(c)).toContain("$.databases[0].readOnly");
  });
  it("rejects unknown workspace links and duplicate names", () => {
    const c = example();
    (c["workspaces"] as { databases: string[] }[])[0]!.databases = ["nope"];
    expect(issuesOf(c)).toContain("$.workspaces[0].databases[0]");
    const d = example();
    (d["databases"] as unknown[]).push((d["databases"] as unknown[])[0]);
    expect(issuesOf(d)).toContain("duplicate database connection name");
  });
  it("validates baseUrl and path placeholders", () => {
    const c = example();
    const api = (c["customApis"] as Record<string, unknown>[])[0]!;
    api["baseUrl"] = "http://user:pw@127.0.0.1:3001/?a=1";
    const msg = issuesOf(c);
    expect(msg).toContain("$.customApis[0].baseUrl");
    expect(msg).not.toContain("pw@");
    const d = example();
    const ep = ((d["customApis"] as { endpoints: Record<string, unknown>[] }[])[0]!).endpoints[0]!;
    ep["path"] = "/items/{id}";
    expect(issuesOf(d)).toContain("'{id}' is not declared");
  });
});

describe("S20 secrets in config", () => {
  const canary = "ghp_CANARYsecretvalue1234567890";
  it("rejects inline secret keys and never echoes the value", () => {
    const c = example();
    (c["github"] as Record<string, unknown>)["token"] = canary;
    const msg = issuesOf(c);
    expect(msg).toContain("$.github");
    expect(msg).not.toContain(canary);
  });
  it("rejects a secret value placed in a *Env field and never echoes it", () => {
    const c = example();
    (c["github"] as Record<string, unknown>)["tokenEnv"] = canary;
    const msg = issuesOf(c);
    expect(msg).toContain("$.github.tokenEnv");
    expect(msg).not.toContain(canary);
  });
  it("invalid JSON error does not echo file content", () => {
    expect(() => parseConfigText(`{"a": "${canary}" oops`)).toThrow(/not valid JSON/);
    try {
      parseConfigText(`{"a": "${canary}" oops`);
    } catch (e) {
      expect((e as Error).message).not.toContain(canary);
    }
  });
});

describe("loadConfig discovery", () => {
  it("errors with a hint when neither flag nor env is set", () => {
    expect(() => loadConfig({ argv: [], env: {}, cwd: tmp })).toThrow(/--config.*DEVWORKSPACE_CONFIG/);
  });
  it("--config wins over DEVWORKSPACE_CONFIG", () => {
    const a = writeCfg(path.join(tmp, "a"), { server: { name: "from-flag" } });
    const b = writeCfg(path.join(tmp, "b"), { server: { name: "from-env" } });
    expect(loadConfig({ argv: ["--config", a], env: { DEVWORKSPACE_CONFIG: b }, cwd: "/" }).config.server.name).toBe("from-flag");
    expect(loadConfig({ argv: [`--config=${a}`], env: {}, cwd: "/" }).config.server.name).toBe("from-flag");
    expect(loadConfig({ argv: [], env: { DEVWORKSPACE_CONFIG: b }, cwd: "/" }).config.server.name).toBe("from-env");
  });
  it("reports unreadable file", () => {
    expect(() => loadConfig({ argv: ["--config", path.join(tmp, "missing.json")], env: {}, cwd: tmp })).toThrow(ConfigError);
  });
});

describe("path resolution", () => {
  function layout(): string {
    const dir = path.join(tmp, "cfg");
    mkdirSync(path.join(dir, "workspace/proj"), { recursive: true });
    return writeCfg(dir, {
      server: { auditLogPath: "./.devworkspace/audit.jsonl" },
      workspaces: [{ id: "p", name: "P", rootPath: "./workspace/proj" }],
      filesystem: { enabled: true, allowedRoots: ["./workspace"] },
      databases: [{ name: "db", type: "sqlite", enabled: true, databasePath: "./data/s.db" }],
    });
  }
  it("resolves relative paths against the config dir, not cwd", () => {
    const p = layout();
    const other = path.join(tmp, "elsewhere");
    mkdirSync(other);
    const { config, configDir } = loadConfig({ argv: ["--config", p], env: {}, cwd: other });
    expect(configDir).toBe(path.join(tmp, "cfg"));
    expect(config.workspaces[0]?.rootPath).toBe(path.join(tmp, "cfg/workspace/proj"));
    expect(config.filesystem.allowedRoots).toEqual([path.join(tmp, "cfg/workspace")]);
    const db = config.databases[0];
    expect(db?.type === "sqlite" && db.databasePath).toBe(path.join(tmp, "cfg/data/s.db"));
    expect(config.server.auditLogPath).toBe(path.join(tmp, "cfg/.devworkspace/audit.jsonl"));
  });
  it("rejects a workspace outside allowedRoots", () => {
    const dir = path.join(tmp, "cfg2");
    mkdirSync(path.join(dir, "workspace"), { recursive: true });
    mkdirSync(path.join(dir, "other"), { recursive: true });
    const p = writeCfg(dir, {
      workspaces: [{ id: "p", name: "P", rootPath: "./other" }],
      filesystem: { enabled: true, allowedRoots: ["./workspace"] },
    });
    expect(() => loadConfig({ argv: ["--config", p], env: {}, cwd: tmp })).toThrow(/\$\.workspaces\[0\]\.rootPath: must resolve inside/);
  });
  it("rejects a workspace that escapes via symlink (realpath)", () => {
    const dir = path.join(tmp, "cfg3");
    mkdirSync(path.join(dir, "workspace"), { recursive: true });
    mkdirSync(path.join(dir, "outside"), { recursive: true });
    symlinkSync(path.join(dir, "outside"), path.join(dir, "workspace/link"));
    const p = writeCfg(dir, {
      workspaces: [{ id: "p", name: "P", rootPath: "./workspace/link" }],
      filesystem: { enabled: true, allowedRoots: ["./workspace"] },
    });
    expect(() => loadConfig({ argv: ["--config", p], env: {}, cwd: tmp })).toThrow(ConfigError);
  });
});

describe("limits overrides (P0-08)", () => {
  const withLimits = (limits: unknown): Record<string, unknown> => ({ ...example(), limits });

  it("defaults come from core (single source)", () => {
    const cfg = parseConfigText(JSON.stringify({ ...example(), limits: {} }));
    expect(cfg.limits).toEqual({});
    expect(resolveLimits(cfg.limits)).toEqual(DEFAULT_LIMITS);
  });

  it("accepts an override for every core key (tightening)", () => {
    const keys = Object.keys(DEFAULT_LIMITS) as (keyof typeof DEFAULT_LIMITS)[];
    for (const key of keys) {
      const value = DEFAULT_LIMITS[key] > 0 ? DEFAULT_LIMITS[key] - 1 : 0;
      const cfg = parseConfigText(JSON.stringify(withLimits({ [key]: value })));
      expect(resolveLimits(cfg.limits)[key]).toBe(value);
    }
  });

  it("accepts redirect keys at their documented values", () => {
    const cfg = parseConfigText(JSON.stringify(withLimits({ maxRedirectsCustomApi: 0, maxRedirectsGithub: 2 })));
    expect(resolveLimits(cfg.limits)).toMatchObject({ maxRedirectsCustomApi: 0, maxRedirectsGithub: 2 });
  });

  it("rejects out-of-range values with the JSON path", () => {
    expect(issuesOf(withLimits({ maxRedirectsCustomApi: 1 }))).toContain("limits.maxRedirectsCustomApi");
    expect(issuesOf(withLimits({ maxRedirectsGithub: 4 }))).toContain("limits.maxRedirectsGithub");
    expect(issuesOf(withLimits({ githubPerPage: 101 }))).toContain("limits.githubPerPage");
    expect(issuesOf(withLimits({ githubPerPageMax: 101 }))).toContain("limits.githubPerPageMax");
    expect(issuesOf(withLimits({ dbMaxRows: 0 }))).toContain("limits.dbMaxRows");
    expect(issuesOf(withLimits({ dbMaxRows: 101 }))).toContain("limits.dbMaxRows");
    expect(issuesOf(withLimits({ bogus: 1 }))).toContain("limits");
  });
});
