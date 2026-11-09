"use client";

import { usePathname } from "next/navigation";

// Reading-progress bar for long pages. Purely decorative (aria-hidden); the animation is CSS scroll-driven
// (motion-chrome.css) and only exists under prefers-reduced-motion: no-preference where animation-timeline is supported.
const LONG_PAGES = ["/install", "/tools", "/security"];

export function ScrollProgress() {
  const pathname = usePathname();
  if (!LONG_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;
  return <div className="scroll-progress" aria-hidden="true" />;
}
