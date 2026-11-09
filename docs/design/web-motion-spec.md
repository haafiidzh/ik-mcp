# apps/web motion spec (P7-09)

Author: ui-ux. Date: 2026-11-09. Status: AS BUILT (updated 2026-11-09 by P7-24a). The original design was written as task "X-02" (a mislabel; that ID is the npm publish task) and tracked as P7-09; the M-00..M-14 IDs below map to board IDs in the table at the end of section 13. Where the text says "As built", it replaces the original design; everything else is the original spec, unchanged. Section 15 lists every deviation, the dropped items and what is still open. The sources for the as-built facts are ADR-120..ADR-129 and the archived handoffs `.claude/context/handoffs/archive/P7/2026-11-09-P7-10..P7-37-developer.md`.
Scope: motion and "visual, modern, animation-rich" feel for `/`, `/install`, `/tools`, `/security`, `/demo`, 404. The `/docs` page is specified separately in `web-docs-spec.md` (P7-24a); section 12 below is superseded by it.
Inputs: `web-design-brief.md`, the current `apps/web` source (read 2026-11-09), `CLAUDE.md` hard rules, `.claude/docs/11-free-stack.md`, human decisions of 2026-11-09 (purpose stated plainly; inspiration only, no copy of phenomenonstudio.com; `motion` 14.10.1 approved, not yet installed; /docs later).

## 0. Principles (apply everywhere)

1. Motion explains MCP behaviour. Every animation answers one question: what did the host send, what did the guard decide, what came back. No decoration without a stated purpose (each section below states it).
2. Content first. All text exists in the static HTML and is readable with no JS, with `prefers-reduced-motion`, and by a screen reader. Nothing is only reachable through motion (no scroll-jacking, no pinned scenes, no hover-only content).
3. Never SSR-hidden. Server HTML is the final visible state. Animations that start from "hidden" arm themselves only after hydration and only for elements that are currently below the fold (section 3.1). This keeps LCP, no-JS and find-in-page correct.
4. Only `transform`, `opacity`, `clip-path`, and (SVG only) `stroke-dashoffset`. No animation of width/height/top/left/margin/font-size/box-shadow/filter blur on large areas. Layout is reserved up front so CLS stays ~0.
5. One-shot, user-driven. No infinite loops, no autoplay that runs longer than 5 s without a control (WCAG 2.2.2). Replays are buttons.
6. Honest content. No fabricated awards, testimonials, ratings, clients, durations or metrics. Demo content is sample data labelled as such (existing `StatusBadge kind="sample"`). No realistic secrets: `[REDACTED]` is the literal constant from `packages/server/src/core/redact.ts`. The `check-forbidden` scan stays green: new files must contain no `console.*`, `localhost`, `127.0.0.1`, `<form`, `fetch(`, `NEXT_PUBLIC_`, token-shaped strings, external `src/href`. For SSRF samples use `169.254.169.254` or `10.0.0.5`, never loopback literals.
7. Inspiration only: the references are "scroll-linked reveal, kinetic type, cursor-reactive surface" as generic techniques. Layout, copy, assets, branding and any named sections of phenomenonstudio.com are not reproduced. The identity stays ik: the eye mark ("I Know"), deep-blue accent, Geist, terminal and guard imagery.

## 1. Shared motion tokens

Defined once as CSS custom properties. As built: they live in `src/app/globals.css` on `:root` (durations, easings, shifts, stagger, a mobile override and a reduced-motion collapse), NOT in `src/styles/motion.css`; the per-feature stylesheets are `src/app/motion-{chrome,theme,landing,hero,flow,tabs,guard,install,tools,demo,404}.css`. `src/lib/motion/tokens.ts` is still an empty placeholder (task P7-26); components read the tokens from the CSS variables at runtime (`use-armed-reveal.ts`). Values are starting points; the human tunes them at the H-16 browser check (Q-H3, ADR-123).

| Token | Value | Use |
|---|---|---|
| `--dur-instant` | 100 ms | press feedback, focus ring |
| `--dur-fast` | 150 ms | hover, icon swap, badge |
| `--dur-base` | 240 ms | reveal, tab panel, card |
| `--dur-slow` | 400 ms | hero window, section header sweep |
| `--dur-scene` | 600 ms | one-off hero/guard flourishes (max) |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | default enter |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | state changes |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | exits (<= 150 ms) |
| `--ease-inout` | `cubic-bezier(0.65, 0, 0.35, 1)` | sweeps, path draw |
| `--ease-linear` | `linear` | scroll-linked only |
| `--shift-md` / `--shift-sm` | 12 px / 8 px | enter translate distance (mobile uses sm) |
| `--stagger` | 40 ms (30 ms mobile) | per-item delay |

Rules: stagger total capped at 400 ms (max 10 staggered items; item 11+ reveals on its own in-view with no delay). Enter animations use ease-out, exits ease-in and are shorter than the enter. Nothing exceeds `--dur-scene`, except typed text (rate-based, below) and the terminal sequence (total <= 4 s).

Spring presets (only in `motion`, only for interactive feedback, never for page-level enters):

| Preset | Config | Use |
|---|---|---|
| `springSnappy` | `{ type: "spring", stiffness: 420, damping: 34 }` | tab indicator, toggle thumb, copy check |
| `springGentle` | `{ type: "spring", stiffness: 220, damping: 26 }` | card settle, stamp-in of verdict badge |
| `springSoft` | `{ type: "spring", stiffness: 120, damping: 20 }` | spotlight follow (cursor), only `(hover:hover)` |

Typing rate: `typeRate = min(22 ms/char, 1200 ms / charCount)`; so no single typed line exceeds 1.2 s.

## 2. Dependency, library split and bundle

