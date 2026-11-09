"use client";

import { useEffect } from "react";

// Natural periodic blink of the header logo eye (P7-35). Renders nothing. A JS timer (no per-frame work, no React
// state) sets `data-blink` on `.ik-eye-lid` for one run of the one-shot CSS `eye-blink` animation (see
// motion-chrome.css, transform scaleY only) and removes it on animationend. The pupil translate (EyeFollow) lives on
// a child element, so lid and pupil transforms never conflict.
// Choice: blinks are skipped while the pointer is on/near the logo link (same near zone as EyeFollow) or the link has
// keyboard focus (the eye is "looking" at the cursor / focus ring); they resume afterwards.
// Stops (static open eye) under prefers-reduced-motion, on coarse/touch pointers, while the tab is hidden, and after
// IDLE_MS without pointer/keyboard/scroll activity (WCAG 2.2.2); restarts on the next activity.
const MIN_DELAY_MS = 3000; // shortest gap between blinks
const MAX_DELAY_MS = 6000; // longest gap between blinks
const DOUBLE_BLINK_P = 0.2; // probability that a blink is a double blink
const DOUBLE_GAP_MS = 180; // start-to-start gap of the two blinks in a double blink
const BLINK_MS = 160; // must match the animation duration in motion-chrome.css (.ik-eye-lid[data-blink])
const IDLE_MS = 60_000; // stop scheduling after this long without user activity
const NEAR_PAD = 40; // px around the logo link treated as "near" (matches EyeFollow)

export function EyeBlink() {
  useEffect(() => {
    const link = document.querySelector<HTMLElement>(".ik-logo-link");
    const lid = link?.querySelector<SVGElement>(".ik-eye-lid");
    if (!link || !lid) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
    let teardown: (() => void) | null = null;

    const start = () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let gapTimer: ReturnType<typeof setTimeout> | undefined;
      let safety: ReturnType<typeof setTimeout> | undefined;
      let running = false; // a delay timer is pending
      let lastActivity = performance.now();
      let px = -1;
      let py = -1;
      let hasPointer = false;
      let focused = false;

      const isNear = () => {
        if (focused) return true;
        if (!hasPointer) return false;
        const r = link.getBoundingClientRect();
        return (
          px >= r.left - NEAR_PAD && px <= r.right + NEAR_PAD &&
          py >= r.top - NEAR_PAD && py <= r.bottom + NEAR_PAD
        );
      };
      const clearBlink = () => {
        lid.removeAttribute("data-blink");
        clearTimeout(safety);
      };
      const blinkOnce = (done?: () => void) => {
        clearBlink();
        // Restart the animation even if the attribute was just removed.
        void lid.getBoundingClientRect();
        lid.setAttribute("data-blink", "");
        const end = () => {
          lid.removeEventListener("animationend", end);
          clearBlink();
          done?.();
        };
        lid.addEventListener("animationend", end);
        // Safety net if animationend never fires (e.g. animation disabled): never leave the attribute set.
        safety = setTimeout(end, BLINK_MS + 100);
      };
      const schedule = () => {
        clearTimeout(timer);
        running = true;
        const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
        timer = setTimeout(fire, delay);
      };
      const fire = () => {
        if (document.hidden) {
          running = false;
          return;
        }
        if (performance.now() - lastActivity > IDLE_MS) {
          running = false; // idle: stop until the next activity
          return;
        }
        if (!isNear()) {
          blinkOnce();
          if (Math.random() < DOUBLE_BLINK_P) {
            gapTimer = setTimeout(() => {
              if (!document.hidden && !isNear()) blinkOnce();
            }, DOUBLE_GAP_MS);
          }
        }
        schedule();
      };
      const stop = () => {
        clearTimeout(timer);
        clearTimeout(gapTimer);
        clearBlink();
        running = false;
      };
      const onActivity = () => {
        lastActivity = performance.now();
        if (!running && !document.hidden) schedule();
      };
      const onMove = (e: PointerEvent) => {
        if (e.pointerType === "touch") return;
        px = e.clientX;
        py = e.clientY;
        hasPointer = true;
        onActivity();
      };
      const onLeave = () => {
        hasPointer = false;
      };
      const onFocusIn = () => {
        focused = link.matches(":focus-visible");
      };
      const onFocusOut = () => {
        focused = false;
      };
      const onVisibility = () => {
        if (document.hidden) stop();
        else if (!running) schedule();
      };

      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("keydown", onActivity, { passive: true });
      window.addEventListener("scroll", onActivity, { passive: true });
      document.documentElement.addEventListener("pointerleave", onLeave);
      document.addEventListener("visibilitychange", onVisibility);
      link.addEventListener("focusin", onFocusIn);
      link.addEventListener("focusout", onFocusOut);
      if (!document.hidden) schedule();
      return () => {
        stop();
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("keydown", onActivity);
        window.removeEventListener("scroll", onActivity);
        document.documentElement.removeEventListener("pointerleave", onLeave);
        document.removeEventListener("visibilitychange", onVisibility);
        link.removeEventListener("focusin", onFocusIn);
        link.removeEventListener("focusout", onFocusOut);
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
