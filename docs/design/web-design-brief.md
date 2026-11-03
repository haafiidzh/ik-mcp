# apps/web design brief (X-01)

Author: ui-ux (run as general-purpose acting as ui-ux). Date: 2026-11-03. Status: DISCUSSION INPUT for the PM. Design only; no code, no scaffolding.
Gate: ADR-014 is PROPOSED. PRD §15, §20, §23.3 still say no frontend before the MCP MVP. Nothing here may be built until the human edits the PRD or confirms ADR-014 (ADR-012 adds phase P7). Everything below is a plan, not a start signal.

## 1. Goals and non-goals

Goals
- G1. Explain in under 60 seconds what DevWorkspace MCP is and is not (an MCP server, not an LLM, not an agent).
- G2. Get a developer from landing to a working Claude Desktop / Claude Code config in 3 steps, per OS.
- G3. Make the security model the visible differentiator (read-only default, least privilege, no secrets, fail closed).
- G4. Be a browsable reference of all tools (31 in the MVP list: 1 status, 6 db, 10 github of which 2 write, 3 api, 6 fs, 5 workspace), their inputs, limits and error codes.
- G5. Show the product working without installing it: a demo using canned sample data and a transcript-style walkthrough of PRD §19 scenarios A-C.
- G6. Read as a credible portfolio piece to reviewers: clear case study, architecture, test and security evidence.

Non-goals
- No login, accounts, forms, comments, or contact forms collecting data in the MVP of the web app.
- No UI that changes config, permissions, integrations or runs tools against a real workspace. No secrets or tokens entered anywhere.
- No call to any model API; no chat box. The demo is a replay of recorded sample output, not live inference.
- No analytics or tracking service (free-only, privacy). Vercel's built-in analytics stays off.
- No display of file contents, secrets or raw upstream bodies, even in the demo (sample data is fabricated and obviously fake).
- No hosted MCP endpoint (ADR-011: server stays local stdio).
- Dashboard is out of the first release (section 3.7).

## 2. Audience and top 3 flows

Audience
- A. Developer who wants to install it (uses Claude Desktop or Claude Code, Windows/macOS/Linux). Wants copy-paste config and honest limits.
- B. Recruiter / reviewer judging a portfolio. Skims. Wants: what, why it is hard, proof (tests, security), repo link, in 2 minutes.
- C. Freelance client evaluating custom MCP integration. Wants the five packs, the safety story and example prompts.

Flow 1: Install in 3 steps (audience A)
Landing hero CTA "Install" -> /install (OS tab preselected from user agent, user can change) -> step 1 install the package (`npx`/global, final command from the P0 package decision), step 2 paste the config snippet for the host (Desktop JSON or `claude mcp add`), step 3 verify (ask Claude to call `server_get_status`, expected output shown). Ends with "Next: configure a workspace" and links to security model. Success = user sees the status tool result described. Every snippet has a copy button and the path placeholder is visibly a placeholder (`/ABSOLUTE/PATH/TO/workspace`), never a real path.

Flow 2: Find a tool (audience A, C)
Header search or /tools -> filter by pack chips (Database, GitHub, API, Filesystem, Workspace) and "read / write" toggle -> expand a tool row -> description, input table, example call, sample result, error codes, limits, "registered only when" note. Deep link per tool (`/tools#db_execute_readonly_query`) so it can be cited from prompts and the README.

Flow 3: View the security model (audience B, C)
Landing "Security first" strip -> /security -> one-screen "What the server will never do" list, then pipeline diagrams per pack (path guard, SQL guard, URL guard), the 21-row test matrix (S1-S21) as a table with pass/fail status once QA verified, then "what you must still do as operator" (read-only DB role, token scopes). Success = reviewer can name three controls in under a minute.

## 3. Sitemap and page outlines

```
/                    Landing
/install             Install guide (tabs: Windows | macOS | Linux; sub-toggle: Claude Desktop | Claude Code)
/tools               Tools reference (index)  -> anchors per tool; optional /tools/[pack] later
/security            Security model
/prompts             Example prompts
/demo                Demo with sample data
/about               Case study + architecture + roadmap (portfolio framing; merges into landing if thin)
/dashboard           (later phase, optional, read-only; see 3.7)
```
Global: header (logo/wordmark, Install, Tools, Security, Prompts, Demo, GitHub icon link, theme toggle), footer (repo, license, version, "no tracking, no cookies" line). Skip-to-content link first in tab order.

