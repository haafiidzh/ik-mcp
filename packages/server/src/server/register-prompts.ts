import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerDeps } from "./register-tools.js";
import { resolvePackState } from "./status.js";

/** Phase 6 skeleton. Prompts of a disabled pack are not registered. */
export function registerPrompts(_server: McpServer, deps: ServerDeps): string[] {
  const packs = resolvePackState(deps.config);
  void packs; // P6: register per-pack prompts behind packs.<name>
  return [];
}
