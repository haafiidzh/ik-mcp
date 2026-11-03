import { z } from "zod";
import { limitField, optionalPathField, READ_ONLY_ANNOTATIONS, workspaceField, type FsToolContext } from "./shared.js";

const input = z.strictObject({ workspace: workspaceField, path: optionalPathField, limit: limitField });

export function registerFsListDirectory(ctx: FsToolContext): void {
  ctx.server.registerTool(
    "fs_list_directory",
    {
      title: "List directory",
      description:
        "Read-only. Lists the entries of one directory inside a configured workspace (name, type, size, mtime). Required: workspace. Optional: path (relative, default root), limit (capped by the server maximum; truncation is reported in meta). Blocked files (such as .env or keys) and ignored directories (such as node_modules, .git) are never listed. Only configured workspaces; absolute paths and .. are rejected.",
      inputSchema: input,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (a) => ctx.run("fs_list_directory", a.workspace, (s) => s.listDirectory(a.workspace, a.path, a.limit)),
  );
}
