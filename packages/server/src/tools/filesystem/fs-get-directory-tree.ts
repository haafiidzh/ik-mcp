import { z } from "zod";
import { optionalPathField, READ_ONLY_ANNOTATIONS, workspaceField, type FsToolContext } from "./shared.js";

const input = z.strictObject({
  workspace: workspaceField,
  path: optionalPathField,
  depth: z.number().int().min(1).optional().describe("Maximum depth; capped by the server maximum."),
});

export function registerFsGetDirectoryTree(ctx: FsToolContext): void {
  ctx.server.registerTool(
    "fs_get_directory_tree",
    {
      title: "Get directory tree",
      description:
        "Read-only. Returns a nested tree of a directory inside a configured workspace with counts. Required: workspace. Optional: path (relative, default root), depth (capped by the server maximum). Ignored directories (node_modules, .git, ...) and blocked files are omitted; symlinks are not followed. Output beyond the entry cap is truncated and flagged in meta.",
      inputSchema: input,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (a) => ctx.run("fs_get_directory_tree", a.workspace, (s) => s.getDirectoryTree(a.workspace, a.path, a.depth)),
  );
}
