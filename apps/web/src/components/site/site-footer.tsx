import Link from "next/link";
import { REPO_URL } from "@/lib/site";
import { Wordmark } from "./logo";

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:px-6 md:flex-row md:justify-between">
        <div className="max-w-md space-y-3">
          <Wordmark />
          <p className="text-sm text-muted-foreground">
            ik (&ldquo;I Know&rdquo;) is a local-first MCP server. This site is a static, public description of it:
            no tracking, no cookies, no third-party requests, no accounts.
          </p>
        </div>
        <nav aria-label="Footer">
          <ul className="grid gap-2 text-sm">
            <li><Link className="underline-offset-4 hover:underline" href="/install">Install</Link></li>
            <li><Link className="underline-offset-4 hover:underline" href="/tools">Tools reference</Link></li>
            <li><Link className="underline-offset-4 hover:underline" href="/security">Security model</Link></li>
            <li><Link className="underline-offset-4 hover:underline" href="/demo">Demo (sample data)</Link></li>
          </ul>
        </nav>
        <p className="max-w-xs text-sm text-muted-foreground">
          Pre-release. Not published on npm. Verified on Linux/WSL only.{" "}
          <a
            className="underline underline-offset-4 hover:text-foreground"
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Source on GitHub<span className="sr-only"> (opens in a new tab)</span>
          </a>
          .
        </p>
      </div>
    </footer>
  );
}
