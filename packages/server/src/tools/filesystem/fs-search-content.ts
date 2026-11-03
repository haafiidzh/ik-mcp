import { z } from "zod";
import { limitField, optionalPathField, READ_ONLY_ANNOTATIONS, workspaceField, type FsToolContext } from "./shared.js";

const input = z.strictObject({
  workspace: workspaceField,
  query: z.string().min(1).max(200).describe("Literal text to find (not a regular expression)."),
  path: optionalPathField,
  caseSensitive: z.boolean().optional(),
  extensions: z.array(z.string().min(1).max(16)).max(20).optional().describe("Only search files with these extensions."),
  limit: limitField,
});

export function registerFsSearchContent(ctx: FsToolContext): void {
  ctx.server.registerTool(
    "fs_search_content",
    {
      title: "Search file contents",
      description:
        "Read-only. Finds a literal string inside text files of a configured workspace and returns relative path, line number and a short snippet. Required: workspace, query (literal, not a regex). Optional: path, caseSensitive, extensions, limit (capped; truncation and partial scans are reported in meta). Binary, blocked and ignored files are skipped. Bounded by depth, files scanned and a time limit.",
      inputSchema: input,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (a) =>
      ctx.run("fs_search_content", a.workspace, (s) =>
        s.searchContent(a.workspace, a.query, {
          ...(a.path !== undefined ? { path: a.path } : {}),
          ...(a.caseSensitive !== undefined ? { caseSensitive: a.caseSensitive } : {}),
          ...(a.extensions !== undefined ? { extensions: a.extensions } : {}),
          ...(a.limit !== undefined ? { limit: a.limit } : {}),
        }),
      ),
  );
}