### 3.1 Landing `/`
1. Hero. Headline intent: "Give Claude safe access to your dev workspace." Sub: local, read-only by default, five packs. Primary CTA Install, secondary CTA Try the demo. Right side: a static terminal-style card showing one real tool call and its structured result (sample data).
2. What it is / is not. Three short columns: MCP server (stdio, local), not an LLM (never calls a model API), not a proxy (configured resources only).
3. Five packs grid. Card per pack: icon, one line, 2-3 tool names, default permission badge (Read-only / Writes off by default).
4. Security strip. Four guarantees as icon rows: read-only default, only configured roots/repos/connections, secrets only from env and always redacted, every call bounded and audited. Link to /security.
5. How it works. 3-step diagram: Claude host -> stdio -> server validates -> pack executes -> structured result (success/error shape from PRD §12). Inline SVG diagram, with text alternative.
6. Demo teaser. Shows scenario B (issue investigation to change plan) as 4 static steps; CTA to /demo.
7. Proof row. Test counts, security matrix pass rate, "free stack" badge. Numbers appear only after QA has produced them; until then the section is omitted (no invented stats).
8. Final CTA + footer.

### 3.2 Install `/install`
1. Requirements bar: Node version (from engines), a supported host, nothing paid. States which host is covered.
2. OS tabs (Windows, macOS, Linux) x host toggle (Claude Desktop, Claude Code). Selection persisted in the URL query (`?os=windows&host=desktop`) so it is shareable, and in localStorage only as a convenience.
3. Three numbered steps (install / configure / verify), each with copyable code block, expected output, and "if this fails" accordion with the 3 most common errors (wrong absolute path, Node not on PATH for Desktop, JSON syntax).
4. Per-OS facts: config file location of Claude Desktop, path separator and quoting notes, WSL note for Windows. Exact values must be taken from current official Claude Desktop/Code docs by the developer (CLAUDE.md official-docs-first); the designer does not assert them.
5. Config reference: workspace config file example with `permissions.allowWrites: false` shown prominently, env var names for secrets (names only, never values).
6. Uninstall / update note.

### 3.3 Tools reference `/tools`
1. Intro + the response envelope (success/error JSON, `meta.truncated`, `nextPageAvailable`).
2. Sticky filter bar: search, pack chips, access toggle (all / read / write), result count (`aria-live`).
3. Tool list grouped by pack. Row collapsed: name (mono), one-line description, badges (Read-only | WRITES, "needs canWrite"). Expanded: input table (name, type, required, limit), example call JSON, example result (sample), errors this tool can return, limits.
4. Error code table (12 codes from doc 04 §3) with retryable column.
5. Write tools (`github_create_issue`, `github_add_issue_comment`) visually distinct (warning badge) and labelled "Not registered unless enabled".
Data source: a single typed JSON/TS data file generated or hand-synced from the server's tool metadata. Open question Q-P2 below about generating it from the server to avoid drift.

### 3.4 Security model `/security`
1. "What it will never do" checklist (no shell, no arbitrary SQL writes, no arbitrary URLs, no whole-disk access, no secrets in output, no model calls).
2. Defense layers diagram: tool args -> schema validation -> policy/allowlist -> pack guard -> bounded execution -> redaction -> audit.
3. Per-pack guard panels (tabs): Filesystem path guard steps, Database SQL guard + connection-level read-only, GitHub allowlist + write gating, Custom API URL/SSRF guard. Content derived from doc 05 but written for readers, not copied verbatim.
4. Prompt-injection note: data returned from issues/files/APIs is untrusted and returned as data.
5. Test matrix S1-S21: table with columns case, pack, expected, status. Status column shown only from QA evidence. Filter by pack.
6. Operator responsibilities (read-only DB role, minimal-scope token, PII is not auto-redacted).
7. Known residual risks (TOCTOU note) stated plainly. Honesty is part of the pitch.

