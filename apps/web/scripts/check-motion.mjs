// Static verification of the motion rules (web-motion-spec section 11, task M-01).
// Headless, deterministic, no network, no dependencies.
//   node scripts/check-motion.mjs                    run all checks (out/ checks are skipped when out/ is absent)
//   node scripts/check-motion.mjs --self-test        run the rules against planted fixtures (must fail them)
//   node scripts/check-motion.mjs --write-baseline   (re)write docs/design/web-motion-budget.json from out/
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = join(root, "..", "..");
const BUDGET_FILE = join(repoRoot, "docs", "design", "web-motion-budget.json");
const MOTION_DIRS = ["src/components/motion", "src/lib/motion"].map((d) => d.split("/").join(sep));
// Client files in components/motion that need no reduced-motion handling (path relative to apps/web -> reason).
const REDUCED_MOTION_ALLOWLIST = new Map([
  [
    join("src", "components", "motion", "stagger.tsx").split(sep).join("/"),
    "reduced motion is handled by useArmedReveal (never arms) and MotionConfig; branching on useReducedMotion() here broke hydration (P7-36)",
  ],
]);
const REQUIRED_TOKENS = [
  "--dur-instant", "--dur-fast", "--dur-base", "--dur-slow", "--dur-scene",
  "--ease-out", "--ease-standard", "--ease-in", "--ease-inout", "--ease-linear",
  "--shift-md", "--shift-sm", "--stagger",
];
const BANNED_TRANSITION_PROPS = new Set(["all", "width", "height", "top", "left", "margin", "font-size"]);
const TAB_ROUTES = new Set(["install", "security", "demo"]);

function walk(dir, exts) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

// ---- pure rule functions (each returns an array of message strings) ----

