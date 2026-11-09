"use client";

import { useEffect, useRef, type ReactNode } from "react";

// /install step rail (web-motion-spec 4.2, M-09). Wraps the server-rendered step sections; children and their text are
// untouched. After hydration it marks the step in the reading band: aria-current="step" on that step's heading link
// (state is exposed to assistive tech, not motion only) and data-active on the section for the CSS badge.
// The rail, badges, fill and snippet sweep are CSS in motion-install.css, gated by prefers-reduced-motion:
// no-preference; this file animates nothing itself, so reduced motion shows the static final state.
export function StepRail({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const sections = Array.from(root.querySelectorAll<HTMLElement>(":scope > section"));
    const inBand = new Set<HTMLElement>();
    const apply = () => {
      const active = sections.find((s) => inBand.has(s));
      for (const s of sections) {
        const link = s.querySelector<HTMLAnchorElement>("h2 a");
        if (s === active) {
          s.setAttribute("data-active", "true");
          link?.setAttribute("aria-current", "step");
        } else {
          s.removeAttribute("data-active");
          link?.removeAttribute("aria-current");
        }
      }
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) inBand.add(e.target as HTMLElement);
          else inBand.delete(e.target as HTMLElement);
        }
        apply();
      },
      { rootMargin: "-40% 0px -55% 0px" },
    );
    for (const s of sections) io.observe(s);
    return () => {
      io.disconnect();
      inBand.clear();
      apply();
    };
  }, []);
  return (
    <div ref={ref} className="step-rail mt-12">
      {children}
    </div>
  );
}
