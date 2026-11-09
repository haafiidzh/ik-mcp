import { createLocalGit } from "../integrations/git/local-git.js";
import { fail, fitToBudget, ok } from "../core/response.js";
import type { PackState } from "../server/status.js";
import { getWorkspaceOverview } from "../workflows/workspace-overview.js";
import { runResource, variable } from "./common.js";
import type { ResourceCtx } from "./index.js";

export const WORKSPACE_LIST_URI = "workspace://list";

/** workspace://list and (filesystem pack) workspace://{workspaceId}/overview. */
export function registerWorkspaceResources({ server, deps, template }: ResourceCtx, packs: PackState): string[] {
  const c = deps.config;
  const names: string[] = [];

  server.registerResource(
    "workspace_list",
    WORKSPACE_LIST_URI,
    {
      title: "Configured workspaces",
      description: "Read-only. Workspace ids and names with the enabled integrations linked to each. No paths, hosts or secrets.",
      mimeType: "application/json",
    },
    (uri) =>
      runResource(deps, "workspace_list", "workspace", undefined, uri, () => {
        const dbEnabled = new Set(c.databases.filter((d) => d.enabled).map((d) => d.name));
        const apiEnabled = new Set(c.customApis.filter((a) => a.enabled).map((a) => a.name));
        const workspaces = c.workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          filesystem: packs.filesystem,
          github: packs.github && w.github !== undefined ? w.github : null,
          databases: w.databases.filter((d) => dbEnabled.has(d)),
          apis: w.apis.filter((a) => apiEnabled.has(a)),
        }));
        return ok({ workspaces, writesAllowed: c.permissions.allowWrites }, { source: "resource:workspace_list", returnedCount: workspaces.length });
      }),
  );
  names.push("workspace_list");

  if (packs.filesystem) {
    const known = new Set(c.workspaces.map((w) => w.id));
    server.registerResource(
      "workspace_overview",
      new template("workspace://{workspaceId}/overview", {
        list: () => ({
          resources: c.workspaces.map((w) => ({ uri: `workspace://${w.id}/overview`, name: `${w.id} overview`, mimeType: "application/json" })),
        }),
      }),
      {
        title: "Workspace overview",
        description: "Read-only, deterministic overview of one configured workspace (same output as workspace_get_overview).",
        mimeType: "application/json",
      },
      (uri, vars) => {
        let id: string;
        try {
          id = variable(vars, "workspaceId");
        } catch (err) {
          return runResource(deps, "workspace_overview", "workspace", "invalid", uri, () => fail(err));
        }
        return runResource(deps, "workspace_overview", "workspace", known.has(id) ? id : "unknown-workspace", uri, async () => {
          const shared = deps.shared;
          if (shared === undefined) throw new Error("services unavailable");
          const git = createLocalGit({ allowedRoots: c.filesystem.allowedRoots });
          const r = await getWorkspaceOverview(
            {
              workspaces: c.workspaces,
              databases: c.databases,
              fs: await shared.fs(),
              github: packs.github ? shared.github() : undefined,
              databaseRegistry: packs.database ? shared.databaseRegistry : undefined,
              api: packs.customApi ? shared.api() : undefined,
              git,
              redactor: deps.redactor,
              deadlineMs: deps.limits.workflowTimeoutMs,
              maxSnippetChars: deps.limits.maxSnippetChars,
            },
            id,
          );
          return fitToBudget(
            ok({ sections: r.sections }, { source: "resource:workspace_overview", partial: r.meta.partial, truncated: r.meta.truncated, returnedCount: r.sections.length, sectionsSummary: r.meta.sectionsSummary }),
            deps.limits.maxResponseBytes,
          );
        });
      },
    );
    names.push("workspace_overview");
  }
  return names;
}
