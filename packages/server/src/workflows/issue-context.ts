/**
 * workspace_find_issue_context (doc 04 sections 5 and 6, PRD 7.5). Deterministic, read-only, no model.
 *
 * Flow: GitHub SERVICE getIssue (repo = the workspace's linked repo, never an argument) ->
 * extractTerms (issue title/body are UNTRUSTED text: only literal search strings come out of them) ->
 * FILESYSTEM SERVICE searchContent/searchFiles per term (the service hides blocked and ignored paths;
 * nothing here bypasses it) -> rank by DISTINCT terms matched, then total hits, then path.
 *
 * `createEvidencePipeline` is shared with the change plan (change-plan.ts) so both use one code path.
 * Workflows call services only; the Port types below are structural subsets of the real services.
 */
import { AppError } from "../core/errors.js";
import { truncateString, type Limits } from "../core/limits.js";
import type { Redactor } from "../core/redact.js";
import type { FilesystemService } from "../integrations/filesystem/filesystem.service.js";
import type { GithubService } from "../integrations/github/github.service.js";
import { filesystemSource, githubSource } from "./source-ref.js";
import { extractTerms, type ExtractedTerm, type TermExtraction } from "./term-extract.js";
import { runSections, sectionOutput, type SectionSpec, type WorkflowResult } from "./workflow-core.js";

export type IssueGithubPort = Pick<GithubService, "getIssue">;
export type EvidenceFsPort = Pick<FilesystemService, "searchContent" | "searchFiles">;

/** The slice of a configured workspace a workflow needs (config workspace entries satisfy it structurally). */
export interface WorkspaceLink {
  id: string;
  /** Linked repository as "owner/repo". */
  github?: string | undefined;
  databases: readonly string[];
  apis: readonly string[];
}

export const EVIDENCE_LIMITS = {
  /** Result cap passed to the filesystem service per term. */
  perTermResults: 20,
  /** Distinct candidate files tracked across all terms. */
  maxCandidateFiles: 200,
  /** Files returned (top N after ranking). */
  topFiles: 10,
  snippetsPerFile: 3,
  /** Share of the workflow deadline the search loop may use before it stops with a partial result. */
  searchBudgetShare: 0.8,
} as const;

const ISSUE_TITLE_CHARS = 300;
const ISSUE_BODY_CHARS = 2000;

export interface IssueSummary {
  number: number;
  title: string;
  state: string;
  labels: string[];
  body: string | null;
  bodyEmpty: boolean;
  /** True when title or body was cut for the result (terms are extracted from the service text, not from this copy). */
  textTruncated: boolean;
  /** Fields that come from the issue author: data, never instructions. */
  untrustedFields: ["title", "body"];
}

export interface EvidenceSnippet {
  term: string;
  line: number | null;
  snippet: string;
}
export interface EvidenceFile {
  file: string;
  terms: string[];
  distinctTerms: number;
  hits: number;
  snippets: EvidenceSnippet[];
}
export interface EvidenceData {
  files: EvidenceFile[];
  termsSearched: number;
  termsSkipped: number;
  /** True when the search loop stopped early (time budget or cancellation). */
  stoppedEarly: boolean;
  candidateFilesCapped: boolean;
}
export interface EvidenceResult {
  data: EvidenceData;
  partial: boolean;
  truncated: boolean;
}

export interface IssueTerms {
  terms: ExtractedTerm[];
  inputTruncated: boolean;
  truncated: boolean;
}

export interface EvidenceDeps {
  github?: IssueGithubPort | undefined;
  filesystem?: EvidencePort | undefined;
  limits: Pick<Limits, "workflowTimeoutMs" | "maxSnippetChars">;
  /** Workflow deadline; defaults to limits.workflowTimeoutMs. */
  deadlineMs?: number;
  redactor?: Redactor;
  now?: () => number;
}
type EvidencePort = EvidenceFsPort;

function safeSegment(s: string): boolean {
  return s.length > 0 && s !== "." && s !== "..";
}

/** Name used for the file-name search: last path segment only; the term itself is only ever a literal. */
export function fileNameNeedle(term: string): string | undefined {
  const last = term.split(/[\\/]/).filter(safeSegment).pop();
  return last !== undefined && last.length <= 200 ? last : undefined;
}

function parseRepo(link: string | undefined): { owner: string; repo: string } | undefined {
  if (link === undefined) return undefined;
  const parts = link.split("/");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return undefined;
  return { owner: parts[0] as string, repo: parts[1] as string };
}

