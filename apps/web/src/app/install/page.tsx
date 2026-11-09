import type { Metadata } from "next";
import Link from "next/link";
import { REPO_URL } from "@/lib/site";
import type { ReactNode } from "react";
import { Bug, CircleDashed, Laptop, ListChecks, Monitor, Route, Terminal, Wrench, type LucideIcon } from "lucide-react";
import { TabPanelCard } from "@/components/shared/tab-panel-card";
import { CodeBlock } from "@/components/shared/code-block";
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
import { StepRail } from "@/components/motion/step-rail";
import "../motion-tabs.css";
import "../motion-install.css";

export const metadata: Metadata = {
  title: "Install",
  description: "Build ik from source and add it to Claude Code. Verified on Linux and WSL only.",
};

const CLONE = `git clone ${REPO_URL}.git ik
cd ik
pnpm install
pnpm build`;

const SAMPLE_DB = `pnpm sample:db`;

const ADD = `claude mcp add --transport stdio ik -- node /ABSOLUTE/PATH/TO/ik/packages/server/dist/index.js --config /ABSOLUTE/PATH/TO/ik/packages/server/config/devworkspace.example.json`;

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

const PLATFORMS: {
  id: string;
  tab: string;
  name: string;
  Icon: LucideIcon;
  kind: "verified" | "not-verified";
  badge: string;
  rows: { Icon: LucideIcon; text: ReactNode }[];
}[] = [
  {
    id: "linux",
    tab: "WSL / Linux",
    name: "WSL / Linux",
    Icon: Terminal,
    kind: "verified",
    badge: "Developed and tested on WSL2/Linux with Node 22",
    rows: [
      { Icon: ListChecks, text: "Follow the steps below as written." },
      { Icon: Terminal, text: <>If you use WSL, run every command inside the WSL shell, including <code>claude</code>.</> },
    ],
  },
  {
    id: "macos",
    tab: "macOS",
    name: "macOS",
    Icon: Laptop,
    kind: "not-verified",
    badge: "NOT YET VERIFIED",
    rows: [
      { Icon: CircleDashed, text: "The steps below use no Linux-specific tools, so they may work, but nobody has tested them on macOS." },
      { Icon: Bug, text: "Treat any difference as a bug to report, not as a supported setup." },
      { Icon: Wrench, text: <>The native module <code>better-sqlite3</code> needs a working build toolchain during <code>pnpm install</code>.</> },
    ],
  },
  {
    id: "windows",
    tab: "Windows",
    name: "Windows",
    Icon: Monitor,
    kind: "not-verified",
    badge: "NOT YET VERIFIED",
    rows: [
      { Icon: CircleDashed, text: "Native Windows (PowerShell, cmd) has not been tested." },
      { Icon: Route, text: "Path separators and quoting in the commands below would differ." },
      { Icon: Terminal, text: "The verified route on a Windows machine is WSL2: install the project inside WSL and use the Linux steps." },
    ],
  },
];

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
        <AnimatedTabs defaultValue="linux" verticalFromMd>
          <AnimatedTabsList label="Operating system">
            {PLATFORMS.map((p) => (
              <AnimatedTabsTrigger key={p.id} value={p.id}>{p.tab}</AnimatedTabsTrigger>
            ))}
          </AnimatedTabsList>
          <AnimatedTabsPanels>
            {PLATFORMS.map((p) => (
              <AnimatedTabsContent key={p.id} value={p.id}>
                <TabPanelCard
                  Icon={p.Icon}
                  title={p.name}
                  badge={<StatusBadge kind={p.kind} label={p.badge} />}
                  rows={p.rows}
                />
              </AnimatedTabsContent>
            ))}
          </AnimatedTabsPanels>
        </AnimatedTabs>
      </Section>

      <StepRail>
        <Section id="build" title="1. Get the code and build it">
          <p>
            Clone the public repository and build it. The project is not published as a package yet, so you build from source.
          </p>
          <CodeBlock code={CLONE} label="Clone and build" />
          <p>This produces <code>packages/server/dist/index.js</code>, the file Claude will start.</p>
        </Section>

        <Section id="sample-db" title="2. Optional: create the sample database">
          <p>
            The example config also lists a read-only SQLite connection named <code>local-sqlite</code>. Its database file is
            generated, not committed, so run this once from the repository root to create it. Without it the{" "}
            <code>db_*</code> tools return <code>INTEGRATION_UNAVAILABLE</code>; the filesystem tools work either way.
          </p>
          <CodeBlock code={SAMPLE_DB} label="Create the sample database (optional)" />
        </Section>

        <Section id="add" title="3. Add it to Claude Code">
          <p>
            The first run can use the example config shipped in the repository. It points at a small sample workspace
            inside the repository, keeps every pack read-only and has the database, GitHub and API packs disabled. Use
            absolute paths; <code>/ABSOLUTE/PATH/TO/ik</code> stands for where you cloned the repository.
          </p>
          <CodeBlock code={ADD} label="Add the server to Claude Code" />
          <p>
            Syntax follows the Claude Code documentation:
            <code> claude mcp add [options] &lt;name&gt; -- &lt;command&gt; [args...]</code>, where <code>--transport stdio</code> is an
            option and goes before the name, and <code>--</code> separates Claude&rsquo;s own options from the server command (
            <a href="https://code.claude.com/docs/en/mcp">code.claude.com/docs/en/mcp</a>).
          </p>
        </Section>

        <Section id="verify" title="4. Verify">
          <CodeBlock code={VERIFY} label="List MCP servers" />
          <p>
            Start <code>claude</code> and ask: &ldquo;Call <code>server_get_status</code> and show me the result.&rdquo; You
            should see the server name and version, which packs are enabled, <code>allowWrites: false</code> and the
            limits in force. The exact fields are listed in the <Link href="/tools">tools reference</Link>.
          </p>
        </Section>
      </StepRail>

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
