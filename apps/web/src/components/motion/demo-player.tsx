"use client";

import { useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

// Opt-in player for /demo (web-motion-spec section 7, M-11). The server renders every step; `children` is that
// full list. Without JS, before hydration, and until the user presses Play or Step, all steps are visible. The
// player only hides later steps (CSS in motion-demo.css, keyed by data-shown) after the user starts it. There is no
// autoplay and no timer before a press. The per-step transition is CSS (opacity/transform), so no animation
// library is loaded for it; reduced motion is honoured in the CSS and by hiding Play.

export interface DemoStepMeta {
  kind: "user" | "assistant" | "tool";
  /** Plain-text description announced in the live region, e.g. "tool call fs_read_file, refused with PERMISSION_DENIED". */
  label: string;
}

/** motion-demo.css has hide rules for this many steps; longer scenarios stay in "show all" (no controls). */
const MAX_STEPS = 12;
const DWELL_MS = { user: 1600, tool: 2200, assistant: 1800 } as const;

const subscribeNever = () => () => {};

export function DemoPlayer({ steps, label, children }: { steps: DemoStepMeta[]; label: string; children: ReactNode }) {
  const reduced = useReducedMotion();
  const total = steps.length;
  const ready = useSyncExternalStore(subscribeNever, () => true, () => false);
  // 0 = show all (default, idle). 1..total = steps revealed so far.
  const [shown, setShown] = useState(0);
  const [playRequested, setPlaying] = useState(false);
  const [fast, setFast] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const follow = useRef(true);
  const opened = useRef(false);
  // Playback ends by itself on the last step; derived, so no state is set from an effect.
  const playing = playRequested && shown < total;

  const stop = useCallback(() => setPlaying(false), []);
  const reset = useCallback(() => {
    setPlaying(false);
    setShown(0);
    opened.current = false;
  }, []);

  const play = () => {
    if (playing) return stop();
    follow.current = true;
    setShown((s) => (s === 0 || s >= total ? 1 : s));
    setPlaying(true);
  };
  const next = () => {
    setPlaying(false);
    setShown((s) => Math.min(total, s + 1));
  };
  const back = () => {
    setPlaying(false);
    setShown((s) => Math.max(1, s - 1));
  };

  // Advance one step after its dwell time. Starts only from a user-pressed Play.
  useEffect(() => {
    if (!playing) return;
    const current = steps[shown - 1];
    const dwell = DWELL_MS[current?.kind ?? "tool"] / (fast ? 2 : 1);
    const id = window.setTimeout(() => {
      // A scenario that became hidden (another tab) must not keep running.
      if (listRef.current && listRef.current.offsetParent === null) return setPlaying(false);
      setShown((s) => s + 1);
    }, dwell);
    return () => window.clearTimeout(id);
  }, [playing, shown, total, fast, steps]);

  // Pause when the tab is hidden, when focus moves into a code block, and stop auto-follow once the user scrolls.
  useEffect(() => {
    if (!playing) return;
    const onVis = () => document.hidden && setPlaying(false);
    const onUser = () => {
      follow.current = false;
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("wheel", onUser, { passive: true });
    window.addEventListener("touchmove", onUser, { passive: true });
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("wheel", onUser);
      window.removeEventListener("touchmove", onUser);
    };
  }, [playing]);

  // Each revealed tool card opens; while playing, keep the new step in view (not under reduced motion).
  useEffect(() => {
    if (shown === 0) return;
    const li = listRef.current?.children[shown - 1];
    if (!li) return;
    // Open every tool card once, on first activation. Hidden steps keep their space (visibility:hidden in the CSS),
    // so opening them up front makes the list height final and nothing below moves while the steps appear.
    if (!opened.current) {
      opened.current = true;
      listRef.current?.querySelectorAll("details").forEach((d) => d.setAttribute("open", ""));
    }
    if (playing && follow.current && !reduced) {
      const r = li.getBoundingClientRect();
      if (r.bottom > window.innerHeight || r.top < 0) li.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [shown, playing, reduced, steps]);

  const enabled = total > 0 && total <= MAX_STEPS;
  const active = shown > 0;
  const finished = active && shown >= total;
  const status = !active
    ? `Showing all ${total} steps.`
    : `Step ${shown} of ${total}: ${steps[shown - 1]?.label ?? ""}${finished && !playing ? ". End of sample." : ""}`;

  return (
    <div className="demo-player" data-active={active ? "true" : "false"}>
      {/* Reserved height so controls appearing after hydration do not shift layout. */}
      <div className="demo-controls" role="group" aria-label={`${label}: walkthrough controls`}>
        {ready && enabled ? (
          <>
            {!reduced ? (
              <Button type="button" size="lg" className="demo-btn" onClick={play} aria-label={playing ? "Pause" : finished ? "Replay" : shown > 0 ? "Resume" : "Play"}>
                {playing ? "Pause" : finished ? "Replay" : shown > 0 ? "Resume" : "Play"}
              </Button>
            ) : null}
            <Button type="button" size="lg" variant="outline" className="demo-btn" onClick={back} disabled={shown <= 1}>
              Back
            </Button>
            <Button type="button" size="lg" variant="outline" className="demo-btn" onClick={next} disabled={finished}>
              {active ? "Next step" : "Step through"}
            </Button>
            <Button type="button" size="lg" variant="outline" className="demo-btn" onClick={reset} disabled={!active}>
              Stop and show all
            </Button>
            {!reduced ? (
              <Button type="button" size="lg" variant="outline" className="demo-btn" aria-pressed={fast} onClick={() => setFast((f) => !f)}>
                Speed {fast ? "2x" : "1x"}
              </Button>
            ) : null}
            <p role="status" aria-live="polite" className="demo-status">
              {status}
            </p>
          </>
        ) : null}
      </div>
      <ol
        ref={listRef}
        className="demo-steps space-y-3"
        data-shown={active ? shown : undefined}
        onFocusCapture={(e) => {
          if (playing && (e.target as HTMLElement).closest("pre")) setPlaying(false);
        }}
      >
        {children}
      </ol>
    </div>
  );
}
