import { AppError } from "../core/errors.js";
import type { SuccessResult } from "../core/response.js";
import type { GithubOutcome } from "../integrations/github/github.service.js";
import type { GithubRepo } from "../integrations/github/github.types.js";
import type { CatalogPage, TableRef } from "../integrations/database/database.types.js";
import type { LocalGit, LocalGitData } from "../integrations/git/local-git.js";
import type { TreeData, TreeNode } from "../integrations/filesystem/filesystem.service.js";
import type { Redactor } from "../core/redact.js";
import { apiSource, databaseSource, filesystemSource, githubSource, githubNoRepoSource, type SourceRef } from "./source-ref.js";
import { runSections, safeErrorPayload, sectionOutput, summarize, type Section, type SectionSpec, type WorkflowResult } from "./workflow-core.js";

/**
 * workspace_get_overview (doc 04 sections 5/6). Deterministic and read-only. Calls services only.
 * Port types below are structural subsets of the real services (assignability is checked in tests).
 */

export interface OverviewFsPort {
  getDirectoryTree(workspace: string, relPath?: string, depth?: number): Promise<SuccessResult<TreeData>>;
}
export interface OverviewGithubPort {
  getRepository(owner: string, repo: string): Promise<GithubOutcome<GithubRepo>>;
}
export interface OverviewDatabaseRegistryPort {
  names(): string[];
  get(name: unknown): Promise<{ listTablesPage(options?: { schema?: string }): Promise<CatalogPage<TableRef>> }>;
}
export interface OverviewApiPort {
  listProfiles(): { name: string; enabled: boolean; authType: string; endpoints: number }[];
}

/** The slice of configuration the workflow reads (config entries satisfy it structurally). */
export interface OverviewWorkspaceLink {
  id: string;
  rootPath: string;
  github?: string | undefined;
  databases: readonly string[];
  apis: readonly string[];
}
export interface OverviewDatabaseConfig {
  name: string;
  type: string;
  enabled: boolean;
  readOnly: boolean;
}

export interface OverviewDeps {
  workspaces: readonly OverviewWorkspaceLink[];
  databases: readonly OverviewDatabaseConfig[];
  /** A pack's port is absent when the pack is disabled: its sections report status "disabled". */
  fs: OverviewFsPort;
  github?: OverviewGithubPort | undefined;
  databaseRegistry?: OverviewDatabaseRegistryPort | undefined;
  api?: OverviewApiPort | undefined;
  /** Absent when local git is not available/enabled. */
  git?: LocalGit | undefined;
  redactor?: Redactor | undefined;
  deadlineMs?: number | undefined;
  maxSnippetChars?: number | undefined;
}

const MAX_EXTENSIONS = 20;
const MAX_NOTABLE = 50;
const NOTABLE_README = /^readme(\.|$)/i;
const NOTABLE_CONFIG = /^[^.].*\.config\.[^.]+$/i;
const NOTABLE_DOCKER = /^dockerfile(\.[\w.-]+)?$/i;
const MIGRATION_DIR = /^(migrations?|migrate)$/i;

export interface NotableFile {
  path: string;
  kind: "readme" | "package-json" | "config" | "dockerfile" | "migrations-dir";
}

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : "(none)";
}

/** Deterministic analysis of a depth-limited tree. Exported for tests. */
export function analyzeTree(root: TreeNode): { extensions: { extension: string; count: number }[]; extensionsTruncated: boolean; notableFiles: NotableFile[]; notableTruncated: boolean } {
  const ext = new Map<string, number>();
  const notable: NotableFile[] = [];
  const walk = (node: TreeNode, prefix: string): void => {
    for (const c of node.children ?? []) {
      const rel = prefix === "" ? c.name : `${prefix}/${c.name}`;
      if (c.type === "file") {
        const e = extensionOf(c.name);
        ext.set(e, (ext.get(e) ?? 0) + 1);
        if (NOTABLE_README.test(c.name)) notable.push({ path: rel, kind: "readme" });
        else if (c.name === "package.json") notable.push({ path: rel, kind: "package-json" });
        else if (NOTABLE_CONFIG.test(c.name)) notable.push({ path: rel, kind: "config" });
        else if (NOTABLE_DOCKER.test(c.name)) notable.push({ path: rel, kind: "dockerfile" });
      } else if (c.type === "dir") {
        if (MIGRATION_DIR.test(c.name)) notable.push({ path: rel, kind: "migrations-dir" });
        walk(c, rel);
      }
    }
  };
  walk(root, "");
  const all = [...ext.entries()].map(([extension, count]) => ({ extension, count })).sort((a, b) => b.count - a.count || (a.extension < b.extension ? -1 : 1));
  notable.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    extensions: all.slice(0, MAX_EXTENSIONS),
    extensionsTruncated: all.length > MAX_EXTENSIONS,
    notableFiles: notable.slice(0, MAX_NOTABLE),
    notableTruncated: notable.length > MAX_NOTABLE,
  };
}

function splitRepo(slug: string): { owner: string; repo: string } | undefined {
  const i = slug.indexOf("/");
  return i > 0 && i < slug.length - 1 ? { owner: slug.slice(0, i), repo: slug.slice(i + 1) } : undefined;
}

function clip(text: string | null, max: number): string | null {
  if (text === null) return null;
  const cp = [...text];
  return cp.length > max ? cp.slice(0, max).join("") : text;
}

