import { McpServer } from "@modelcontextprotocol/server";
import { registerPrompts } from "./register-prompts.js";
import { registerResources } from "./register-resources.js";
import { registerTools, type ServerDeps } from "./register-tools.js";
import { readServerVersion } from "./status.js";

/** Build a fully registered McpServer. Called once per connection by serveStdio. */
export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: deps.config.server.name, version: readServerVersion() });
  const tools = registerTools(server, deps);
  const resources = registerResources(server, deps);
  const prompts = registerPrompts(server, deps);
  deps.logger.info("server created", { tools: tools.length, resources: resources.length, prompts: prompts.length });
  return server;
}
