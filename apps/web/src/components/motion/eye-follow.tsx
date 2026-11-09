"use client";

import { useEffect } from "react";

// Logo eye follows the pointer (P7-33). Renders nothing; drives the `.ik-eye-pupil` inside the header logo link
// through a direct style.transform write (no React state, no re-render per move). Active only for a fine pointer
// when motion is not reduced (prefers-reduced-motion); otherwise the pupil stays centred (SSR/no-JS default).
// The pupil looks straight ahead while the pointer is near/over the logo link or the link has keyboard focus,
// when the pointer leaves the window, and when the tab is hidden.
const RX = 5; // max pupil travel in SVG user units (eye socket is 28 wide, pupil r = 5.2)
const RY = 2.3;
const FULL_DIST = 70; // px from eye centre at which the pupil reaches full travel
const NEAR_PAD = 40; // px around the logo link treated as "near"
const EASE = 0.18; // lerp factor per frame

export function EyeFollow() {
  useEffect(() => {
    const link = document.querySelector<HTMLElement>(".ik-logo-link");
    const pupil = link?.querySelector<SVGElement>(".ik-eye-pupil");
    const eye = pupil?.ownerSVGElement;
    if (!link || !pupil || !eye) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
    let teardown: (() => void) | null = null;

    const start = () => {
      let raf = 0;
      let cx = 0;
      let cy = 0;
      let eyeRect = eye.getBoundingClientRect();
      let linkRect = link.getBoundingClientRect();
      let px = -1;
      let py = -1;
      let hasPointer = false;
      let focused = false;
      let x = 0;
      let y = 0;
      let tx = 0;
      let ty = 0;
      let rectDirty = false;

      const measure = () => {
        eyeRect = eye.getBoundingClientRect();
        linkRect = link.getBoundingClientRect();
        rectDirty = false;
      };
      const computeTarget = () => {
        if (!hasPointer || focused || document.hidden) {
          tx = 0;
          ty = 0;
          return;
        }
        const near =
          px >= linkRect.left - NEAR_PAD && px <= linkRect.right + NEAR_PAD &&
          py >= linkRect.top - NEAR_PAD && py <= linkRect.bottom + NEAR_PAD;
        if (near) {
          tx = 0;
          ty = 0;
          return;
        }
        cx = eyeRect.left + eyeRect.width / 2;
        cy = eyeRect.top + eyeRect.height / 2;
        const dx = px - cx;
        const dy = py - cy;
        const dist = Math.hypot(dx, dy);
        if (dist < 1) {
          tx = 0;
          ty = 0;
          return;
        }
        const k = Math.min(1, dist / FULL_DIST);
        tx = (dx / dist) * RX * k;
        ty = (dy / dist) * RY * k;
      };
      const frame = () => {
        raf = 0;
        if (document.hidden) return;
        if (rectDirty) measure();
        computeTarget();
        x += (tx - x) * EASE;
        y += (ty - y) * EASE;
        const settled = Math.abs(tx - x) < 0.01 && Math.abs(ty - y) < 0.01;
        if (settled) {
          x = tx;
          y = ty;
        }
        pupil.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
        if (!settled) raf = requestAnimationFrame(frame);
      };
      const kick = () => {
        if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
      };
      const onMove = (e: PointerEvent) => {
        if (e.pointerType === "touch") return;
        px = e.clientX;
        py = e.clientY;
        hasPointer = true;
        kick();
      };
      const onLeave = () => {
        hasPointer = false;
        kick();
      };
      const onFocusIn = () => {
        focused = link.matches(":focus-visible");
        kick();
      };
      const onFocusOut = () => {
        focused = false;
        kick();
      };
      const onResize = () => {
        rectDirty = true;
        kick();
      };
      const onVisibility = () => {
        if (document.hidden) {
          if (raf) cancelAnimationFrame(raf);
          raf = 0;
        } else {
          kick();
        }
      };

      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("resize", onResize, { passive: true });
      window.addEventListener("scroll", onResize, { passive: true });
      document.documentElement.addEventListener("pointerleave", onLeave);
      document.addEventListener("visibilitychange", onVisibility);
      link.addEventListener("focusin", onFocusIn);
      link.addEventListener("focusout", onFocusOut);
      return () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("resize", onResize);
        window.removeEventListener("scroll", onResize);
        document.documentElement.removeEventListener("pointerleave", onLeave);
        document.removeEventListener("visibilitychange", onVisibility);
        link.removeEventListener("focusin", onFocusIn);
        link.removeEventListener("focusout", onFocusOut);
        if (raf) cancelAnimationFrame(raf);
        pupil.style.transform = "";
      };
    };

    const sync = () => {
      const enable = !reduce.matches && fine.matches;
      if (enable && !teardown) teardown = start();
      else if (!enable && teardown) {
        teardown();
        teardown = null;
      }
    };
    sync();
    reduce.addEventListener("change", sync);
    fine.addEventListener("change", sync);
    return () => {
      reduce.removeEventListener("change", sync);
      fine.removeEventListener("change", sync);
      teardown?.();
    };
  }, []);

  return null;
}
