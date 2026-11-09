"use client";

import { useEffect } from "react";

// Scroll-spy for the /tools pack chip nav (web-motion-spec 4.3). Renders nothing. The nav stays server-rendered; after
// hydration this sets aria-current="true" on the chip whose section is in the reading band. State is exposed through
// aria-current (not motion only); the visual pill is CSS (motion-tools.css, opacity only, transition gated by
// prefers-reduced-motion: no-preference). This file animates nothing itself. No layout changes.
export function PackSpy({ navId, headingIds }: { navId: string; headingIds: readonly string[] }) {
  useEffect(() => {
    const nav = document.getElementById(navId);
    if (!nav || typeof IntersectionObserver === "undefined") return;
    const links = new Map<string, HTMLAnchorElement>();
    const sections = new Map<Element, string>();
    for (const id of headingIds) {
      const link = nav.querySelector<HTMLAnchorElement>(`a[href="#${CSS.escape(id)}"]`);
      const section = document.getElementById(id)?.closest("section");
      if (link && section) {
        links.set(id, link);
        sections.set(section, id);
      }
    }
    const inBand = new Set<string>();
    const apply = () => {
      // First section in document order that is inside the band wins.
      const active = headingIds.find((id) => inBand.has(id));
      for (const [id, link] of links) {
        if (id === active) link.setAttribute("aria-current", "true");
        else link.removeAttribute("aria-current");
      }
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = sections.get(e.target);
          if (!id) continue;
          if (e.isIntersecting) inBand.add(id);
          else inBand.delete(id);
        }
        apply();
      },
      { rootMargin: "-40% 0px -55% 0px" },
    );
    for (const s of sections.keys()) io.observe(s);
    return () => {
      io.disconnect();
      for (const link of links.values()) link.removeAttribute("aria-current");
    };
  }, [navId, headingIds]);
  return null;
}
