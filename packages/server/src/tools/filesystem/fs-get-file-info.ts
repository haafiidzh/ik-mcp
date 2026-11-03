import { z } from "zod";
import { READ_ONLY_ANNOTATIONS, requiredPathField, workspaceField, type FsToolContext } from "./shared.js";

const input = z.strictObject({ workspace: workspaceField, path: requiredPathField });

export function registerFsGetFileInfo(ctx: FsToolContext): void {
  ctx.server.registerTool(
    "fs_get_file_info",
    {
      title: "Get file info",
      description:
        "Read-only. Returns metadata for one file or directory inside a configured workspace (name, relative path, type, size, mtime, isText, extension) without reading its content. Required: workspace, path (relative). Blocked paths are denied; absolute paths and .. are rejected.",
      inputSchema: input,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (a) => ctx.run("fs_get_file_info", a.workspace, (s) => s.getFileInfo(a.workspace, a.path)),
  );
}