### 3.5 Example prompts `/prompts`
1. Intro: prompts are for the Claude host; the server does not interpret them.
2. Grouped by pack and by scenario (A overview, B issue investigation, C API + DB). Each card: prompt text (copy button), which tools Claude will likely call, what a safe result looks like, "what it will refuse" example (e.g. a request to read `.env` returns PERMISSION_DENIED).
3. Link to MCP prompts (`review_project_health`, ...) once Phase 6 ships; until then show as "coming" and keep out of the page.

### 3.6 Demo `/demo`
Replay player over canned sample data (a fictional "acme-shop" workspace, fake repo, SQLite sample DB). No live backend, no model, no uploads.
1. Scenario picker: A / B / C (PRD §19).
2. Left: conversation transcript (user prompt, assistant text marked as "recorded", tool calls as collapsible cards). Right: inspector showing the structured tool result with truncation and `partial` markers.
3. Controls: Step / Play / Reset, speed. Everything also usable as a plain list with no animation (reduced motion default).
4. Banner at top: "Recorded sample data. Nothing here touches your files." Fake data is labelled; no realistic-looking secrets or tokens even as fakes (use `ghp_EXAMPLE...`-style obviously invalid placeholders, or none).
5. Includes a "refusal" step in each scenario to demonstrate the guards.
Transcripts are static JSON authored by hand or captured from a real run against fixtures (QA/dev-supplied; see build order).

### 3.7 Dashboard `/dashboard` (later phase, optional, read-only)
Only after the server's optional one-way audit sync exists (ADR-011b) and the human approves a P7 dashboard sub-phase.
- Data: redacted audit metadata only (ts, tool, integration, resourceRef, outcome, errorCode, durationMs, write flag). Never arguments, SQL, contents.
- Views: calls over time (small bar chart), outcome breakdown, top tools, error codes, integration status list (pack, enabled, last seen), recent calls table with filters.
- States: empty ("sync is off or no events yet" with how to enable), loading skeletons, stale ("last event N minutes ago"), error.
- Auth question: the data is the owner's. A public deploy needs either static sample data (safe, portfolio-friendly) or an owner login. Recommended default: ship the dashboard first as a sample-data view only (same canned approach as /demo) and defer real data and auth. See Q-H3.
- No write actions anywhere; no toggles for permissions.

### 3.8 About `/about` (optional, small)
Problem, constraints (free only, local-first), architecture diagram, phase roadmap, decisions (ADR highlights), tech stack, link to repo and README. Fold into landing if content is thin.

## 4. Visual direction

Tone: calm, technical, trustworthy; security-forward without alarm. Dense but legible; documentation-first. No gradients-and-glow marketing clichés, no stock illustrations. Diagrams and real tool output are the imagery.

Consistency with the human's other app (/home/coder/automation-workflow): Next 16, React 19, Tailwind 4, shadcn with `radix-ui`, `lucide-react`, `class-variance-authority`, `tw-animate-css`, Geist + Geist Mono via `next/font/google`, oklch tokens, pnpm 10.22. Reuse the same conventions so components can be shared by copy. Note the other app uses pure neutral grayscale; this one adds one accent so the site has identity.

Font (free, OFL): Geist Sans for UI and prose, Geist Mono for code, tool names, JSON. Loaded through `next/font/google` (self-hosted at build, no runtime request to Google). Fallback stack: `ui-sans-serif, system-ui` and `ui-monospace`. Scale: 14 mono in code blocks, 16 body (never below), 20/24/32/48 headings, line-height 1.6 body, measure 65-75ch for prose.

Tokens (oklch, defined on `:root` and `.dark`; names follow shadcn so shadcn components pick them up). Contrast pairs are targets to be verified with a checker at implementation; AA needs 4.5:1 text, 3:1 UI.

