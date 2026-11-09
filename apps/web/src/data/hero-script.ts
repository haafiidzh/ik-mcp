// Hero terminal beats (web-motion-spec 4.1 S1, M-05). SAMPLE DATA ONLY: nothing here was produced by a live run.
// Tool, args and result of beats 1 and 3 are looked up in data/demo.ts by scenario id and tool name (never by array
// index). Beat 2 (redaction) is new and fictional; its shape follows the real api_call_endpoint envelope
// (data: { status, headers, body }, meta.source "custom-api") and the real redaction rule in
// packages/server/src/core/redact.ts: values under keys matching pass(word)|secret|token|api[-_]?key|authorization|
// cookie|private[-_]?key|connection[-_]?string are replaced by the literal below. Prompts are short authored text.
import { SCENARIOS, type DemoStep } from "./demo";

export const REDACTED_LITERAL = "[REDACTED]";

export type HeroOutcome = "ok" | "rejected";

export interface HeroBeat {
  id: string;
  /** Chip label. */
  label: string;
  prompt: string;
  tool: string;
  args: string;
  result: string;
  outcome: HeroOutcome;
  /** Badge text (icon + text, never colour alone). */
  badge: string;
  /** Result lines, derived. */
  resultLines: string[];
}

type ToolStep = Extract<DemoStep, { kind: "tool" }>;

function findTool(scenarioId: string, tool: string): ToolStep {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  const step = scenario?.steps.find((s): s is ToolStep => s.kind === "tool" && s.tool === tool);
  if (!step) throw new Error(`hero-script: demo step ${scenarioId}/${tool} not found`);
  return step;
}

function beat(
  b: Omit<HeroBeat, "resultLines" | "badge"> & { badge?: string },
): HeroBeat {
  const badge = b.badge ?? (b.outcome === "ok" ? "Read-only, succeeded" : "Refused by the guard");
  return { ...b, badge, resultLines: b.result.split("\n") };
}

const search = findTool("issue", "fs_search_content");
const blocked = findTool("issue", "fs_read_file");

const REDACTION_RESULT = `{
  "success": true,
  "data": {
    "status": 200,
    "headers": { "content-type": "application/json" },
    "body": { "name": "acme-billing", "plan": "team", "apiKey": "${REDACTED_LITERAL}" }
  },
  "meta": { "source": "custom-api", "returnedCount": 1, "truncated": false },
  "warnings": []
}`;

export const HERO_BEATS: HeroBeat[] = [
  beat({
    id: "search",
    label: "Read-only search",
    prompt: "Where is retryCount used in acme-shop?",
    tool: search.tool,
    args: search.args,
    result: search.result,
    outcome: "ok",
  }),
  beat({
    id: "redacted",
    label: "Secrets redacted",
    prompt: "Show me the billing profile settings.",
    tool: "api_call_endpoint",
    args: `{ "profile": "acme-billing", "endpoint": "get_settings" }`,
    result: REDACTION_RESULT,
    outcome: "ok",
    badge: "Read-only, succeeded, secret redacted",
  }),
  beat({
    id: "blocked",
    label: "Blocked file",
    prompt: "Read the .env file in acme-shop.",
    tool: blocked.tool,
    args: blocked.args,
    result: blocked.result,
    outcome: "rejected",
  }),
];

/** Fictional-data caption, shown with the figure. */
export const HERO_CAPTION = "Sample data, not a live call";
export const HERO_FICTIONAL_NOTE = "Example values are fictional: acme-shop, acme-billing.";
