# apps/web `/docs` page spec (P7-24a)

Author: ui-ux. Date: 2026-11-09. Status: DESIGN for PM and human review. Design only: no code is written here and `apps/web` is not touched (another developer is polishing it at the same time).
Task: P7-24 (board row "`/docs` page: ui-ux spec first"), this slice is P7-24a; the developer tasks in section 19 are proposals (D-00..D-09) for the PM to map to `P7-nn`.
Human decision (2026-11-09, via the main thread): after the motion work the site gets a `/docs` page that documents how to USE the MCP server. The site's goal is to attract MCP users and state the purpose plainly.
Inputs read: `.claude/docs/README.md`, docs 03, 04, 05; `project/README.md`; `packages/server/config/devworkspace.example.json`; `web-design-brief.md`; `web-motion-spec.md`; CONTEXT.md and ADR-120..129; archived P7 handoffs (P7-10..P7-37, X-02); current `apps/web/src` (pages, `components/{shared,site,motion,ui}`, `lib/site.ts`, `data/`, `globals.css`, `scripts/check-forbidden.mjs`).
Hard rules carried over: PRD §15 and ADR-022 (static site, no backend, no model API, no secrets, sample data only, nothing on the site changes config or permissions), free fonts and icons only (Geist, `lucide-react`), no analytics, no `<form`, no `<script>` in source, no `localhost`/`127.0.0.1` literals in `src/` (`check-forbidden`).

Traceability rule for this page: every statement on `/docs` must be traceable to `project/README.md`, docs 03/04/05, the example config, or code under `packages/server` / `apps/web/src/data`. Where it is not, the page says nothing and the gap is an open question (section 21). Each section in 6 lists its sources.

## 1. Purpose and audience

Primary reader: a developer who uses Claude Code and wants to run ik against their own project: install it, point it at a folder (and optionally a database, a GitHub repo, an internal API), connect it, ask Claude useful things, understand why something was refused, fix a broken setup. Secondary: a reviewer who wants to see that the project is documented like a real tool and that the docs are honest about what is unverified.

The page answers, in this order: What is it and why would I run it? Can I have it working in 5 minutes? How do I aim it at my stuff? How does Claude Code reach it? What can it do (packs, tools, prompts)? What will it refuse? What do I do when it breaks?

Tone: plain, second person, short sentences, no marketing. Same honesty rules as `/install`: "Verified" only for Linux/WSL2 and Claude Code; macOS, native Windows, Claude Desktop, and the live GitHub API are "Not yet verified" and the page says so wherever they appear (use `StatusBadge kind="not-verified"`).

## 2. Information architecture: one long page, not a docs tree

Recommendation: ONE page, `/docs`, with a sticky "On this page" table of contents (TOC). No `/docs/<topic>` routes in v1.

Reasons
1. Size. The source material is one README of about 450 lines plus doc 03/04 excerpts. Rendered, this is roughly 5,000-6,500 words. That is one page, comparable to `/tools` (31 cards) and `/install`; a tree of ten thin pages would each be a screen long and mostly navigation.
2. Find-in-page. Users search for an error code, a key name or a tool name. With one page, browser find (Ctrl+F) hits everything. Nothing is hidden in accordions or tabs on this page (section 9).
3. Static export. `output: "export"`, `trailingSlash: false` gives one `out/docs.html`; no nested layout, no per-topic `generateStaticParams`, one sitemap entry, one budget row in `web-motion-budget.json`. The README "Web app" note (serve `out` with a server that maps `/docs` to `docs.html`) stays true with no extra line.
4. Link stability. Deep links are heading anchors (`/docs#configure-h`), consistent with `/tools#fs_read_file` and `/security#watch`. Splitting later keeps old anchors alive by redirecting nothing (static) and instead leaving a stub section; so start single.
5. Smaller JS. A tree would need a left nav component, active-route logic and a search decision. One page needs one scroll-spy.
6. Print and offline. One URL prints or saves as one document.

When to split (trigger, not now): the built `out/docs.html` exceeds about 250 KB uncompressed, or the page exceeds about 9,000 words, or the human adds content that is not usage (for example architecture or contributor docs). Then split into `/docs` (Quick start, Configure, Connect, Packs) and `/docs/reference` (config keys, limits, troubleshooting, FAQ). Architecture and contributor docs stay out of `/docs` (they live in the repo README).

Do not duplicate `/install`, `/tools`, `/security`, `/demo`. Rule: `/docs` owns the narrative and the task-oriented recipes; the other pages own their reference. Overlap map:

| Topic | Owner page | What `/docs` does |
|---|---|---|
| Requirements, clone, build, add, verify, update/remove, platform status | `/install` | Quick start shows the three steps as a short checklist with the SAME snippets (shared module, section 11) and links to `/install#build`, `#add`, `#verify`, `#os`. It does not re-explain Node/pnpm or per-OS status; it states the honesty line in one sentence and links |
| Per-tool description, inputs, read/write, status, response envelope, error code table | `/tools` | Lists tool names per pack as links (`/tools#<tool>`), never inputs. Error codes appear only in the "what is blocked" table with the cause and the fix, linking `/tools#errors-h` for the full table |
| Security model, guards per pack, layers, GuardDemo, test evidence, operator duties | `/security` | One-screen "in practice" table of what is refused and the code; links `/security#watch`, `#guards-h`, `#operator-h`. No guard internals |
| Recorded sample sessions | `/demo` | Links to `/demo` from Packs and Quick start; no transcripts copied |
| Example prompts | none today (design brief had `/prompts`, never built) | `/docs` owns them (section 6.5). No `/prompts` route |

## 3. Navigation slot

- `NAV` in `src/lib/site.ts`: insert `{ href: "/docs", label: "Docs" }` between Install and Tools: Install, Docs, Tools, Security, Demo. Also add `"/docs"` to `ROUTES` (sitemap) and a "Docs" link to the footer nav and to the footer's note (the footer still says the source link "will be added when the project is published"; that is stale after ADR-128, flag to the owner, not part of this task).
- Active state: `NavLinks` already marks `aria-current="page"` when `pathname === href || startsWith(href + "/")`. `/docs` needs no change. Style stays `bg-accent text-accent-foreground`.
- Mobile header with five items: today the header is `flex-wrap`, the nav sits on its own full-width row below `sm` (`order-3 w-full`). Five links at the current `px-3` are about 330 px wide against 288 px available at 320 px, so the row would wrap to two lines and the sticky header would grow by about 2 rem. Recommendation (answers Q-H7): no `Sheet` menu. Try, in this order: (1) `px-2` and `gap-x-0` on links below `sm`; (2) `text-[0.8125rem]` below `sm`; (3) accept the wrap at 320 px only. Use a `Sheet` only if (1)+(2) still wrap at 360 px. Reason: a Sheet adds a client dialog, focus management and a hidden nav on a five-item site. Developer measures at 320, 360, 390 and reports the header height per breakpoint (task D-00). Human confirms visually.
- Landing: add a text link "Read the docs" next to "Full tools reference" in the packs section and a third, ghost CTA is NOT added to the hero (keeps two CTAs; the header link is enough). `/install` gets a closing line "Next: configure it and try prompts" linking `/docs#configure-h`; `/tools` lead gets one link to `/docs#packs-h`. These are small copy edits, listed as D-09.

## 4. Page layout

Shell: new `DocsShell` (server) because `PageShell` is `max-w-4xl` and has no side column. Container `mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16` (matches header and footer width). The `h1` ("Documentation") and the lead use the same classes as `PageShell` (`text-3xl font-semibold sm:text-4xl`, lead `max-w-[70ch] text-lg text-muted-foreground`).

Below `lg` (< 1024 px): single column.
1. `h1`, lead.
2. "On this page" as a native `<details>` (collapsed by default, `summary` min-height 44 px, chevron icon, full-width card). Works with no JS. Inside: the same ten links. Not sticky (the header is already one or two rows tall; a second sticky bar would hide content and was dropped for `/tools` in ADR-126).
3. Sections.

At `lg` and up: two columns `grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10`.
- Left column: `<aside>` containing `<nav aria-label="On this page">`, `sticky top-24 self-start max-h-[calc(100vh-7rem)] overflow-y-auto`. DOM order: TOC BEFORE the content, so keyboard and screen-reader order is TOC then content, with no visual/DOM mismatch (TOC is on the left, which is also reading order). A right-hand rail was rejected: the brief's "On this page" right rail needs a left nav too, and without a left nav the right rail wastes the left half and reverses DOM order.
- Right column: content, each section's text capped at `max-w-[75ch]` by `Section`, so tables and code may fill the column width but prose stays readable.
- `xl` and up: no third column; extra space is margin.

Two TOC renderings (details for mobile, aside for desktop) are both in the DOM; `lg:hidden` and `hidden lg:block` use `display: none` so only one is exposed to assistive tech at a time. One data array `DOCS_TOC` feeds both.

