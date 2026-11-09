import type { Metadata } from "next";
import { CodeBlock } from "@/components/shared/code-block";
import { PageShell } from "@/components/shared/page-shell";
import { StatusBadge } from "@/components/shared/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SCENARIOS, type DemoStep } from "@/data/demo";

export const metadata: Metadata = {
  title: "Demo (sample data)",
  description: "A recorded-style walkthrough of ik tool calls on a fictional project. Static sample data, nothing live.",
};

async function Step({ step, index }: { step: DemoStep; index: number }) {
  if (step.kind === "user") {
    return (
      <li className="rounded-lg border bg-card p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">You asked</p>
        <p className="mt-1">{step.text}</p>
      </li>
    );
  }
  if (step.kind === "assistant") {
    return (
      <li className="rounded-lg border bg-muted p-4">
        <p className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Claude replied <StatusBadge kind="sample" label="Authored sample text, not live" />
        </p>
        <p className="mt-1">{step.text}</p>
      </li>
    );
  }
  return (
    <li className="rounded-lg border p-4">
      <details open={index < 0}>
        <summary className="flex cursor-pointer flex-wrap items-center gap-2 rounded-md py-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Tool call</span>
          <span className="font-mono text-sm font-semibold">{step.tool}</span>
          {step.outcome === "ok" ? <StatusBadge kind="read-only" label="Succeeded, read-only" /> : <StatusBadge kind="rejected" label="Refused by the guard" />}
        </summary>
        {step.note ? <p className="mt-2 text-sm text-muted-foreground">{step.note}</p> : null}
        <CodeBlock code={step.args} lang="json" label={`Arguments for ${step.tool}`} noCopy />
        <CodeBlock code={step.result} lang="json" label={`Result of ${step.tool}`} noCopy />
      </details>
    </li>
  );
}

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
          captured from a live run. Tool-call cards open and close; no step plays automatically.
        </span>
      </div>
      <Tabs defaultValue={SCENARIOS[0]?.id}>
        <TabsList aria-label="Scenario" className="h-auto flex-wrap">
          {SCENARIOS.map((s) => (
            <TabsTrigger key={s.id} value={s.id} className="h-9 px-3">{s.title}</TabsTrigger>
          ))}
        </TabsList>
        {SCENARIOS.map((s) => (
          <TabsContent key={s.id} value={s.id}>
            <p className="mb-4 text-muted-foreground">{s.summary}</p>
            <ol className="space-y-3">
              {s.steps.map((step, i) => (
                <Step key={i} step={step} index={i} />
              ))}
            </ol>
          </TabsContent>
        ))}
      </Tabs>
    </PageShell>
  );
}
