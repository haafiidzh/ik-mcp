import type { McpServer } from "@modelcontextprotocol/server";
import type { McpToolResult, ToolResult } from "../../core/response.js";
import type { ServerDeps } from "../../server/register-tools.js";
import { registerFsGetDirectoryTree } from "./fs-get-directory-tree.js";
import { registerFsGetFileInfo } from "./fs-get-file-info.js";
import { registerFsListDirectory } from "./fs-list-directory.js";
import { registerFsReadFile } from "./fs-read-file.js";
import { registerFsSearchContent } from "./fs-search-content.js";
import { registerFsSearchFiles } from "./fs-search-files.js";
import { buildFsContext } from "./shared.js";

type RunTool = (
  deps: ServerDeps,
  tool: string,
  integration: string,
  handler: () => Promise<ToolResult> | ToolResult,
  resourceRef?: string,
) => Promise<McpToolResult>;

/** Registers the six read-only fs_* tools. Call only when the filesystem pack is enabled. */
export function registerFilesystemTools(server: McpServer, deps: ServerDeps, runTool: RunTool): string[] {
  const ctx = buildFsContext(server, deps, runTool);
  registerFsListDirectory(ctx);
  registerFsGetFileInfo(ctx);
  registerFsReadFile(ctx);
  registerFsSearchFiles(ctx);
  registerFsSearchContent(ctx);
  registerFsGetDirectoryTree(ctx);
  return [
    "fs_list_directory",
    "fs_get_file_info",
    "fs_read_file",
    "fs_search_files",
    "fs_search_content",
    "fs_get_directory_tree",
  ];
}
