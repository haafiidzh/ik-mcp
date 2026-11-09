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
  return labToRgb(L, C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180));
}
function labToRgb(L, a, b) {
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ].map((v) => Math.min(1, Math.max(0, v))); // linear sRGB
}
const lumRgb = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const lum = (c) => lumRgb(toRgb(c));
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// Resolved colours (linear sRGB triples) for the derived surfaces below.
const gamma = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const ungamma = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
// `color-mix(in oklab, <c> <alpha>%, transparent)` painted over an opaque backdrop: browsers blend in gamma-encoded sRGB.
const over = (c, alpha, backdrop) => toRgb(c).map((v, i) => ungamma(alpha * gamma(v) + (1 - alpha) * gamma(backdrop[i])));
// Opaque `color-mix(in oklab, <a> <pct>%, <b>)`.
const mixOklab = (a, pct, b) => {
  const lab = ([L, C, H]) => [L, C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180)];
  const [x, y] = [lab(a), lab(b)];
  return labToRgb(...x.map((v, i) => pct * v + (1 - pct) * y[i]));
};
const ratioRgb = (a, b) => { const [x, y] = [lumRgb(a), lumRgb(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const pairs = [
  ["foreground", "background", 4.5], ["card-foreground", "card", 4.5], ["muted-foreground", "background", 4.5],
  ["muted-foreground", "muted", 4.5], ["primary", "background", 4.5], ["primary-foreground", "primary", 4.5],
  ["safe", "background", 4.5], ["warn", "background", 4.5], ["danger", "background", 4.5],
  ["safe", "card", 4.5], ["warn", "card", 4.5], ["danger", "card", 4.5], ["ring", "background", 3], ["border", "background", 1],
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

// Surfaces and states added by the motion tasks (P7-15, P7-29, P7-34, P7-37), both themes. Alphas mirror the CSS:
// motion-hero.css (.hero-hl::before 14%/22%, .hero-spot peak 10%/18%), motion-guard.css (.guard-code::before danger 12%),
// motion-theme.css + theme-toggle.tsx (track bg-muted/60, thumb bg-background), ui/button.tsx outline (dark:bg-input/30,
// hover bg-muted / dark:bg-input/50), motion-tabs.css (.animated-tabs-seg pill, .tab-icon).
for (const [name, t, dark] of [[":root", block(":root"), false], [".dark", block("\\.dark"), true]]) {
  const rgb = (k) => toRgb(t[k]);
  const bg = rgb("background"), card = rgb("card"), muted = rgb("muted");
  const surfaces = [
    ["hero highlight", "foreground", over(t.primary, dark ? 0.22 : 0.14, bg), 4.5],
    ["spotlight peak", "foreground", over(t.primary, dark ? 0.18 : 0.1, bg), 4.5],
    ["spotlight peak", "muted-foreground", over(t.primary, dark ? 0.18 : 0.1, bg), 4.5],
    ["danger tint (guard code)", "foreground", over(t.danger, 0.12, card), 4.5],
    ["danger chip on card", "danger", card, 4.5],
    ["theme toggle track (unchecked icon)", "muted-foreground", over(t.muted, 0.6, bg), 4.5],
    ["theme toggle thumb (checked icon)", "primary", bg, 4.5],
    ["github button", "foreground", dark ? over(t.input, 0.3, bg) : bg, 4.5],
    ["github button hover", "foreground", dark ? over(t.input, 0.5, bg) : muted, 4.5],
    ["demo tab active pill", "foreground", dark ? mixOklab(t.input, 0.45, t.muted) : bg, 4.5],
    ["demo tab inactive", "muted-foreground", muted, 4.5],
    ["demo tab hover", "foreground", muted, 4.5],
    ["demo tab icon inactive", "muted-foreground", over(t.foreground, 0.07, muted), 4.5],
    ["demo tab icon active", "primary-foreground", rgb("primary"), 4.5],
  ];
  for (const [label, fg, surface, min] of surfaces) {
    const r = ratioRgb(rgb(fg), surface);
    const ok = r >= min;
    if (!ok) failed = true;
    process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name} ${label}: ${fg}: ${r.toFixed(2)} (min ${min})\n`);
  }
}
process.exit(failed ? 1 : 0);
