import { z } from "zod";
import { READ_ONLY_ANNOTATIONS, requiredPathField, workspaceField, type FsToolContext } from "./shared.js";

const input = z.strictObject({
  workspace: workspaceField,
  path: requiredPathField,
  startLine: z.number().int().min(1).optional().describe("First line to return (1-based)."),
  endLine: z.number().int().min(1).optional().describe("Last line to return (inclusive)."),
});

export function registerFsReadFile(ctx: FsToolContext): void {
  ctx.server.registerTool(
    "fs_read_file",
    {
      title: "Read file",
      description:
        "Read-only. Reads a UTF-8 text file inside a configured workspace, optionally a line range. Required: workspace, path (relative). Optional: startLine, endLine. Content beyond the maximum file size is cut and flagged truncated (also in meta). Binary files return UNSUPPORTED; blocked files (such as .env, keys) return PERMISSION_DENIED without content. Absolute paths and .. are rejected.",
      inputSchema: input,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (a) => ctx.run("fs_read_file", a.workspace, (s) => s.readFile(a.workspace, a.path, a.startLine, a.endLine)),
  );
}
