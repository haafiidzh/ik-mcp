import type { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { DatabaseRegistry } from "../../integrations/database/database.registry.js";
import { createLocalGit } from "../../integrations/git/local-git.js";
import type { FilesystemService } from "../../integrations/filesystem/filesystem.service.js";
import type { ServerDeps } from "../../server/register-tools.js";
import { createDataFlowApiPort, type SharedServices } from "../../server/shared-services.js";
import type { PackState } from "../../server/status.js";
import type { PlanApiProfile } from "../../workflows/change-plan.js";
import type { RunTool } from "../github/shared.js";
import { buildWorkspaceChangePlanTool } from "./workspace-change-plan.js";
import { buildWorkspaceDataFlowTool } from "./workspace-data-flow.js";
import { buildWorkspaceIssueContextTool, issueContextInput, type WorkflowToolDef } from "./workspace-issue-context.js";
import { buildWorkspaceActivityTool } from "./workspace-activity.js";
import { buildWorkspaceOverviewTool } from "./workspace-overview.js";

/** Filesystem service that is created on first call (the real one is async); same instance as the fs_* tools. */
function lazyFs(shared: SharedServices): Pick<FilesystemService, "searchContent" | "searchFiles"> {
  return {
    searchContent: async (...a) => (await shared.fs()).searchContent(...a),
    searchFiles: async (...a) => (await shared.fs()).searchFiles(...a),
  };
}

function registerDef(server: McpServer, deps: ServerDeps, runTool: RunTool, def: WorkflowToolDef<typeof issueContextInput>): string {
  server.registerTool(
    def.name,
    { title: def.title, description: def.description, inputSchema: def.inputSchema, annotations: def.annotations },
    (a: z.infer<typeof issueContextInput>, extra: unknown) => {
      const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
      return runTool(deps, def.name, "workflow", () => def.handler(a, signal ? { signal } : {}), def.resourceRef(a));
    },
  );
  return def.name;
}

/**
 * Registers the composite workflow tools whose required packs are enabled (doc 04 §5). Workflows use
 * the SAME service instances as the pack tools (deps.shared); a disabled pack's service is omitted so
 * its sections report "disabled". Never grants authority: links come from config only.
 */
export function registerWorkflowTools(
  server: McpServer,
  deps: ServerDeps,
  runTool: RunTool,
  packs: PackState,
  registry: DatabaseRegistry | undefined,
): string[] {
  const shared = deps.shared;
  if (shared === undefined) return [];
  const names: string[] = [];
  const c = deps.config;
  const gh = packs.github ? shared.github() : undefined;
  const apiProfiles: PlanApiProfile[] = c.customApis.map((a) => ({ name: a.name, enabled: a.enabled, endpoints: a.endpoints.map((e) => ({ name: e.name, method: e.method, path: e.path, description: e.description, permission: e.permission === "write" ? "write" : "read" })) }));

  if (packs.filesystem) {
    const git = createLocalGit({ allowedRoots: c.filesystem.allowedRoots });
    const t = buildWorkspaceOverviewTool({
      deps,
      runTool,
      services: async () => ({
        fs: await shared.fs(),
        github: gh,
        databaseRegistry: packs.database ? registry : undefined,
        api: packs.customApi ? shared.api() : undefined,
        git,
      }),
    });
    server.registerTool(t.name, t.config, t.handler);
    names.push(t.name);
  }
  if (packs.github) {
    const t = buildWorkspaceActivityTool({ deps, runTool, github: () => shared.github() });
    server.registerTool(t.name, t.config, t.handler);
    names.push(t.name);
  }
  if (packs.github && packs.filesystem) {
    const evidence = {
      github: shared.github(),
      filesystem: lazyFs(shared),
      limits: { workflowTimeoutMs: deps.limits.workflowTimeoutMs, maxSnippetChars: deps.limits.maxSnippetChars },
      redactor: deps.redactor,
      maxResponseBytes: deps.limits.maxResponseBytes,
    };
    names.push(registerDef(server, deps, runTool, buildWorkspaceIssueContextTool({ ...evidence, workspaces: c.workspaces })));
    names.push(
      registerDef(
        server,
        deps,
        runTool,
        buildWorkspaceChangePlanTool({
          ...evidence,
          workspaces: c.workspaces,
          database: packs.database ? registry : undefined,
          apiProfiles: packs.customApi ? apiProfiles : undefined,
        }),
      ),
    );
  }
  if (packs.filesystem && (packs.database || packs.customApi)) {
    const t = buildWorkspaceDataFlowTool({
      deps,
      runTool,
      workflow: {
        workspaces: c.workspaces,
        fs: lazyFs(shared),
        db: packs.database ? registry : undefined,
        api: packs.customApi ? createDataFlowApiPort(c) : undefined,
        limits: deps.limits,
      },
    });
    server.registerTool(t.name, t.definition, t.handler);
    names.push(t.name);
  }
  return names;
}
