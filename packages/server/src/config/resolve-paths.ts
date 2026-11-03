import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Config } from "./schema.js";
import { ConfigError } from "./errors.js";

/** Resolve against the config directory (never cwd) and normalise. */
function abs(p: string, configDir: string): string {
  return path.resolve(configDir, p);
}

/** realpath of the nearest existing ancestor, with the missing tail re-appended. */
function realpathLoose(p: string): string {
  let current = p;
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return p;
    tail.unshift(path.basename(current));
    current = parent;
  }
  return path.join(realpathSync(current), ...tail);
}

function isInside(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Returns a copy of the config with every path made absolute and
 * symlink-resolved. Throws ConfigError when a workspace root does not exist or
 * lies outside every allowed root (D10).
 */
export function resolveConfigPaths(config: Config, configDir: string): Config {
  const issues: { path: string; message: string }[] = [];

  const allowedRoots = config.filesystem.allowedRoots.map((r, i) => {
    const full = abs(r, configDir);
    if (!existsSync(full)) {
      if (config.filesystem.enabled) {
        issues.push({ path: `$.filesystem.allowedRoots[${i}]`, message: "directory does not exist" });
      }
      return realpathLoose(full);
    }
    return realpathSync(full);
  });

  const workspaces = config.workspaces.map((w, i) => {
    const full = abs(w.rootPath, configDir);
    if (!existsSync(full)) {
      issues.push({ path: `$.workspaces[${i}].rootPath`, message: "directory does not exist" });
      return { ...w, rootPath: full };
    }
    const real = realpathSync(full);
    if (!allowedRoots.some((root) => isInside(real, root))) {
      issues.push({
        path: `$.workspaces[${i}].rootPath`,
        message: "must resolve inside one of filesystem.allowedRoots",
      });
    }
    return { ...w, rootPath: real };
  });

  if (issues.length > 0) throw new ConfigError(issues);

  return {
    ...config,
    server: {
      ...config.server,
      ...(config.server.auditLogPath !== undefined
        ? { auditLogPath: realpathLoose(abs(config.server.auditLogPath, configDir)) }
        : {}),
    },
    workspaces,
    filesystem: { ...config.filesystem, allowedRoots },
    databases: config.databases.map((d) =>
      d.type === "sqlite" ? { ...d, databasePath: realpathLoose(abs(d.databasePath, configDir)) } : d,
    ),
  };
}