export interface EvidencePipeline {
  availability: {
    github: { state: "enabled" } | { state: "disabled" | "unavailable"; reason: string };
    filesystem: { state: "enabled" } | { state: "disabled" | "unavailable"; reason: string };
  };
  sources: { github: ReturnType<typeof githubSource>; filesystem: ReturnType<typeof filesystemSource> };
  issue(): Promise<IssueSummary>;
  terms(): Promise<IssueTerms>;
  evidence(signal: AbortSignal): Promise<EvidenceResult>;
}

/** Memoised issue -> terms -> evidence chain for one workspace and issue number. Never takes paths or repos from callers. */
export function createEvidencePipeline(deps: EvidenceDeps, ws: WorkspaceLink, number: number): EvidencePipeline {
  const repo = parseRepo(ws.github);
  const now = deps.now ?? Date.now;
  const deadlineMs = deps.deadlineMs ?? deps.limits.workflowTimeoutMs;

  const github: EvidencePipeline["availability"]["github"] =
    deps.github === undefined
      ? { state: "disabled", reason: "The GitHub pack is disabled." }
      : repo === undefined
        ? { state: "unavailable", reason: "This workspace has no linked GitHub repository." }
        : { state: "enabled" };
  const filesystem: EvidencePipeline["availability"]["filesystem"] =
    deps.filesystem === undefined ? { state: "disabled", reason: "The filesystem pack is disabled." } : { state: "enabled" };

  let issueP: Promise<{ summary: IssueSummary; raw: { title: string; body: string | null } }> | undefined;
  let termsP: Promise<IssueTerms> | undefined;
  let evidenceP: Promise<EvidenceResult> | undefined;

  const loadIssue = (): Promise<{ summary: IssueSummary; raw: { title: string; body: string | null } }> => {
    issueP ??= (async () => {
      if (deps.github === undefined || repo === undefined) throw new AppError("INTEGRATION_UNAVAILABLE", "The GitHub source is not available.");
      const out = await deps.github.getIssue(repo.owner, repo.repo, number);
      const i = out.data;
      const title = truncateString(i.title, ISSUE_TITLE_CHARS);
      const body = i.body === null ? null : truncateString(i.body, ISSUE_BODY_CHARS);
      return {
        summary: {
          number: i.number,
          title: title.text,
          state: i.state,
          labels: [...i.labels].slice(0, 20).map((l) => truncateString(l, 80).text),
          body: body?.text ?? null,
          textTruncated: title.meta.truncated || body?.meta.truncated === true,
          bodyEmpty: i.body === null || i.body.trim() === "",
          untrustedFields: ["title", "body"],
        },
        raw: { title: i.title, body: i.body },
      };
    })();
    return issueP;
  };

  const loadTerms = (): Promise<IssueTerms> => {
    termsP ??= (async () => {
      const { raw } = await loadIssue();
      const x: TermExtraction = extractTerms({ title: raw.title, body: raw.body });
      return { terms: x.terms, inputTruncated: x.meta.inputTruncated, truncated: x.meta.truncated };
    })();
    return termsP;
  };

  const loadEvidence = (signal: AbortSignal): Promise<EvidenceResult> => {
    evidenceP ??= (async () => {
      const fs = deps.filesystem;
      if (fs === undefined) throw new AppError("INTEGRATION_DISABLED", "The filesystem source is disabled.");
      const { terms } = await loadTerms();
      return gatherEvidence(fs, ws.id, terms, {
        signal,
        now,
        budgetMs: Math.floor(deadlineMs * EVIDENCE_LIMITS.searchBudgetShare),
        maxSnippetChars: deps.limits.maxSnippetChars,
      });
    })();
    return evidenceP;
  };

  return {
    availability: { github, filesystem },
    sources: {
      github: githubSource(repo?.owner ?? "", repo?.repo ?? ""),
      filesystem: filesystemSource(ws.id),
    },
    issue: async () => (await loadIssue()).summary,
    terms: loadTerms,
    evidence: loadEvidence,
  };
}

interface Candidate {
  terms: Set<string>;
  hits: number;
  snippets: EvidenceSnippet[];
}

const KEEP_SNIPPETS_WHILE_COLLECTING = 10;

