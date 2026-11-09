"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useRef, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { cn } from "@/lib/utils";

const OPTIONS = [
  { value: "system", label: "System theme", Icon: Monitor },
  { value: "light", label: "Light theme", Icon: Sun },
  { value: "dark", label: "Dark theme", Icon: Moon },
] as const;

type ThemeValue = (typeof OPTIONS)[number]["value"];

const subscribe = () => () => {};

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Short opacity cross-fade of the page background, used when the View Transitions API is missing. */
function fallbackFade(): void {
  const veil = document.createElement("div");
  veil.setAttribute("aria-hidden", "true");
  veil.style.cssText = `position:fixed;inset:0;z-index:2147483646;pointer-events:none;background:${getComputedStyle(document.body).backgroundColor}`;
  document.body.appendChild(veil);
  const anim = veil.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: "cubic-bezier(0.2, 0, 0, 1)" });
  const done = () => veil.remove();
  anim.addEventListener("finish", done);
  anim.addEventListener("cancel", done);
}

export function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const current: ThemeValue = mounted ? ((theme as ThemeValue | undefined) ?? "system") : "system";
  const activeIndex = Math.max(0, OPTIONS.findIndex((o) => o.value === current));

  function choose(value: ThemeValue, origin: { x: number; y: number }) {
    if (value === current) return;
    const root = document.documentElement;
    const target = value === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : value;
    // Animate whenever the RESOLVED theme changes (system included); otherwise just move the thumb. Reduced motion: never.
    const animate = target !== resolvedTheme && !prefersReducedMotion();
    if (!animate) {
      setTheme(value);
      return;
    }
    if (typeof document.startViewTransition !== "function") {
      fallbackFade();
      setTheme(value);
      return;
    }
    const { x, y } = origin;
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    root.style.setProperty("--vt-x", `${x}px`);
    root.style.setProperty("--vt-y", `${y}px`);
    root.style.setProperty("--vt-r", `${Math.ceil(radius)}px`);
    root.setAttribute("data-theme-vt", "");
    const transition = document.startViewTransition(() => {
      flushSync(() => setTheme(value));
    });
    const cleanup = () => root.removeAttribute("data-theme-vt");
    void transition.finished.then(cleanup, cleanup);
  }

  function centreOf(el: HTMLElement) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + OPTIONS.length) % OPTIONS.length;
    const el = refs.current[next];
    if (!el) return;
    el.focus();
    choose(OPTIONS[next]?.value ?? "system", centreOf(el));
  }

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className="theme-toggle relative inline-flex items-center rounded-full border border-border/70 bg-muted/60 p-0.5 shadow-inner backdrop-blur"
    >
      {mounted && (
        <span
          aria-hidden="true"
          className="theme-toggle-thumb absolute left-0.5 top-0.5 size-8 rounded-full bg-background shadow-sm ring-1 ring-border"
          style={{ "--i": activeIndex } as React.CSSProperties}
        />
      )}
      {OPTIONS.map(({ value, label, Icon }, i) => {
        const checked = mounted && current === value;
        return (
          <button
            key={value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={label}
            title={label}
            tabIndex={i === activeIndex ? 0 : -1}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              // Pointer clicks start at the cursor; keyboard activation (detail 0) at the control centre.
              const origin = e.detail === 0 ? centreOf(e.currentTarget) : { x: e.clientX || rect.left + rect.width / 2, y: e.clientY || rect.top + rect.height / 2 };
              choose(value, origin);
            }}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "relative z-10 inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors duration-[var(--dur-fast)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              checked && "text-primary hover:text-primary",
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
