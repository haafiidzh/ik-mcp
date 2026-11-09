import type { Metadata } from "next";
import { FolderTree, SearchCode } from "lucide-react";
import { TabsContent } from "@/components/ui/tabs";
import { AnimatedTabs, AnimatedTabsList, AnimatedTabsTrigger } from "@/components/motion/animated-tabs";
import { CodeBlock } from "@/components/shared/code-block";
import { PageShell } from "@/components/shared/page-shell";
import { StatusBadge } from "@/components/shared/status-badge";
import { DemoPlayer, type DemoStepMeta } from "@/components/motion/demo-player";
import { SCENARIOS, type DemoStep } from "@/data/demo";
import "../motion-demo.css";
import "../motion-tabs.css";

// Announcement text for the player's live region, derived from the step (no extra copy to maintain).
function stepMeta(step: DemoStep): DemoStepMeta {
  if (step.kind === "user") return { kind: "user", label: "you asked" };
  if (step.kind === "assistant") return { kind: "assistant", label: "Claude replied (authored sample text)" };
  if (step.outcome === "ok") return { kind: "tool", label: `tool call ${step.tool}, succeeded` };
  const code = /"code":\s*"([A-Z_]+)"/.exec(step.result)?.[1];
  return { kind: "tool", label: `tool call ${step.tool}, refused${code ? ` with ${code}` : ""}` };
}

export const metadata: Metadata = {
  title: "Demo (sample data)",
  description: "A recorded-style walkthrough of ik tool calls on a fictional project. Static sample data, nothing live.",
};

async function Step({ step, index }: { step: DemoStep; index: number }) {
  if (step.kind === "user") {
    return (
      <li data-kind="user" className="rounded-lg border bg-card p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">You asked</p>
        <p className="mt-1">{step.text}</p>
      </li>
    );
  }
  if (step.kind === "assistant") {
    return (
      <li data-kind="assistant" className="rounded-lg border bg-muted p-4">
        <p className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Claude replied <StatusBadge kind="sample" label="Authored sample text, not live" />
        </p>
        <p className="mt-1">{step.text}</p>
      </li>
    );
  }
  return (
    <li data-kind="tool" data-outcome={step.outcome} className="rounded-lg border p-4">
      <details open={index < 0}>
        <summary className="flex cursor-pointer flex-wrap items-center gap-2 rounded-md py-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Tool call</span>
          <span className="font-mono text-sm font-semibold">{step.tool}</span>
          {step.outcome === "ok" ? <StatusBadge kind="read-only" label="Succeeded, read-only" /> : <StatusBadge kind="rejected" label="Refused by the guard" />}
        </summary>
        {step.note ? <p className="demo-note mt-2 text-sm text-muted-foreground">{step.note}</p> : null}
        <div className="demo-args">
          <CodeBlock code={step.args} lang="json" label={`Arguments for ${step.tool}`} noCopy />
        </div>
        <div className="demo-result">
          <CodeBlock code={step.result} lang="json" label={`Result of ${step.tool}`} noCopy />
        </div>
      </details>
    </li>
  );
}

const SCENARIO_ICONS = [FolderTree, SearchCode];

export default function DemoPage() {
  return (
    <PageShell
      title="Demo with sample data"
      lead="A recorded-style walkthrough on a fictional project called acme-shop. Nothing on this page runs a server, reads a file or calls the network."
    >
      <div role="note" className="mb-8 flex flex-wrap items-center gap-3 rounded-lg border border-warn/50 bg-warn/5 p-4 text-sm">
        <StatusBadge kind="sample" label="Sample data" />
        <span>
          Everything below is hand-written and fictional. It follows the documented result shape, but it was not
          captured from a live run. Tool-call cards open and close. Nothing plays by itself: press Play or Step through if you want it paced.
        </span>
      </div>
      <AnimatedTabs defaultValue={SCENARIOS[0]?.id ?? ""} className="flex-col gap-4">
        <AnimatedTabsList label="Scenario" variant="segmented">
          {SCENARIOS.map((s, i) => {
            const Icon = SCENARIO_ICONS[i] ?? FolderTree;
            const tools = s.steps.filter((x) => x.kind === "tool").length;
            return (
              <AnimatedTabsTrigger key={s.id} value={s.id} variant="segmented">
                <span className="tab-icon" aria-hidden="true"><Icon className="size-4" /></span>
                <span className="tab-text">
                  <span className="tab-label">{s.title.replace(/^[A-Z]\.\s*/, "")}</span>
                  <span className="tab-meta">{s.steps.length} steps, {tools} tool calls</span>
                </span>
              </AnimatedTabsTrigger>
            );
          })}
        </AnimatedTabsList>
        {SCENARIOS.map((s) => (
          <TabsContent key={s.id} value={s.id} forceMount className="min-w-0 data-[state=inactive]:hidden">
            <p className="mb-4 text-muted-foreground">{s.summary}</p>
            <DemoPlayer label={s.title} steps={s.steps.map(stepMeta)}>
              {s.steps.map((step, i) => (
                <Step key={i} step={step} index={i} />
              ))}
            </DemoPlayer>
          </TabsContent>
        ))}
      </AnimatedTabs>
    </PageShell>
  );
}
