import { ok } from "../core/response.js";
import { runResource, variable } from "./common.js";
import type { ResourceCtx } from "./index.js";

/** filesystem://{workspaceId}/tree: depth-limited tree through the filesystem service (guards, ignore dirs, limits). */
export function registerFilesystemResources({ server, deps, template }: ResourceCtx): string[] {
  const c = deps.config;
  const known = new Set(c.workspaces.map((w) => w.id));
  server.registerResource(
    "filesystem_tree",
    new template("filesystem://{workspaceId}/tree", {
      list: () => ({
        resources: c.workspaces.map((w) => ({ uri: `filesystem://${w.id}/tree`, name: `${w.id} file tree`, mimeType: "application/json" })),
      }),
    }),
    {
      title: "Workspace file tree",
      description: "Read-only directory tree (depth 3, bounded) of a configured workspace. Blocked and ignored paths are never shown.",
      mimeType: "application/json",
    },
    (uri, vars) => {
      const raw = vars["workspaceId"];
      const ref = typeof raw === "string" && known.has(raw) ? raw : "unknown-workspace";
      return runResource(deps, "filesystem_tree", "filesystem", ref, uri, async () => {
        const id = variable(vars, "workspaceId");
        const shared = deps.shared;
        if (shared === undefined) throw new Error("services unavailable");
        const fs = await shared.fs();
        const r = await fs.getDirectoryTree(id, ".", Math.min(3, deps.limits.maxTreeDepth));
        return ok(r.data, { ...r.meta, source: "resource:filesystem_tree" }, r.warnings);
      });
    },
  );
  return ["filesystem_tree"];
}