export function checkSourceText(text, file, { inMotionDir }) {
  const problems = [];
  const importsMotion = /from\s+["'](?:motion\/react(?:-m)?|motion|framer-motion)["']/.test(text);
  if (/from\s+["']framer-motion["']/.test(text)) problems.push(`${file}: framer-motion is not approved; use motion/react`);
  if (importsMotion && !inMotionDir) problems.push(`${file}: motion import is only allowed in src/components/motion and src/lib/motion`);
  if (importsMotion && /\bmotion\.[a-z]+\b/.test(text.replace(/from\s+["'][^"']+["']/g, ""))) {
    problems.push(`${file}: use the m namespace (LazyMotion strict), not motion.*`);
  }
  for (const m of text.matchAll(/transition(?:-property)?\s*:\s*[^;}\n]*/g)) {
    const bad = bannedTransition(m[0]);
    if (bad) problems.push(`${file}: transition on layout/all property "${bad}" is forbidden (animate transform/opacity only)`);
  }
  if (/animation-iteration-count\s*:\s*infinite|\banimate-(?:spin|pulse|bounce|ping)\b/.test(text)) {
    problems.push(`${file}: infinite animation is forbidden (WCAG 2.2.2)`);
  }
  return problems;
}

function bannedTransition(decl) {
  const isProperty = /^transition-property/.test(decl);
  const value = decl.replace(/^transition(?:-property)?\s*:\s*/, "");
  for (const item of value.split(",")) {
    const parts = item.trim().split(/\s+/);
    const names = isProperty ? [parts[0]] : parts;
    for (const n of names) {
      const name = n.toLowerCase();
      if (BANNED_TRANSITION_PROPS.has(name) || /^margin-/.test(name)) return name;
    }
  }
  return null;
}

export function checkClientMotionFile(text, file) {
  if (!/^\s*["']use client["']/.test(text)) return [];
  if (REDUCED_MOTION_ALLOWLIST.has(file)) return [];
  if (/useReducedMotion|MotionConfig|prefers-reduced-motion/.test(text)) return [];
  return [`${file}: client motion file lacks useReducedMotion / MotionConfig / prefers-reduced-motion guard (or an allowlist entry with reason)`];
}

// ADR-129 / P7-38: a client component must render the same markup on the server and on the first client render.
// useReducedMotion() is null on the server and true on the first client render for reduced-motion users, and
// window.matchMedia does not exist on the server, so neither may be read while rendering. Allowed: inside effects,
// event handlers and callbacks (nothing runs during render), in module-level helper functions, or behind an after-mount
// gate (a useSyncExternalStore whose server snapshot is `() => false`).
// Uses the TypeScript parser (already a devDependency) so JSX text, strings and regexes cannot confuse it.
const SAFE_CALLEES = new Set([
  "useCallback", "useSyncExternalStore", "addEventListener", "setTimeout", "requestAnimationFrame", "queueMicrotask",
]);
// useEffect, useLayoutEffect, useInsertionEffect and local wrappers such as useIsoLayoutEffect
const isSafeCallee = (name) => SAFE_CALLEES.has(name) || /^use\w*Effect$/.test(name);

export function checkRenderBranches(text, file) {
  if (!/^\s*["']use client["']/.test(text)) return [];
  if (!/useReducedMotion|matchMedia/.test(text)) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const problems = [];
  const reducedVars = new Set();
  const gateVars = new Set();
  const calleeName = (call) => {
    const e = call.expression;
    return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : "";
  };
  const isFn = (n) => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n);
  const fnName = (f) => {
    if (f.name && ts.isIdentifier(f.name)) return f.name.text;
    const p = f.parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    return "";
  };
  const isRenderFn = (f) => /^(?:[A-Z]|use[A-Z])/.test(fnName(f));
  // Pass 1: collect `const x = useReducedMotion()` and after-mount gates.
  const collect = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isCallExpression(n.initializer)) {
      const name = calleeName(n.initializer);
      if (name === "useReducedMotion") reducedVars.add(n.name.text);
      if (name === "useSyncExternalStore") {
        const server = n.initializer.arguments[2];
        if (server && ts.isArrowFunction(server) && server.body.kind === ts.SyntaxKind.FalseKeyword) gateVars.add(n.name.text);
      }
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const mentionsGate = (n) => {
    let found = false;
    const w = (x) => { if (ts.isIdentifier(x) && gateVars.has(x.text)) found = true; else ts.forEachChild(x, w); };
    w(n);
    return found;
  };
  // Is `node` (which sits in render code) guarded by an after-mount gate?
  const gated = (node) => {
    for (let c = node, p = node.parent; p; c = p, p = p.parent) {
      if (isFn(p) && isRenderFn(p)) return false;
      if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && p.right === c && mentionsGate(p.left)) return true;
      if (ts.isConditionalExpression(p) && p.condition !== c && mentionsGate(p.condition)) return true;
      if (ts.isIfStatement(p) && p.expression !== c && mentionsGate(p.expression)) return true;
    }
    return false;
  };
  // Does `node` run during render (true) or only later / on demand (false)?
  const inRender = (node) => {
    for (let p = node.parent; p; p = p.parent) {
      if (!isFn(p)) continue;
      if (isRenderFn(p)) return true;
      const par = p.parent;
      if (par && ts.isCallExpression(par) && par.arguments.includes(p) && isSafeCallee(calleeName(par))) return false;
      if (par && ts.isJsxExpression(par) && par.parent && ts.isJsxAttribute(par.parent) && /^on[A-Z]/.test(par.parent.name.getText())) return false;
      if (/^(?:on|handle)[A-Z]/.test(fnName(p))) return false;
      // a nested `function choose() {}` declaration is a local helper called from handlers, not part of render
      if (ts.isFunctionDeclaration(p)) return false;
      // module-level helper (lower-case, not a hook): not part of any render until called
      let outer = false;
      for (let q = p.parent; q; q = q.parent) if (isFn(q)) outer = true;
      if (!outer) return false;
      // otherwise a plain nested callback (e.g. .map): keep walking up to decide
    }
    return false;
  };
  const report = (node, what) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    problems.push(`${file}:${line + 1}: ${what} read during render (server and first client render would differ, React #418); move it into an effect/handler, CSS @media, or behind a useSyncExternalStore(..., () => false) gate (ADR-129)`);
  };
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      const declared = ts.isVariableDeclaration(n.parent) && n.parent.initializer === n;
      if (name === "matchMedia" && inRender(n) && !gated(n)) report(n, "window.matchMedia()");
      if (name === "useReducedMotion" && !declared && inRender(n) && !gated(n)) report(n, "useReducedMotion()");
    } else if (ts.isIdentifier(n) && reducedVars.has(n.text)) {
      const p = n.parent;
      const isDecl = ts.isVariableDeclaration(p) && p.name === n;
      const isProp = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n);
      // dependency arrays only list the value; they do not branch on it
      const isDep = ts.isArrayLiteralExpression(p) && p.parent && ts.isCallExpression(p.parent) && isSafeCallee(calleeName(p.parent));
      if (!isDecl && !isProp && !isDep && inRender(n) && !gated(n)) report(n, `useReducedMotion() value "${n.text}"`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return problems;
}

// Minimal CSS scanner: yields declarations with their enclosing block preludes.
export function scanCss(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const decls = [];
  const keyframes = new Set();
  const stack = [];
  let buf = "";
  const flush = () => {
    const d = buf.trim();
    buf = "";
    if (d) decls.push({ decl: d, stack: [...stack] });
  };
  for (const ch of text) {
    if (ch === "{") {
      const prelude = buf.trim();
      buf = "";
      stack.push(prelude);
      const kf = /^@(?:-\w+-)?keyframes\s+([\w-]+)/.exec(prelude);
      if (kf) keyframes.add(kf[1]);
    } else if (ch === "}") {
      flush();
      stack.pop();
    } else if (ch === ";") flush();
    else buf += ch;
  }
  return { decls, keyframes };
}

export function checkCss(css, file) {
  const problems = [];
  const { decls, keyframes } = scanCss(css);
  for (const { decl, stack } of decls) {
    if (stack.some((s) => /^@(?:-\w+-)?keyframes/.test(s))) continue;
    const m = /^(animation(?:-name|-iteration-count)?|transition(?:-property)?)\s*:\s*([\s\S]*)$/i.exec(decl);
    if (!m) continue;
    const prop = m[1].toLowerCase();
    const value = m[2];
    if (prop.startsWith("animation") && /\binfinite\b/.test(value)) problems.push(`${file}: "${decl}" uses an infinite animation`);
    if (prop === "animation" || prop === "animation-name") {
      const used = value.split(/[\s,]+/).filter((t) => keyframes.has(t));
      const guarded = stack.some((s) => /^@media[^{]*prefers-reduced-motion\s*:\s*no-preference/.test(s));
      if (used.length && !guarded) problems.push(`${file}: keyframes ${used.join(", ")} applied outside @media (prefers-reduced-motion: no-preference)`);
    }
    if (prop.startsWith("transition")) {
      const bad = bannedTransition(decl);
      if (bad) problems.push(`${file}: transition on "${bad}" is forbidden`);
    }
  }
  return problems;
}

export function checkTokens(css, file) {
  const { decls } = scanCss(css);
  const defined = new Set();
  for (const { decl, stack } of decls) {
    const m = /^(--[\w-]+)\s*:/.exec(decl);
    if (m && stack.some((s) => s === ":root")) defined.add(m[1]);
  }
  return REQUIRED_TOKENS.filter((t) => !defined.has(t)).map((t) => `${file}: motion token ${t} is not defined on :root`);
}

export function checkReducedAndPrintBlocks(css, file) {
  const problems = [];
  const { decls } = scanCss(css);
  const inBlock = (re) => decls.some((d) => d.stack.some((s) => re.test(s)));
  if (!inBlock(/^@media[^{]*prefers-reduced-motion\s*:\s*reduce/)) problems.push(`${file}: missing @media (prefers-reduced-motion: reduce) block`);
  if (!inBlock(/^@media\s+print/)) problems.push(`${file}: missing @media print override`);
  return problems;
}

export function checkHtml(html, file) {
  const problems = [];
  if (/style="[^"]*opacity\s*:\s*0(?![.\d])/i.test(html)) problems.push(`${file}: inline opacity:0 in server HTML (content must be visible before hydration)`);
  if (/style="[^"]*visibility\s*:\s*hidden/i.test(html)) problems.push(`${file}: inline visibility:hidden in server HTML`);
  for (const m of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const attrs = m[2];
    if (!/(?:^|\s)hidden(?:=""|=hidden|(?=[\s/]|$))/i.test(attrs)) continue;
    if (/role="tabpanel"|data-motion-stage|\bid="S:|\bid="_R_/.test(attrs) || /^(?:template|meta|link|script|noscript)$/i.test(m[1])) continue;
    // Next.js emits an empty `<div hidden><!--$--><!--/$--></div>` Suspense placeholder: no content, allowed.
    if (/^(?:<!--[\s\S]*?-->)*<\/div>/.test(html.slice(m.index + m[0].length))) continue;
    problems.push(`${file}: hidden attribute on <${m[1]}> outside tab panels / stage layers`);
  }
  return problems;
}

// ---- self-test ----

function selfTest() {
  const CLIENT = '"use client";\n';
  const cases = [
    ["html opacity:0", () => checkHtml('<div style="opacity:0">x</div>', "f.html"), true],
    ["html visibility:hidden", () => checkHtml('<div style="color:red;visibility:hidden">x</div>', "f.html"), true],
    ["html hidden attr", () => checkHtml("<div hidden>x</div>", "f.html"), true],
    ["html hidden tabpanel ok", () => checkHtml('<div role="tabpanel" hidden>x</div>', "f.html"), false],
    ["html hidden empty placeholder ok", () => checkHtml("<div hidden><!--$--><!--/$--></div>", "f.html"), false],
    ["html clean", () => checkHtml('<div style="opacity:0.5">x</div>', "f.html"), false],
    ["css unguarded keyframes", () => checkCss("@keyframes a{from{opacity:0}to{opacity:1}} .x{animation:a 1s}", "f.css"), true],
    ["css guarded keyframes", () => checkCss("@keyframes a{from{opacity:0}to{opacity:1}} @media (prefers-reduced-motion: no-preference){.x{animation:a 1s}}", "f.css"), false],
    ["css infinite", () => checkCss("@media (prefers-reduced-motion: no-preference){.x{animation:a 1s infinite}}", "f.css"), true],
    ["css transition width", () => checkCss(".x{transition: width 1s}", "f.css"), true],
    ["css transition-property all", () => checkCss(".x{transition-property: all}", "f.css"), true],
    ["css transition transform ok", () => checkCss(".x{transition: transform 1s, opacity 1s}", "f.css"), false],
    ["src motion import outside", () => checkSourceText('import { m } from "motion/react";', "src/a.tsx", { inMotionDir: false }), true],
    ["src motion import inside", () => checkSourceText('import { m } from "motion/react";', "src/components/motion/a.tsx", { inMotionDir: true }), false],
    ["src motion.div", () => checkSourceText('import { motion } from "motion/react"; const a = <motion.div/>;', "src/components/motion/a.tsx", { inMotionDir: true }), true],
    ["client file no guard", () => checkClientMotionFile('"use client";\nexport const A = 1;', "src/components/motion/a.tsx"), true],
    ["client file guarded", () => checkClientMotionFile('"use client";\nuseReducedMotion();', "src/components/motion/a.tsx"), false],
    ["render: if (reduced) return", () => checkRenderBranches(CLIENT + 'export function A(){ const reduced = useReducedMotion(); if (reduced) return null; return <div/>; }', "a.tsx"), true],
    ["render: reduced ? a : b", () => checkRenderBranches(CLIENT + 'export function A(){ const r = useReducedMotion(); return r ? <p/> : <div/>; }', "a.tsx"), true],
    ["render: reduced prop", () => checkRenderBranches(CLIENT + 'export function A(){ const r = useReducedMotion(); return <m.div transition={r ? { duration: 0 } : spring}/>; }', "a.tsx"), true],
    ["render: inline useReducedMotion()", () => checkRenderBranches(CLIENT + 'export function A(){ return useReducedMotion() ? <p/> : <div/>; }', "a.tsx"), true],
    ["render: matchMedia in component", () => checkRenderBranches(CLIENT + 'export function A(){ const q = window.matchMedia("(min-width: 1px)").matches; return <div>{q}</div>; }', "a.tsx"), true],
    ["render: reduced inside .map callback", () => checkRenderBranches(CLIENT + 'export function A(){ const r = useReducedMotion(); return <ul>{xs.map((x) => (r ? <li/> : <b/>))}</ul>; }', "a.tsx"), true],
    ["render: hook body read", () => checkRenderBranches(CLIENT + 'export function useX(){ const r = useReducedMotion(); return r ? 1 : 2; }', "a.ts"), true],
    ["render ok: inside useEffect", () => checkRenderBranches(CLIENT + 'export function A(){ const r = useReducedMotion(); useEffect(() => { if (r) return; window.matchMedia("(x)"); }, [r]); return <div/>; }', "a.tsx"), false],
    ["render ok: event handler", () => checkRenderBranches(CLIENT + 'export function A(){ const r = useReducedMotion(); const onGo = () => { if (r) return; }; return <button onClick={() => { if (r) return; }} onKeyDown={onGo}/>; }', "a.tsx"), false],
    ["render ok: useCallback", () => checkRenderBranches(CLIENT + 'export function A(){ const r = useReducedMotion(); const go = useCallback(() => { if (r) return; }, [r]); return <b onClick={go}/>; }', "a.tsx"), false],
    ["render ok: after-mount gate &&", () => checkRenderBranches(CLIENT + 'export function A(){ const r = useReducedMotion(); const ready = useSyncExternalStore(s, () => true, () => false); return <div>{ready && (r ? <p/> : <b/>)}</div>; }', "a.tsx"), false],
    ["render ok: after-mount gate ?:", () => checkRenderBranches(CLIENT + 'export function A(){ const r = useReducedMotion(); const ok = useSyncExternalStore(s, () => true, () => false); return ok ? (r ? <p/> : <b/>) : null; }', "a.tsx"), false],
    ["render ok: gate in same expression", () => checkRenderBranches(CLIENT + 'export function A(){ const r = useReducedMotion(); const m = useSyncExternalStore(s, () => true, () => false); const can = m && r === false; return <div>{can}</div>; }', "a.tsx"), false],
    ["render bad: gate with TRUE server snapshot", () => checkRenderBranches(CLIENT + 'export function A(){ const r = useReducedMotion(); const m = useSyncExternalStore(s, () => true, () => true); return m && r ? <p/> : <b/>; }', "a.tsx"), true],
    ["render ok: local effect wrapper", () => checkRenderBranches(CLIENT + 'export function A(){ const r = useReducedMotion(); useIsoLayoutEffect(() => { if (r) return; }, [r]); return <div/>; }', "a.tsx"), false],
    ["render ok: nested function declaration", () => checkRenderBranches(CLIENT + 'export function A(){ function choose(){ return window.matchMedia("(x)").matches; } return <b onClick={choose}/>; }', "a.tsx"), false],
    ["render ok: module helper", () => checkRenderBranches(CLIENT + 'function prefersReduced(){ return window.matchMedia("(x)").matches; } export function A(){ return <div/>; }', "a.tsx"), false],
    ["render ok: server component", () => checkRenderBranches('export function A(){ return window.matchMedia("(x)").matches ? <p/> : null; }', "a.tsx"), false],
    ["tokens missing", () => checkTokens(":root{--dur-fast:1ms}", "f.css"), true],
  ];
  let failed = 0;
  for (const [name, run, expectProblems] of cases) {
    const got = run().length > 0;
    if (got !== expectProblems) {
      failed++;
      process.stderr.write(`self-test FAIL: ${name} (expected ${expectProblems ? "problems" : "clean"})\n`);
    }
  }
  if (failed) process.exit(1);
  process.stdout.write(`check-motion self-test OK (${cases.length} cases)\n`);
}

// ---- bundle ----

function bundleSizes(outDir) {
  const routes = {};
  const gz = new Map();
  const size = (rel) => {
    if (!gz.has(rel)) {
      const f = join(outDir, rel);
      gz.set(rel, existsSync(f) ? gzipSync(readFileSync(f)).length : 0);
    }
    return gz.get(rel);
  };
  const firstLoad = new Set();
  for (const file of walk(outDir, [".html"])) {
    const rel = relative(outDir, file).split(sep).join("/");
    if (rel.startsWith("_next/")) continue;
    const route = rel.replace(/\.html$/, "").replace(/\/index$/, "") || "index";
    const html = readFileSync(file, "utf8");
    const js = new Set();
    const css = new Set();
    for (const m of html.matchAll(/(?:src|href)="\/(_next\/static\/[^"?]+\.(js|css))"/g)) (m[2] === "js" ? js : css).add(m[1]);
    // Scripts marked noModule (Next's legacy polyfill chunk) are never fetched by browsers that run the site's ES modules.
    const legacy = new Set();
    for (const m of html.matchAll(/<script\b([^>]*)>/g)) {
      const src = /\ssrc="\/(_next\/static\/[^"?]+\.js)"/.exec(m[1]);
      if (src && /\snoModule\b/i.test(m[1])) legacy.add(src[1]);
    }
    js.forEach((f) => firstLoad.add(f));
    const total = (set) => [...set].reduce((a, f) => a + size(f), 0);
    routes[route] = {
      jsFiles: js.size,
      jsGzipBytes: total(js),
      jsGzipBytesModern: total(new Set([...js].filter((f) => !legacy.has(f)))),
      cssGzipBytes: total(css),
    };
  }
  const sorted = Object.fromEntries(Object.keys(routes).sort().map((k) => [k, routes[k]]));
  const chunkFiles = walk(join(outDir, "_next", "static", "chunks"), [".js", ".css"]);
  const chunkTotal = chunkFiles.reduce((a, f) => a + gzipSync(readFileSync(f)).length, 0);
  // Chunks no page lists in its HTML: loaded on demand (LazyMotion features, domMax, dynamic imports).
  const lazy = chunkFiles
    .map((f) => ({ f: relative(outDir, f).split(sep).join("/"), b: gzipSync(readFileSync(f)).length }))
    .filter((c) => c.f.endsWith(".js") && !firstLoad.has(c.f));
  return {
    routes: sorted,
    chunksGzipBytesTotal: chunkTotal,
    lazyJsChunks: { files: lazy.length, gzipBytes: lazy.reduce((a, c) => a + c.b, 0), largestGzipBytes: lazy.map((c) => c.b).sort((x, y) => y - x).slice(0, 3) },
  };
}

const roundUp = (n, step) => Math.ceil(n / step) * step;

// Budget model (schema 2, P7-25): every route has an ABSOLUTE cap on first-load JS gzip bytes (capBytes). The cap is the
// measured post-motion size plus 1 KiB of headroom rounded up to 512 B, so any later growth fails the check. The spec
// target (pre-motion size + allowed delta, web-motion-spec section 10) is stored next to it; a route over its spec
// target is printed as OVER and is a decision for the human, not hidden by the cap.
function writeBaseline(outDir) {
  const sizes = bundleSizes(outDir);
  const prev = existsSync(BUDGET_FILE) ? JSON.parse(readFileSync(BUDGET_FILE, "utf8")) : {};
  const specDelta = prev.specTargetDeltaBytes ?? { default: 20 * 1024, tabRoutes: 35 * 1024 };
  const preMotion = prev.preMotionJsGzipBytes ?? {};
  const tabRoutes = prev.tabRoutes ?? [...TAB_ROUTES].sort();
  const routes = {};
  for (const [route, r] of Object.entries(sizes.routes)) {
    const pre = preMotion[route] ?? null;
    routes[route] = {
      ...r,
      preMotionJsGzipBytes: pre,
      specTargetBytes: pre === null ? null : pre + (tabRoutes.includes(route) ? specDelta.tabRoutes : specDelta.default),
      capBytes: roundUp(r.jsGzipBytes + 1024, 512),
    };
  }
  const budget = {
    description: "First-load JS budget for the static export (apps/web/out), gzip bytes, same metric as the pre-motion numbers (every script/preload the HTML lists, including the noModule polyfill chunk; jsGzipBytesModern leaves that one out). Enforced as an absolute cap per route (capBytes). specTargetBytes = pre-motion size + the allowed delta of web-motion-spec section 10. Regenerate with: node apps/web/scripts/check-motion.mjs --write-baseline (after pnpm web:build).",
    schema: 2,
    measuredFrom: "local apps/web/out (Q-P4 default)",
    specTargetDeltaBytes: specDelta,
    tabRoutes,
    preMotionJsGzipBytes: preMotion,
    routes,
    lazyJsChunks: { ...sizes.lazyJsChunks, capGzipBytes: roundUp(sizes.lazyJsChunks.gzipBytes + 2048, 512) },
    chunksGzipBytesTotal: sizes.chunksGzipBytesTotal,
  };
  writeFileSync(BUDGET_FILE, JSON.stringify(budget, null, 2) + "\n");
  process.stdout.write(`wrote ${relative(repoRoot, BUDGET_FILE)}\n`);
}

function checkBundle(outDir, problems) {
  if (!existsSync(BUDGET_FILE)) {
    process.stdout.write("check-motion: no budget baseline file; bundle comparison skipped\n");
    return;
  }
  const base = JSON.parse(readFileSync(BUDGET_FILE, "utf8"));
  if (base.schema !== 2) {
    problems.push(`${relative(repoRoot, BUDGET_FILE)}: schema ${base.schema} is outdated; regenerate with --write-baseline`);
    return;
  }
  const cur = bundleSizes(outDir);
  for (const [route, b] of Object.entries(base.routes ?? {})) {
    const c = cur.routes[route];
    if (!c) continue;
    const spec = b.specTargetBytes;
    const specNote = spec === null ? "no pre-motion figure" : c.jsGzipBytes <= spec ? `within spec target ${spec}` : `OVER spec target ${spec} by ${c.jsGzipBytes - spec} (accepted cap pending human decision)`;
    process.stdout.write(`  ${route}: js gz ${c.jsGzipBytes} B (modern ${c.jsGzipBytesModern}), cap ${b.capBytes}; ${specNote}\n`);
    if (c.jsGzipBytes > b.capBytes) problems.push(`out/${route}: first-load JS is ${c.jsGzipBytes} B gzip, over the absolute cap of ${b.capBytes} B`);
  }
  const lz = cur.lazyJsChunks;
  const lcap = base.lazyJsChunks?.capGzipBytes;
  process.stdout.write(`  lazy chunks (not in any first load): ${lz.files} files, ${lz.gzipBytes} B gz${lcap ? `, cap ${lcap}` : ""}\n`);
  if (lcap && lz.gzipBytes > lcap) problems.push(`out/_next/static/chunks: lazy JS is ${lz.gzipBytes} B gzip, over the cap of ${lcap} B`);
}

// ---- main ----

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) return selfTest();
  const outDir = join(root, "out");
  if (args.includes("--write-baseline")) {
    if (!existsSync(outDir)) {
      process.stderr.write("check-motion: out/ is missing; run pnpm web:build first\n");
      process.exit(1);
    }
    return writeBaseline(outDir);
  }

  const problems = [];
  const rel = (f) => relative(root, f);

  for (const file of walk(join(root, "src"), [".ts", ".tsx"])) {
    const r = rel(file);
    const text = readFileSync(file, "utf8");
    const inMotionDir = MOTION_DIRS.some((d) => r.startsWith(d + sep));
    const isShadcn = r.startsWith(join("src", "components", "ui") + sep);
    // shadcn primitives use Tailwind transition-all (class names, not CSS decls); only motion-import rules apply there.
    problems.push(...checkSourceText(text, r, { inMotionDir }).filter((p) => !(isShadcn && /transition|infinite/.test(p))));
    if (inMotionDir) problems.push(...checkClientMotionFile(text, r));
    if (!isShadcn) problems.push(...checkRenderBranches(text, r));
  }

  const cssFiles = walk(join(root, "src"), [".css"]);
  for (const file of cssFiles) {
    const css = readFileSync(file, "utf8");
    problems.push(...checkCss(css, rel(file)));
  }
  const globals = join(root, "src", "app", "globals.css");
  const allCss = cssFiles.map((f) => readFileSync(f, "utf8")).join("\n");
  problems.push(...checkTokens(allCss, rel(globals)));
  problems.push(...checkReducedAndPrintBlocks(allCss, rel(globals)));

  // Content parity for the guard cases, once the data file exists (M-08).
  const guards = join(root, "src", "data", "guards.ts");
  const securityHtml = join(root, "out", "security.html");
  if (existsSync(guards)) {
    const gtext = readFileSync(guards, "utf8");
    const testDir = join(repoRoot, "packages", "server", "test", "security");
    for (const m of gtext.matchAll(/testRef:\s*["']([^"':\s]+)\s*::/g)) {
      if (!existsSync(join(testDir, m[1]))) problems.push(`src/data/guards.ts: testRef file ${m[1]} not found in packages/server/test/security`);
    }
    if (existsSync(securityHtml)) {
      const html = readFileSync(securityHtml, "utf8");
      for (const m of gtext.matchAll(/\bcode:\s*["']([A-Z_]+)["']/g)) {
        if (!html.includes(m[1])) problems.push(`out/security.html: guard code ${m[1]} is missing from the HTML`);
      }
    }
  }

  if (existsSync(outDir)) {
    for (const file of walk(outDir, [".html"])) problems.push(...checkHtml(readFileSync(file, "utf8"), relative(root, file)));
    if (existsSync(join(root, "src", "data", "hero-script.ts")) && existsSync(join(outDir, "index.html"))) {
      if (!readFileSync(join(outDir, "index.html"), "utf8").includes("[REDACTED]")) problems.push("out/index.html: hero script literal [REDACTED] is missing from the HTML");
    }
    checkBundle(outDir, problems);
  } else {
    process.stdout.write("check-motion: out/ not found; HTML and bundle checks skipped (run pnpm web:build)\n");
  }

  if (problems.length) {
    process.stderr.write(`check-motion: ${problems.length} problem(s)\n`);
    for (const p of problems) process.stderr.write(`  - ${p}\n`);
    process.exit(1);
  }
  process.stdout.write("check-motion: OK\n");
}

main();