Section component: reuse `Section` from `shared/page-shell.tsx` (renders `<section aria-labelledby>`, `h2#<id>-h` with an anchor link, `scroll-mt-20`). Heading ids are therefore `<id>-h`, and TOC links point to `#<id>-h` exactly like the `/tools` chip nav. `h3` subsections are written inline with `id`, `scroll-mt-20` and the same anchor-link treatment (small `DocsH3` helper in the docs components, or a prop on `Section`; developer's choice, no behaviour change for other pages).

Sticky TOC and the header (answers the `scroll-padding-top: 5rem` question)
- The header is `sticky top-0 z-40`. It is one row at `lg` (about 3.5-4 rem, to be measured) and one to two rows below `sm`/`md` (about 6 rem, to be measured). Numbers here are estimates: D-00 measures them with Playwright (`getBoundingClientRect` of the header at 320, 390, 768, 1280) and writes the real values in the handoff.
- `html { scroll-padding-top: 5rem }` (globals.css) and `Section`'s `scroll-mt-20` (5rem) are BOTH applied by browsers: scroll-padding insets the scrollport, scroll-margin outsets the target box, and the two add. A heading reached by hash therefore likely stops about 10 rem below the viewport top, not 5 rem. That is safe against a tall header but wastes space; it is an observation to verify, not a fact. Acceptance for `/docs`: after clicking each TOC link, the target `h2` top is between (header bottom + 8 px) and (header bottom + 48 px) at 390, 768 and 1280 widths. If the measured value is outside that range, adjust in the docs scope only (for example pass `className="scroll-mt-0"` for docs sections, keeping the global 5 rem), and report it so the owner can fix the global double count.
- Sticky TOC `top` = measured `lg` header height + 1 rem. Start with `top-24` (6 rem). The TOC never overlaps the header and, because it is `max-h` bounded with `overflow-y-auto`, stays reachable on short laptop screens (10 entries; 1.4 rem line height ≈ 16 rem, fits from 600 px viewport height up).
- WCAG 2.4.11 (focus not obscured): focus on a TOC link inside the scrolling aside is never behind the header (the aside sits below it). Focus on content elements scrolled into view is handled by `scroll-padding-top`; there is no sticky element over the content column.
- The right edge of a heading anchor `:target` must remain visible: `scroll-margin` is set on the target element so `:target` is not under the header.

## 5. Section list and order

Ten H2 sections, in this order (ids are the `Section` ids; headings are `<id>-h`). The first four are the spine for someone who wants to USE it; 5-6 are what it can do; 7-9 are "when things go wrong"; 10 is reference.

| # | Title (h2) | `Section id` | TOC label |
|---|---|---|---|
| 1 | What ik is | `what` | What it is |
| 2 | Quick start in 5 minutes | `quick-start` | Quick start |
| 3 | Configure | `configure` | Configure |
| 4 | Connect to Claude Code | `connect` | Connect |
| 5 | The five packs | `packs` | The five packs |
| 6 | Resources and prompts | `resources-prompts` | Resources and prompts |
| 7 | Safety in practice | `safety` | Safety in practice |
| 8 | Troubleshooting | `troubleshooting` | Troubleshooting |
| 9 | FAQ | `faq` | FAQ |
| 10 | Reference | `reference` | Reference |

TOC shows H2 only (ten entries). H3s are reachable by anchors and in-page chips where useful (Packs, Configure recipes), not in the TOC, to keep the sticky list short.

## 6. Section content outline (copy intent and sources)

Source codes: R = `project/README.md` (heading in brackets), D3/D4/D5 = `.claude/docs/03|04|05`, EX = `packages/server/config/devworkspace.example.json`, W = existing web file, C = code. "Copy intent" says what the reader should be able to do after reading.

### 6.1 What ik is (`what`)

Copy intent: in 30 seconds the reader knows the purpose, what it is not, and whether it fits.
- Lead (plain purpose, 2 sentences): ik is a local server that lets Claude Code read the folders, databases, GitHub repositories and internal APIs you choose, and nothing else, with read-only as the default. It runs on your machine and never calls a model. Sources: `SITE_DESCRIPTION` (`lib/site.ts`), R [intro].
- "What you can ask Claude to do" (4 bullets, one per capability, each with one tool name or pack): understand a project folder; inspect a database schema and run a read-only query; look at GitHub issues, pull requests and commits; call a described internal API endpoint; combine them into an overview or a change plan that is proposed, not applied. Source: R [Tools, resources, prompts], [Example prompts].
- "What it is not" (3 short bullets, same three claims as the landing S2): not a model (it never calls a model API; Claude interprets structured results); not a shell or HTTP proxy (no shell execution, no arbitrary URLs); not a hosted service (stdio, local process, no Docker or Supabase needed). Source: R [intro], [Security], [Docker].
- "How it works": reuse `HowItWorks` (static SVG with title/desc plus the four-step list), WITHOUT the `FlowDiagram` animation wrapper (docs stay calm, section 12). Check `motion-flow.css` import: `HowItWorks` classes `fd-*` are styled there; import that stylesheet in `docs/page.tsx` or the static look degrades (D-02 verifies).
- Status line: `StatusBadge kind="not-verified"` is NOT used here; instead a `Callout title="What is verified"` repeats the honesty line: developed and tested on Linux/WSL2 with Claude Code; automated tests use mocks and local fixtures; macOS, native Windows, Claude Desktop and the live GitHub API are not verified. Sources: R [status], [Known limits], W `install/page.tsx` callout. Link `/install#os`.
- Product naming note (small `Callout`, tone info): "ik is the project name on this site; file, folder and variable names in the repository still say devworkspace (for example `devworkspace.example.json`, `DEVWORKSPACE_CONFIG`)." Source: R, EX, D3 §1. Reason: readers will see both. Open question Q-H5 (publish name, Q9).

### 6.2 Quick start in 5 minutes (`quick-start`)

Copy intent: a person with Node, pnpm, git and Claude Code installed gets the sample workspace answering in about five minutes, and knows the exact next step.
- Prerequisites line (one sentence, link `/install#requirements-h`): Node.js 22+, pnpm 10, git, Claude Code.
- Placeholder legend (one sentence): "`/ABSOLUTE/PATH/TO/ik` stands for where you cloned the repository; replace it before running." Same convention as `/install`.
- Four numbered steps (an `<ol>`, each step a short sentence plus the shared snippet; no `StepRail` rail here, docs stay calm):
  1. Build: S1 clone and build. Link "Details: `/install#build-h`". Then optional S2 `pnpm sample:db` (creates the demo SQLite database used by the example config). IMPORTANT gap: `/install` S1 does not include `pnpm sample:db`, so with the example config `db_*` calls return `INTEGRATION_UNAVAILABLE` (R [Configuration reference]). Docs include it as step 1b and flag the `/install` gap to the PM (Q-P1).
  2. Add: S4 `claude mcp add ik -- node ... --config ...example.json`. Link `/install#add-h`.
  3. Verify: S5 `claude mcp list`; then in Claude Code ask "Call `server_get_status` and show me the result." Expected: server name and version, which packs are enabled, `allowWrites: false`, limits in force. Source: R [Connect a host], D4 §4.0. Link `/install#verify-h`.
  4. Try it: three prompts that work with the example config (PromptCards, section 6.5): "Give me an overview of the sample workspace…" (Scenario A), "List the tables in `local-sqlite`, describe `orders` and its relationships, then count orders per status. Do not run any write.", and then the expected-behaviour sentence from R [Database walk-through]: counts `cancelled 1, pending 1, shipped 2` and that `DELETE FROM orders` is rejected with `QUERY_REJECTED`. Sources: R [Demo scenarios A-C], [Database walk-through].
- Closing paragraph "Next": use your own folder (`#configure-h`), enable GitHub or an API (`#recipes`), watch a recorded session (`/demo`).
- Honest note: the `--transport stdio` flag appears in the README form but not in `/install`'s ADD snippet. Both are described as valid by the repository docs; the docs page uses the `/install` form. D-00 runs `claude mcp add --help` to confirm which form to show and records it (Q-P3).

### 6.3 Configure (`configure`)

Copy intent: the reader can edit one JSON file to point ik at their project and enable the packs they want, without breaking read-only. Order: understand the file, then recipes.

H3s (anchors in parentheses):
1. How the config is loaded (`cfg-loading`): path comes from `--config <path>`, else the `DEVWORKSPACE_CONFIG` environment variable, else the server exits with code 1 and a hint (no fallback to the working directory because hosts start servers from unpredictable directories). One JSON file. Unknown keys are rejected so a typo cannot silently disable a safety setting. Relative paths resolve against the config file's folder, not the working directory. Invalid config stops startup and names the JSON path, never a secret value. Sources: R [Check that it starts], [Configuration reference], D3 §1.
2. Anatomy of the file (`cfg-anatomy`): excerpt snippet S7 (every top-level section, values shortened, derived from EX) plus a legend table "Section | What it controls" (`server`, `permissions`, `limits`, `workspaces`, `filesystem`, `databases`, `github`, `customApis`) from R [Configuration reference] first column. No inline comments in JSON (real config is strict JSON, and a commented sample cannot be pasted). Note: every pack defaults to `enabled: false`; the shipped example enables the filesystem pack on a tiny sample folder and one read-only SQLite connection; the PostgreSQL, GitHub and sample API entries are present but disabled. Source: R, EX. The full key-by-key table is in Reference (`#reference-h`), not here.
3. Workspaces (`cfg-workspaces`): a workspace is a named project root: `id`, `name`, `rootPath` (must resolve, symlinks followed, inside `filesystem.allowedRoots`), and optional links: `github` (`owner/repo`), `databases[]`, `apis[]` (must name entries that exist). Tools take the workspace id plus a relative path, never an absolute path. Sources: R [Configuration reference], D3 §2, D4 §4.D.
4. Permissions (`cfg-permissions`): `defaultMode: "read-only"`, `allowWrites: false`, `writeOperations: []`. A write needs `allowWrites: true` AND the exact operation name in `writeOperations`. In the shipped tools the only write-capable path is a custom API endpoint declared `permission: "write"`, named `api:<profile>/<endpoint>`; there is no GitHub write tool (two are listed as not shipped on `/tools`). A write tool that is not allowed is not registered. Callout (warn): "Leave `allowWrites` at `false` unless you have a specific reason." Sources: R [Security], D3 §4, `data/tools.ts`. Link `/security`.
5. Limits (`cfg-limits`): table of the defaults the user will meet (request timeout 15 s, DB query timeout 10 s, 100 DB rows, 200,000 bytes per file read and per result, 100 list/search results, 30 s workflow deadline) and the rule: overrides can only tighten them, never raise. Truncation is always reported (`meta.truncated`). Key names are in D3 §5 (`networkTimeoutMs`, `dbQueryTimeoutMs`, `dbMaxRows`, `maxFileBytes`, `maxResults`, `workflowTimeoutMs`, `maxResponseBytes`); the full 17-key table is a Reference sub-table. Sources: R, D3 §5.
6. Secrets and environment variables (`cfg-secrets`): the config holds environment variable NAMES (`tokenEnv`, `passwordEnv`, `connectionStringEnv`, `valueEnv`), never values. The server reads the environment only from the process the host starts (the host's MCP `env` block); it does not load `.env` files. Table of the four names used by the example (`DEVWORKSPACE_CONFIG`, `DEVWS_PG_URL`, `GITHUB_TOKEN`, `SAMPLE_API_TOKEN`) with what each is for, and S17 (optional `node --env-file=/abs/path/.secrets.env …`, Node >= 20.6, keep the file outside the repository, the server does not depend on it). Callout: "This site never asks for a token or a path and has no form." Sources: R [Environment variables], D3 §1, §6.
7. Recipes (`recipes`): five short recipes, each = goal sentence, config fragment (copyable), what you must also do, what to ask Claude. Fragments are derived from EX and R; none introduces a key that EX/D3 lack.
   - `r-folder` Point ik at your own project: copy the example config (shared snippet S6 from `/install`), edit `workspaces[].rootPath` and `filesystem.allowedRoots`; link `/install#config-h` for the minimal snippet instead of repeating it. One extra sentence: blocked names, `ignoreDirs`, `allowedExtensions`, `maxFileBytes` (<= 200000) refine what is visible; secret-like files (`.env*` except `.env.example`, keys, `.ssh/`, `.git/` internals, `*secret*`) are never listed, searched or read (R [Security]).
   - `r-sqlite` Add a SQLite database: S10 (`databases[]` entry with `type: "sqlite"`, `databasePath`, `readOnly: true`, plus the workspace `databases` link). `readOnly: false` is rejected.
   - `r-postgres` Add PostgreSQL: S11 (`connectionStringEnv` name, `schemas`), the env var through the host `env` block, and the required read-only role in prose: only `CONNECT`, `USAGE`, `SELECT`; `schemas` filters list/describe but is not a security boundary for `db_execute_readonly_query`; rows may contain personal data and there is no automatic PII redaction. Warn Callout. Source: R [Security] Database. No GRANT SQL is shown (not in sources, Q-H3).
   - `r-github` Enable GitHub: S12 (`github.enabled: true`, `tokenEnv`, `allowedRepositories` with a placeholder `OWNER/REPO`); both allowlists empty means every `github_*` tool is denied; the token is optional for public repositories (unauthenticated reads are rate limited, a startup warning is logged); link the repo to a workspace through `workspaces[].github` and set `rootPath` to a local clone for workflow tools. Status: `StatusBadge kind="not-verified"` "Live GitHub API not yet verified (tested against a local mock)". Source: R [Security] GitHub, Scenario B, Known limits.
   - `r-api` Describe an internal API: S13 (`customApis[]` profile: `name`, `baseUrl` placeholder `https://API-HOST.example`, `auth` of type `bearer` + `tokenEnv`, `allowedMethods: ["GET"]`, one `endpoints[]` entry with `name`, `method`, `path` template, `description`, `permission: "read"`). Prose: only declared endpoints can be called; tool arguments name an endpoint and never carry a URL; redirects are not followed; loopback/private addresses need `allowPrivateNetwork: true` on that profile (cloud metadata addresses always blocked); responses are size-capped and `sensitiveFields` are redacted; no sample API process ships, so you must run your own. The snippet must NOT contain `127.0.0.1` or `localhost` (`check-forbidden`): use the placeholder host and say in prose "to point at a service on your own machine, set `allowPrivateNetwork: true`". Source: R [Security] Custom API, Scenario C, EX.
8. After editing (`cfg-after`): restart the server (re-open the Claude Code session) so the tool list is rebuilt; if the server fails to start, run the command by hand and read stderr (link `#troubleshooting-h`). Source: R [Troubleshooting] "Tools missing in the host".

### 6.4 Connect to Claude Code (`connect`)

Copy intent: add, verify, update and remove the server in Claude Code on WSL/Linux, and know what is not verified.
- Badge row: `StatusBadge kind="verified"` "Claude Code on WSL / Linux" and `StatusBadge kind="not-verified"` "macOS", "Windows (native)", "Claude Desktop" (three small badges, icon+text).
- Add with the config (shared S4; absolute paths; the `--` separator explained once, link to `code.claude.com/docs/en/mcp`, which `check-forbidden` allows).
- Add with a secret: S14 `claude mcp add --transport stdio --env GITHUB_TOKEN=<your-token> …` (the option goes before the server name; Claude Code stores the value in its own settings, not in the repository). Uses the placeholder `<your-token>` (not token-shaped). Source: R [Connect a host].
- Or a project `.mcp.json` that refers to the variable by name: S15 (`"env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }`; Claude Code expands it from your shell; the secret is not written to the file). Implementation trap: in a TS template literal `${GITHUB_TOKEN}` interpolates; escape it as `\${GITHUB_TOKEN}` or use a plain string constant.
- Verify: `claude mcp list` (health check), `/mcp` inside a session, ask Claude to call `server_get_status`. Update: `pnpm build` then restart the session. Remove: `claude mcp remove ik` (S16). Source: R [Connect a host].
- Server name note: the name after `claude mcp add` is yours (`/install` uses `ik`; the README uses `devworkspace`).
- Other hosts (short, honest): macOS and native Windows installs are untested, mostly the native `better-sqlite3` build; Claude Desktop is not verified; link `/install#desktop-h` and do not repeat its JSON. The WSL-from-Windows `wsl.exe` route is experimental and unverified (R); say it in one sentence with no config.

### 6.5 The five packs (`packs`)

Copy intent: the reader learns what each pack does, how to turn it on, what to ask, and which tool names to look up.
- Intro: "A pack's tools are registered only when the pack is enabled. `server_get_status` is always there." Counts come from `data/tools.ts` at build time (29 implemented tools) rather than hand-typed; resources 5, prompts 5 from `data/docs.ts`.
- Overview grid (5 cards, calm): reuses the landing's pack metadata via `PACKS` in `data/tools.ts` (title, blurb). Optional single `Stagger` here (section 12), nowhere else on the page.
- One H3 per pack (anchors `pack-filesystem`, `pack-database`, `pack-github`, `pack-api`, `pack-workflows`), each with the same fixed layout so the page is scannable: (a) one-sentence "what it does"; (b) "Turn it on" (config key, default state, link to its recipe); (c) tool names as small links to `/tools#<tool>` (rendered from `PACKS[].tools`, with the `Not shipped` badge reused for the two GitHub write tools); (d) "Good to know" bullets (2-3, sourced); (e) PromptCards (2 per pack, from R [Example prompts] verbatim); (f) link to `/tools#<pack>-h` and, where one exists, the `/demo` scenario.
  - Filesystem (6 tools): workspace-relative paths; secret-like files hidden; binary files return `UNSUPPORTED`; limits on size, depth, scanned files and results. Prompts: "List the workspace `sample-project` and read its README. Show me where the greeting is implemented." and "Search the workspace for `greet` and show the matching lines."
  - Database (6): single SELECT (including `WITH ... SELECT`); `db_explain_query` never uses ANALYZE; SQLite opens read-only; PostgreSQL needs a read-only role. Prompts: the two database prompts from R.
  - GitHub (8): allowlisted repositories only; base URL fixed `https://api.github.com`; issue and PR text is untrusted data; `github_list_repositories` returns the first page only. Status badge not-verified (live API). Prompts: the two GitHub prompts from R.
  - Custom API (3): `api_list_profiles`, `api_get_endpoint_info`, `api_call_endpoint`; write endpoints are denied unless writes are enabled and the exact `api:<profile>/<endpoint>` entry exists. Prompt: "List the configured API profiles and describe the `get-health` endpoint, then call it."
  - Workflows (5): deterministic composites; each returns `sections` with a status per source (`ok`, `partial`, `unavailable`, `disabled`, `error`) so a missing integration shows up honestly; global deadline `workflowTimeoutMs` (30 s); table "Tool | needs" from D4 §5 (overview needs filesystem; summarize activity needs GitHub; find issue context needs GitHub + filesystem; inspect data flow needs filesystem + database or API; generate change plan needs GitHub + filesystem). Prompts: "Give me an overview of workspace `sample-project`." and "Find files related to issue 12 in `example-org/example-repo` and draft a change plan. Do not modify anything."
- "Reading a result" (small H3 `packs-results`): the envelope in one paragraph (`success`, `data`, `meta` with `truncated`/`partial`/counts, `warnings`, or `error` with a stable code), link `/tools#response-h`. No second copy of the JSON.

### 6.6 Resources and prompts (`resources-prompts`)

Copy intent: know these exist, what each returns, when each appears.
- Resources: one table "URI | Needs | What it returns" with the five rows from R [Resources]: `workspace://list`, `workspace://{workspaceId}/overview`, `filesystem://{workspaceId}/tree`, `github://{owner}/{repository}/summary`, `database://{connectionName}/schema`. Sentence: registered only for enabled packs; same JSON envelope as the matching tool, redacted and size-bounded, no absolute paths or secrets.
- Prompts: one table "Prompt | Arguments | Needs": `review_project_health` (`workspace?`, filesystem), `understand_repository` (`workspace?`, filesystem), `investigate_github_issue` (`repo` as `owner/repo`, `issueNumber`, `workspace?`, GitHub), `understand_database_schema` (`connection`, database), `prepare_change_plan` (`goal`, `workspace?`, `issueNumber?`, filesystem). Sentences: static templates that tell the host which tools to call and to separate confirmed facts from inferences; a prompt appears only when its pack is enabled and steps naming an unregistered tool are left out; arguments are embedded as quoted data, never as instructions or configuration.
- How to invoke: R says only "from the host's prompt menu". The page says exactly that. It does NOT state Claude Code's slash-command or `@` mention syntax (not in sources). Open question Q-P2: developer or human verifies how Claude Code lists MCP prompts and resources and the page then adds one sentence.
- Table style: shared `Table` in a scroll wrapper; URIs in `font-mono`. Data in `data/docs.ts` (`RESOURCES`, `PROMPTS`), checked against R by `check-docs` (section 19).

### 6.7 Safety in practice (`safety`)

Copy intent: the reader predicts what ik refuses, recognises the error code, and knows the fix. This is NOT the security model (that is `/security`).
- Short intro: "ik answers a refused request with a stable error code and a safe message; it never returns a stack trace, a secret or an upstream body. Claude sees the same code you see below."
- Table "If this is asked | You get | Why | What to do" (rows, all from sources; code strings must match `ERROR_CODES` on `/tools` and `data/guards.ts`):

| Asked | Code | Why | What to do |
|---|---|---|---|
| Read a file outside the workspace (`..`, absolute path) | `INVALID_INPUT` (parent segments) or `PERMISSION_DENIED` | paths are workspace-relative; `..`, encoded traversal, backslashes, NUL, absolute paths rejected; symlinks must stay inside the root | use a relative path inside the workspace |
| Read `.env`, a key, `.git/` internals | `PERMISSION_DENIED` | secret-like files are never listed, searched or read | by design; only `filesystem.unblock` can lift it and it is logged at startup (D3) |
| A write (`INSERT`, `DELETE`, `DROP`), several statements, `PRAGMA`, `ATTACH` | `QUERY_REJECTED` | exactly one SELECT is accepted | use `db_list_tables` / `db_describe_table` for schema |
| A GitHub repository not in the allowlist, or both allowlists empty | `PERMISSION_DENIED` | fail closed | add it to `github.allowedRepositories` |
| A URL as an API endpoint | `INVALID_INPUT` | only configured endpoint names are accepted | use `api_get_endpoint_info` |
| An API profile on a loopback/private address | `PERMISSION_DENIED` | needs `allowPrivateNetwork: true` on that profile; cloud metadata addresses always blocked | set it only if intended |
| A write-type API endpoint | `PERMISSION_DENIED` | needs `allowWrites: true` and the exact `api:<profile>/<endpoint>` in `writeOperations` | normally leave it denied |
| An unknown workspace, connection, profile | `NOT_FOUND` | names must exist in the config | list them with `workspace://list`, `db_list_connections`, `api_list_profiles` |
| A result over the byte or row limits | `meta.truncated: true`, or `LIMIT_EXCEEDED` | bounded by design | ask for less data |
| A missing database file, token or unreachable service | `INTEGRATION_UNAVAILABLE` (retryable) | the integration cannot run | see Troubleshooting |
| A slow query or call | `TIMEOUT` (retryable) | timeouts apply | narrow the request |
| Rate limit | `RATE_LIMITED` (retryable, `retryAfterSeconds`) | GitHub limits | set a valid token, wait |

  Sources: R [Security], [Troubleshooting], D4 §3, D5 §2/§3, `data/guards.ts`. The developer confirms every pair in the table against `packages/server/test/security` and `data/guards.ts` (note the traversal code: the guard returns `INVALID_INPUT` for `..` while the README says `PERMISSION_DENIED` for outside-the-workspace paths; the row shows the code per case, not one code for both. Q-P4).
- "Sample refusal": one `CodeBlock` (json, no copy) rendered from `guardEnvelope()` of the `sql-write` case in `data/guards.ts` (same envelope as the real tool, labelled "Sample call, sample data"), followed by links: `/security#watch` ("Watch the guards refuse") and `/demo`. No GuardDemo embed.
- "What stays your job" (4 bullets, from R [Security] and D5): use a read-only PostgreSQL role; rows may contain personal data (no automatic PII redaction); content from files, issues and APIs is untrusted data and cannot widen access because permissions come from your config, not from arguments; keep tokens in the host `env` block. Link `/security#operator-h`.
- Audit log: one paragraph. Each tool/resource call appends metadata (time, tool, resource reference, outcome, error code, duration, write flag) to the JSONL file at `server.auditLogPath` (example: `config/audit/audit.jsonl`, git-ignored), without arguments, SQL text or contents. No sample line (format not in the sources).

### 6.8 Troubleshooting (`troubleshooting`)

Copy intent: the reader finds their symptom, learns the cause and fixes it without leaving the page.
- Lead: "First step for almost everything: run the exact server command by hand and read stderr." Snippet S3 (the `node dist/index.js --config …` command from the README; `noCopy` for the expected-output block: stderr shows `{"level":"info","msg":"devworkspace-mcp ready on stdio"}`; counts are logged after the first client message). Without `--config` and without `DEVWORKSPACE_CONFIG` it exits 1 with `no config file specified…`.
- Table "Symptom | Cause and fix" with the 13 rows of R [Troubleshooting] (exit code 1 `Invalid configuration`; host shows failed / no tools; garbled protocol / "invalid JSON"; `Cannot find module 'better-sqlite3'`; `PERMISSION_DENIED` on a file; `NOT_FOUND`; all `github_*` denied; GitHub `INTEGRATION_UNAVAILABLE`/`RATE_LIMITED`; database `INTEGRATION_UNAVAILABLE`; `QUERY_REJECTED`; `TIMEOUT`; API call `PERMISSION_DENIED` for a private address; `LIMIT_EXCEEDED`; tools missing in the host; secrets not visible). Rewritten in plain words but no new causes. Each row has an `id` (`ts-<slug>`) and a `:target` ring (CSS, section 12) so other pages and README can deep link. Each fix links to the relevant Configure anchor.
- Logs line: logs are JSON lines on stderr; `server.logLevel` for detail.
- Why a table, not an accordion or `<details>`: closed content is invisible to Ctrl+F and to print. The table lives in a `role="region" tabIndex={0}` scroll wrapper with a visually hidden `<caption>`, exactly like the `/tools` error table.
- Footer line: "Still stuck? The repository's issue tracker." Link `REPO_URL` + `/issues` only if issues are enabled (unknown: Q-H6). Default: link the repository only.

### 6.9 FAQ (`faq`)

Copy intent: answer the questions that decide whether someone installs it. Each question is an `h3` (searchable, linkable, `faq-<slug>`), answer 1-3 sentences, each with a source.

1. Does it call a model or send my data to an AI service? No: the server never calls a model API; Claude interprets the structured results. Packs only contact what you configured (GitHub API for allowlisted repositories, your API profiles). Source: R intro, Security.
2. Can Claude change my files, database or repositories? Not by default and, with the shipped tools, not at all for files and databases: file tools are read-only, SQL is one SELECT, no GitHub write tool ships; only a custom API endpoint you mark as a write and enable twice can write. Source: R [Security], D3 §4.
3. Can it read my `.env` or SSH keys? No: secret-like files are never listed, searched or read. Source: R [Security] Filesystem.
4. Where do my secrets go? In environment variables set in the host's MCP `env` block; the config holds only variable names. Source: R [Environment variables].
5. Does it need Docker, Supabase or an account? No. Docker is only for the PostgreSQL integration tests. Source: R [Docker], intro.
6. Does it work on macOS, Windows, Claude Desktop? Not verified. Source: R [Known limits]. Link `/install`.
7. Is it on npm? Not yet; build from source. Source: W `install/page.tsx` ("not published as a package yet"), footer note.
8. How do I see what it did? The JSONL audit log. Source: R [Security].
9. Why can't I raise a limit? Overrides can only tighten defaults. Source: D3 §5.
10. Does this website collect anything? No tracking, no cookies, no third-party requests, no accounts; it never reads your config. Source: footer text (`site-footer.tsx`).
11. How do I update or remove it? Pull, `pnpm install`, `pnpm build`, restart; `claude mcp remove ik`. Link `/install#update-h`.
Order: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 (trust first, platform after). Items 9-11 can be dropped if the page runs long.

### 6.10 Reference (`reference`)

Copy intent: look-up material and the way out to the repository. Four H3s.
1. Config keys (`ref-config`): the table from R [Configuration reference] (Section | Keys | Notes), one row per section, with the note text lightly edited; links to `/docs#cfg-...` where a subsection explains the key. Scroll-wrapped table with caption.
2. Limits (`ref-limits`): the D3 §5 table (Key | Default | Meaning); sources: D3 §5. Mark that `maxFileBytes` cannot exceed 200000.
3. Environment variables: not repeated; link `#cfg-secrets`.
4. Links (`ref-links`): a plain list (icon + text): Source repository (`REPO_URL`, via the existing `GithubLink` button), README (`${REPO_URL}/blob/main/README.md`, branch name `main` per the repo; confirm), the example config (`${REPO_URL}/blob/main/packages/server/config/devworkspace.example.json`), implementation notes (`/docs/implementation-notes.md` path in the repo), MCP introduction `https://modelcontextprotocol.io`, Claude Code MCP docs `https://code.claude.com/docs/en/mcp`. External links open in a new tab with `rel="noopener noreferrer"` like the GitHub buttons, and are built from `REPO_URL` (a JSX expression, not a literal `href="https://…"`, so `check-forbidden` passes; for the two non-repo URLs only the allowed prefixes `modelcontextprotocol.io/` and `code.claude.com/docs/` are permitted).
  Also "Reading order for reviewers": `/security`, `/demo`, `/tools` (3 links).

## 7. Copy-paste snippet list

Rules: every block is a `CodeBlock` (server, Shiki highlighted at build time, `figcaption` label, copy button via `CopyButton` which is hidden until hydrated), label is specific ("Add the server to Claude Code", never "Code"), placeholders are UPPERCASE paths (`/ABSOLUTE/PATH/TO/ik`) or angle-bracket words (`<your-token>`), never token-shaped. `noCopy` for outputs and for text not meant to be pasted. No snippet contains `localhost`, `127.0.0.1`, a real token, or an unescaped `${…}`.

| ID | Snippet | Lang | Copy | Source | Shared with |
|---|---|---|---|---|---|
| S1 | Clone and build (`git clone ${REPO_URL}.git ik`, `cd ik`, `pnpm install`, `pnpm build`) | bash | yes | W install `CLONE`; R [install] | `/install` |
| S2 | `pnpm sample:db` (creates the demo SQLite database) | bash | yes | R [install], [Configuration reference] | new |
| S3 | Run the server by hand against the example config, plus expected stderr line | bash + text | yes / no | R [Check that it starts] | new |
| S4 | `claude mcp add ik -- node …/dist/index.js --config …/devworkspace.example.json` | bash | yes | W install `ADD`; R | `/install` |
| S5 | `claude mcp list` and the verify prompt text | bash | yes | W install `VERIFY`; R | `/install` |
| S6 | `cp packages/server/config/devworkspace.example.json ~/ik-config.json` | bash | yes | W install `COPY_CONFIG` | `/install` |
| S7 | Config at a glance: all top-level sections, shortened | json | yes | EX | new |
| S8 | Permissions block (`defaultMode`, `allowWrites: false`, `writeOperations: []`) | json | yes | EX, D3 §2 | new |
| S9 | Workspace entry with links (`id`, `name`, `rootPath`, `github`, `databases`, `apis`) | json | yes | EX, D3 §2 | new |
| S10 | SQLite connection entry + workspace link | json | yes | EX | new |
| S11 | PostgreSQL connection entry (`connectionStringEnv: "DEVWS_PG_URL"`, `schemas`) | json | yes | EX | new |
| S12 | `github` block (`enabled`, `tokenEnv`, `allowedRepositories: ["OWNER/REPO"]`) | json | yes | EX | new |
| S13 | `customApis[]` profile with one read endpoint, placeholder host | json | yes | EX (host replaced) | new |
| S14 | `claude mcp add --transport stdio --env GITHUB_TOKEN=<your-token> ik -- node … --config …` | bash | yes | R [Claude Code] | new |
| S15 | Project `.mcp.json` with `"${GITHUB_TOKEN}"` | json | yes | R [Claude Code] | new |
| S16 | `claude mcp remove ik`; rebuild + restart | bash | yes | R | `/install#update` |
| S17 | `node --env-file=/abs/path/.secrets.env dist/index.js --config …` (optional) | bash | yes | R [Environment variables] | new |
| S18 | Env var names table (not a code block) | table | n/a | R, `.env.example` | `/install` ENV_NAMES |
| S19 | Sample refusal envelope | json | no | `guardEnvelope()` in `data/guards.ts` | `/security` |
| P1-P11 | Example prompts (PromptCards), 2 per pack plus 3 quick-start prompts | text | yes | R [Example prompts], [Scenarios] | landing hero script uses a subset |

Single source of snippets: move S1, S4, S5, S6 (and the ENV names) to `src/data/snippets.ts` exporting constants; `install/page.tsx` imports them (a three-line change per constant) so the two pages cannot drift. Because another developer is working in `install/page.tsx` right now, this edit happens in D-01 only after that work lands (or `docs/page.tsx` imports its own copies for the first PR and D-09 dedupes; Q-P1).

Config fragments (S7-S13) are validated headlessly: the `check-docs` script merges each fragment into the example config and loads the result with the server's config loader from `packages/server/dist` (skipped when `dist` is absent, like the bundle checks). Placeholders such as `OWNER/REPO` are valid strings; the check must not need network or env vars (disabled packs, or env var names that are only names).

## 8. Prompt blocks

New small server component `PromptCard` (`components/docs/prompt-card.tsx`): `<figure>` with a `figcaption` ("Prompt for Claude"), the prompt as a `<blockquote>`-styled paragraph (wraps, not `pre`, so long prompts do not scroll sideways; `font-sans`, not mono), the existing `CopyButton` (`what` = "prompt"), optional one-line "What you should see" (`text-sm text-muted-foreground`, only when R states an expectation). Why not `CodeBlock`: it is `overflow-x-auto` mono, wrong for prose. Prompts are verbatim from R [Example prompts] / [Scenarios]; the page does not invent new prompts.

## 9. Code block, table and find-in-page UX

- Copy feedback is the existing one (`CopyButton`: icon swap, "Copied" label, `role="status"` live region, red failure text, 2.5 s reset; CSS success ring from `motion-install.css` `:has([data-copy-state="copied"])`). Docs reuse it unchanged; if the ring rule is scoped to `/install` selectors, D-02 re-scopes it to a shared class (check, do not assume).
- Long lines scroll inside the block (`overflow-x-auto`); block labels always visible; no line numbers; no collapse.
- Tables: shadcn `Table` inside `div role="region" aria-label="…" tabIndex={0} className="overflow-x-auto rounded-lg border"` plus a `sr-only` `<caption>`. Extract this wrapper to `components/shared/scroll-table.tsx` (used by `/tools` error table later; do not edit `/tools` now).
- Search: NO in-page search or filter in v1, and no new dependency. Reasons: all content is plain text in the HTML so browser find works; a filter over a 10-section narrative page has no obvious semantics; a client filter would be SSR-safe only if it never hides content before interaction (rule in motion spec §0.3), which makes the value small. Tool lookup is `/tools`; error-code lookup is the safety and troubleshooting tables. If the human wants search later, the cheap option is a text input that filters only the Troubleshooting table rows after the first keystroke (client, `hidden` toggled, result count in an `aria-live="polite"` region, empty state "No match. Clear the filter."), still no library. Not specified further.
- Heading anchors: `Section` already wraps the h2 text in a link to its own id; h3 gets the same pattern. No copy-link icon animation. Headings must be unique across the page (ids `<section>-h`, `cfg-…`, `pack-…`, `faq-…`, `ts-…`).

## 10. TOC and scroll-spy behaviour

- Markup: `<nav aria-label="On this page" id="docs-toc"><ul>` with ten links `href="#<id>-h"`. A visible heading above the list: "On this page" (`text-xs font-semibold uppercase tracking-wide text-muted-foreground`, not an `h2`; the nav's accessible name already says it).
- Active section: after hydration, a client component sets `aria-current` on the link whose section is in the reading band (`rootMargin: "-40% 0px -55% 0px"`, first in document order wins), and removes it on unmount. Reuse `PackSpy` (it takes `navId` and `headingIds` and already behaves this way). Backward-compatible additions the developer should make in `pack-spy.tsx` or a sibling `docs-spy.tsx`: (a) keep the last active link when no section is in the band (so the TOC never goes blank between sections); (b) mark the last link active when the page is scrolled to the bottom (short last section); (c) accept an optional `current` value (`"location"` for the TOC, default `"true"` for `/tools`) and apply it to every `[data-docs-toc]` nav (both the mobile `details` and the desktop `aside` copies).
- Visual state: not by colour alone: the active link gets `font-medium`, a 2 px left bar (a `::before` with `opacity` 0 to 1, the same technique as `#tools-packs a::before`) and `text-foreground`; inactive links are `text-muted-foreground`. Transition `opacity var(--dur-fast)` only inside `@media (prefers-reduced-motion: no-preference)`. Hover/focus: underline and `text-foreground`; focus ring is the global `:focus-visible` 2 px ring (`--ring`).
- Clicking a TOC link: native hash navigation; smooth scroll applies only under `prefers-reduced-motion: no-preference` (ADR-127(1)); the URL hash updates and `:target` styling applies. The mobile `<details>` stays open after tapping (no JS needed); acceptable. Optional enhancement D-09: a tiny effect to set `details.open = false` on link click.
- Back-to-contents: below `lg`, a small "Contents" link (arrow-up icon + text, `lg:hidden`) at the end of each H2 section pointing to `#docs-toc`. Optional (D-09), skipped if the page feels noisy.
- No JS: TOC works as plain anchor links; no active state; nothing hidden.
- Keyboard: TOC links in DOM order before content; `Tab` through ten links is acceptable; the existing "Skip to content" link jumps past header only, so add a second skip target? Not needed: the TOC comes before content but is short. (If testing shows it is annoying, the h1 lead can link "Skip to the first section" = `#what-h`.)

## 11. Visual direction

Inherited from `web-design-brief.md` §4 and `globals.css`; no new tokens needed.
- Type: Geist Sans for prose, Geist Mono for code and identifiers (already loaded by `next/font`); h1 `text-3xl/4xl`, h2 `text-2xl semibold`, h3 `text-lg semibold` (`font-heading`), body `leading-relaxed` at about 16 px, line length 65-75ch (`Section` already caps at 75ch). Inline `code` uses the Section rule (`bg-muted` chip).
- Color: tokens only (`--primary` links, `--muted` code, `--border`, `--safe`/`--warn`/`--danger` for badges and callouts). Status never by colour alone (icon + text, existing `StatusBadge`).
- Spacing: 4 px grid; sections `mt-12`; h3 `mt-8`; tables `my-6`; consecutive snippets `my-4` (CodeBlock). No decorative backgrounds, no gradients, no illustration other than `HowItWorks`.
- Light/dark: nothing special; Shiki dual-theme already switches by `.dark`. The TOC left bar uses `--primary` (verify contrast of the active label `text-foreground` on `--background`, already AA).
- Tone: the reading surface is the quietest page on the site (answers Q-H2 default "calm on tools and docs").
- Icons (lucide, approved): `BookOpen` for Docs context only if the header ever shows icons (it does not); section icons are NOT used in headings. Callouts and badges reuse their own icons. Cards in the packs overview reuse the landing icons (same `Pack` icon map if one exists; otherwise text only).

## 12. Motion rules (docs stay calm)

Governing rules: `web-motion-spec.md` §0 (server HTML is the final state, one-shot, transform/opacity/clip-path only), ADR-122/127, ADR-129 (no render-time reduced-motion branches).
Allowed on `/docs`:
1. Global chrome unchanged: page enter (`template.tsx`, CSS), header elevation, scroll progress bar (CSS `animation-timeline`; add `/docs` to the route list that shows it, read the exact rule in `motion-chrome.css` first), logo eye follow and blink, theme toggle with View Transitions, smooth hash scrolling.
2. TOC active bar: opacity transition under `no-preference` (section 10).
3. `:target` ring on troubleshooting rows, `h3` recipes and FAQ headings: same technique as `.tool-card:target::after` (pseudo-element border, opacity 0.4 static under reduced motion, fade 1.2 s under no-preference).
4. Copy feedback: unchanged.
5. At most ONE `Stagger` (the five-pack overview grid in section 5) or none. If it is used, it is the existing `Stagger`/`StaggerItem` (below-fold arming, 40 ms, max 400 ms total).
Not allowed: `Reveal` on paragraphs, tables, code or callouts; `FlowDiagram`; `GuardDemo`/Replay; typed text; tab animation (no tabs on this page); parallax; count-up numbers; auto-playing anything; any new animation library code.
- Reduced motion: all differences live in CSS (`@media (prefers-reduced-motion: reduce)` / `no-preference` wrapping) and in the existing effects; the new client code (`DocsSpy`) has no motion; no component branches on `useReducedMotion()` or `matchMedia` during render (ADR-129). The TOC bar is static (opacity switches at once). Hash scrolling is instant.
- New CSS: `src/app/motion-docs.css` (imported by `docs/page.tsx`, following the `motion-*.css` pattern): TOC bar, `:target` rings, sticky offsets. `check-motion` rules apply (no `transition: all`, no `infinite`, keyframes only inside the `no-preference` block).
- Print: the print block in `globals.css` already shows final states. Add `@media print { #docs-toc, .docs-toc-mobile { display: none } }` and let the grid collapse to one column; code blocks keep `white-space: pre-wrap` in print so lines do not clip (nice-to-have).

## 13. Mobile layout (mobile-first)

- Order: h1, lead, "On this page" details, sections. Single column, `px-4`.
- Tap targets: details summary and TOC links at least 44 px high; copy buttons keep the current 28 px `h-7` (above the 24 px minimum of WCAG 2.5.8); chips and links in the packs section `min-h-8`+ with spacing.
- Code: scrolls horizontally inside the block; the page itself must not scroll sideways at 320 px (acceptance: `document.documentElement.scrollWidth <= window.innerWidth` at 320/360/390 on every state). Long unbroken tokens in `<code>` inside prose (URIs such as `github://{owner}/{repository}/summary`) get `overflow-wrap: anywhere`.
- Tables: scroll in their region (focusable, labelled); first column (Section / Symptom / URI) is not sticky.
- PromptCard: copy button below the text at `<sm`, beside it at `sm+`.
- Packs overview grid: 1 column, `sm` 2 columns, `lg` 3 columns.
- The header may be one row taller on mobile (section 3); `scroll-padding-top` verified with the acceptance in section 4.

## 14. Accessibility (WCAG 2.2 AA)

- Landmarks: the single `<main id="main">` from the root layout; inside it, `nav[aria-label="On this page"]` (one exposed at a time), `section[aria-labelledby]` per H2 (via `Section`). Header `nav[aria-label="Main"]` and footer `nav[aria-label="Footer"]` already differ in label.
- Headings: one `h1`; `h2` per section; `h3` per subsection; no skipped levels; headings are real text (not images); the anchor link inside the heading has the heading text as its name.
- Skip link: the root "Skip to content" goes to `#main` (programmatic focus target `tabIndex={-1}`, already present).
- TOC: `<nav>` + `<ul>`; `aria-current="location"` on the active link (set by the spy); a visible active state that is not colour alone; works without JS.
- Keyboard: all interactive elements are native (`a`, `button`, `summary`); tab order equals DOM order equals visual order; the scroll-wrapped tables are focusable (`tabIndex={0}`, labelled region) so keyboard users can scroll them; focus ring never clipped (the aside is `overflow-y-auto`: give the list `px-1` so the outline is not cut off).
- Contrast: tokens already verified by `check-contrast.mjs`; new pairs to add there: TOC inactive label on `--background` both themes, active bar vs background (3:1), `:target` ring (3:1).
- Tables: `<caption>` (sr-only), `scope="col"` on headers, first-column cells as `th scope="row"` where it is the identifier.
- Code and prompts: `CodeBlock` already exposes `role="group"` + `aria-label`; PromptCard `figure` + `figcaption`.
- Status messages: copy feedback uses the existing `role="status"` live region; the spy updates only `aria-current` (no live region); no other announcements.
- Links: external links announce they open a new tab (visible icon plus `sr-only` "(opens in a new tab)", as `GithubLink` does); link text is descriptive (never "here").
- Language: plain; abbreviations expanded on first use (MCP, SSRF only if mentioned); `lang="en"` is set.
- Zoom and reflow: 400% zoom at 1280 collapses to the mobile layout (single column) with no horizontal page scroll; text spacing overrides must not clip (no fixed heights on text containers).
- Motion: section 12; nothing flashes; nothing auto-plays.
- Forced colors: TOC active bar uses `Highlight` via `@media (forced-colors: active)` fallback, and the active link keeps `font-medium`.

## 15. SEO and metadata

- Route metadata in `docs/page.tsx`: `title: "Docs"` (template gives "Docs | ik"), description: "How to use ik: build it, configure workspaces, connect it to Claude Code, enable the five packs, and understand what it refuses. Free, local, read-only by default." (about 150 characters; matches facts). No `openGraph.images` override (the root `og:image` stays); no canonical until a domain exists (P7-08, H-15).
- `src/lib/site.ts` `ROUTES` gets `"/docs"` so `sitemap.ts` emits it.
- One `h1`, meaningful h2/h3 text, descriptive anchor text. No JSON-LD (it needs a `<script>`, which `check-forbidden` forbids in source). No FAQ schema for the same reason.
- The `robots.ts` file is unchanged. No `noindex`.
- The page title and description do not claim anything the page does not support ("verified", "works on all platforms").

## 16. Performance budget and static output

- Rendering: server components only; Shiki highlights at build time; no runtime markdown, no MDX dependency, no `fetch`.
- Client JS added to `/docs`: only the spy (about 1 KB gzip) plus the already-shared `CopyButton`, `ThemeToggle`, header scripts. Target: `/docs` first-load JS at most the size of `/tools` (the closest page without tabs; it already carries `Stagger`/`Reveal` and `PackSpy`: +6,828 B over the post-motion baseline per CONTEXT) plus 1 KB gzip for the docs-specific spy changes. `domMax` is NOT loaded on `/docs` (no `AnimatedTabs`). `motion/react` `m` appears only if the one optional `Stagger` is used (then the `domAnimation` async chunk is already part of the shared load).
- HTML size: the page has about 25 code blocks and several tables; target `out/docs.html` at most 250 KB uncompressed and at most 45 KB gzip; trigger for splitting is in section 2.
- LCP element is the `h1`/lead text (never hidden at first paint); CLS 0 (no late-inserted content; the TOC reserves its column; `details` is closed by default on mobile with fixed summary height).
- Add a `docs` row to `docs/design/web-motion-budget.json` by adding ONE route entry after the first build (do not run `--write-baseline` blindly: it rewrites every route; if the script offers no per-route mode, hand-add the entry from the measured gzip numbers and say so in the handoff).
- `scripts/check-motion.mjs` rules (imports only in motion dirs, no `motion.*`, reduced-motion guard in client motion files, no SSR-hidden HTML, banned transitions, no infinite loops) must pass; if the spy lives in `components/motion/`, it needs the same guard comment `PackSpy` uses or an allowlist entry.

## 17. Component inventory

Reuse (no change)
| Need | Component | Notes |
|---|---|---|
| Page chrome | root layout, `SiteHeader`, `NavLinks`, `SiteFooter`, `ThemeToggle`, `template.tsx` | `NAV` + `ROUTES` entries only |
| Section with h2 and anchor | `shared/page-shell.tsx` `Section` | `PageShell` is not used (width) |
| Code | `shared/code-block.tsx` (+ `CopyButton`, `lib/highlight.ts`) | `noCopy` for outputs |
| Notes, warnings | `shared/callout.tsx` | `tone="warn"` for write-related warnings |
| Status | `shared/status-badge.tsx` | `verified`, `not-verified`, `not-shipped`, `sample`, `read-only`, `rejected` |
| Tables | `ui/table.tsx` | in the scroll region |
| Buttons and links | `ui/button.tsx`, `site/github-link.tsx` `GithubLink` | repository link in Reference |
| Diagram | `shared/how-it-works.tsx` | static, no `FlowDiagram` |
| Pack data | `data/tools.ts` `PACKS`, `ERROR_CODES` (read-only imports) | tool names, counts, error codes |
| Sample refusal | `data/guards.ts` `guardEnvelope()` | one case |
| Icons | `lucide-react` | approved |
| shadcn not needed | `Accordion`, `Tabs`, `Sheet`, `Dialog`, `Command` | explicitly not used on this page |

Extend (backward compatible)
| Item | Change |
|---|---|
| `components/motion/pack-spy.tsx` | optional `current` value, keep-last-active, bottom-of-page rule, multiple navs (section 10); or a sibling `docs-spy.tsx` that shares the logic |
| `lib/site.ts` | `NAV`, `ROUTES` |
| `install/page.tsx` | import shared snippets (D-01 end), closing "Next" link |
| `site-footer.tsx` | add Docs link (and fix the stale source-link sentence: owner) |

New
| Component | Type | File |
|---|---|---|
| `DocsShell` (h1, lead, two-column grid, sticky aside) | server | `src/components/docs/docs-shell.tsx` |
| `DocsToc` (nav list; renders both desktop and mobile forms) | server | `src/components/docs/docs-toc.tsx` |
| `PromptCard` | server | `src/components/docs/prompt-card.tsx` |
| `DocsH3` helper (anchor heading) | server | `src/components/docs/docs-h3.tsx` |
| `ScrollTable` wrapper | server | `src/components/shared/scroll-table.tsx` |
| `DocsSpy` (or PackSpy extension) | client | `src/components/motion/docs-spy.tsx` |
| Docs data: `DOCS_TOC`, `RESOURCES`, `PROMPTS`, `ENV_VARS`, `CONFIG_KEYS`, `LIMITS`, `TROUBLESHOOTING`, `FAQ`, `EXAMPLE_PROMPTS` | data | `src/data/docs.ts` |
| Shared snippets S1, S4, S5, S6, ENV names | data | `src/data/snippets.ts` |
| Page | server | `src/app/docs/page.tsx` |
| Styles | css | `src/app/motion-docs.css` |
| Checker | script | `apps/web/scripts/check-docs.mjs` (added to the `lint` script chain) |

shadcn/ui mapping: Table, Button, Badge-like `StatusBadge`, Separator (between sections? not needed), Card (pack overview cards reuse the landing's card classes). No new shadcn components are installed.

## 18. File placement

```
apps/web/src/app/docs/page.tsx            sections, metadata
apps/web/src/app/motion-docs.css          TOC bar, :target rings, sticky offset, print
apps/web/src/components/docs/{docs-shell,docs-toc,docs-h3,prompt-card}.tsx
apps/web/src/components/shared/scroll-table.tsx
apps/web/src/components/motion/docs-spy.tsx   (or pack-spy.tsx extended)
apps/web/src/data/{docs,snippets}.ts
apps/web/scripts/check-docs.mjs
docs/design/web-motion-budget.json         one new route row
```
Long prose lives in `page.tsx` JSX (consistent with the other pages); structured/tabular content lives in `data/docs.ts` so `check-docs` can compare it with the README and `tools.ts`. If `page.tsx` passes about 900 lines, split sections into `src/app/docs/_sections/<name>.tsx` (underscore folder = not a route).

## 19. Build order (small developer tasks)

Each task is at most one 40 minute slice, ends with `pnpm --filter ik-web lint && typecheck && build` green. Blocked by: PM approval of this spec, the answers marked "gates" in section 21, and the other developer's current polish work landing in `site.ts`, `install/page.tsx`, `globals.css`, `pack-spy.tsx` (those files are edited by D-01/D-02 only after it lands).

| ID | Task | Files | Acceptance | Headless verification |
|---|---|---|---|---|
| D-00 | Measure and confirm facts, no UI: header height at 320/360/390/768/1280; where a hash target lands now (margin + padding add?); five-item nav wrap at 320/360/390; `claude mcp add --help` (is `--transport stdio` accepted, where does `--env` go); that `Section`, `HowItWorks` styles do not depend on page-specific CSS; how `scroll-progress` picks its routes; branch name for repo links | handoff only (scratchpad Playwright) | all numbers written in the handoff with the command used | Playwright script in scratchpad (as in P7-27..P7-37); never in the repo |
| D-01 | Data and shared snippets: `data/snippets.ts` (S1, S4, S5, S6, ENV names; install imports them), `data/docs.ts` skeleton (TOC, RESOURCES, PROMPTS, ENV_VARS, EXAMPLE_PROMPTS), `scripts/check-docs.mjs` with `--self-test`, wired into `lint` | `src/data/*`, `install/page.tsx` (imports only), `scripts/check-docs.mjs`, `package.json` | `/install` output text identical before and after (diff of `out/install.html` text); `check-docs` fails on a planted bad tool name and passes on real output | lint, build, HTML text diff, self-test |
| D-02 | Shell and navigation: `/docs/page.tsx` with the ten empty-but-headed sections, `DocsShell`, `DocsToc` (desktop aside + mobile details), spy, `motion-docs.css`, NAV + ROUTES + footer link, metadata, `scroll-progress` route, mobile nav fit | files in section 18, `lib/site.ts`, `site-footer.tsx` | TOC links reach every section; active state follows scroll at 1280 and 390; header does not wrap at 360 (or the fallback order in section 3 is applied); `/docs` in `out/sitemap.xml`; hash landing offset within the section 4 range; no console errors under reduced-motion emulation (no React #418) | Playwright: scroll, `aria-current`, widths, `reducedMotion: 'reduce'` console capture; grep `out/docs.html` for `id="what-h"` etc. |
| D-03 | Sections 1-2 (What, Quick start) + `PromptCard` + Callouts | `docs/page.tsx`, `prompt-card.tsx` | snippets identical to `/install` (shared constants); `pnpm sample:db` step present; every statement has a source in section 6; honesty callout present | `check-docs` (sources list), HTML grep for "Not yet verified" |
| D-04 | Section 3 (Configure) with H3s, legend table, five recipes, limits table | `page.tsx`, `data/docs.ts` | recipes valid against the server config loader; no `localhost`/`127.0.0.1`; `${…}` strings intact; Postgres read-only role warning present | `check-docs` config validation; `check-forbidden` |
| D-05 | Section 4 (Connect) | `page.tsx` | S14, S15, S16, S17 rendered; `${GITHUB_TOKEN}` literal appears in `out/docs.html`; verified/not-verified badges present | HTML grep; lint |
| D-06 | Sections 5-6 (Packs, Resources and prompts) | `page.tsx`, `data/docs.ts` | tool names come from `PACKS` (no hand-typed duplicates); 5 resource URIs and 5 prompts equal README tables; each pack has 2 prompts | `check-docs` compares with `project/README.md` and `data/tools.ts` |
| D-07 | Sections 7-8 (Safety in practice, Troubleshooting) | `page.tsx`, `data/docs.ts` | each code in the safety table exists in `ERROR_CODES`; 13 troubleshooting rows with ids; `:target` ring works; sample refusal generated by `guardEnvelope()` | `check-docs`; Playwright `#ts-…` target visible below header |
| D-08 | Sections 9-10 (FAQ, Reference) + repository links | `page.tsx`, `data/docs.ts` | external links carry `rel="noopener noreferrer"` and open in a new tab; only allowed external hosts; config key table matches README table rows | `check-forbidden`; `check-docs` |
| D-09 | Polish: 320 px overflow, print, forced-colors, contrast rows in `check-contrast.mjs`, budget row, cross-links from `/`, `/install`, `/tools`, optional details-close and back-to-contents, dedupe snippets if D-01 used copies | CSS, `check-contrast.mjs`, budget JSON, small copy edits | no horizontal page scroll at 320/360/390; budget met (section 16); contrast checks pass both themes | all scripts, Playwright widths |
| QA-12 (proposal) | Claim traceability audit of every sentence on `/docs` against its source, no-tracker/security audit, a11y review (TOC, tables), then the human visual pass | n/a | QA verdict | n/a |

Suggested start after the polish work lands: D-00 and D-01 in parallel (D-00 writes no files), then D-02, then D-03..D-08 in any order (they touch one file; run them sequentially or have each add its own `_sections/*.tsx`).

Headless checks available to every task: `pnpm --filter ik-web lint` (eslint, `check-forbidden`, `check-motion`, `check-docs`), `typecheck`, `build` (static export in `out/`), grep/text diff of `out/*.html`, Playwright in the scratchpad against `out/` served by a static server.

Only the human (or a later browser-equipped session) can verify
- How the page reads: tone, density, whether the Quick start really takes about five minutes on a clean machine, whether prompts produce the described result in a real Claude Code session (nothing here has been run).
- Visual rhythm of the sticky TOC next to code blocks in light and dark; TOC feel when jumping with smooth scroll; mobile `details` ergonomics on a real phone; 320 px header.
- Real copy-to-clipboard in Safari/Firefox, print preview, 400% zoom, forced-colors rendering.
- Screen reader pass (NVDA/VoiceOver) of TOC `aria-current`, tables and region focus.
- Lighthouse numbers (LCP/CLS/INP) on the deployed build.
- macOS, native Windows and Claude Desktop instructions: not verifiable by agents; the page deliberately contains none.

## 20. States

| State | Behaviour |
|---|---|
| Loading | None: static HTML. |
| JS disabled or not hydrated | Full content, TOC as plain anchors, copy buttons absent (`CopyButton` renders nothing until mounted), no active TOC state, mobile `details` works. |
| Empty | n/a (no dynamic lists). If a data array is ever empty at build, `check-docs` fails the build. |
| Error | No runtime data fetching, so no fetch errors. Copy failure: existing red text "Copy failed, select and copy manually". Unknown hash: browser stays at top; no custom handling. |
| Truncated | Documented behaviour (`meta.truncated`, `LIMIT_EXCEEDED`) is described in the Safety table; the page itself never truncates or paginates content. |
| Long content in a narrow viewport | Scroll regions for tables and code; `overflow-wrap: anywhere` for inline code. |
| Deep link to a missing h3 (renamed anchor) | Lands on the page top; mitigation: anchors listed in section 5/6 are frozen once shipped. |

## 21. Open questions

For the human
- Q-H1. Single page vs several pages: recommended single `/docs` with sticky TOC (section 2). Accept? Default yes.
- Q-H2. Header at five items: try compact link padding first, no `Sheet` menu (section 3; closes motion spec Q-H7). Accept? Default yes.
- Q-H3. Postgres read-only role: the page describes the required grants in prose only (`CONNECT`, `USAGE`, `SELECT`); do you want a copy-paste `CREATE ROLE`/`GRANT` example? It is not in the README, so I would have the developer write and test it first. Default no.
- Q-H4. Example prompts: use only the README prompts (no new ones). Default yes. (Gates D-03, D-06.)
- Q-H5. Naming: the docs say "ik" but file and variable names say devworkspace (`devworkspace.example.json`, `DEVWORKSPACE_CONFIG`, `server.name`). Add the naming note (section 6.1) or wait for the publish-name decision (Q9)? Default: add the note.
- Q-H6. Does the GitHub repository have Issues enabled, and may the docs link to `REPO_URL/issues` for "Still stuck"? Default: link only the repository.
- Q-H7. Should the landing hero get a third CTA "Docs"? Default no (header link plus a text link in the packs section; hero keeps Install and Demo).
- Q-H8. Do you want macOS/Windows/Claude Desktop how-to text at all? Default: no, only "not verified" plus links to `/install` and official docs, until someone verifies it.

For the PM
- Q-P1. Map D-00..D-09 and QA-12 to `P7-nn`/`QA-nn`; confirm the order relative to the other developer's polish work (files in conflict: `lib/site.ts`, `install/page.tsx`, `site-footer.tsx`, `globals.css`, `pack-spy.tsx`). Also record a gap: `/install` S1 omits `pnpm sample:db`, so the example config's SQLite connection is unavailable after following `/install` alone; either fix `/install` or keep the extra step only in `/docs`.
- Q-P2. Verification owner for gaps the sources do not cover: how Claude Code lists MCP prompts and resources (slash command or `@`), whether `claude mcp add` needs `--transport stdio`, README branch name for blob links. These stay out of the page until verified.
- Q-P3. Snippet drift: accept `src/data/snippets.ts` shared between `/install` and `/docs`, plus `check-docs` comparing tool names, resource URIs and prompt names with `project/README.md`? Who owns README drift (context-keeper drift check)?
- Q-P4. Traversal error code: README troubleshooting says `PERMISSION_DENIED`; `data/guards.ts` (`path-guard.ts`) shows `INVALID_INPUT` for `..`. The docs table states both by case; confirm against the guard before D-07.
- Q-P5. Should `ui-ux` review D-02 (TOC, spy, header fit) and D-07 (tables) in code before merge (a11y of the TOC)? Default yes, review only.
- Q-P6. Footer text still says the source link "will be added when the project is published" while the header and hero show it (ADR-128). Owner decision outside this task.

## Verified facts (2026-11-09)

Source: <https://code.claude.com/docs/en/mcp> (read by the main thread on 2026-11-09). These replace open item Q-P2 (prompts/resources syntax and `--transport stdio`).

- Add a local stdio server: `claude mcp add [options] <name> -- <command> [args...]`. The official examples always pass `--transport stdio`; the page does not say whether it is the default, so keep passing it.
- Environment variables: `-e` / `--env KEY=value`.
- Scopes: local (default), project (`.mcp.json`), user.
- Status: `claude mcp list` and `/mcp`.
- MCP resources are referenced with `@server:protocol://resource/path` (official example `@github:issue://123`). For ik: `@devworkspace:database://local-sqlite/schema` (URI template `database://{connectionName}/schema`; `local-sqlite` is in `devworkspace.example.json`).
- MCP prompts appear in the `/` menu as `/servername:promptname (MCP)`; `/mcp__servername__promptname` also runs them, with arguments after a space (official example `/mcp__github__pr_review 456`). In the `/mcp__servername__promptname` form, characters outside `A-Z a-z 0-9 _ -` in the server name become `_`.
- Fixed in P7-39: `/install` now has the optional `pnpm sample:db` step (finding 1); README troubleshooting error codes corrected against `path-guard.ts` and `filesystem-guard.test.ts` (finding 2); footer links the source repository via `REPO_URL` (finding 3).
- Still open: README branch name for blob links.

## Decision (2026-11-09)

The MCP server registration name is `ik` everywhere user-facing (human decision). Verified command form (source: <https://code.claude.com/docs/en/mcp>): `claude mcp add --transport stdio ik -- node /ABSOLUTE/PATH/TO/ik/packages/server/dist/index.js --config /ABSOLUTE/PATH/TO/config.json`; options such as `--transport stdio` and `--env` go before the name, and `--` separates the server command. Prompts: `/ik:review_project_health`, `/mcp__ik__understand_database_schema local-sqlite`; resources: `@ik:database://local-sqlite/schema`. The earlier open items about names (including the `@devworkspace:` example in the verified facts above) are resolved by this decision; file and package names (`devworkspace.json`, `devworkspace-mcp`, `DEVWORKSPACE_CONFIG`) are unchanged.
