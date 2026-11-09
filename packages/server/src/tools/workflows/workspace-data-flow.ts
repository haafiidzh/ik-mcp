import { z } from "zod";
import { fitToBudget, type McpToolResult } from "../../core/response.js";
import type { ServerDeps } from "../../server/register-tools.js";
import { DATA_FLOW_TOOL, inspectDataFlow, type DataFlowDeps } from "../../workflows/data-flow.js";
import type { RunTool } from "../github/shared.js";

export interface WorkspaceDataFlowToolDeps {
  deps: ServerDeps;
  runTool: RunTool;
  workflow: DataFlowDeps;
}

const workspaceField = z.string().min(1).max(2048).describe("Id of a configured workspace.");
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SLUG = /^[A-Za-z0-9_.-]{1,64}$/;

export const dataFlowInputSchema = z
  .strictObject({
    workspace: workspaceField,
    connection: z.string().min(1).max(2048).optional().describe("Name of a database connection linked to the workspace. Mutually exclusive with profile."),
    profile: z.string().min(1).max(2048).optional().describe("Name of a custom API profile linked to the workspace. Mutually exclusive with connection."),
  })
  .refine((a) => (a.connection === undefined) !== (a.profile === undefined), { message: "Provide exactly one of connection or profile." });

export type DataFlowArgs = z.infer<typeof dataFlowInputSchema>;

export interface WorkspaceDataFlowTool {
  name: typeof DATA_FLOW_TOOL;
  /** Pass to `server.registerTool(name, definition, handler)` in wave 2. */
  definition: {
    title: string;
    description: string;
    inputSchema: typeof dataFlowInputSchema;
    annotations: { readOnlyHint: true; destructiveHint: false; idempotentHint: true; openWorldHint: false };
  };
  handler: (args: DataFlowArgs) => Promise<McpToolResult>;
}

/** Thin tool: validate (zod) -> workflow -> response budget. Audit resourceRef = workspace id only. */
export function buildWorkspaceDataFlowTool(t: WorkspaceDataFlowToolDeps): WorkspaceDataFlowTool {
  const known = new Set(t.workflow.workspaces.map((w) => w.id));
  return {
    name: DATA_FLOW_TOOL,
    definition: {
      title: "Inspect data flow",
      description:
        "Read-only, deterministic. For one configured workspace and exactly one linked target (connection: a database connection, or profile: a custom API profile) lists the target's metadata (tables from the catalog, or configured endpoints; no table data is read and no endpoint is called) and the workspace files that mention each table name or endpoint path, with hit counts and short snippets. Sections: target, references, unknowns (what could not be determined). Blocked and ignored files are never searched. Results are capped and partial results are flagged in meta.",
      inputSchema: dataFlowInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler: (a) =>
      t.runTool(
        t.deps,
        DATA_FLOW_TOOL,
        "workflow",
        async () => fitToBudget(await inspectDataFlow(t.workflow, a), t.deps.limits.maxResponseBytes),
        known.has(a.workspace) && SLUG.test(a.workspace) && NAME.test(a.workspace) ? a.workspace : "unknown-workspace",
      ),
  };
}
