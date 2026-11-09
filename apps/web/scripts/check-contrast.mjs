// Computes WCAG contrast for token pairs in src/app/globals.css (oklch -> sRGB). Exit 1 on failure.
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

function block(sel) {
  const m = css.match(new RegExp(`${sel}\\s*\\{([^}]*)\\}`));
  const out = {};
  for (const [, k, l, c, h] of (m?.[1] ?? "").matchAll(/--([\w-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/g)) {
    out[k] = [Number(l), Number(c), Number(h)];
  }
  return out;
}
function toRgb([L, C, H]) {
  const a = C * Math.cos((H * Math.PI) / 180), b = C * Math.sin((H * Math.PI) / 180);
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ].map((v) => Math.min(1, Math.max(0, v))); // linear sRGB
}
const lum = (c) => { const [r, g, b] = toRgb(c); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const pairs = [
  ["foreground", "background", 4.5], ["card-foreground", "card", 4.5], ["muted-foreground", "background", 4.5],
  ["muted-foreground", "muted", 4.5], ["primary", "background", 4.5], ["primary-foreground", "primary", 4.5],
  ["safe", "background", 4.5], ["warn", "background", 4.5], ["danger", "background", 4.5],
  ["safe", "card", 4.5], ["warn", "card", 4.5], ["ring", "background", 3], ["border", "background", 1],
];
let failed = false;
for (const [name, tokens] of [[":root", block(":root")], [".dark", block("\\.dark")]]) {
  for (const [fg, bg, min] of pairs) {
    if (!tokens[fg] || !tokens[bg]) continue;
    const r = ratio(tokens[fg], tokens[bg]);
    const ok = r >= min;
    if (fg === "border") continue; // decorative hairline, informational only
    if (!ok) failed = true;
    process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name} ${fg} on ${bg}: ${r.toFixed(2)} (min ${min})\n`);
  }
}
process.exit(failed ? 1 : 0);