| Token | Light | Dark | Use |
|---|---|---|---|
| --background | oklch(0.99 0.003 250) | oklch(0.16 0.01 255) | page |
| --foreground | oklch(0.20 0.02 255) | oklch(0.96 0.005 250) | text |
| --card | oklch(1 0 0) | oklch(0.20 0.012 255) | surfaces |
| --muted | oklch(0.96 0.006 250) | oklch(0.25 0.012 255) | code bg, zebra |
| --muted-foreground | oklch(0.45 0.02 255) | oklch(0.74 0.015 250) | secondary text (check >= 4.5 on background) |
| --border | oklch(0.90 0.008 250) | oklch(0.30 0.012 255) | hairlines |
| --primary | oklch(0.48 0.15 255) (deep blue) | oklch(0.74 0.12 250) | links, CTA |
| --primary-foreground | oklch(0.99 0 0) | oklch(0.16 0.01 255) | text on primary |
| --ring | oklch(0.55 0.16 255) | oklch(0.78 0.12 250) | focus ring, 2px + 2px offset |
| --safe | oklch(0.50 0.12 155) | oklch(0.78 0.13 155) | read-only badge, pass |
| --warn | oklch(0.52 0.13 70) | oklch(0.82 0.13 80) | WRITES badge, partial |
| --danger | oklch(0.50 0.19 27) | oklch(0.75 0.15 25) | rejected, fail |
| --radius | 0.5rem | | base radius |

Rules: status never by color alone (always icon + text label). Code blocks use `--muted` bg with a syntax theme that has >= 4.5:1 (single mono palette, few hues). Spacing on a 4px grid; section padding 64/96px desktop, 40/56px mobile. Max content width 72rem; docs pages use a 2-column layout (content + on-this-page rail) from lg. Icons: lucide-react (ISC, free). Motion: 150-200 ms fades; none required for comprehension; all disabled under `prefers-reduced-motion`. Theme: system default, manual toggle (light/dark/system), no flash on load.

## 5. shadcn/ui component inventory

Already used in the sibling app (copy as-is): Button, Card, Badge, Alert, Separator, Skeleton, Tooltip, ScrollArea, Input, Textarea (Textarea not needed here).

New for apps/web (all from the shadcn registry, built on `radix-ui`, already a dependency in the sibling app):
| Component | Used for |
|---|---|
| Tabs | OS and host selector, per-pack security panels, demo scenarios |
| ToggleGroup | host toggle, read/write filter |
| Accordion | "if this fails", tool row expand (or Collapsible), FAQ |
| Table | input schema tables, error codes, S1-S21 matrix |
| Command (+Dialog) | header search / tool jump (optional; needs `cmdk`, a new dep) |
| Sheet | mobile nav |
| DropdownMenu | theme toggle |
| Breadcrumb | tool detail pages if added |
| Progress or custom stepper | demo playback position |
| Collapsible | tool-call cards in demo |
| Sonner (toast) | "copied" feedback (new dep `sonner`; alternative: inline "Copied" text swap, zero deps) |

Custom (composed, not from registry): CodeBlock (copy button, filename label, language, line highlighting, `aria-label`), ToolRow, PackCard, StatusBadge (read-only / writes / partial / truncated / pass / fail), Diagram (inline SVG with title/desc), TranscriptStep, ResultInspector, SiteHeader, SiteFooter, ThemeProvider, OnThisPage rail, Callout (uses Alert).
Syntax highlighting: build-time highlighter (Shiki, MIT) to avoid shipping a client highlighter; needs approval (doc 11). Charts for dashboard: shadcn `chart` wraps Recharts (MIT); dashboard phase only.
Dependencies to ask approval for when P7 starts: next, react, tailwindcss, shadcn deps already named, plus `shiki`, optionally `cmdk`, `sonner`, `next-themes`, later `recharts`. Nothing outside doc 11 "Approved" may be installed before approval.

## 6. States and accessibility

States
| Surface | Empty | Loading | Error | Truncated / partial |
|---|---|---|---|---|
| Tools filter | "No tools match. Clear filters" with reset button | none (static data) | n/a | n/a |
| Demo player | scenario not chosen: prompt to pick | skeleton for transcript on first load (static, so brief) | scenario JSON fails to load: Alert with retry and plain-text fallback link | result inspector shows `truncated: true` badge plus the "N more not shown" line; partial sections show status per section |
| Install snippet | n/a | n/a | clipboard API blocked: select-all fallback and "Copy failed, select and copy manually" | n/a |
| Security matrix | status "not yet verified" shown as neutral badge, never as pass | n/a | n/a | n/a |
| Dashboard (later) | "No events. Audit sync is off" + enable instructions | skeletons | Alert with safe message (no upstream detail) | "showing last N events" notice |
| 404 / 500 | friendly page, links to Install and Tools | n/a | n/a | n/a |
| Offline / no-JS | docs pages are server-rendered and readable without JS; demo shows static transcript list; copy buttons hidden without JS | | | |

