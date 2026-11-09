import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Callout } from "@/components/shared/callout";
import { PageShell, Section } from "@/components/shared/page-shell";
import { StatusBadge } from "@/components/shared/status-badge";
import {
  AnimatedTabs,
  AnimatedTabsContent,
  AnimatedTabsList,
  AnimatedTabsPanels,
  AnimatedTabsTrigger,
} from "@/components/motion/animated-tabs";
import { GuardDemo } from "@/components/motion/guard-demo";
import { Reveal } from "@/components/motion/reveal";
import { Stagger, StaggerItem } from "@/components/motion/stagger";
import { Database, FolderOpen, Globe, GitBranch, ShieldCheck, type LucideIcon } from "lucide-react";
import "../motion-tabs.css";
import "../motion-guard.css";

export const metadata: Metadata = {
  title: "Security model",
  description: "What ik will never do, how access is limited, and what you still have to do yourself.",
};

const NEVER = [
  "Run shell commands.",
  "Execute SQL that writes, or more than one statement per call.",
  "Call a URL, host or database that is not in your config.",
  "Read outside the configured workspace roots, or follow a link out of one.",
  "Put a secret in a config file, a log line, an error message or a tool result.",
  "Call Claude or any other model. The server is deterministic; Claude does the interpreting.",
  "Write anywhere by default. Writes are off unless you enable them, and no write tool is shipped today.",
];

const PRINCIPLES = [
  { t: "Read-only by default", d: "permissions.allowWrites is false unless you change it. A feature that needs a write starts denied." },
  { t: "Least privilege", d: "Only configured roots, connections, repositories and API profiles exist for the server. A tool argument can pick among them but can never add one: no arbitrary connection strings, base URLs or absolute paths." },
  { t: "No secrets in config", d: "Config files hold the name of an environment variable (for example tokenEnv), never the value. Secrets are redacted from logs, errors and results." },
  { t: "stdio hygiene", d: "Standard output carries the MCP protocol only. Diagnostics go to standard error or a log file, so a stray print cannot corrupt the session." },
  { t: "No model calls", d: "Composite tools are fixed algorithms. They combine results and label what is confirmed; they do not guess." },
  { t: "Bounded and fail-closed", d: "Every list, search, read and query has size, row, time and byte caps and reports truncation. A missing allowlist means denied, not allowed." },
];

const LAYERS = [
  "The arguments are validated against a strict schema; unknown fields are rejected.",
  "The target (workspace, connection, repository, profile) must exist in your config.",
  "The pack guard runs: path guard, SQL guard, repository allowlist or URL guard.",
  "The operation runs with limits on size, rows, time and response bytes.",
  "Secrets and configured sensitive fields are redacted from the result.",
  "The outcome is written to a local audit log (metadata only, no contents).",
];

const OPERATOR = [
  "Use a database account that can only read, even though the connection is also read-only.",
  "Give the GitHub token the smallest scope that works.",
  "Point a workspace at a project folder, not at your home directory.",
  "Personal data is not detected automatically. Redaction covers secrets and fields you name, not PII.",
];

const PACKS: { id: string; name: string; role: string; Icon: LucideIcon; guards: ReactNode[] }[] = [
  {
    id: "fs",
    name: "Filesystem",
    role: "Files in your workspace",
    Icon: FolderOpen,
    guards: [
      "Paths are relative to a configured workspace root and are resolved and checked against it.",
      <>Blocked names (such as <code>.env</code> and private keys) and ignored directories are hidden.</>,
      "Symlinks are not followed out of the root.",
      "Binary files are refused.",
      "Results never contain absolute host paths.",
    ],
  },
  {
    id: "db",
    name: "Database",
    role: "Read-only SQL",
    Icon: Database,
    guards: [
      "The SQL is checked to be a single read-only statement.",
      "The connection itself is read-only, so a validator miss still cannot write.",
      "Identifiers are checked against the catalog.",
      "Row counts and time are capped.",
      <><code>EXPLAIN</code> never uses <code>ANALYZE</code>.</>,
      "Connection details are never shown.",
    ],
  },
  {
    id: "gh",
    name: "GitHub",
    role: "Allowlisted repositories",
    Icon: GitBranch,
    guards: [
      "Only allowlisted repositories can be read; with no allowlist, everything is denied.",
      "The token comes from an environment variable.",
      <>Rate limits are reported as <code>RATE_LIMITED</code> with a retry hint.</>,
      "The two write tools are not shipped.",
    ],
  },
  {
    id: "api",
    name: "Custom API",
    role: "Endpoints you define",
    Icon: Globe,
    guards: [
      "Only endpoints you defined in a profile can be called, with inputs checked against the schema you gave.",
      "Hosts are checked so that private and metadata addresses are refused unless you explicitly allow a private network for that profile.",
      "Write-method endpoints are denied unless allowed.",
      "Responses are truncated and sensitive fields are redacted.",
    ],
  },
];

