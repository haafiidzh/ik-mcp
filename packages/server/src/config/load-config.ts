import { readFileSync } from "node:fs";
import path from "node:path";
import { configSchema, type Config } from "./schema.js";
import { ConfigError } from "./errors.js";
import { resolveConfigPaths } from "./resolve-paths.js";

export { ConfigError, type ConfigIssue } from "./errors.js";

export interface LoadedConfig {
  config: Config;
  /** Absolute path of the config file. */
  configPath: string;
  /** Absolute directory of the config file; base for relative paths. */
  configDir: string;
}

export interface LoadConfigOptions {
  argv?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
}

export function formatJsonPath(segments: readonly PropertyKey[]): string {
  let out = "$";
  for (const s of segments) {
    out += typeof s === "number" ? `[${s}]` : `.${String(s)}`;
  }
  return out;
}

/** Extracts `--config <path>` or `--config=<path>`; undefined when absent. */
export function parseConfigArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new ConfigError([{ path: "--config", message: "requires a file path argument" }]);
      }
      return next;
    }
    if (a !== undefined && a.startsWith("--config=")) {
      const v = a.slice("--config=".length);
      if (v === "") throw new ConfigError([{ path: "--config", message: "requires a file path argument" }]);
      return v;
    }
  }
  return undefined;
}

/** Parse + validate raw JSON text (no path resolution, no filesystem). */
export function parseConfigText(text: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // JSON.parse messages can quote file content; do not forward them.
    throw new ConfigError([{ path: "$", message: "file is not valid JSON" }]);
  }
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((i) => ({ path: formatJsonPath(i.path), message: i.message })),
    );
  }
  return result.data;
}

const HINT = "pass --config <path> or set DEVWORKSPACE_CONFIG (see config/devworkspace.example.json)";

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const chosen = parseConfigArg(argv) ?? (env["DEVWORKSPACE_CONFIG"] || undefined);
  if (chosen === undefined) {
    throw new ConfigError([{ path: "config file", message: `no config file specified: ${HINT}` }]);
  }
  const configPath = path.resolve(cwd, chosen);

  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    throw new ConfigError([{ path: "config file", message: `cannot read '${configPath}': check the path and permissions` }]);
  }

  const parsed = parseConfigText(text);
  const configDir = path.dirname(configPath);
  return { config: resolveConfigPaths(parsed, configDir), configPath, configDir };
}