Accessibility (WCAG 2.2 AA targets)
- Contrast: 4.5:1 text, 3:1 large text and UI components, in both themes; verify tokens with a checker in the build task, not by eye.
- Keyboard: every control reachable and operable; visible focus ring (2px, 3:1) never removed; focus not obscured by sticky header (WCAG 2.4.11), use `scroll-margin-top` on anchors; skip link; logical order; no keyboard traps in Sheet/Command (Radix handles focus trap and return).
- Target size >= 24x24 CSS px (2.5.8), 44px for primary mobile controls.
- Tabs/Accordion follow WAI-ARIA patterns (Radix); filters announce result count via `aria-live="polite"`.
- Copy buttons: accessible name includes what is copied; success announced via live region.
- Diagrams: inline SVG with `<title>`/`<desc>` and an adjacent text list; no information only in images.
- Tables: real `<table>` with headers and captions; horizontal scroll container is keyboard-focusable on mobile.
- Reduced motion: no autoplay; demo is step-driven by default, "Play" off until the user presses it, and ignores animation when `prefers-reduced-motion`.
- Color independence: status = icon + label. Forced-colors mode checked.
- Language and structure: `lang="en"`, one h1 per page, heading order, landmarks (header, nav, main, footer), descriptive link text, page titles unique.
- Responsive: mobile-first, 16px gutters, no horizontal page scroll at 320px, code blocks scroll inside their container, text reflows at 400% zoom.
- Theme: respects system, no flash, persisted choice in localStorage wrapped in try/catch.
- Performance as accessibility: static generation for every page, no layout shift (fixed font loading via next/font), images in AVIF/WebP with dimensions, Lighthouse a11y >= 95 as a gate.
- Privacy: no cookies, no third-party requests (fonts self-hosted), stated in the footer.

## 7. Recommended build order (tasks for PM to estimate)

Task IDs are proposals; the PM assigns real IDs (suggest `W-nn` or `P7-nn`). Sizing: S = under 40 min slice, M = one 40 min slice with tests, L = split further. All are blocked by G0 unless noted.

Gates
- G0. Human edits PRD (§15, §20, §23.3, §4 hosted-DB wording, §9.3 layout) or confirms ADR-014. Nothing below starts before this.
- G1. Phase 0 exists (the `project/` workspace root from ADR-012). Web tasks need `pnpm-workspace.yaml` and the root.
- G2. Human approves P7 dependency list in doc 11.
- G3. Server work: tool metadata exists (per pack phases P1-P5), QA evidence for S1-S21 exists, sample fixtures exist.