// Every block below the hero reveals on first scroll (Reveal arms only after hydration and only when below the fold).
function Block({ children }: { children: ReactNode }) {
  return <Reveal className="mt-12 first:mt-0">{children}</Reveal>;
}

export default function SecurityPage() {
  return (
    <PageShell
      title="Security model"
      lead="ik is built so that giving Claude access does not mean giving Claude your machine. These are the rules the project holds itself to."
    >
      <Block>
      <Section id="never" title="What the server will never do">
        <Stagger as="ul" className="space-y-2">
          {NEVER.map((n, i) => (
            <StaggerItem key={n} as="li" index={i} className="flex gap-2"><span aria-hidden="true">&#x2715;</span><span>{n}</span></StaggerItem>
          ))}
        </Stagger>
      </Section>
      </Block>

      <Block>
      <Section id="principles" title="The rules, in plain words">
        <Stagger as="ul" className="space-y-4">
          {PRINCIPLES.map((p, i) => (
            <StaggerItem key={p.t} as="li" index={i}>
              <p className="font-semibold">{p.t}</p>
              <p className="text-muted-foreground">{p.d}</p>
            </StaggerItem>
          ))}
        </Stagger>
      </Section>
      </Block>

      <Block>
      <Section id="layers" title="How a call is checked">
        <Stagger as="ol" className="list-decimal space-y-1 pl-5">
          {LAYERS.map((t, i) => (
            <StaggerItem key={t} as="li" index={i}>{t}</StaggerItem>
          ))}
        </Stagger>
      </Section>
      </Block>

      <Block>
      <div id="watch" className="scroll-mt-20">
        <Section id="watch-demo" title="Watch the guards refuse">
          <p>
            Five attempts that the server&apos;s security tests cover, with the error code and message each one gets back.
            The call stops at the first check that refuses it, and the tool never runs.
          </p>
          <GuardDemo />
        </Section>
      </div>
      </Block>

      <Block>
      <Section id="guards" title="Guards per pack">
        <AnimatedTabs defaultValue="fs" verticalFromMd>
          <AnimatedTabsList label="Pack">
            {PACKS.map((p) => (
              <AnimatedTabsTrigger key={p.id} value={p.id}>{p.name}</AnimatedTabsTrigger>
            ))}
          </AnimatedTabsList>
          <AnimatedTabsPanels>
            {PACKS.map((p) => (
              <AnimatedTabsContent key={p.id} value={p.id}>
                <div className="rounded-xl border bg-card p-4 text-card-foreground sm:p-5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b pb-3">
                    <span className="inline-flex size-9 items-center justify-center rounded-lg bg-muted text-foreground" aria-hidden="true">
                      <p.Icon className="size-5" />
                    </span>
                    <h3 className="text-lg font-semibold">{p.name}</h3>
                    <span className="rounded-full border px-2.5 py-0.5 text-xs font-medium text-muted-foreground">{p.role}</span>
                  </div>
                  <ul className="mt-3 space-y-2.5 text-sm leading-relaxed sm:text-base">
                    {p.guards.map((g, i) => (
                      <li key={i} className="flex items-start gap-2.5">
                        <ShieldCheck className="mt-[0.3em] size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="min-w-0">{g}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </AnimatedTabsContent>
            ))}
          </AnimatedTabsPanels>
        </AnimatedTabs>
      </Section>
      </Block>

      <Block>
      <Section id="injection" title="Untrusted content">
        <p>
          Issues, files and API responses can contain text written by someone else, including text that looks like
          instructions. ik returns it as data and never acts on it; Claude and you remain responsible for how it is used.
        </p>
      </Section>
      </Block>

      <Block>
      <Section id="operator" title="What you still have to do">
        <Stagger as="ul" className="list-disc space-y-1 pl-5">
          {OPERATOR.map((t, i) => (
            <StaggerItem key={t} as="li" index={i}>{t}</StaggerItem>
          ))}
        </Stagger>
      </Section>
      </Block>

      <Block>
      <Section id="evidence" title="Test evidence">
        <p className="flex flex-wrap items-center gap-2">
          <StatusBadge kind="not-verified" label="Web page does not show a pass/fail matrix yet" />
        </p>
        <p>
          The server has security tests per pack, run in its own repository. This site does not publish a
          per-case pass matrix yet, so it claims no pass rate. A summary will be added only from recorded QA results.
        </p>
        <Callout title="Known limits" tone="warn">
          <p>
            Checking a path and then opening it leaves a small time-of-check gap that a local attacker with write access to
            the workspace could exploit. ik is meant for a workspace you control, not for hostile multi-user machines.
          </p>
        </Callout>
      </Section>
      </Block>
    </PageShell>
  );
}
