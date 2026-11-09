/**
 * workspace_generate_change_plan (doc 04 sections 5 and 6, PRD 7.5). A STRUCTURED SKELETON, proposed and
 * never applied: no file writes, no GitHub writes, no queries, no endpoint calls, no model.
 *
 * Evidence comes from the same pipeline as issue context (issue-context.ts). Optional enrichment:
 * - relatedSchema: only tables whose NAME appears (word boundary) in the evidence text, through the
 *   database registry (listTablesPage + describeTable metadata calls only);
 * - relatedEndpoints: only from configured API endpoint metadata (no call is ever made).
 * Steps are fixed templates. Only validated tokens (service file paths, safe terms, DB/config names)
 * are interpolated; free text from the issue appears only inside data fields (`issue`, `evidence`).
 */
import { AppError } from "../core/errors.js";
import type { DatabaseRegistry } from "../integrations/database/database.registry.js";
import type { DatabaseAdapter } from "../integrations/database/database.types.js";
import {
  createEvidencePipeline,
  type EvidenceData,
  type EvidenceDeps,
  type EvidenceFile,
  type IssueContextInput,
  type IssueSummary,
  type IssueTerms,
  type WorkspaceLink,
} from "./issue-context.js";
import { apiSource, databaseSource } from "./source-ref.js";
import { runSections, sectionOutput, type Section, type SectionSpec, type WorkflowResult } from "./workflow-core.js";

export const PLAN_LABEL = "proposed, not applied";

/** Registry slice used: enabled connection names and adapters (metadata methods only are called). */
export interface PlanDatabasePort {
  names: DatabaseRegistry["names"];
  get(name: unknown): Promise<Pick<DatabaseAdapter, "listTablesPage" | "describeTable">>;
}

/** Configured API metadata (config profile entries satisfy it structurally). Never used to make a call. */
export interface PlanApiProfile {
  name: string;
  enabled: boolean;
  endpoints: readonly { name: string; method: string; path: string; description: string; permission: "read" | "write" }[];
}

export const PLAN_LIMITS = {
  maxTables: 5,
  maxEndpoints: 10,
  maxStepFiles: 5,
  minTableNameChars: 3,
} as const;

export interface RelatedTable {
  connection: string;
  table: string;
  kind: "table" | "view";
  columns: { name: string; type: string }[];
  primaryKey: string[];
  foreignKeys: { columns: string[]; referencedTable: string; referencedColumns: string[] }[];
}
export interface RelatedEndpoint {
  profile: string;
  endpoint: string;
  method: string;
  path: string;
  permission: "read" | "write";
  description: string;
  matchedTokens: string[];
}

export interface ChangePlanDeps extends EvidenceDeps {
  workspaces: readonly WorkspaceLink[];
  database?: PlanDatabasePort | undefined;
  apiProfiles?: readonly PlanApiProfile[] | undefined;
}

export interface ChangePlan {
  label: typeof PLAN_LABEL;
  issue: { number: number; title: string; state: string; labels: string[]; untrustedFields: ["title", "body"] } | null;
  evidence: { file: string; terms: string[]; snippets: { term: string; line: number | null; snippet: string }[] }[];
  relatedSchema?: RelatedTable[];
  relatedEndpoints?: RelatedEndpoint[];
  proposedSteps: string[];
  unknowns: string[];
}

