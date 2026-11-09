"use client";

import { useEffect, useRef } from "react";

// Pointer-follow glow behind the hero terminal (web-motion-spec 4.1 S1). Decorative, aria-hidden, transform and
// opacity only. Active only for a fine hover pointer and when motion is not reduced (prefers-reduced-motion);
// otherwise the element stays invisible. Follows the pointer over its parent element.
const SIZE = 480;

export function Spotlight() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const glow = ref.current;
    const host = glow?.parentElement?.parentElement;
    if (!glow || !host) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = host.getBoundingClientRect();
        glow.style.transform = `translate3d(${Math.round(e.clientX - r.left - SIZE / 2)}px, ${Math.round(e.clientY - r.top - SIZE / 2)}px, 0)`;
        glow.style.opacity = "1";
      });
    };
    const onLeave = () => {
      glow.style.opacity = "0";
    };
    host.addEventListener("pointermove", onMove, { passive: true });
    host.addEventListener("pointerleave", onLeave);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
    };
  }, []);
  return (
    <div className="hero-spot-clip" aria-hidden={true}>
      <div ref={ref} className="hero-spot" />
    </div>
  );
}
