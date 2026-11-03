import { readFileSync } from "node:fs";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";
import type { Config } from "../config/schema.js";
import type { Limits } from "../core/limits.js";

/** Pack enablement derived from config. Names only; never paths, hosts or env values. */
export interface PackState {
  database: boolean;
  github: boolean;
  customApi: boolean;
  filesystem: boolean;
  workflows: boolean;
}

export function resolvePackState(config: Config): PackState {
  return {
    database: config.databases.some((d) => d.enabled),
    github: config.github.enabled,
    customApi: config.customApis.some((a) => a.enabled),
    filesystem: config.filesystem.enabled,
    // Workflows (Phase 5) have no config switch yet; they stay off until implemented.
    workflows: false,
  };
}

let cachedVersion: string | undefined;

/** Package version; package.json is two levels above both src/server and dist/server. */
export function readServerVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const raw: unknown = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    const v = (raw as { version?: unknown }).version;
    cachedVersion = typeof v === "string" ? v : "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

export interface StatusData {
  server: { name: string; version: string };
  protocol: { latest: string; supported: string[] };
  packs: PackState;
  allowWrites: boolean;
  uptimeSeconds: number;
  limits: Limits;
}

export interface StatusInput {
  config: Config;
  limits: Limits;
  startedAtMs: number;
  nowMs?: number;
  version?: string;
}

/** Build the status payload. Only whitelisted, non-sensitive fields are copied. */
export function buildStatus(input: StatusInput): StatusData {
  const now = input.nowMs ?? Date.now();
  return {
    server: { name: input.config.server.name, version: input.version ?? readServerVersion() },
    protocol: { latest: LATEST_PROTOCOL_VERSION, supported: [...SUPPORTED_PROTOCOL_VERSIONS] },
    packs: resolvePackState(input.config),
    allowWrites: input.config.permissions.allowWrites,
    uptimeSeconds: Math.max(0, Math.floor((now - input.startedAtMs) / 1000)),
    limits: { ...input.limits },
  };
}
