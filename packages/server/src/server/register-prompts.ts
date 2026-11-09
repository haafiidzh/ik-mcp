import type { McpServer } from "@modelcontextprotocol/server";
import { availableTools, PROMPTS } from "../prompts/prompts.js";
import type { ServerDeps } from "./register-tools.js";
import { resolvePackState } from "./status.js";

/** Prompts are static templates. A prompt whose required pack is disabled is not registered. */
export function registerPrompts(server: McpServer, deps: ServerDeps): string[] {
  const packs = resolvePackState(deps.config);
  const avail = availableTools(packs);
  const names: string[] = [];
  for (const p of PROMPTS) {
    if (!p.requires(packs)) continue;
    p.register(server, avail);
    names.push(p.name);
  }
  return names;
}
