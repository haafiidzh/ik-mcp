import type { Metadata } from "next";
import { Callout } from "@/components/shared/callout";
import { PageShell, Section } from "@/components/shared/page-shell";
import { StatusBadge } from "@/components/shared/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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

export default function SecurityPage() {
  return (
    <PageShell
      title="Security model"
      lead="ik is built so that giving Claude access does not mean giving Claude your machine. These are the rules the project holds itself to."
    >
      <Section id="never" title="What the server will never do">
        <ul className="space-y-2">
          {NEVER.map((n) => (
            <li key={n} className="flex gap-2"><span aria-hidden="true">&#x2715;</span><span>{n}</span></li>
          ))}
        </ul>
      </Section>

      <Section id="principles" title="The rules, in plain words">
        <dl className="space-y-4">
          {PRINCIPLES.map((p) => (
            <div key={p.t}>
              <dt className="font-semibold">{p.t}</dt>
              <dd className="text-muted-foreground">{p.d}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section id="layers" title="How a call is checked">
        <ol className="list-decimal space-y-1 pl-5">
          <li>The arguments are validated against a strict schema; unknown fields are rejected.</li>
          <li>The target (workspace, connection, repository, profile) must exist in your config.</li>
          <li>The pack guard runs: path guard, SQL guard, repository allowlist or URL guard.</li>
          <li>The operation runs with limits on size, rows, time and response bytes.</li>
          <li>Secrets and configured sensitive fields are redacted from the result.</li>
          <li>The outcome is written to a local audit log (metadata only, no contents).</li>
        </ol>
      </Section>

      <Section id="guards" title="Guards per pack">
        <Tabs defaultValue="fs">
          <TabsList aria-label="Pack" className="h-auto flex-wrap">
            <TabsTrigger value="fs" className="h-9 px-3">Filesystem</TabsTrigger>
            <TabsTrigger value="db" className="h-9 px-3">Database</TabsTrigger>
            <TabsTrigger value="gh" className="h-9 px-3">GitHub</TabsTrigger>
            <TabsTrigger value="api" className="h-9 px-3">Custom API</TabsTrigger>
          </TabsList>
          <TabsContent value="fs"><p>Paths are relative to a configured workspace root and are resolved and checked against it. Blocked names (such as <code>.env</code> and private keys) and ignored directories are hidden, symlinks are not followed out of the root, and binary files are refused. Results never contain absolute host paths.</p></TabsContent>
          <TabsContent value="db"><p>The SQL is checked to be a single read-only statement, and the connection itself is read-only, so a validator miss still cannot write. Identifiers are checked against the catalog, row counts and time are capped, and <code>EXPLAIN</code> never uses <code>ANALYZE</code>. Connection details are never shown.</p></TabsContent>
          <TabsContent value="gh"><p>Only allowlisted repositories can be read; with no allowlist, everything is denied. The token comes from an environment variable. Rate limits are reported as <code>RATE_LIMITED</code> with a retry hint. The two write tools are not shipped.</p></TabsContent>
          <TabsContent value="api"><p>Only endpoints you defined in a profile can be called, with inputs checked against the schema you gave. Hosts are checked so that private and metadata addresses are refused unless you explicitly allow a private network for that profile. Write-method endpoints are denied unless allowed. Responses are truncated and sensitive fields are redacted.</p></TabsContent>
        </Tabs>
      </Section>

      <Section id="injection" title="Untrusted content">
        <p>
          Issues, files and API responses can contain text written by someone else, including text that looks like
          instructions. ik returns it as data and never acts on it; Claude and you remain responsible for how it is used.
        </p>
      </Section>

      <Section id="operator" title="What you still have to do">
        <ul className="list-disc space-y-1 pl-5">
          <li>Use a database account that can only read, even though the connection is also read-only.</li>
          <li>Give the GitHub token the smallest scope that works.</li>
          <li>Point a workspace at a project folder, not at your home directory.</li>
          <li>Personal data is not detected automatically. Redaction covers secrets and fields you name, not PII.</li>
        </ul>
      </Section>

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
    </PageShell>
  );
}