Library: `motion` 14.10.1 (MIT, exact pin, installed by P7-10, ADR-120). As built (ADR-124, ADR-125): the `m` namespace is imported as `import * as m from "motion/react-m"`; `LazyMotion`, `MotionConfig`, `domAnimation`, `domMax`, `useReducedMotion` come from `motion/react`; `useAnimate` comes from `motion/react-mini` (WAAPI based, used only in `src/components/motion/flow-diagram.tsx`; the docs page for that entry should be re-checked in P7-23 or QA-11). `scripts/check-motion.mjs` accepts both entry points. Where this spec says "`m` from `motion/react`" read `motion/react-m`. Original text: developer task M-00 verifies license, maintenance and the exact API against the current official docs (CLAUDE.md official-docs-first), adds the row to doc 11 "Approved" for `apps/web` only (human's chat approval 2026-11-09 recorded; PM/context-keeper update), and records it in `implementation-notes.md`. This spec names API shapes (`LazyMotion`, `domAnimation`/`domMax`, `m`, `MotionConfig`, `useReducedMotion`, `useInView`, `AnimatePresence`, `useAnimate`, `layoutId`) from memory: confirm each before use.

What CSS does (no JS, zero added bundle):
- Hover/focus/press, `:target` highlight, tab panel crossfade, hero entrance (load keyframes), typed-line (clip-path `steps()`), line-by-line reveal, underline sweep, scroll progress bar and header elevation via scroll-driven animations (`animation-timeline: scroll()/view()`, wrapped in `@supports (animation-timeline: scroll())`; unsupported browsers just get the static state), page enter (`template.tsx` + keyframes).

What `motion` does (clear value only):
1. Cross-browser in-view reveal and stagger (Firefox lacks default scroll-driven animations; IntersectionObserver-based `useInView` works everywhere): `Reveal`, `Stagger`.
2. Sliding tab indicator with `layoutId` (works on wrapped tab rows, which the existing `flex-wrap` tab lists produce on mobile).
3. Orchestrated, interruptible, replayable sequences with state: `GuardDemo`, demo `Player`, `FlowDiagram` (`useAnimate`).
4. Mount/unmount transitions: copy-state icon swap, demo step enter/collapse (`AnimatePresence`).

Bundle strategy:
- One client `MotionRoot` in `layout.tsx` wraps children with `<MotionConfig reducedMotion="user">` and `<LazyMotion features={() => import("@/lib/motion/features-dom")} strict>`; components import only `m` (never `motion`), `strict` makes a stray `motion.*` throw in dev.
- `features-dom` re-exports `domAnimation` (animations, variants, exit, tap/hover/focus, in-view). Tabs-only pages (`/security`, `/install`, `/demo`) wrap `AnimatedTabs` in a nested `LazyMotion` that async-loads `domMax` (needed for `layoutId`). Landing never loads `domMax`.
- Server Components stay server: `Reveal`/`Stagger` are small client wrappers taking `children`; page files, `CodeBlock` (async Shiki) and data stay server-rendered and are passed as children/props.
- Budget: `motion` adds <= 20 KB gzip to the shared first-load JS on `/` (target ~5 KB core plus ~15 KB lazy features, loaded after hydration, not render-blocking) and <= 35 KB gzip on tab pages including `domMax`. As built (CONTEXT, P7-25): measured against the post-motion baseline `docs/design/web-motion-budget.json`, `/` +11,997 B, `/security` +10,052 B, `/install` +6,612 B, `/tools` +6,828 B, `/demo` +1,988 B, 404 +503 B. The baseline was written after `motion` was installed, so `check-motion` reports +0 against it; against the pre-motion numbers `/` grew about 11.1 KB core (+31.2 KB across all chunks), about 11 KB over the 20 KB target when the lazy `domAnimation` chunk is counted. The budget decision is open (P7-25, P7-23). Measure with the build output and `out/_next/static/chunks` gzip sizes; if exceeded, drop `layoutId` (fallback in 6.3) before dropping anything else. Verify numbers; they are targets, not facts.
- If the human prefers zero new dependency risk: the CSS-only fallback column in each section keeps the page correct (every `motion` use has one).

## 3. Reusable components and file placement

As built (differences from this original tree): tokens and reduced-motion overrides are in `src/app/globals.css`; keyframes live in the `src/app/motion-*.css` files (all keyframes inside `prefers-reduced-motion: no-preference`); `tokens.ts` is empty; `use-play-once.ts`, `copy-feedback.tsx` and `data/hero-script.ts`'s separate hook were not created (the Terminal and GuardDemo own their play-once logic; copy feedback is CSS); added: `pack-spy.tsx`, `eye-follow.tsx`, `eye-blink.tsx`, `src/components/site/{theme-toggle,github-link}.tsx`, `src/components/shared/tab-panel-card.tsx`, `src/app/motion-theme.css`; `shared/sample-call.tsx` is unused. `scripts/check-motion.mjs` exists and runs in `lint`.

```
src/styles/motion.css                 (not built; see above) tokens, keyframes, scroll-driven rules, reduced-motion overrides
src/lib/motion/tokens.ts              durations, easings, springs, stagger (mirror of CSS vars; still empty)
src/lib/motion/features-dom.ts        export { domAnimation as default }
src/lib/motion/features-max.ts        export { domMax as default }
src/lib/motion/use-armed-reveal.ts    hook: below-fold arming (3.1)
src/lib/motion/use-play-once.ts       hook: in-view start, replay(), reduced-motion => final state
src/components/motion/motion-root.tsx     MotionConfig + LazyMotion (client)
src/components/motion/reveal.tsx          <Reveal as? delay? y? once?>
src/components/motion/stagger.tsx         <Stagger step? max?> + <Stagger.Item>
src/components/motion/terminal.tsx        hero Terminal (client) fed by data/hero-script.ts
src/components/motion/guard-demo.tsx      GuardDemo (client) fed by data/guards.ts
src/components/motion/flow-diagram.tsx    animated version of how-it-works SVG
src/components/motion/animated-tabs.tsx   wrapper over ui/tabs (indicator + panel transition)
src/components/motion/step-rail.tsx       /install vertical rail
src/components/motion/demo-player.tsx     /demo opt-in player (children = server-rendered steps)
src/components/motion/copy-feedback.tsx   icon swap used by shared/copy-button.tsx
src/components/motion/spotlight.tsx       pointer-follow glow, hero only
src/components/motion/scroll-progress.tsx server-safe CSS bar (no JS)
src/app/template.tsx                      page enter (CSS)
src/data/hero-script.ts                   hero beats, derived from data/demo.ts + redaction constant
src/data/guards.ts                        GuardDemo cases with testRef
scripts/check-motion.mjs                  static verification (section 11)
```

`src/components/ui/*` (shadcn) is not edited beyond data attributes; behaviour lives in wrappers. `shared/copy-button.tsx` and `site/logo.tsx` get small, listed edits.

### 3.1 Reveal / Stagger contract
- Server output: children rendered visible, no inline `opacity:0`, no `hidden`. `check-motion` greps `out/**/*.html` to enforce this.
- On mount (client): if the element's top is below `innerHeight` (not yet seen) set state `armed`; animate `opacity 0 -> 1`, `y --shift-md -> 0`, `--dur-base`, `--ease-out`, when `useInView({ once: true, margin: "0px 0px -10% 0px" })` fires. Elements already in the viewport on mount, anchored via `#hash`, or above the fold are never hidden.
- Arming happens before first paint of those off-screen elements; since they are off-screen there is no flash. If hydration is late, they simply stay visible.
- `reducedMotion`: `armed` is never set; element stays in final state.
- Stagger: container arms children; item delay `index * --stagger`, capped per rules in section 1.
- Print / `Ctrl+F`: unrevealed off-screen text is found and scrolling to it triggers reveal. Print stylesheet forces final state (`@media print` sets all to visible).

### 3.2 Reduced-motion model (global)
- Source of truth: `prefers-reduced-motion: reduce` (media query), read by CSS and by `MotionConfig reducedMotion="user"`. Because `user` in motion may still allow opacity changes, our own components additionally branch with `useReducedMotion()` and render the final state immediately (no fades either).
- Existing global rule in `globals.css` (`animation-duration: 0.01ms !important` etc.) stays as the safety net but is not relied on: it still lets 0.01 ms animations fire `animationend`; new CSS wraps animated declarations in `@media (prefers-reduced-motion: no-preference)` so the base state is already final.
- As built (ADR-129, P7-36): client components render the same markup on the server and on the first client render. `useReducedMotion()` is `null` on the server and already `true` on the first client render for reduced-motion users, so branching on it (or on `matchMedia`) during render caused React hydration error #418. Reduced-motion differences therefore live in effects (for example `use-armed-reveal.ts` never arms), in CSS `@media (prefers-reduced-motion: reduce)` (for example `.fd-ctl` hidden in `motion-flow.css`), or behind an after-mount gate (`useSyncExternalStore(..., () => false)` server snapshot, for example `demo-player.tsx`). The "our own components additionally branch with `useReducedMotion()`" sentence above is superseded by this rule.
- Under reduce: Terminal shows all lines at once; GuardDemo shows the verdict state statically for every case; FlowDiagram fully drawn; Player offers Step/Back buttons only (instant); spotlight absent; scroll progress hidden; page enter none; tab indicator jumps; hover transforms removed (colour change only).
- Reduced motion does not remove information: Step, Replay and "show all" controls remain.

## 4. Per-page specification

Legend: Trigger = load | in-view | hover/focus | tab change | click. Dur/ease use tokens. "Fallback" = no `motion` (CSS only) or reduced motion.

### 4.0 Global shell (all pages)

As built: page enter, header elevation, scroll progress and nav underline are CSS in `motion-chrome.css` (P7-12). The logo blink runs once per full page load on any route (the header persists across client navigation) and page enter also plays on the first full load (ADR-126). Human decisions after the spec (ADR-127): (1) smooth anchor scrolling under `prefers-reduced-motion: no-preference` only (`globals.css` `scroll-behavior: smooth`; `data-scroll-behavior="smooth"` on `<html>` in `layout.tsx`); (2) the theme toggle is a 3-option segmented radiogroup (system, light, dark) and every toggle-initiated change that alters the RESOLVED theme, "system" included, animates with a View Transitions circle reveal from the clicked option (Chromium; elsewhere a 240 ms veil fade; none on first load, OS changes or reduced motion), replacing the row below; this is not a page-exit transition (Q-H5 still holds for routes); (3) the header logo eye follows a fine pointer (rAF-lerped, looks forward near the logo, on focus, when the pointer leaves or the tab is hidden) and blinks at random every 3-6 s (about 20% double), stops after 60 s without activity and resumes on activity (WCAG 2.2.2), both off under reduced motion and on touch (`eye-follow.tsx`, `eye-blink.tsx`); (4) GitHub link buttons in the header (hidden on `/` while the hero button is visible) and in the hero (ADR-128, `site/github-link.tsx`). The values in the table below are the original design.

| Element | What animates | Trigger | Values | Purpose | Fallback |
|---|---|---|---|---|---|
| Page enter (`app/template.tsx`) | `<div class="page-enter">` fades and rises | route change | opacity 0->1, y 8 px->0, `--dur-base`, ease-out. No exit animation | Orientation that a new page loaded. Exit animations are dropped: in App Router the old tree unmounts before an `AnimatePresence` can hold it, and holding it would delay link response and risk focus issues | Static |
| Header elevation | bottom border + shadow fade in after ~8 px scroll | scroll (CSS `animation-timeline: scroll(root)`, range 0-64 px) | opacity of a pseudo-element, linear | Separates sticky header from content | None (always plain border) |
| Reading progress | 2 px bar, `scaleX 0->1` on `/install`, `/tools`, `/security` | scroll (CSS) | `transform-origin:left`, linear, colour `--primary`, `aria-hidden` | Long-page position | Hidden if unsupported or reduced motion |
| Nav links | underline `scaleX` from left; active link keeps solid pill (existing) | hover/focus | `--dur-fast`, ease-out | Affordance | Colour change |
| Logo eye | on first visit load of `/`: one blink (eye `scaleY 1->0.15->1`), `--dur-base`; on hover/focus the pupil shifts 2 units right-down, `--dur-fast` | load once per session (CSS animation, no storage) / hover | Requires `logo.tsx` to give pupil + eye classes. "ik = I know": brand motion, not decoration | Static eye |
| Theme toggle | (original design, superseded by ADR-127 above) keep existing instant background change; icons rotate 90 deg on active, `--dur-fast` | click | Original: theme switching never animated. As built: View Transitions circle reveal, see the note above | Static |
| Focus | ring appears with `--dur-instant` opacity only (never scale) | keyboard focus | Existing 2 px ring unchanged | A11y | Same |
| Footer | none | | | Quiet end of page | |

Cursor effects: only hero spotlight (4.1) and card tilt-free hover (lift 2 px). No custom cursor, no cursor-following elements elsewhere, no magnetic buttons (decision: dropped; hurts precision, fails on touch, adds nothing for an MCP user).

### 4.1 `/` Landing

Purpose of the page: say plainly "ik gives Claude controlled, read-only-by-default access to your files, databases, GitHub and internal APIs, locally" and show it working. The existing copy already does this; motion supports it and does not change the words. (Copy tweaks, if any, are a PM/human call: Q-H1.)

As built (P7-14, P7-15, P7-16): S2-S4 use `Stagger`/`StaggerItem`, S6 uses `Reveal`; pack cards get a border-colour hover in `motion-landing.css` (no shadow animation). Dropped: S2/S4 icon spring (`springGentle` scale), S6 primary-button hover ring, and the S4 mini guard preview (the "Watch the guards refuse" link to `/security#watch` was added with P7-18). The hero Terminal, spotlight and h1 highlight are CSS driven (no `motion` runtime in `terminal.tsx`): 3 beats, all in the server HTML in one grid cell, beat 1 is the no-JS state, plays once at >= 60% visible or on chip/Replay, about 3 s; beat prompts are short authored sample text (not copied from `demo.ts`); no `use-play-once.ts` hook. `FlowDiagram` (S5) is as designed plus Pause/Resume (P7-16) and a Pause/Resume fix (P7-27: `play()` on a finished WAAPI animation restarted it); the current list item is highlighted by colour only (no weight change, to avoid reflow); controls sit below the grid; `.fd-ctl` is hidden under reduced motion by CSS.

**S1 Hero** (`<section>` first)
| Element | Animation | Trigger | Values | Purpose |
|---|---|---|---|---|
| Eyebrow, lead paragraph, CTA row, pre-release note | fade + rise | load | delays 0 / 80 / 160 / 240 ms, `--dur-base`, ease-out, y 12 px. CSS keyframes, base state visible, animation under `no-preference` | Direct the eye from claim to action. The `h1` is NOT animated from hidden: it is the LCP element and must paint immediately |
| `h1` key phrase "controlled access" | highlight sweep: pseudo-element `scaleX 0->1` behind the phrase, text unchanged and always readable | load, delay 300 ms | `--dur-slow`, ease-inout, 14% alpha `--primary` in light, 22% in dark; contrast of text on highlight verified by `check-contrast` | Emphasise the product's point (controlled) |
| Terminal window (`Terminal`) | window fade + scale 0.98->1; then sequence below | load, delay 200 ms; starts typing only when >= 60% visible (`usePlayOnce`) | window `--dur-slow` ease-out | The product proof: a real call shape |
| Spotlight | 480 px radial glow (`--primary` at 10% light / 18% dark) translates toward the pointer behind the terminal | pointer move, `(hover:hover) and (pointer:fine)` only | `springSoft`; transform only; pointer events none; `aria-hidden`; disabled on touch and reduced motion | Depth; light tie to the "eye" idea. Optional, first thing to cut if perf budget slips |
| Scroll-away | terminal translates -24 px and fades to 0.6 as hero leaves viewport | scroll (CSS `view()`), supports-gated | linear | Depth; non-essential |

**Terminal simulation (kept, adapted).**
Keep: it is the single best explainer of what an MCP server does (prompt -> tool call -> structured result).
Adapt: (a) not an endless loop: one beat plays once, then chips let the user replay or pick another beat (`aria-pressed` buttons, no tablist needed); (b) the text of every beat is in the DOM from server render inside `<pre>`; animation reveals by `clip-path`/opacity per line, so layout height is final from first paint; (c) no durations or latency numbers on screen (would be fabricated metrics); (d) data is derived, not hand-copied: `src/data/hero-script.ts` builds beats from `SCENARIOS` in `data/demo.ts` (prompt = first `user` step text of scenario `overview`... choose via id lookup, not array index; tool/args/result = the matching `tool` step) plus one beat for redaction.

Beats (labels in chips):
1. "Read-only search": user text -> `fs_search_content` args -> `{success:true,...}` (same data as `SampleCall`, which this replaces on the landing; `SampleCall` stays as the no-JS/reduced-motion final state: Terminal renders its own full `<pre>` so `SampleCall` is not duplicated).
2. "Secrets redacted": `api_call_endpoint` with a profile name, result containing e.g. `"apiKey": "[REDACTED]"` and `"name": "acme-billing"`. New sample data in `hero-script.ts`, marked fictional; redaction follows the real behaviour (sensitive keys replaced by `[REDACTED]`, see `core/redact.ts`). Developer confirms the exact sensitive-key list against `redact.ts` and that the shape matches the `api_call_endpoint` result envelope in the tools reference.
3. "Blocked file": `fs_read_file` `.env` -> `PERMISSION_DENIED` (already in `demo.ts`). Shown with the danger-coloured `rejected` badge (icon + text).

Timeline for one beat (t = 0 when 60% visible), all CSS driven by `--d` custom properties set from `typeRate`:
- 0 ms: prompt line begins typing (`> ` caret glyph static, not blinking; no blinking caret loop). Typed with `clip-path: inset(0 100% 0 0) -> inset(0)` using `steps(N, end)` in a monospace line; duration `N * typeRate` (<= 1.2 s).
- prompt end + 200 ms: label "Tool call" and tool name fade in (`--dur-fast`); args line reveal by clip, 300 ms.
- + 300 ms: result container border flashes from `--primary` to `--border` (`--dur-slow`) as "response arrives".
- + 100 ms: result lines reveal top to bottom, 50 ms/line, max 12 lines (rest together), opacity+clip, no y movement.
- + 150 ms: status badge ("Read-only, succeeded" / "Refused by the guard") scales 0.9->1 with `springGentle`; on beat 2 the `[REDACTED]` token gets a hatched background pulse once (opacity 0.5->1, 400 ms); on beat 3 the badge uses `--danger`, plus a 1-time 4 px horizontal nudge? No nudge (vestibular risk); only a colour fade.
- Total <= 4 s; interruptible: clicking a chip or Replay cancels and restarts; scrolling away does not restart.
- Reduced motion / no JS / `motion` not loaded: all lines visible instantly, chips still switch beats instantly.
- A11y: terminal is `<figure aria-labelledby>` with caption "Sample data, not a live call" (existing wording). The full text is the accessible content; typing is visual only. A visually hidden `role="status"` announces once when a new beat is selected ("Showing example: Blocked file"), never per character. Caret/typed overlay is `aria-hidden`; the real text node is the source (screen readers read the complete text immediately). Replay/chip buttons >= 44 px on mobile, visible focus.
- Mobile: font 12-13 px, `overflow-x:auto` per line block (existing code blocks scroll), stagger 30 ms, spotlight off. Terminal sits below the CTAs (existing grid collapses).

**S2 "What it is, and what it is not"** (3 columns)
- Icons draw-in: `scale 0.8->1` + opacity with `springGentle`, columns stagger 40 ms. Trigger in-view (`Stagger`). Purpose: separate the three claims (server / not LLM / not proxy). Hover: none. Fallback: CSS-only `view()` fade-up or static.

**S3 Five packs** (cards)
- `Stagger` reveal of the 5 cards, 40 ms, y 12 px, in-view of the grid (not each card), `--dur-base`.
- Hover/focus-within: lift `translateY(-2px)`, border to `--primary` at 40%, icon `rotate(-6deg)` `--dur-fast` (only under `(hover:hover)`); no shadow animation (use a pre-rendered pseudo-element with opacity change if a shadow is wanted). Cards are not links today; do not add `tabindex`. If the PM later links each card to `/tools#<pack>`, the card becomes a link and gets a visible arrow slide (translateX 2 px).
- Purpose: show five separate, individually switchable packs and their status badge.

**S4 "Security is the point"** (four guarantees)
- Rows reveal with 40 ms stagger. Each check/lock icon gets one-time `springGentle` scale 0.8->1 after its row reveals. Under it, the first of the guard visuals is previewed: a miniature "request -> shield -> denied" inline SVG? Dropped: the real GuardDemo lives on `/security`; the landing gets one link button "Watch the guards refuse" (`/security#watch`). Reason: do not duplicate heavy components on the landing and keep one source of truth.

**S5 How it works** (`FlowDiagram` replaces animating `HowItWorks`'s svg; markup stays the existing svg with ids/classes added)
- Trigger: in-view once (>= 50%). Sequence: Claude box outline draws (`stroke-dashoffset`, `pathLength=1`, 300 ms), request arrow draws left->right with a 6 px dot travelling along it (`offset-path`-free: animate dot `x` via transform), ik box draws, "validate" and "bounded, redacted" labels fade in sequentially (120 ms apart), pack box draws, result arrow draws right->left. Total 2.4 s. Each stage also sets the matching list item in the `<ol>` to "current" (primary marker colour + weight, no size change) so text and diagram stay in sync; at the end all items return to normal.
- Replay button below the diagram (ghost, "Replay"). Hover/focus on a list item re-highlights its diagram part (pure CSS `:has()` or data attributes, `--dur-fast`).
- Purpose: show the trust boundary: host -> stdio -> validate against config -> bounded pack -> redacted structured result.
- Reduced motion/no JS: fully drawn. The `<title>/<desc>` and the ordered list remain the text alternative (already exists).

**S6 Final CTA**: CTA buttons reveal; primary button has a one-time pointer-ring on hover (`::after` opacity). No pulse loop (explicitly dropped: attention-seeking loop, WCAG 2.2.2 risk).

### 4.2 `/install`

As built (P7-19, P7-32, ADR-126): `StepRail` is a client wrapper that only sets `aria-current="step"` on the in-view step (IntersectionObserver); the rail line, dot badge, snippet accent sweep and copy feedback (icon pop, 600 ms success ring through `:has([data-copy-state="copied"])`) are CSS in `motion-install.css`, so there is no `copy-feedback.tsx` and no `AnimatePresence`. The step badge is a dot (the numbers stay in the headings). The ring rule only applies where `motion-install.css` is loaded (`/install`). "Your platform" is `AnimatedTabs` with `verticalFromMd` and each panel is a `TabPanelCard` (P7-32). Dropped: the "Expected output" badge reveal and the `allowWrites` highlight pulse.

Purpose: get a developer from zero to a working config in 3 steps, show what a successful verify looks like, and make copy feedback unmistakable.

| Section | Animation | Trigger | Values | Purpose |
|---|---|---|---|---|
| Header + requirements | `Reveal` of lead | load | standard | Calm entry |
| OS tabs (`AnimatedTabs`) | active-trigger background slides between triggers (`layoutId="os-pill"`); panel crossfade | tab change | indicator `springSnappy`; panel via CSS stack-grid crossfade (6.2) `--dur-base` | Show the selection changed without the page jumping |
| Steps 1-3 (`StepRail`) | vertical rail on the left: step number badge pops (scale 0.8->1, `springGentle`) when its section is 40% visible; the rail line between badges fills (`scaleY` 0->1, `--dur-slow`, linear, scroll-linked via CSS `view()` when supported, else one-shot on reveal); code block of the step reveals (fade + y 12) 100 ms after its badge | in-view | per step, not whole page at once | Make the 3-step order visible; the user always knows which step they are on |
| Snippets | NOT typed or streamed. Reason: users copy/paste them, they are long, and typing delays reading. Only a 2 px left accent bar sweeps down the block once on reveal (`scaleY`, `--dur-slow`) | in-view | | Draws attention without delaying content |
| Copy feedback (`CopyButton`) | icon swap Copy -> Check: `AnimatePresence mode="wait"`, scale 0.6->1 + opacity, `springSnappy`; label swaps "Copy" -> "Copied" (crossfade 100 ms); a 600 ms success-tint ring (`--safe`, opacity 0.35->0) on the code block border via CSS class toggled for 600 ms; on failure the existing red text fades in (no shake) | click | resets after 2.5 s (existing timer) | Unmistakable confirmation. Existing live region (`role="status"`) is kept as the SR channel; visual animation is `aria-hidden` |
| Verify step | the expected output block ("claude mcp list" result) gets the `StatusBadge` "Expected output" reveal 200 ms after the block | in-view | | Shows what success looks like |
| "If this fails" / other details | existing `<details>`/accordion: add height-free open (content fade 150 ms); no height animation | toggle | | Avoid layout shift |
| Config reference | `allowWrites: false` line gets a persistent, non-animated highlight; on reveal, a 1-time soft pulse of the highlight (opacity 0.4->0, 800 ms) | in-view | | Stress read-only default |

Dropped: auto-detecting OS with a switching animation (belongs to the earlier brief, adds nothing visual); confetti or checkmark celebrations (tone).
Fallback: `StepRail` shows badges and a static line; all steps visible.
Mobile: rail collapses to inline numbered badges above each block (no left gutter); copy button stays 44 px.

### 4.3 `/tools`

As built (P7-20): scroll-spy is `pack-spy.tsx` (sets `aria-current="true"`, renders nothing); the chip nav is NOT sticky and the pill is a `::before` opacity layer, not a `layoutId` pill (so no `motion` dependency in the nav). Dropped: sticky chip nav and the `scroll-padding-top: 8rem` change that went with it. Cards: first 6 per pack `Stagger`, the rest `Reveal` individually; `:target` ring is CSS; the two response blocks use `Reveal`. Hash loads never arm reveals (deep links show cards at once).

Purpose: find a tool fast and understand its safety status (read/write, implemented vs not shipped).

| Section | Animation | Trigger | Values | Purpose |
|---|---|---|---|---|
| Pack chip nav (`<nav aria-label="Packs on this page">`) | scroll-spy: the chip of the pack section in view gets `aria-current="true"` and an animated underline/pill (`layoutId="pack-pill"`, `springSnappy`) | scroll (IntersectionObserver in a small hook; section margin `-40% 0 -55% 0`) | chip row is sticky on `lg`, static on mobile | Keep orientation in a 31-tool list |
| Pack section heading | heading underline sweep `scaleX` once | in-view | `--dur-slow`, ease-inout | Section rhythm |
| Tool cards (`<article>`) | staggered reveal per pack section (first 6 cards: 40 ms steps, rest reveal individually, no delay), y 12 px | in-view of each card list | `Stagger`, `--dur-base` | Show list structure without forcing a long wait; 31 cards never queue |
| Card hover | border to `--primary` 40%, 2 px lift; "copy link" anchor affordance fades in on `:hover`/`:focus-within` (the `#tool_name` heading link is always present in the DOM and keyboard focusable; only visual emphasis animates) | hover/focus | `--dur-fast` | Deep-link discoverability |
| `:target` highlight | when URL is `/tools#fs_read_file`, that card gets a ring that fades from `--primary` 60% to transparent over 1.2 s and the page scrolls with `scroll-margin-top` (existing `scroll-mt-20`) | navigation (CSS `:target`) | opacity-only ring (pseudo-element) | Citing tools from prompts and README (flow 2) |
| Write/not-shipped cards | `StatusBadge` "Not shipped" static (no animation); the two GitHub write tools get a hatched left border, static | none | | Danger/limits must not move |
| Response shape + error table | `Reveal`; the success and failure JSON blocks reveal side by side (success first, failure +120 ms) | in-view | | Teach the envelope: success vs coded error |
| Error table rows | row highlight on hover; no stagger (table) | hover | | Scanability |

Filtering/search: not on the page today; if added later, result list changes use `AnimatePresence` with `popLayout`-free simple fade, count in `aria-live` (existing brief 6). Not specified now.
Empty/loading/error: static page, none; truncated: n/a.

### 4.4 `/security`

As built (P7-18, P7-28, P7-31, ADR-127(4)): see the note at the top of section 5. "Guards per pack" is `AnimatedTabs` with `verticalFromMd` and each panel is a designed card (header icon, pack name, role badge, one guard per row). Sections reveal on first scroll.

Purpose: make the guard model understandable in under a minute and show the guards actually say no, with real error codes.

| Section | Animation | Trigger | Purpose |
|---|---|---|---|
| "What the server will never do" | list items reveal with a strike-through-free "no" glyph (`Ban` icon) scaling in, 40 ms stagger | in-view | Scan the negatives quickly |
| "How a call is checked" (layers) | pipeline of the 7 layers as a horizontal chip rail on `lg` (vertical on mobile): chips light up in order left to right (colour `--primary` fill 0->100% via `scaleX` pseudo, 150 ms each, total <= 1.2 s) once on in-view; hovering/focusing a chip shows its one-line description inline (no tooltip needed: text already exists in the list below) | in-view / hover | Shows ordered defence in depth |
| **GuardDemo** (new section `id="watch"`, placed after "layers", before "Guards per pack") | see 5 | click/in-view | The core visual of the page |
| "Guards per pack" tabs | `AnimatedTabs` (6) | tab change | One guard per pack without a wall of text |
| "Untrusted content", "What you still have to do" | `Reveal` only | in-view | Calm: this is the honesty section, no flourishes |
| "Test evidence" | static; the `not-verified` badge never animates; no count-up numbers (there are no real numbers to count) | none | Honest. Count-up counters on test numbers are dropped: they would invite fabricated or premature metrics and imply a pass rate the page deliberately does not claim |

## 5. GuardDemo ("the guard blocks the attack")

As built (P7-18, P7-31, ADR-126 superseded by ADR-127(4)): `GuardDemo` is a list of five static cards (ask, ordered checks, "Nothing ran", answer JSON, why, test reference), always the base layout. There is no stage, no case picker, no Run button and no typed args; the packet is a line filled by `scaleX` with a small bounce. Each card that starts below the fold is armed before first paint (it shows the start frame of its sequence) and plays its sequence of about 1.6 s ONCE when >= 40% visible (>= 45% of the viewport height for tall cards) via IntersectionObserver; every card keeps its own Replay button (shown only after mount, not under reduced motion). GuardDemo is therefore no longer "Replay only" (the earlier no-auto-run choice is withdrawn). Chips are Schema / Target in config / Pack guard; the URL-as-endpoint case is refused at "Target in config". `/security#watch` is a wrapper `div` because `Section` only emits `#<id>-h`. Data is `src/data/guards.ts` with `testRef`s that resolve to `packages/server/test/security`. The original design follows.

Verdict: keep. It is the strongest visual for read-only/least-privilege. Adapt to what the tests prove and to what the page already claims (no pass-rate claim).

Data: `src/data/guards.ts`, typed:
`{ id, pack, title, attackLabel (plain words), tool, args (string), code, message, retryable, why (one sentence), testRef: "<file> :: <describe name>" }`.
The cases come from existing tests; the developer copies codes and messages from the code under test (not from this spec) and records the source in `testRef`:

| id | Pack | What the "attacker" asks | Tool and args (sample) | Expected code | Evidence (read from repo) |
|---|---|---|---|---|---|
| traversal | Filesystem | read outside the workspace | `fs_read_file {workspace:"acme-shop", path:"../outside/notes.txt"}` | `INVALID_INPUT` ("Parent directory segments are not allowed.", `path-guard.ts` line ~50) | `test/security/filesystem-guard.test.ts` "S1 traversal" (test accepts INVALID_INPUT or PERMISSION_DENIED; the guard actually returns INVALID_INPUT for `..`; developer confirms and shows the real one) |
| blocked-file | Filesystem | read a secret file | `fs_read_file {path:".env"}` | `PERMISSION_DENIED` | `filesystem-guard.test.ts` (`.env` blocked, line ~165); also already in `data/demo.ts` |
| sql-write | Database | stacked statement that drops a table | `db_execute_readonly_query {connection:"sample-sqlite", sql:"SELECT 1; DROP TABLE customers"}` | `QUERY_REJECTED` | `test/security/db-tools-qa.test.ts` (stacked-statement list); `DELETE FROM orders` variant already in `data/demo.ts` |
| url-as-argument | Custom API | pass a URL where an endpoint name belongs (SSRF attempt) | `api_call_endpoint {profile:"acme-billing", endpoint:"http://169.254.169.254/x"}` | `INVALID_INPUT`, message must not echo the URL | `test/security/url-guard.test.ts` "S11 ... arbitrary URL" |
| private-address | Custom API | a profile whose host resolves to a private address | `api_call_endpoint {profile:"internal-profile", endpoint:"get-status"}` (profile config says private network not allowed) | `PERMISSION_DENIED` | `url-guard.test.ts` ("hostname resolving to private ... is refused") |

Rules: error codes shown are the real `ErrorCode` strings; the displayed JSON uses the same envelope as `data/demo.ts` (`success:false`, `error.code/message/retryable/retryAfterSeconds`). Label "Sample call, sample data, covered by test: <testRef>". Do not display a green "PASS" or any count: the page states it claims no pass rate (security page, "Test evidence"). Use an `StatusBadge kind="rejected"` ("Refused by the guard") as the verdict; no new status that implies verification.

Layout: card with left column "The ask" (plain label + tool + args in mono), centre a guard "gate" (the eye mark with a shield outline; lucide `ShieldCheck`/`ShieldX`), right column "The answer" (error JSON). On mobile: stacked vertical, gate between.
Controls: case picker as a `ToggleGroup` / segmented buttons (5 cases, `aria-pressed`) plus "Run" (primary) and "Replay". The first case is selected; nothing auto-runs on load for reduced motion; for motion-ok users it runs once when 60% in view.

Sequence for one run (total 2.2 s; interruptible by picking another case):
1. 0 ms: ask card border `--primary`; args typed in (typeRate, <= 800 ms).
2. +100 ms after typing: a packet (6 px dot) travels from ask card to the gate along a path (transform `x`, 350 ms, `--ease-inout`).
3. At the gate: the 3 relevant checks (from the layers list: "schema", "policy", "pack guard") tick in sequence, 120 ms each, as small chips (the one that rejects turns `--danger` with an X icon; chips after it stay dimmed "not reached" with text, so it is clear that the call stops at the first failing layer: fail closed).
4. Rejection: the packet bounces back 12 px (transform, 150 ms ease-in) and stops; it never reaches a "pack executes" box that is shown dimmed (with text "Nothing ran").
5. Answer card: error JSON lines reveal (50 ms/line); verdict badge pops with `springGentle`; the `code` line has a highlight fade (`--danger` 12% alpha -> 0, 600 ms).
6. Reduced motion / no JS / `motion` not loaded: all five cases render their final state as a plain list of cards (ask, checks, answer), picker and Run hidden (server HTML contains the full list; client component hides the list only after mount if motion is allowed? No: simpler rule, the list is the base layout; the "stage" layout is progressive enhancement applied after mount when motion is allowed; reduced-motion users keep the list).
A11y: each case is a `<li>` with `<h3>`; after a run a `role="status"` sentence announces "Refused with QUERY_REJECTED: only read-only statements are allowed. Nothing ran."; packet/gate decorations `aria-hidden`; case picker is keyboard operable (arrow keys optional, Tab + Enter/Space sufficient); the result text is real text, not SVG. Colours: danger plus icon plus word.
Theme: gate/packet colours via `--primary`/`--danger`/`--border` tokens only; packet glow limited to light 0 / dark 0.2 alpha.
Failure state: if state mismatch, show the static list (error boundary around the stage).

## 6. Tabs with animated transitions

As built (P7-17, P7-28, P7-32, P7-37, ADR-127(5)): `AnimatedTabs` (+ `AnimatedTabsList`, `Trigger`, `Panels`, `Content`) wraps the Radix `Tabs` unchanged and nests a `LazyMotion` that loads `domMax` lazily, only here. Panels are force-mounted, so all panel text is in the server HTML (inactive ones are `inert` and `visibility:hidden` through `motion-tabs.css`; Radix does not set `hidden` on force-mounted panels). Props added: `verticalFromMd` (vertical list from `md`, Radix orientation follows through `matchMedia` in an effect, used on `/security` and `/install`) and `variant: "default" | "segmented"` on the list and trigger (segmented, evenly split control with icon tile and a meta line, used on `/demo`). Known issue: `ui/tabs.tsx` `data-horizontal:flex-col` never matches, so each user sets its layout explicitly (P7-23). Original design follows.

`AnimatedTabs` wraps the existing shadcn `Tabs` (Radix). Radix semantics, roving tabindex and keyboard behaviour are untouched.

6.1 Indicator: a `m.span layoutId="<group>-pill"` rendered inside the active `TabsTrigger` (`data-state=active`), `springSnappy`, `aria-hidden`. Works across wrapped rows. Needs `domMax` (lazy, tabs pages only). Fallback: active background colour transition `--dur-fast` (current styling) with no sliding.
6.2 Panel transition (CSS only, no motion): `TabsContent forceMount` for all panels, laid out in one grid cell (`grid-area: 1 / 1`), inactive panels `visibility:hidden; opacity:0; transform: translateY(8px); pointer-events:none`, active `visible; opacity:1; translateY(0)`; transition `opacity, transform var(--dur-base) var(--ease-out)` and `visibility 0s linear var(--dur-base)` on inactive (so exit fades, enter shows immediately). The grid takes the height of the tallest panel, so there is no height jump and no CLS. Hidden panels are out of the accessibility tree and not focusable because of `visibility:hidden` (verify with `inert` as belt-and-braces, set via attribute). Use for: `/security` guard tabs (4 short paragraphs), `/install` OS tabs (short).
6.3 `/demo` scenarios are long lists: do not stack-render all of them. Use enter-only: active panel's steps `Stagger` in (40 ms, first 5), no exit (Radix unmounts). Direction-aware slide is dropped (adds state, little value).
Reduced motion: no translate, no fade; indicator jumps.
Mobile: the existing `flex-wrap` stays; triggers 44 px high.

## 7. `/demo`

As built (P7-21, P7-30, P7-37, ADR-127(5)): scenarios stay tabs (the human withdrew a vertical stacking request), now an `AnimatedTabs` `variant="segmented"` with icons and a meta line; "A."/"B." are stripped from the tab label only. Both scenarios are in the server HTML (`forceMount`, inactive one `hidden`). `DemoPlayer` is opt-in; per-step transitions are CSS (opacity/transform), no `m`; nothing plays until a control is pressed ("Stop" returns to show-all, "Replay" is Play after finish); on first activation all tool cards are opened once so the list height is final; the Play control is gated after mount and hidden under reduced motion (ADR-129). The banner copy says nothing plays by itself.

Purpose: show an MCP session end to end without installing, including a refusal, with the recorded-sample banner always visible.

Base state (server, unchanged): scenario tabs, banner, full ordered list of steps (`Step` in `demo/page.tsx`). Opt-in layer `DemoPlayer` wraps the list for the active scenario; the server-rendered `<li>` nodes (including async `CodeBlock`) are passed as `children`.
- Controls bar (sticky under header on `lg`, static on mobile): Step, Back, Play/Pause, Reset, speed 1x/2x (`ToggleGroup`), position text "Step 3 of 6" (`aria-live=polite`). Buttons >= 44 px on mobile.
- Default: everything visible, controls idle (no autoplay, ever; also brief 3.6/6). Pressing Play or Step collapses to step 1 and then reveals step by step; Reset returns to "show all".
- Per-step enter: user card slides in from left 12 px; assistant card fades in; tool card: header reveals, `details` opens, args reveal, 250 ms later the result (line reveal 40 ms/line); rejected tool card: danger border tint, badge `springGentle`, `note` line fades (the "Refusal step" text). Step interval at 1x: 1.6 s (user), 2.2 s (tool), 1.8 s (assistant); 2x halves.
- Enter uses `AnimatePresence` for mount; steps never animate height in the list above them (new steps append below; the page does not auto-scroll except `scrollIntoView({block:"nearest"})` once per step when the new step is outside the viewport and Play is active; disabled under reduced motion; user scroll cancels auto-follow).
- A11y: ordered list remains `<ol>`; revealed content is appended in DOM order; `role="status"` announces "Step 3 of 6: tool call db_execute_readonly_query, refused with QUERY_REJECTED". Pause on `blur`? No; pause when tab hidden (`visibilitychange`) and when focus moves into a code block. Playing is never required to read anything.
- Reduced motion: Play button hidden; Step/Back/Reset remain; steps appear instantly.
- States: empty (no scenario): n/a, first scenario preselected. Loading: none (static). Error (player failed): static list remains. Truncated: steps with `meta.truncated:true` show the existing badge; no motion on it. Refusal: always labelled.
- Dropped: chat-style typing of the assistant text (hurts reading, and the text is authored sample, so animating it as "thinking" would imply live inference). Dropped: fake "thinking" dots (implies a model running).

## 8. 404

As built (P7-22): CSS only. Lid `scaleY` 0.1 to 1 over `--dur-slow`, pupil `translateX` 0, -3, +3, 0 over about 750 ms after it opens, text and buttons fade in at about 1.4 s; one-shot, final state under reduced motion.

Purpose: friendly dead end with next links; consistent with the eye brand.
- The eye mark (large, 96 px, `EyeMark`) sits above `404`. On load: eye opens from closed (`scaleY 0.1->1`, `--dur-slow`, ease-out), the pupil looks left, right, centre (translateX -3, +3, 0 in SVG units; 3 x 250 ms, `--ease-inout`), one time, total ~1.3 s. Pure CSS keyframes via classes on `EyeMark` parts.
- Text and buttons reveal 100 ms after (CSS delay).
- No exit/loop. Reduced motion: eye open, centred. Screen reader: eye decorative (`aria-hidden`), `h1` first in content.
- Mobile: same, smaller (64 px).

## 9. Accessibility (motion specific, WCAG 2.2 AA)

- 2.2.2 Pause, Stop, Hide: no loop >5 s; the only multi-second sequences (hero, FlowDiagram, GuardDemo, Player) run once or are user-started and have Replay/Pause/Step. Spotlight follows the pointer and is not autoplay.
- 2.3.3 / vestibular: no parallax of text, no large-scale zoom, no horizontal shakes, no motion >12 px on text, no flashing (nothing flashes >3 times/s; typing is not flashing).
- 2.4.7 / 2.4.11 / 2.4.13: focus rings are never animated away, never obscured: sticky chip nav (tools) and player controls get `scroll-margin-top` on targets and are included in `scroll-padding-top` (raise from 5rem to 8rem on pages with the sticky chip bar).
- 1.4.13 / 3.2.x: hover content never required; nothing changes on focus except style; no focus trap.
- 4.1.3 Status messages: Terminal beat change, GuardDemo result, Player step, copy result use `role="status"` (polite). One live region per component, text updated once per event, never per character.
- 2.5.8 Target size >= 24 px (44 px mobile) for all new buttons.
- Content is never gated behind motion: verified statically (`check-motion` rules) and by the "all text present in HTML" test.
- Keyboard: Replay, chip, picker, Play are real `<button>`s; Escape does not need handling. Tab order is DOM order; hidden stage elements use `visibility:hidden` so they are not focusable.
- Forced colors: verdict uses icon + text; borders use `CanvasText`/`Highlight` via `forced-colors` media query for chips and gate; no information in background-only gradients.
- Screen reader: animated SVG keeps `<title>/<desc>`; decorative pieces `aria-hidden`.

## 10. Performance budget

| Metric | Target | Notes |
|---|---|---|
| LCP | <= 2.0 s on a mid mobile (Lighthouse "mobile", Vercel static) , ceiling 2.5 s | LCP element = hero `h1`; never opacity-0 at first paint; no web font swap shift (next/font stays) |
| CLS | 0 (ceiling 0.02) | Terminal/GuardDemo height reserved by final-state DOM; tab panels stack in grid; no animated layout properties; images/SVG have dimensions |
| INP | <= 200 ms | No work in `pointermove` except one rAF-batched transform write; spotlight throttled to rAF |
| Added JS | `motion` <= 20 KB gz on `/`, <= 35 KB on tab pages (section 2) | Async `LazyMotion` features, no `motion.*`, `domMax` only on tab pages |
| Main-thread | no task > 50 ms from animation setup; TBT not worse than baseline +50 ms | Sequences are CSS where possible |
| Animated props | transform, opacity, clip-path (single small elements), SVG stroke-dashoffset | `will-change` only on elements animating at that moment, removed on `animationend` |
| Concurrent animations | <= 3 running simultaneously per viewport; scroll-driven CSS limited to header, progress bar, hero parallax | |
| Static output | `out/` still works with JS disabled; HTML contains all copy | `check-motion` |

If the budget is missed: first drop spotlight, then `layoutId` indicator (CSS fallback), then hero scroll-away, in that order.

## 11. Verification model (agents have no browser, H-16)

Headless checks the developer or QA can run:
1. `pnpm --filter ik-web lint` (includes `check-forbidden`), `typecheck`, `build` (static export). All must pass; `check-forbidden` ensures no analytics, no network primitives, no `console.*`.
2. New `scripts/check-motion.mjs` (add to `lint`): (a) in `src/`, no import of `motion/react` outside `src/components/motion` and `src/lib/motion`; (b) no `motion.` namespace usage (only `m.`); (c) every client file in `components/motion` references `useReducedMotion`, `MotionConfig`, or a `prefers-reduced-motion` CSS guard, or is on an allowlist with reason; (d) in `out/**/*.html`: no `style="opacity:0"`, no `visibility:hidden`/`hidden` attribute on elements outside tab panels/inert stage layers, and the strings of the hero script, all five guard codes and all demo step texts are present in the HTML; (e) CSS: every `@keyframes` is referenced only inside `@media (prefers-reduced-motion: no-preference)` or declared in `motion.css` guarded block; no `animation-iteration-count: infinite` anywhere; (f) forbid animating props: grep `transition(-property)?:\s*(all|width|height|top|left|margin)`.
3. Bundle: script prints gzip size of `out/_next/static/chunks/*` and compares per-route first-load JS to a committed baseline (`docs/design/web-motion-budget.json` created in M-01 before `motion` is added) with the section 10 deltas.
4. `scripts/check-contrast.mjs` extended with: hero highlight over `--background`, spotlight peak under body text, danger tint under error text, both themes.
5. Content parity test: `hero-script.ts` and `guards.ts` are built from `SCENARIOS`/test-referenced codes; `check-motion` asserts each guard `code` is in the `ErrorCode` list shown on `/tools` and each `testRef` file exists in `packages/server/test/security/`.

Only the human (or a later browser-equipped agent) can verify:
- Feel and timing of every sequence (hero, GuardDemo, FlowDiagram, Player), the spring values, and whether the page reads "visual and modern" without being noisy.
- Real LCP/CLS/INP in Chrome (Lighthouse), real device mobile behaviour (iOS Safari, Android Chrome), pointer spotlight smoothness.
- `prefers-reduced-motion` actually toggled at OS level; Windows high-contrast/forced-colors rendering.
- Safari/Firefox without scroll-driven animations (fallback correctness), Safari `clip-path` stepping.
- Screen reader passes (NVDA/VoiceOver) on Terminal, GuardDemo, Player announcements.
- Dark/light visual balance of glow, highlights and danger tints.
- Print preview.

## 12. Room for /docs (superseded by `web-docs-spec.md`)

Status: the `/docs` page is specified in `web-docs-spec.md` (P7-24a): one long page with a sticky "On this page" TOC, nav slot between Install and Tools, near-zero motion. The text below is the original placeholder and is kept for history; where it differs (for example the 2-column left nav / right rail shell and the `layoutId` sidebar indicator), the docs spec wins.

- Nav: add one slot to `NAV` in `lib/site.ts` between Install and Tools ("Docs", `/docs`); header already wraps (`flex-wrap`), at 5 items check the 320 px layout (may need a `Sheet` menu: PM decision). Add `/docs` to `ROUTES` when the page exists. Not added now.
- Layout: `src/app/docs/layout.tsx` will be a 2-column shell (left nav, content, right "On this page" rail) per the brief; it reuses `PageShell`/`Section`, `template.tsx` page enter, `scroll-progress`, `CopyButton` feedback and `Reveal` for the first section only.
- Motion rules for docs when specified: reading surface = near-zero motion: no reveal on body paragraphs, only sidebar active indicator (`layoutId`), heading anchor affordance, copy feedback, code-block `:target` highlight. Reuse `Terminal` and `GuardDemo` as embeddable figures if the docs author wants them.
- The motion components take data as props and have no page assumptions, so `/docs` can embed them.

## 13. Build order (small developer tasks)

Each task <= one 40 min slice. Blocked by: PM approval of this spec and the human answering the questions that gate it (section 14). `motion` tasks wait for M-00. Acceptance always includes `pnpm --filter ik-web lint && typecheck && build` green, plus the listed checks.

| ID | Task | Files | Acceptance | Verify headlessly |
|---|---|---|---|---|
| M-00 | Add `motion` (pin per lockfile), verify license/maintenance/API vs official docs, update doc 11 + implementation-notes; create `MotionRoot`, `features-dom`, wire in `layout.tsx` (no animation yet) | `package.json`, `pnpm-lock.yaml`, `src/components/motion/motion-root.tsx`, `src/lib/motion/{tokens,features-dom,features-max}.ts`, `layout.tsx` | build passes; `LazyMotion strict`; baseline vs new first-load JS recorded | build; bundle script |
| M-01 | Tokens CSS + reduced-motion model + print override + `check-motion.mjs` + budget baseline (can run before M-00) | `src/styles/motion.css`, `globals.css` import, `scripts/check-motion.mjs`, `package.json` lint script, `docs/design/web-motion-budget.json` | tokens present in both themes; script fails on a planted `opacity:0` fixture and passes on real output | lint; build; script self-test |
| M-02 | `template.tsx` page enter, header elevation, scroll progress, nav underline, logo blink | `src/app/template.tsx`, `src/components/motion/scroll-progress.tsx`, `site/{nav-links,logo,site-header}.tsx` | content visible with animations disabled; no layout shift (static check: no animated layout props) | check-motion; build; grep `out/` |
| M-03 | `Reveal`, `Stagger`, `use-armed-reveal` | `src/components/motion/{reveal,stagger}.tsx`, `src/lib/motion/use-armed-reveal.ts` | server HTML visible; arms only below fold; reduced motion returns final state (code review + check) | check-motion (d) |
| M-04 | Landing sections S2-S4, S6 using Reveal/Stagger + card hover | `src/app/page.tsx` | no markup text change; copy identical (diff) | build; HTML diff of text content before/after |
| M-05 | `hero-script.ts` data, `Terminal` (CSS sequence + chips + live region), replace `SampleCall` in hero, keep no-JS final state, h1 highlight, spotlight | `src/data/hero-script.ts`, `src/components/motion/{terminal,spotlight}.tsx`, `use-play-once.ts`, `page.tsx` | all beat text in HTML; h1 not hidden; `[REDACTED]` literal present; no `console`/`localhost`; reduced-motion = all lines visible; height equal in all beats (fixed `min-height` = tallest beat) | check-motion; check-forbidden; build |
| M-06 | `FlowDiagram` (useAnimate) + list sync + Replay | `src/components/motion/flow-diagram.tsx`, `shared/how-it-works.tsx` | SVG title/desc and ol preserved; final state without JS | build; HTML grep for `<title id="flow-title">` |
| M-07 | `AnimatedTabs` (indicator + stack-grid crossfade) used on `/security`, `/install` | `src/components/motion/animated-tabs.tsx`, `security/page.tsx`, `install/page.tsx` | panels stack in one grid cell; inactive `visibility:hidden`; keyboard (Arrow, Home/End) intact; `domMax` only on these routes (bundle script) | check-motion; chunk analysis |
| M-08 | `guards.ts` + `GuardDemo` + `/security#watch` section + landing link | `src/data/guards.ts`, `src/components/motion/guard-demo.tsx`, `security/page.tsx`, `page.tsx` | five cases present in HTML as list; codes match tests (script reads `test/security` file existence and the real strings); no pass/fail claim; no loopback literal | check-motion (e,5); lint |
| M-09 | `/install` StepRail, snippet accent sweep, CopyFeedback | `src/components/motion/{step-rail,copy-feedback}.tsx`, `shared/copy-button.tsx`, `install/page.tsx` | live region unchanged; copy still hidden without JS; failure message intact | build; check-motion |
| M-10 | `/tools` pack scroll-spy pill, card Stagger, `:target` highlight, response blocks reveal | `tools/page.tsx`, `src/components/motion/*`, `motion.css` | 31 cards, none hidden in SSR HTML; deep link `#fs_read_file` target exists; sticky bar `scroll-padding` updated | build; HTML id grep |
| M-11 | `/demo` `DemoPlayer` (opt-in), per-step transitions, live status | `src/components/motion/demo-player.tsx`, `demo/page.tsx` | default shows all steps; no autoplay; reduced-motion = Step/Back/Reset only; refusal step labelled | check-motion; HTML contains all step texts |
| M-12 | 404 eye animation | `not-found.tsx`, `logo.tsx`, `motion.css` | static final state under reduced motion | build |
| M-13 | Polish pass: bundle budget, contrast extension, mobile spacing, forced-colors | `scripts/check-contrast.mjs`, CSS | budgets met or the fallback order in section 10 applied | all scripts |
| M-14 | QA: security/no-tracker audit of new code, a11y review of live regions, then human visual review | n/a | QA verdict; human sign-off checklist (section 11 human list) | n/a |

Suggested slices to start: M-01 (no dependency), M-00, M-02/M-03 in parallel (different files).

Task ID mapping and status (as of 2026-11-09; the board `TASKS.md` is authoritative):

| Spec ID | Board ID | Status |
|---|---|---|
| M-00 | P7-10 | DONE (`motion` 14.10.1 installed, `MotionRoot`) |
| M-01 | P7-11 | DONE (tokens in `globals.css`, `check-motion.mjs`, budget baseline) |
| M-02 | P7-12 | DONE |
| M-03 | P7-13 | DONE |
| M-04 | P7-14 | DONE (icon spring and S6 ring dropped) |
| M-05 | P7-15 | DONE |
| M-06 | P7-16 | DONE (plus P7-27 Pause/Resume fix) |
| M-07 | P7-17 | DONE (plus P7-28, P7-32, P7-37 extensions) |
| M-08 | P7-18 | DONE (static cards; autoplay once added by P7-31) |
| M-09 | P7-19 | DONE (CSS-only copy feedback) |
| M-10 | P7-20 | DONE (chip nav not sticky) |
| M-11 | P7-21 | DONE (plus P7-30 layout fix) |
| M-12 | P7-22 | DONE |
| M-13 | P7-23 | TODO (budget, contrast extension, mobile spacing, forced-colors, `tokens.ts` follow-ups P7-26, `ui/tabs.tsx` orientation) |
| M-14 | QA-11 | TODO |
| none | P7-24 | `/docs`: spec in `web-docs-spec.md`, tasks D-00..D-09 proposed |
| none | P7-25 | budget baseline decision, open |
| none | P7-27..P7-37 | post-spec changes, DONE: FlowDiagram Pause fix, Guards-per-pack cards, theme toggle, `/demo` layout fix, `/security` first-scroll autoplay, `/install` platform cards, eye follow, GitHub buttons, eye blink, hydration #418 fix, `/demo` segmented tabs |

## 14. Open questions

Status 2026-11-09: Q-H1..Q-H7 were answered with the defaults on the same day (ADR-123: keep the hero copy; motion amount as specced; the human tunes timings at H-16; one fictional redaction example; no page exit transitions; GuardDemo may ship without a per-case matrix; the mobile-menu question moved to `web-docs-spec.md`, which recommends no `Sheet`). Q-P1 is answered by the mapping table in section 13; Q-P2 is done (doc 11, ADR-120, ADR-124). Q-P3 (drift owner for `guards.ts`) and Q-P5 (ui-ux review of live regions, also QA-11) are still open for the PM; Q-P4 is covered by P7-25. The original questions follow.

For the human
1. Q-H1. Product purpose line: keep the current hero copy ("Give Claude controlled access to your dev workspace ... local-first MCP server ...") or do you want a shorter plain-purpose line above it (for example one sentence naming Claude Desktop/Code)? Default: keep, since it already states purpose plainly.
2. Q-H2. Is the amount of motion right? Default here is "rich on hero, security, install; calm on tools and docs". Say if you want more (for example a full-bleed hero background effect) or less. Anything beyond this adds paint cost and must stay one-shot or user-driven.
3. Q-H3. You will judge timings and springs (section 1) in a browser. Default values are starting points; please nominate who tunes after M-05/M-08.
4. Q-H4. May the hero include one new fictional redaction example (`api_call_endpoint` with an `apiKey: "[REDACTED]"` field)? It is sample data following the real redaction behaviour, not captured output; default yes with the "Sample data" badge.
5. Q-H5. Page exit transitions are dropped (section 4.0). Accept, or do you want View Transitions API (Chromium-only, progressive) later?
6. Q-H6. The GuardDemo shows five real test scenarios without a pass count. OK to ship before QA publishes a per-case matrix? Default yes (the page already says it claims no rate).
7. Q-H7. `/docs` nav: with five items does the header need a mobile menu (`Sheet`, shadcn)? Default: decide when `/docs` is specced.

For the PM
1. Q-P1. Task IDs: M-00..M-14 are proposals; map to `P7-nn` and size/split (M-05, M-08, M-11 are each near a full slice).
2. Q-P2. Doc 11: add `motion` to the "Approved" web row (human approved in chat 2026-11-09, 14.10.1) and log it in `implementation-notes.md`; the `check-forbidden` banned-deps regex does not match `motion`, no change needed.
3. Q-P3. Who owns `hero-script.ts`/`guards.ts` drift against server error codes and messages (context-keeper drift check vs developer)? Default: `check-motion` asserts codes and test file existence; messages copied at implementation time.
4. Q-P4. Should `docs/design/web-motion-budget.json` baseline be taken from the deployed Vercel build or local `out/`? Default: local `out/` gzip sizes.
5. Q-P5. `ui-ux` review of M-05, M-08, M-11 in code (a11y of live regions) before merge? Default yes, review only.

## 15. As-built summary (P7-12..P7-37, 2026-11-09)

Source: archived handoffs `P7-12..P7-37` under `.claude/context/handoffs/archive/P7/`, ADR-124..ADR-129. Nothing here was verified in a real browser (H-16 still open); timings and feel are the human's call.

Deviations from this spec as built
1. Library and imports: `m` from `motion/react-m`, `useAnimate` from `motion/react-mini`; `LazyMotion strict` + async `domAnimation` in `MotionRoot`; `domMax` only inside `AnimatedTabs` (ADR-124, ADR-125).
2. Tokens in `src/app/globals.css`, per-feature CSS in `src/app/motion-*.css`, `tokens.ts` still empty (P7-26).
3. Reduced-motion model: no render-time branches on `useReducedMotion()`/`matchMedia` (ADR-129); the effect, CSS-media or after-mount-gate patterns replace them.
4. Most motion is CSS (hero Terminal, spotlight, h1 highlight, GuardDemo, StepRail, copy feedback, `/demo` player transitions, 404, chrome); `m` is used only in `reveal.tsx`, `stagger.tsx`, `animated-tabs.tsx`.
5. P7-12: blink once per full load on any route; page enter also on first load.
6. P7-15: Terminal uses short authored prompts, 3 beats, `role="region"` figure.
7. P7-16/P7-27: FlowDiagram highlights the current step by colour only; Pause/Resume added; controls under the whole grid.
8. P7-17: `AnimatedTabs` force-mounts panels (inactive text is in the SSR HTML).
9. P7-18/P7-31: GuardDemo is five cards, per-card Replay, autoplay once at >= 40% visible (ADR-127(4)); packet is a `scaleX` line.
10. P7-19: CSS-only copy feedback and snippet sweep; ring only where `motion-install.css` loads.
11. P7-20: `/tools` chip nav not sticky, pill is a `::before` layer.
12. P7-21/P7-30/P7-37: `/demo` tabs kept, segmented `AnimatedTabs`; player is CSS-driven.
13. P7-28/P7-32: designed panel cards for "Guards per pack" and "Your platform" (`TabPanelCard`), `verticalFromMd`.
14. P7-29: segmented theme toggle with View Transitions (system included).
15. P7-33/P7-35: logo eye follow and random blink with 60 s idle stop.
16. P7-34: GitHub buttons and `REPO_URL`.
17. P7-36: hydration #418 fix (ADR-129).

Dropped (will not be built unless the human asks)
- Icon springs S2/S4 on the landing; S6 primary-button hover ring; the "Expected output" badge reveal on `/install`; the `allowWrites` highlight pulse on `/install`; sticky chip nav on `/tools` (and the `scroll-padding-top: 8rem` change); `copy-feedback.tsx` with `AnimatePresence`; the GuardDemo stage, picker and Run button; the "Replay only" rule for GuardDemo (replaced by autoplay once plus Replay).
- From the original list and still dropped: page exit transitions, magnetic cursor, count-up numbers, looping pulses, typed snippets, assistant text typing.

Open
- P7-23 (M-13): budget decision and polish (measure the lazy `domMax` chunk, contrast extension, mobile spacing, forced-colors), `ui/tabs.tsx` orientation selector, `tokens.ts` (P7-26).
- P7-25: whether the budget baseline is rebuilt from the pre-motion numbers.
- QA-11 (M-14): security and no-tracker audit, live-region review; confirm ADR-125 (`react-mini` entry on the docs page) and ADR-129.
- H-16: the human's visual, mobile, keyboard and theme-toggle pass and the tuning of every duration and spring (Q-H3).
- `/docs`: `web-docs-spec.md`, tasks D-00..D-09 (P7-24).
