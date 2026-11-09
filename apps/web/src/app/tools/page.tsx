import type { Metadata } from "next";
import { CodeBlock } from "@/components/shared/code-block";
import { Callout } from "@/components/shared/callout";
import { PageShell, Section } from "@/components/shared/page-shell";
import { StatusBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ERROR_CODES, PACKS } from "@/data/tools";

export const metadata: Metadata = {
  title: "Tools reference",
  description: "Every tool name ik exposes or plans to expose, by pack, with inputs, access level and status.",
};

const SUCCESS = `{
  "success": true,
  "data": {},
  "meta": { "source": "github", "partial": false, "returnedCount": 0,
            "nextPageAvailable": false, "truncated": false },
  "warnings": []
}`;
const FAILURE = `{
  "success": false,
  "error": { "code": "PERMISSION_DENIED", "message": "...", "retryable": false, "retryAfterSeconds": null }
}`;

export default function ToolsPage() {
  const count = PACKS.flatMap((p) => p.tools);
  const shipped = count.filter((t) => t.status === "implemented").length;
  return (
    <PageShell
      title="Tools reference"
      lead={`${shipped} tools are implemented, plus 5 resource URIs and 5 prompts. ${count.filter((t) => t.status === "not-shipped").length} GitHub write tools are planned but not shipped. Every tool is read-only by default; a call to a write-type API endpoint is denied unless writes are explicitly enabled.`}
    >
      <nav aria-label="Packs on this page" className="mb-10">
        <ul className="flex flex-wrap gap-2 text-sm">
          {PACKS.map((p) => (
            <li key={p.id}>
              <a className="inline-flex min-h-8 items-center rounded-md border px-3 hover:bg-accent" href={`#${p.id}-h`}>
                {p.title}
              </a>
            </li>
          ))}
          <li><a className="inline-flex min-h-8 items-center rounded-md border px-3 hover:bg-accent" href="#response-h">Response shape</a></li>
          <li><a className="inline-flex min-h-8 items-center rounded-md border px-3 hover:bg-accent" href="#errors-h">Error codes</a></li>
        </ul>
      </nav>

      {PACKS.map((pack) => (
        <Section key={pack.id} id={pack.id} title={pack.title}>
          <p>{pack.blurb}</p>
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <StatusBadge kind={pack.status === "implemented" ? "implemented" : "in-development"} />
            {pack.statusNote}
          </p>
          <div className="not-prose max-w-none space-y-3">
            {pack.tools.map((t) => (
              <article key={t.name} id={t.name} aria-labelledby={`${t.name}-name`} className="scroll-mt-20 rounded-lg border bg-card p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 id={`${t.name}-name`} className="font-mono text-base font-semibold">
                    <a href={`#${t.name}`} className="hover:underline">{t.name}</a>
                  </h3>
                  {t.access === "read" ? <StatusBadge kind="read-only" /> : <StatusBadge kind="writes" />}
                  {t.status === "not-shipped" ? <StatusBadge kind="not-shipped" /> : null}
                  {t.status === "in-development" ? <StatusBadge kind="in-development" /> : null}
                </div>
                <p className="mt-2 text-sm">{t.summary}</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Inputs: <span className="font-mono">{t.inputs}</span> (a trailing <span className="font-mono">?</span> means optional)
                </p>
                {t.note ? <p className="mt-1 text-sm text-muted-foreground">{t.note}</p> : null}
              </article>
            ))}
          </div>
        </Section>
      ))}

      <Section id="response" title="Response shape">
        <p>
          Every tool returns the same envelope, as structured content and as one text item with the same JSON.
          Failures set the MCP error flag. Empty results are a success with a count of zero; a missing integration is an
          error, not an empty list; partial results say so in <code>meta.partial</code>.
        </p>
        <CodeBlock code={SUCCESS} lang="json" label="Success envelope" noCopy />
        <CodeBlock code={FAILURE} lang="json" label="Error envelope" noCopy />
        <Callout title="Limits apply to everything">
          <p>Lists, searches, reads and queries are bounded. When a result is cut, <code>meta.truncated</code> is true and <code>nextPageAvailable</code> says whether more exists.</p>
        </Callout>
      </Section>

      <Section id="errors" title="Error codes">
        <div role="region" aria-label="Error codes table" tabIndex={0} className="overflow-x-auto rounded-lg border">
          <Table>
            <caption className="sr-only">Error codes returned by tools</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Code</TableHead>
                <TableHead scope="col">Retryable</TableHead>
                <TableHead scope="col">Meaning</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ERROR_CODES.map((e) => (
                <TableRow key={e.code}>
                  <TableCell className="font-mono text-xs">{e.code}</TableCell>
                  <TableCell>{e.retryable}</TableCell>
                  <TableCell className="whitespace-normal">{e.meaning}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>
    </PageShell>
  );
}
