import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerDeps } from "./register-tools.js";
import { resolvePackState } from "./status.js";

/** Phase 6 skeleton. Resources of a disabled pack are not registered. */
export function registerResources(_server: McpServer, deps: ServerDeps): string[] {
  const packs = resolvePackState(deps.config);
  void packs; // P6: register per-pack resources behind packs.<name>
  return [];
}