export async function getWorkspaceOverview(deps: OverviewDeps, workspaceId: string, signal?: AbortSignal): Promise<WorkflowResult> {
  const ws = deps.workspaces.find((w) => w.id === workspaceId);
  if (ws === undefined) throw new AppError("NOT_FOUND", "Unknown workspace. Use a workspace id from the server configuration.");
  const maxText = deps.maxSnippetChars ?? 300;
  const specs: SectionSpec[] = [];

  specs.push({
    id: "filesystem",
    title: "Workspace files",
    source: filesystemSource(ws.id),
    run: async () => {
      const r = await deps.fs.getDirectoryTree(ws.id, ".", 2);
      const a = analyzeTree(r.data.root);
      return sectionOutput(
        { tree: r.data.root, counts: r.data.counts, extensions: a.extensions, extensionsTruncated: a.extensionsTruncated, notableFiles: a.notableFiles, notableFilesTruncated: a.notableTruncated, depth: 2 },
        { truncated: r.meta.truncated === true || a.extensionsTruncated || a.notableTruncated },
      );
    },
  });

  // GitHub: the workspace's linked repository only. Allowlist rules are the service's.
  const repo = ws.github !== undefined ? splitRepo(ws.github) : undefined;
  const ghSource: SourceRef = repo !== undefined ? githubSource(repo.owner, repo.repo) : githubNoRepoSource();
  const gh = deps.github;
  specs.push({
    id: "github",
    title: "GitHub repository",
    source: ghSource,
    availability:
      gh === undefined
        ? { state: "disabled", reason: "The GitHub pack is not enabled." }
        : repo === undefined
          ? { state: "unavailable", reason: "No GitHub repository is linked to this workspace." }
          : { state: "enabled" },
    run: async () => {
      if (gh === undefined || repo === undefined) return null;
      const o = await gh.getRepository(repo.owner, repo.repo);
      const r = o.data;
      return sectionOutput(
        {
          fullName: r.fullName,
          description: clip(r.description, maxText),
          visibility: r.visibility ?? (r.private ? "private" : "public"),
          defaultBranch: r.defaultBranch,
          topics: r.topics.slice(0, 20),
          stars: r.stars,
          forks: r.forks,
          openIssues: r.openIssues,
          language: r.language,
          archived: r.archived,
          pushedAt: r.pushedAt,
        },
        { truncated: o.truncated },
      );
    },
  });

  // Database: status + table count per linked connection (no queries).
  for (const name of ws.databases) {
    const cfg = deps.databases.find((d) => d.name === name);
    const reg = deps.databaseRegistry;
    const registered = reg?.names().includes(name) === true;
    specs.push({
      id: `database:${name}`,
      title: `Database connection ${name}`,
      source: databaseSource(name),
      availability:
        reg === undefined || cfg === undefined || !cfg.enabled || !registered
          ? { state: "disabled", reason: "The database connection is not enabled." }
          : { state: "enabled" },
      run: async () => {
        if (reg === undefined || cfg === undefined) return null;
        const adapter = await reg.get(name);
        const page = await adapter.listTablesPage();
        return sectionOutput(
          { name, type: cfg.type, readOnly: cfg.readOnly, tableCount: page.items.length, tableCountIsLowerBound: page.truncated },
          { truncated: page.truncated },
        );
      },
    });
  }

  // Custom API: profile status only, never an endpoint call.
  if (ws.apis.length > 0) {
    const api = deps.api;
    const profiles = api?.listProfiles() ?? [];
    for (const name of ws.apis) {
      const p = profiles.find((x) => x.name === name);
      specs.push({
        id: `api:${name}`,
        title: `API profile ${name}`,
        source: apiSource(name),
        availability: api === undefined || p === undefined ? { state: "disabled", reason: "The API profile is not enabled." } : { state: "enabled" },
        run: async () => {
          if (p === undefined) return null;
          return { name: p.name, enabled: p.enabled, authType: p.authType, endpoints: p.endpoints, checkedByCall: false };
        },
      });
    }
  }

  // Local git (read-only, fixed commands). Unavailable states carry fixed, path-free reasons.
  const git = deps.git;
  specs.push({
    id: "git",
    title: "Local git",
    source: filesystemSource(ws.id),
    availability: git === undefined ? { state: "disabled", reason: "Local git inspection is not enabled." } : { state: "enabled" },
    run: async () => {
      if (git === undefined) return null;
      const r = await git.inspect(ws.rootPath);
      if (r.status === "unavailable") return new GitUnavailableMarker(r.reason);
      const d: LocalGitData = r.data;
      return sectionOutput(d, { partial: r.partial });
    },
  });

  const result = await runSections(specs, {
    ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}),
    ...(deps.redactor !== undefined ? { redactor: deps.redactor } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
  return remapUnavailable(result, deps.redactor);
}

/** Internal: git ran fine but the repository cannot be read (not a repo, unsafe ownership, no git...). */
class GitUnavailableMarker {
  constructor(readonly reason: string) {}
}

/** Turn marker results into status "unavailable" sections and recompute the summary flags. */
function remapUnavailable(result: WorkflowResult, redactor?: Redactor): WorkflowResult {
  let changed = false;
  const sections = result.sections.map((s) => {
    if (s.status === "ok" && s.data instanceof GitUnavailableMarker) {
      changed = true;
      return { id: s.id, title: s.title, source: s.source, status: "unavailable" as const, error: safeErrorPayload(new AppError("INTEGRATION_UNAVAILABLE", s.data.reason), redactor) } satisfies Section;
    }
    return s;
  });
  if (!changed) return result;
  const sectionsSummary = summarize(sections);
  return { sections, meta: { ...result.meta, sectionsSummary, partial: sectionsSummary.ok !== sectionsSummary.total } };
}
