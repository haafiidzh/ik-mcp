import { z } from "zod";
import { ok } from "../../core/response.js";
import { READ_ONLY_ANNOTATIONS, type DbToolContext } from "./shared.js";

export function registerDbListConnections(ctx: DbToolContext): void {
  ctx.server.registerTool(
    "db_list_connections",
    {
      title: "List database connections",
      description:
        "Read-only. Lists the enabled database connections configured for this server: name, type (sqlite or postgres), enabled and readOnly. Takes no input. Never returns hosts, users, passwords, paths or connection strings.",
      inputSchema: z.strictObject({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    () =>
      ctx.plain("db_list_connections", () => {
        const names = new Set(ctx.registry.names());
        const items = ctx.deps.config.databases
          .filter((d) => d.enabled && names.has(d.name))
          .map((d) => ({ name: d.name, type: d.type, enabled: d.enabled, readOnly: d.readOnly }));
        return ok(items, { source: "database", returnedCount: items.length });
      }),
  );
}
