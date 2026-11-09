// Fails when the web app references something the project forbids (P7 web security checks W1-W5).
// Scans src/ always, package.json, and out/ (static export) when present. No dependencies.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const problems = [];

function walk(dir, exts) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

const SRC_RULES = [
  [/\bfetch\s*\(/, "fetch( is forbidden (no runtime network calls; W1/W5)"],
  [/\bXMLHttpRequest\b|\bsendBeacon\b|\bWebSocket\b|\bEventSource\b/, "network primitive is forbidden (W1/W5)"],
  [/\bprocess\.env\b/, "process.env in src is forbidden (W2)"],
  [/NEXT_PUBLIC_/, "NEXT_PUBLIC_ variables are forbidden (W2)"],
  [/document\.cookie/, "cookies are forbidden (W3)"],
  [/<script\b/i, "<script> tag in source is forbidden"],
  [/<form\b/i, "forms are forbidden (W3: no data collection)"],
  [/console\.(log|info|debug|warn|error)/, "console output is forbidden"],
  [/from\s+["'](?:@vercel\/analytics|@vercel\/speed-insights|react-ga4?|posthog-js|@sentry\/[\w-]+|mixpanel-browser|@segment\/[\w-]+)/, "analytics/telemetry import is forbidden (W3)"],
  [/localhost|127\.0\.0\.1/, "localhost reference is forbidden (W5: no calls to a local MCP server)"],
  [/api\.anthropic\.com|api\.openai\.com/, "model API reference is forbidden (no model calls)"],
  [/\b(?:src|href|action)\s*=\s*["']https?:\/\/(?!code\.claude\.com\/docs\/|modelcontextprotocol\.io\/|vercel\.com\/(?:docs|pricing|legal)|nextjs\.org\/docs|tailwindcss\.com\/docs|ui\.shadcn\.com\/docs)/, "external src/href is forbidden except the documented doc links"],
  [/\b(?:ghp_|github_pat_|sk-ant-|sk-[A-Za-z0-9]{20})[A-Za-z0-9_]{6,}/, "token-shaped string is forbidden (W4)"],
];

for (const file of walk(join(root, "src"), [".ts", ".tsx", ".css", ".json", ".svg"])) {
  const text = readFileSync(file, "utf8");
  for (const [re, msg] of SRC_RULES) {
    if (re.test(text)) problems.push(`${relative(root, file)}: ${msg}`);
  }
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const bannedDeps = /analytics|speed-insights|sentry|posthog|mixpanel|segment|supabase|openai|anthropic|axios|swr|react-query|tanstack/i;
for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
  if (bannedDeps.test(dep)) problems.push(`package.json: dependency ${dep} is not approved`);
}

// Built output: no third-party script/link/img/iframe origins and no known tracker hosts.
const out = join(root, "out");
if (existsSync(out)) {
  const hostRe = /<(?:script|link|img|iframe|source)\b[^>]*\b(?:src|href)=["']https?:\/\/[^"']+/gi;
  const trackerRe = /localhost:\d+|google-analytics|googletagmanager|plausible\.io|vitals\.vercel-insights|va\.vercel-scripts|segment\.com|hotjar|sentry\.io|fonts\.googleapis|fonts\.gstatic/i;
  for (const file of walk(out, [".html", ".js", ".css", ".txt"])) {
    const text = readFileSync(file, "utf8");
    const rel = relative(root, file);
    for (const m of text.matchAll(hostRe)) {
      if (!/rel=["']?(?:canonical|alternate)/i.test(m[0])) problems.push(`${rel}: third-party resource ${m[0].slice(0, 120)}`);
    }
    if (trackerRe.test(text)) problems.push(`${rel}: tracker or runtime font host reference`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`check-forbidden FAILED:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("check-forbidden: ok\n");