| ID | Task | Size | Blocked by | Depends on server work |
|---|---|---|---|---|
| W-00 | Design review round: PM + human answer section 8 questions; ui-ux freezes brief v1 | S | none (design only) | no |
| W-01 | ui-ux: wireframe-level page specs per page (low-fi layout notes, copy intent, final copy for landing + install) | M | G0 for acceptance, can draft now | no |
| W-02 | Scaffold `apps/web` (Next App Router, TS, Tailwind 4, shadcn init, pnpm workspace member, lint, tsconfig, Vercel root dir note) | M | G0, G1, G2 | no |
| W-03 | Design tokens + theme (light/dark, no-flash, toggle) + Geist fonts + global layout (header, footer, skip link) | M | W-02 | no |
| W-04 | Shared components: CodeBlock (with Shiki at build), StatusBadge, Callout, PackCard, Diagram wrapper, OnThisPage | M | W-03, Shiki approval | no |
| W-05 | Landing page (static content; omit proof row until real numbers exist) | M | W-04 | no |
| W-06 | Install guide with OS/host tabs, URL state, verify step | M | W-04, final install command from P0 | Yes: needs the published/packaged run command and `server_get_status` output shape (P0) |
| W-07 | Tools reference data model (typed file) + page with filters/search + error table | L (split: data, UI) | W-04 | Yes: tool metadata from each pack phase; consider generating from server (Q-P2). Can ship pack-by-pack as P1-P5 land |
| W-08 | Security model page (static prose + diagrams); matrix table fed by QA results file | M | W-04 | Matrix status needs QA verification of S1-S21; page text can ship earlier with status "not verified" |
| W-09 | Example prompts page | S | W-04 | Soft: prompts validated against working tools (P1+); MCP prompt templates need P6 |
| W-10 | Demo: transcript JSON schema + player UI + 3 scenarios | L (split: schema+player, scenario A, B, C) | W-04 | Yes: real captured output from fixtures for PRD §19 (P5/P6); can start with hand-written transcripts clearly labelled |
| W-11 | About / case study page | S | W-04 | no |
| W-12 | a11y + responsive pass (axe, keyboard walk-through, 320px, 400% zoom, forced colors, Lighthouse gate) | M | W-05..W-11 | no |
| W-13 | SEO/OG basics (metadata, sitemap, robots, static OG image), 404, deploy to Vercel Hobby, preview checks | S | W-12 | no |
| W-14 | QA of web: link check, copy-snippet correctness against actual server, no-secret/no-tracker audit, a11y verdict | M | W-13 | Yes: needs final server |
| W-15 | (Later) Dashboard sample-data view | L | G0, a separate human approval for dashboard, W-04 | No for sample data; Yes for real data |
| W-16 | (Later) Dashboard real data from audit sync | L | W-15, human decision on auth (Q-H3) | Yes: server audit-sync feature (ADR-011b) must exist first, plus a defined redacted schema |

Suggested slices: W-00/W-01 now (design only); everything else waits for G0. Earliest meaningful web release = W-02..W-06, W-08 (text only), W-12, W-13 as a "v0 site"; add W-07, W-09, W-10 as the packs land.

## 8. Questions (max 8, each with my recommended default)

For the PM
1. Q-P1. Do web tasks use their own phase P7 with `W-nn` IDs, or `P7-nn`? Default: P7 with `P7-nn` to match the ID scheme in doc 09 section 8; sequence them after P6 but allow W-00/W-01 design work in parallel because it is docs only.
2. Q-P2. Should the tools reference be generated from the server's registered tool metadata (a build script emitting JSON) or hand-maintained? Default: generated from a small exported metadata module in `packages/server`, committed JSON snapshot consumed by the web app, with a drift check test (context-keeper already does drift checks). Hand-maintenance is the fallback if the server does not export metadata cleanly.
3. Q-P3. Who produces the demo transcripts and the S1-S21 status data? Default: `qa` exports a results JSON after each phase; `developer` captures sample tool output from fixtures; the web only reads these committed files, never runs the server.
4. Q-P4. Is `ui-ux` revived as a permanent agent for P7 (ADR-006 says revisit at P7 start)? Default: yes, activate it for P7 design and a11y review only; developers implement.

For the human
5. Q-H1. Edit PRD §15/§20/§23.3 (and §4, §9.3) now, or confirm ADR-014 as written? Default: edit the PRD to say "optional public docs site and read-only dashboard allowed after the MCP MVP (P6), per ADR-012"; web work stays after the server MVP in priority.
6. Q-H2. Site name, domain and repo link: use the default `*.vercel.app` URL and the GitHub repo URL, no custom domain (domains cost money)? Default: yes, free `vercel.app` only; wordmark "DevWorkspace MCP" in Geist, no logo asset beyond a simple lucide icon.
7. Q-H3. Dashboard scope: sample-data view only (public, no auth, portfolio-safe) or real audit data (needs auth and a hosted DB, Supabase per ADR-011b)? Default: sample-data view only for P7; real data is a separate decision after the audit-sync server feature exists. Public pages must never expose real audit data.
8. Q-H4. Accent color and tone: OK with deep blue accent, Geist fonts and neutral dark/light, matching the sibling app's stack? Default: yes; any preference for a different accent can be changed in tokens without changing structure.

Also noted, not a question: the docs site may duplicate content from the repo README; the README is the source of truth for install commands and the web page must copy from it at implementation time, not from this brief.