const SAFE_TOKEN = /^[A-Za-z0-9_.\/-]{1,100}$/;
const SAFE_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[A-Za-z0-9]+$/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary (identifier-char aware) case-insensitive containment. */
export function containsWord(haystack: string, word: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(word)}(?![A-Za-z0-9_])`, "i").test(haystack);
}

function evidenceText(files: readonly EvidenceFile[], terms: readonly string[]): string {
  return [...files.flatMap((f) => [f.file, ...f.terms, ...f.snippets.map((s) => s.snippet)]), ...terms].join("\n");
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

function dataOf<T>(sections: readonly Section[], id: string): T | undefined {
  const s = sections.find((x) => x.id === id);
  return s !== undefined && (s.status === "ok" || s.status === "partial") ? (s.data as T) : undefined;
}

export interface ChangePlanResult {
  sections: Section[];
  plan: ChangePlan;
  meta: WorkflowResult["meta"];
}

export async function runChangePlan(
  deps: ChangePlanDeps,
  input: IssueContextInput,
  options: { signal?: AbortSignal } = {},
): Promise<ChangePlanResult> {
  const ws = deps.workspaces.find((w) => w.id === input.workspace);
  if (ws === undefined) throw new AppError("NOT_FOUND", "Unknown workspace. Use a configured workspace id.");
  const p = createEvidencePipeline(deps, ws, input.number);
  const gh = p.availability.github;
  const fsAvail = p.availability.filesystem;
  const specs: SectionSpec[] = [
    { id: "issue", title: "Issue", source: p.sources.github, availability: gh, run: () => p.issue() },
    {
      id: "evidence",
      title: "Evidence",
      source: p.sources.filesystem,
      availability: gh.state !== "enabled" ? gh : fsAvail,
      run: async ({ signal }) => {
        const [terms, e] = await Promise.all([p.terms(), p.evidence(signal)]);
        return sectionOutput(
          { ...e.data, terms: terms.terms.map((t) => ({ term: t.term, kind: t.kind })) },
          { partial: e.partial, truncated: e.truncated || terms.truncated },
        );
      },
    },
  ];

  const evidenceReady = gh.state === "enabled" && fsAvail.state === "enabled";
  const evidenceFiles = async (signal: AbortSignal): Promise<{ files: EvidenceFile[]; terms: string[] }> => {
    const [terms, e] = await Promise.all([p.terms(), p.evidence(signal)]);
    return { files: e.data.files, terms: terms.terms.map((t) => t.term) };
  };

  // One section per linked connection / profile. Linked but not enabled in the registry -> disabled.
  if (ws.databases.length > 0) {
    const enabled = new Set(deps.database?.names() ?? []);
    for (const conn of ws.databases) {
      const dbAvail =
        deps.database === undefined || !enabled.has(conn)
          ? ({ state: "disabled", reason: "This database connection is disabled or not configured." } as const)
          : evidenceReady
            ? ({ state: "enabled" } as const)
            : ({ state: "unavailable", reason: "Evidence is required to select tables and is not available." } as const);
      specs.push({
        id: `schema:${conn}`,
        title: "Related schema",
        source: databaseSource(conn),
        availability: dbAvail,
        run: async ({ signal }) => {
          const { files, terms } = await evidenceFiles(signal);
          const text = evidenceText(files, terms);
          const adapter = await (deps.database as PlanDatabasePort).get(conn);
          const page = await adapter.listTablesPage();
          const matched = page.items
            .filter((t) => t.name.length >= PLAN_LIMITS.minTableNameChars && SAFE_NAME.test(t.name) && containsWord(text, t.name))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          const picked = matched.slice(0, PLAN_LIMITS.maxTables);
          const out: RelatedTable[] = [];
          for (const t of picked) {
            const d = await adapter.describeTable(t.name, t.schema !== null ? { schema: t.schema } : undefined);
            out.push({
              connection: conn,
              table: t.name,
              kind: t.kind,
              columns: d.columns.map((c) => ({ name: c.name, type: c.type })),
              primaryKey: d.primaryKey,
              foreignKeys: d.foreignKeys.map((f) => ({ columns: f.columns, referencedTable: f.referencedTable, referencedColumns: f.referencedColumns })),
            });
          }
          return sectionOutput(out, { truncated: page.truncated || matched.length > picked.length });
        },
      });
    }
  }

  if (ws.apis.length > 0) {
    for (const name of ws.apis) {
      const profile = deps.apiProfiles?.find((x) => x.name === name);
      const apiAvail =
        profile === undefined || !profile.enabled
          ? ({ state: "disabled", reason: "This API profile is disabled or not configured." } as const)
          : gh.state === "enabled"
            ? ({ state: "enabled" } as const)
            : ({ state: "unavailable", reason: "Issue terms are required to select endpoints and are not available." } as const);
      specs.push({
        id: `endpoints:${name}`,
        title: "Related endpoints",
        source: apiSource(name),
        availability: apiAvail,
        run: async () => {
          const issueTerms = await p.terms();
          const termTokens = new Set(issueTerms.terms.flatMap((t) => tokens(t.term)));
          const found: RelatedEndpoint[] = [];
          for (const e of (profile as PlanApiProfile).endpoints) {
            const staticPath = e.path.replace(/\{[^}]*\}|:[A-Za-z_]\w*/g, " ");
            const matchedTokens = [...new Set([...tokens(e.name), ...tokens(staticPath)])].filter((t) => termTokens.has(t)).sort();
            if (matchedTokens.length === 0) continue;
            found.push({ profile: name, endpoint: e.name, method: e.method, path: e.path, permission: e.permission, description: e.description, matchedTokens });
          }
          found.sort((a, b) => b.matchedTokens.length - a.matchedTokens.length || (a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : 0));
          return sectionOutput(found.slice(0, PLAN_LIMITS.maxEndpoints), { truncated: found.length > PLAN_LIMITS.maxEndpoints });
        },
      });
    }
  }

  const result = await runSections(specs, {
    deadlineMs: deps.deadlineMs ?? deps.limits.workflowTimeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(deps.redactor ? { redactor: deps.redactor } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  return { sections: result.sections, meta: result.meta, plan: composePlan(result.sections, ws) };
}

type EvidenceSectionData = EvidenceData & { terms: { term: string; kind: IssueTerms["terms"][number]["kind"] }[] };

/** Pure and deterministic: the same sections always give the same plan. */
export function composePlan(sections: readonly Section[], ws: WorkspaceLink): ChangePlan {
  const issue = dataOf<IssueSummary>(sections, "issue");
  const ev = dataOf<EvidenceSectionData>(sections, "evidence");
  const evSection = sections.find((s) => s.id === "evidence");
  const issueSection = sections.find((s) => s.id === "issue");
  const unknowns: string[] = [];

  if (issue === undefined) unknowns.push(`The issue could not be read (section status: ${issueSection?.status ?? "missing"}).`);
  else if (issue.bodyEmpty) unknowns.push("The issue body is empty.");

  const files = ev?.files ?? [];
  if (ev === undefined) {
    if (issue !== undefined) unknowns.push(`Filesystem evidence is unavailable (section status: ${evSection?.status ?? "missing"}).`);
  } else {
    if (ev.terms.length === 0) unknowns.push("No search terms could be extracted from the issue.");
    else if (files.length === 0) unknowns.push("No files matched the extracted terms.");
    if (evSection?.truncated === true) unknowns.push("Evidence is truncated; more files may match.");
    if (ev.stoppedEarly) unknowns.push("The evidence search stopped early; some terms were not searched.");
    if (ev.termsSkipped > 0) unknowns.push("Some terms were skipped because the search refused them.");
  }

  const evidence = files.map((f) => ({ file: f.file, terms: f.terms, snippets: f.snippets }));

  const plan: ChangePlan = {
    label: PLAN_LABEL,
    issue:
      issue === undefined
        ? null
        : { number: issue.number, title: issue.title, state: issue.state, labels: issue.labels, untrustedFields: issue.untrustedFields },
    evidence,
    proposedSteps: [],
    unknowns,
  };

  const schemaSections = sections.filter((s) => s.id.startsWith("schema:"));
  if (ws.databases.length > 0) {
    const tables: RelatedTable[] = [];
    for (const s of schemaSections) {
      if (s.status === "ok" || s.status === "partial") tables.push(...(s.data as RelatedTable[]));
      else unknowns.push(`Database source ${s.source.ref} is unavailable (section status: ${s.status}).`);
      if (s.truncated === true) unknowns.push(`Related tables from ${s.source.ref} are truncated.`);
    }
    plan.relatedSchema = tables;
    if (tables.length === 0 && schemaSections.every((s) => s.status === "ok" || s.status === "partial")) {
      unknowns.push("No database table names were found in the evidence.");
    }
  }
  const endpointSections = sections.filter((s) => s.id.startsWith("endpoints:"));
  if (ws.apis.length > 0) {
    const eps: RelatedEndpoint[] = [];
    for (const s of endpointSections) {
      if (s.status === "ok" || s.status === "partial") eps.push(...(s.data as RelatedEndpoint[]));
      else unknowns.push(`API source ${s.source.ref} is unavailable (section status: ${s.status}).`);
      if (s.truncated === true) unknowns.push(`Related endpoints from ${s.source.ref} are truncated.`);
    }
    plan.relatedEndpoints = eps;
    if (eps.length === 0 && endpointSections.every((s) => s.status === "ok" || s.status === "partial")) {
      unknowns.push("No configured API endpoints matched the issue terms.");
    }
  }

  const steps = plan.proposedSteps;
  if (issue !== undefined) steps.push(`Read issue #${issue.number} and confirm the expected behaviour with its author.`);
  const termKinds = new Map((ev?.terms ?? []).map((t) => [t.term, t.kind] as const));
  for (const f of files.slice(0, PLAN_LIMITS.maxStepFiles)) {
    if (!SAFE_TOKEN.test(f.file)) continue;
    const shown = f.terms.filter((t) => termKinds.get(t) !== "quote" && SAFE_TOKEN.test(t));
    steps.push(shown.length > 0 ? `Review ${f.file} (matches: ${shown.join(", ")})` : `Review ${f.file} (matches: quoted text)`);
  }
  const testFile = files.find((f) => TEST_PATH.test(f.file) && SAFE_TOKEN.test(f.file));
  if (files.length > 0) {
    steps.push(testFile !== undefined ? `Add/adjust tests near ${testFile.file}` : "Add tests for the change; no existing test file matched the evidence.");
  }
  for (const t of plan.relatedSchema ?? []) {
    if (SAFE_NAME.test(t.table) && SAFE_NAME.test(t.connection)) steps.push(`Review table ${t.table} in database connection ${t.connection} (read-only metadata).`);
  }
  for (const e of plan.relatedEndpoints ?? []) {
    if (SAFE_NAME.test(e.profile) && SAFE_NAME.test(e.endpoint)) steps.push(`Review API endpoint ${e.profile}/${e.endpoint} (${e.permission}); do not call it from this plan.`);
  }
  steps.push("Run the project's tests and review the diff. This plan was not applied and changed nothing.");
  return plan;
}
