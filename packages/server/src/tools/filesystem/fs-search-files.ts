import { z } from "zod";
import { limitField, optionalPathField, READ_ONLY_ANNOTATIONS, workspaceField, type FsToolContext } from "./shared.js";

const input = z.strictObject({
  workspace: workspaceField,
  pattern: z.string().min(1).max(200).describe("Glob or substring matched against file names."),
  path: optionalPathField,
  limit: limitField,
});

export function registerFsSearchFiles(ctx: FsToolContext): void {
  ctx.server.registerTool(
    "fs_search_files",
    {
      title: "Search files by name",
      description:
        "Read-only. Finds files and directories by name (glob or substring) inside a configured workspace. Required: workspace, pattern. Optional: path (relative start directory), limit (capped; truncation and partial scans are reported in meta). Blocked and ignored paths are never returned. Bounded by depth, files scanned and a time limit.",
      inputSchema: input,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (a) => ctx.run("fs_search_files", a.workspace, (s) => s.searchFiles(a.workspace, a.pattern, a.path, a.limit)),
  );
}
