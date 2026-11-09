import { ArrowRight, Eye, FileSearch, GitBranch, Database, Plug, Workflow, Lock, ShieldCheck, KeyRound, Gauge, TerminalSquare, Ban } from "lucide-react";
import Link from "next/link";
import { GithubLink } from "@/components/site/github-link";
import type { ComponentType, CSSProperties } from "react";
import { FlowDiagram } from "@/components/motion/flow-diagram";
import { HowItWorks } from "@/components/shared/how-it-works";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/motion/reveal";
import { Spotlight } from "@/components/motion/spotlight";
import { Stagger, StaggerItem } from "@/components/motion/stagger";
import { Terminal } from "@/components/motion/terminal";
import { PACKS, type PackId } from "@/data/tools";
import "./motion-hero.css";
import "./motion-landing.css";
import "./motion-flow.css";

const ICONS: Record<PackId, ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  server: Eye,
  filesystem: FileSearch,
  database: Database,
  github: GitBranch,
  api: Plug,
  workspace: Workflow,
};

const GUARANTEES = [
  { Icon: ShieldCheck, title: "Read-only by default", text: "Every integration starts read-only. Writes are off unless you turn them on, and the two GitHub write tools are not shipped yet." },
  { Icon: Lock, title: "Only what you configured", text: "Workspace roots, database connections, GitHub repositories and API profiles come from your config. Tool arguments never widen them." },
  { Icon: KeyRound, title: "Secrets stay in the environment", text: "Tokens and connection strings come from environment variables. They are never in config files, logs or results." },
  { Icon: Gauge, title: "Everything is bounded", text: "Size, row, time and response limits apply to every call, and a cut result says it was truncated." },
];

