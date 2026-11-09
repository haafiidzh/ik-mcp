import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "@/components/shared/code-block";
import { Callout } from "@/components/shared/callout";
import { PageShell, Section } from "@/components/shared/page-shell";
import { StatusBadge } from "@/components/shared/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const metadata: Metadata = {
  title: "Install",
  description: "Build ik from source and add it to Claude Code. Verified on Linux and WSL only.",
};

const CLONE = `git clone <REPOSITORY_URL> ik
cd ik
pnpm install
pnpm build`;

const ADD = `claude mcp add ik -- node /ABSOLUTE/PATH/TO/ik/packages/server/dist/index.js --config /ABSOLUTE/PATH/TO/ik/packages/server/config/devworkspace.example.json`;

const VERIFY = `claude mcp list`;

const COPY_CONFIG = `cp packages/server/config/devworkspace.example.json ~/ik-config.json`;

const CONFIG_SNIPPET = `{
  "permissions": {
    "defaultMode": "read-only",
    "allowWrites": false
  },
  "workspaces": [
    { "id": "my-project", "name": "My Project", "rootPath": "/ABSOLUTE/PATH/TO/my-project", "databases": [] }
  ],
  "filesystem": {
    "enabled": true,
    "allowedRoots": ["/ABSOLUTE/PATH/TO/my-project"]
  }
}`;

const DESKTOP = `{
  "mcpServers": {
    "ik": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/ik/packages/server/dist/index.js",
        "--config",
        "/ABSOLUTE/PATH/TO/ik/packages/server/config/devworkspace.example.json"
      ]
    }
  }
}`;

const ENV_NAMES = `DEVWORKSPACE_CONFIG    # config path, used when --config is not passed
GITHUB_TOKEN          # only if you enable the GitHub pack (name set by tokenEnv in config)
DEVWS_PG_URL          # only if you enable the PostgreSQL connection (connectionStringEnv)`;

export default function InstallPage() {
  return (
    <PageShell
      title="Install"
      lead="ik is built from source today. There is no npm package and no installer. These steps are the ones used to verify it on Linux and WSL."
    >
      <Callout title="Honest status" tone="warn">
        <p>
          Developed and tested on Linux and WSL2, and meant for Claude Code. Not yet verified: macOS, native Windows
          and Claude Desktop. The commands below are the real ones from the repository; where an OS or host is
          unverified the page says so instead of guessing.
        </p>
      </Callout>

      <Section id="requirements" title="Requirements">
        <ul className="list-disc space-y-1 pl-5">
          <li>Node.js 22 or newer (the repository sets <code>engines.node &gt;= 22</code>).</li>
          <li>pnpm 10 (the repository pins pnpm 10.22.0).</li>
          <li>git, and Claude Code (<code>claude</code> on your PATH).</li>
          <li>Nothing paid, no account, no API key. The server never calls a model.</li>
        </ul>
      </Section>

      <Section id="os" title="Your platform">
        <Tabs defaultValue="linux">
          <TabsList aria-label="Operating system" className="h-auto flex-wrap">
            <TabsTrigger value="linux" className="h-9 px-3">WSL / Linux</TabsTrigger>
            <TabsTrigger value="macos" className="h-9 px-3">macOS</TabsTrigger>
            <TabsTrigger value="windows" className="h-9 px-3">Windows</TabsTrigger>
          </TabsList>
          <TabsContent value="linux" className="space-y-2">
            <StatusBadge kind="verified" label="Developed and tested on WSL2/Linux with Node 22" />
            <p>Follow the steps below as written. If you use WSL, run every command inside the WSL shell, including <code>claude</code>.</p>
          </TabsContent>
          <TabsContent value="macos" className="space-y-2">
            <StatusBadge kind="not-verified" label="NOT YET VERIFIED" />
            <p>
              The steps below use no Linux-specific tools, so they may work, but nobody has tested them on macOS.
              Treat any difference as a bug to report, not as a supported setup. The native module
              <code> better-sqlite3</code> needs a working build toolchain during <code>pnpm install</code>.
            </p>
          </TabsContent>
          <TabsContent value="windows" className="space-y-2">
            <StatusBadge kind="not-verified" label="NOT YET VERIFIED" />
            <p>
              Native Windows (PowerShell, cmd) has not been tested. Path separators and quoting in the commands below
              would differ. The verified route on a Windows machine is WSL2: install the project inside WSL and use the
              Linux steps.
            </p>
          </TabsContent>
        </Tabs>
      </Section>

      <Section id="build" title="1. Get the code and build it">
        <p>
          Replace <code>&lt;REPOSITORY_URL&gt;</code> with the repository address; it is a placeholder because the
          project is not published yet.
        </p>
        <CodeBlock code={CLONE} label="Clone and build" />
        <p>This produces <code>packages/server/dist/index.js</code>, the file Claude will start.</p>
      </Section>

      <Section id="add" title="2. Add it to Claude Code">
        <p>
          The first run can use the example config shipped in the repository. It points at a small sample workspace
          inside the repository, keeps every pack read-only and has the database, GitHub and API packs disabled. Use
          absolute paths; <code>/ABSOLUTE/PATH/TO/ik</code> stands for where you cloned the repository.
        </p>
        <CodeBlock code={ADD} label="Add the server to Claude Code" />
        <p>
          Syntax follows the Claude Code documentation:
          <code> claude mcp add [options] &lt;name&gt; -- &lt;command&gt; [args...]</code>, where <code>--</code> separates
          Claude&rsquo;s own options from the server command (
          <a href="https://code.claude.com/docs/en/mcp">code.claude.com/docs/en/mcp</a>).
        </p>
      </Section>

      <Section id="verify" title="3. Verify">
        <CodeBlock code={VERIFY} label="List MCP servers" />
        <p>
          Start <code>claude</code> and ask: &ldquo;Call <code>server_get_status</code> and show me the result.&rdquo; You
          should see the server name and version, which packs are enabled, <code>allowWrites: false</code> and the
          limits in force. The exact fields are listed in the <Link href="/tools">tools reference</Link>.
        </p>
      </Section>

      <Section id="config" title="Use your own folder">
        <p>
          Copy the example config, then edit the workspace and the allowed root. Relative paths in the config are
          resolved against the config file&rsquo;s own directory. Keep <code>allowWrites</code> at <code>false</code>.
        </p>
        <CodeBlock code={COPY_CONFIG} label="Copy the example config" />
        <CodeBlock code={CONFIG_SNIPPET} lang="json" label="Minimal config (placeholders)" />
        <p>Secrets are never written in this file. Environment variable names the server reads:</p>
        <CodeBlock code={ENV_NAMES} label="Environment variable names (names only)" noCopy />
      </Section>

      <Section id="desktop" title="Claude Desktop">
        <StatusBadge kind="not-verified" label="NOT YET VERIFIED with Claude Desktop" />
        <p>
          ik has not been tested with Claude Desktop, and this page does not state where its config file lives; check
          the official Claude Desktop documentation for that. MCP hosts generally accept a stdio server in this shape:
        </p>
        <CodeBlock code={DESKTOP} lang="json" label="Generic stdio entry (unverified for Claude Desktop)" />
      </Section>

      <Section id="update" title="Update and remove">
        <p>
          To update, pull the new code and run <code>pnpm install</code> and <code>pnpm build</code> again. To remove,
          run <code>claude mcp remove ik</code> and delete the clone.
        </p>
      </Section>
    </PageShell>
  );
}