/** Bounded, sequential, deterministic search over the extracted terms through the filesystem SERVICE. */
export async function gatherEvidence(
  fs: EvidenceFsPort,
  workspaceId: string,
  terms: readonly ExtractedTerm[],
  opts: { signal: AbortSignal; now: () => number; budgetMs: number; maxSnippetChars: number },
): Promise<EvidenceResult> {
  const candidates = new Map<string, Candidate>();
  const started = opts.now();
  let stoppedEarly = false;
  let truncated = false;
  let capped = false;
  let searched = 0;
  let skipped = 0;

  const touch = (file: string, term: string): Candidate | undefined => {
    let c = candidates.get(file);
    if (c === undefined) {
      if (candidates.size >= EVIDENCE_LIMITS.maxCandidateFiles) {
        capped = true;
        return undefined;
      }
      c = { terms: new Set(), hits: 0, snippets: [] };
      candidates.set(file, c);
    }
    c.terms.add(term);
    c.hits += 1;
    return c;
  };

  const tolerate = (e: unknown): boolean => {
    // A term the service refuses as input is skipped; any other failure is a real section failure.
    if (e instanceof AppError && e.code === "INVALID_INPUT") {
      skipped += 1;
      return true;
    }
    return false;
  };

  for (const t of terms) {
    if (opts.signal.aborted || opts.now() - started > opts.budgetMs) {
      stoppedEarly = true;
      break;
    }
    searched += 1;
    if (t.kind === "file") {
      const needle = fileNameNeedle(t.term);
      if (needle !== undefined) {
        try {
          const r = await fs.searchFiles(workspaceId, needle, undefined, EVIDENCE_LIMITS.perTermResults);
          if (r.meta.truncated) truncated = true;
          for (const h of r.data) if (h.type === "file") touch(h.relPath, t.term);
        } catch (e) {
          if (!tolerate(e)) throw e;
        }
      }
    }
    try {
      const r = await fs.searchContent(workspaceId, t.term, { limit: EVIDENCE_LIMITS.perTermResults });
      if (r.meta.truncated) truncated = true;
      for (const h of r.data) {
        const c = touch(h.relPath, t.term);
        if (c !== undefined && c.snippets.length < KEEP_SNIPPETS_WHILE_COLLECTING) {
          c.snippets.push({ term: t.term, line: h.line, snippet: h.snippet.slice(0, opts.maxSnippetChars) });
        }
      }
    } catch (e) {
      if (!tolerate(e)) throw e;
    }
  }

  const ranked = [...candidates.entries()]
    .map(([file, c]) => ({ file, c }))
    .sort((a, b) => b.c.terms.size - a.c.terms.size || b.c.hits - a.c.hits || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  if (ranked.length > EVIDENCE_LIMITS.topFiles) truncated = true;
  if (capped) truncated = true;

  const order = new Map(terms.map((t, i) => [t.term, i] as const));
  const files: EvidenceFile[] = ranked.slice(0, EVIDENCE_LIMITS.topFiles).map(({ file, c }) => ({
    file,
    terms: [...c.terms].sort((x, y) => (order.get(x) ?? 0) - (order.get(y) ?? 0)),
    distinctTerms: c.terms.size,
    hits: c.hits,
    snippets: [...c.snippets]
      .sort((x, y) => (x.line ?? 0) - (y.line ?? 0) || (order.get(x.term) ?? 0) - (order.get(y.term) ?? 0))
      .slice(0, EVIDENCE_LIMITS.snippetsPerFile),
  }));

  return {
    data: { files, termsSearched: searched, termsSkipped: skipped, stoppedEarly, candidateFilesCapped: capped },
    partial: stoppedEarly,
    truncated,
  };
}

export interface IssueContextInput {
  workspace: string;
  number: number;
}

/** Sections `issue`, `terms`, `files` (spec order). Throws NOT_FOUND only for an unknown workspace id. */
export async function runIssueContext(
  deps: EvidenceDeps & { workspaces: readonly WorkspaceLink[] },
  input: IssueContextInput,
  options: { signal?: AbortSignal } = {},
): Promise<WorkflowResult> {
  const ws = deps.workspaces.find((w) => w.id === input.workspace);
  if (ws === undefined) throw new AppError("NOT_FOUND", "Unknown workspace. Use a configured workspace id.");
  const p = createEvidencePipeline(deps, ws, input.number);
  const gh = p.availability.github;
  const fsAvail = p.availability.filesystem;
  const specs: SectionSpec[] = [
    { id: "issue", title: "Issue", source: p.sources.github, availability: gh, run: () => p.issue() },
    {
      id: "terms",
      title: "Search terms",
      source: p.sources.github,
      availability: gh,
      run: async () => {
        const t = await p.terms();
        return sectionOutput(
          { terms: t.terms.map((x) => ({ term: x.term, kind: x.kind, field: x.field })), inputTruncated: t.inputTruncated },
          { truncated: t.truncated || t.inputTruncated },
        );
      },
    },
    {
      id: "files",
      title: "Matching files",
      source: p.sources.filesystem,
      availability: gh.state !== "enabled" ? gh : fsAvail,
      run: async ({ signal }) => {
        const e = await p.evidence(signal);
        return sectionOutput(e.data, { partial: e.partial, truncated: e.truncated });
      },
    },
  ];
  return runSections(specs, {
    deadlineMs: deps.deadlineMs ?? deps.limits.workflowTimeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(deps.redactor ? { redactor: deps.redactor } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
}