export default function HomePage() {
  const packs = PACKS.filter((p) => p.id !== "server");
  return (
    <>
      <section className="relative isolate mx-auto grid max-w-6xl gap-12 px-4 pb-16 pt-14 sm:px-6 sm:pt-20 lg:grid-cols-2 lg:items-center">
        <Spotlight />
        <div className="relative z-[1]">
          <p className="hero-rise inline-flex items-center gap-2 text-sm font-medium text-primary" style={{ "--hd": "0ms" } as CSSProperties}>
            <Eye className="size-4" aria-hidden={true} /> ik, short for &ldquo;I Know&rdquo;
          </p>
          <h1 className="mt-4 text-4xl font-semibold leading-tight sm:text-5xl">
            Give Claude <span className="hero-hl">controlled access</span> to your dev workspace.
          </h1>
          <p className="hero-rise mt-5 max-w-[60ch] text-lg text-muted-foreground" style={{ "--hd": "80ms" } as CSSProperties}>
            ik is a local-first MCP server. It lets Claude look at your files, databases, GitHub repositories and
            internal APIs through a small set of read-only tools, on your machine, over stdio. It is free, it runs
            nothing in the cloud, and it never calls a model itself.
          </p>
          <div className="hero-rise mt-8 flex flex-wrap gap-3" style={{ "--hd": "160ms" } as CSSProperties}>
            <Button asChild className="h-11 px-5 text-base">
              <Link href="/install">Install <ArrowRight aria-hidden={true} /></Link>
            </Button>
            <Button asChild variant="outline" className="h-11 px-5 text-base">
              <Link href="/demo">See the demo</Link>
            </Button>
            <GithubLink size="hero" observeHero />
          </div>
          <p className="hero-rise mt-6 text-sm text-muted-foreground" style={{ "--hd": "240ms" } as CSSProperties}>
            Pre-release. Verified on Linux and WSL; macOS and native Windows are not yet verified. Not published on npm:
            you build it from source.
          </p>
        </div>
        <Terminal />
      </section>

      <section aria-labelledby="what-h" className="border-y bg-card">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 id="what-h" className="text-2xl font-semibold">What it is, and what it is not</h2>
          <Stagger className="mt-8 grid gap-6 md:grid-cols-3">
            {[
              { Icon: TerminalSquare, t: "An MCP server", d: "A local process that Claude Desktop or Claude Code starts. It talks over stdio. There is no hosted endpoint." },
              { Icon: Ban, t: "Not an LLM", d: "It never calls Claude or any other model API. Tools are deterministic; Claude interprets the structured results." },
              { Icon: Lock, t: "Not a proxy", d: "No arbitrary URLs, connection strings, absolute paths, shell commands or SQL writes. Only what your config lists." },
            ].map(({ Icon, t, d }, i) => (
              <StaggerItem key={t} index={i}>
                <Icon className="size-5 text-primary" aria-hidden={true} />
                <h3 className="mt-3 text-lg font-semibold">{t}</h3>
                <p className="mt-1 text-muted-foreground">{d}</p>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      </section>

      <section aria-labelledby="packs-h" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 id="packs-h" className="text-2xl font-semibold">Five capability packs</h2>
        <p className="mt-2 max-w-[70ch] text-muted-foreground">
          Each pack can be switched on or off in config. Status below is what exists in the repository today.
        </p>
        <Stagger as="ul" className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {packs.map((p, i) => {
            const Icon = ICONS[p.id];
            return (
              <StaggerItem as="li" key={p.id} index={i} className="pack-card flex flex-col rounded-xl border bg-card p-5">
                <div className="flex items-center justify-between gap-2">
                  <Icon className="size-5 text-primary" aria-hidden={true} />
                  <StatusBadge kind={p.status === "implemented" ? "implemented" : "in-development"} />
                </div>
                <h3 className="mt-3 text-lg font-semibold">{p.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{p.blurb}</p>
                <p className="mt-3 font-mono text-xs text-muted-foreground">
                  {p.tools.slice(0, 3).map((t) => t.name).join(", ")}
                </p>
                <div className="mt-4"><StatusBadge kind="read-only" /></div>
              </StaggerItem>
            );
          })}
        </Stagger>
        <p className="mt-4 text-sm"><Link className="text-primary underline underline-offset-4" href="/tools">Full tools reference</Link></p>
      </section>

      <section aria-labelledby="sec-h" className="border-y bg-card">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 id="sec-h" className="text-2xl font-semibold">Security is the point</h2>
          <Stagger as="ul" className="mt-8 grid gap-6 sm:grid-cols-2">
            {GUARANTEES.map(({ Icon, title, text }, i) => (
              <StaggerItem as="li" key={title} index={i} className="flex gap-4">
                <Icon className="mt-1 size-5 shrink-0 text-primary" aria-hidden={true} />
                <div>
                  <h3 className="font-semibold">{title}</h3>
                  <p className="text-muted-foreground">{text}</p>
                </div>
              </StaggerItem>
            ))}
          </Stagger>
          <p className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <Link className="text-primary underline underline-offset-4" href="/security">Read the security model</Link>
            <Link className="text-primary underline underline-offset-4" href="/security#watch">Watch the guards refuse</Link>
          </p>
        </div>
      </section>

      <section aria-labelledby="how-h" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 id="how-h" className="mb-8 text-2xl font-semibold">How it works</h2>
        <FlowDiagram>
          <HowItWorks />
        </FlowDiagram>
      </section>

      <section aria-labelledby="cta-h" className="border-t">
        <Reveal className="mx-auto max-w-6xl px-4 py-16 text-center sm:px-6">
          <h2 id="cta-h" className="text-2xl font-semibold">Try it on a folder you choose</h2>
          <p className="mx-auto mt-2 max-w-[60ch] text-muted-foreground">
            Build from source, point it at one folder, ask Claude to call <code className="font-mono">server_get_status</code>.
            Or read a recorded walkthrough first. It uses sample data only.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button asChild className="h-11 px-5 text-base"><Link href="/install">Install</Link></Button>
            <Button asChild variant="outline" className="h-11 px-5 text-base"><Link href="/demo">Demo with sample data</Link></Button>
          </div>
        </Reveal>
      </section>
    </>
  );
}
