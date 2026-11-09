"use client";

import { useReducedMotion } from "motion/react";
import { useAnimate } from "motion/react-mini";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

// S5 "How it works" (web-motion-spec 4.1, M-06). `children` is the server-rendered HowItWorks (svg + ordered list),
// which is already the final state. After hydration the diagram is armed (parts hidden), then plays once when >= 50%
// visible (request -> guard -> pack -> result), or on Replay. Parts draw with stroke-dashoffset (pathLength=1) and fade
// with opacity; the dot moves with transform. Nothing loops. Reduced motion: never armed, fully drawn.
// useAnimate comes from "motion/react-mini" (WAAPI, smaller than the hybrid one in "motion/react").

type Controls = { cancel: () => void };
type Phase = "idle" | "playing" | "paused" | "done";

const EASE = [0.16, 1, 0.3, 1] as const;
/** Stage start times in seconds; stage n also sets data-step=n so the matching list item and part are highlighted. */
const STAGES = [0, 0.6, 1.2, 1.8] as const;
const TOTAL = 2.4;

const STATUS: Record<Phase, string> = { idle: "", playing: "Playing the flow.", paused: "Paused.", done: "Flow finished." };

export function FlowDiagram({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const [phase, setPhase] = useState<Phase>("idle");
  const [announce, setAnnounce] = useState("");
  const controls = useRef<Controls[]>([]);
  const timers = useRef<number[]>([]);
  // WAAPI animations that were running when Pause was pressed; only these are resumed (see onPause).
  const pausedAnims = useRef<Animation[]>([]);
  const clock = useRef({ offset: 0, resumedAt: 0 });
  const startedRef = useRef(false);

  const setAttr = useCallback(
    (name: string, value: string | null) => {
      const el = scope.current;
      if (!el) return;
      if (value === null) el.removeAttribute(name);
      else el.setAttribute(name, value);
    },
    [scope],
  );

  const clearTimers = useCallback(() => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  }, []);

  const schedule = useCallback(() => {
    clearTimers();
    const { offset } = clock.current;
    let current = 0;
    STAGES.forEach((t, i) => {
      if (t * 1000 <= offset) current = i + 1;
      else timers.current.push(window.setTimeout(() => setAttr("data-step", String(i + 1)), t * 1000 - offset));
    });
    if (current) setAttr("data-step", String(current));
    timers.current.push(
      window.setTimeout(() => {
        setAttr("data-flow", "done");
        setAttr("data-step", null);
        setPhase("done");
      }, TOTAL * 1000 - offset),
    );
  }, [clearTimers, setAttr]);

  const stop = useCallback(() => {
    clearTimers();
    for (const c of controls.current) c.cancel();
    controls.current = [];
    pausedAnims.current = [];
    // Finished animations commit their end values as inline styles; drop them so a replay starts from the hidden state.
    scope.current?.querySelectorAll<SVGElement>(".fd-part, .fd-dot").forEach((n) => n.removeAttribute("style"));
  }, [clearTimers, scope]);

  const play = useCallback(() => {
    stop();
    startedRef.current = true;
    setAttr("data-flow", "play");
    const draw = (sel: string, at: number, dur: number) =>
      animate(sel, { strokeDashoffset: [1, 0] }, { delay: at, duration: dur, ease: EASE });
    const fade = (sel: string, at: number, dur = 0.15) =>
      animate(sel, { opacity: [0, 1] }, { delay: at, duration: dur, ease: EASE });
    controls.current = [
      draw("#fd-claude", 0, 0.3),
      fade(".fd-t-claude", 0, 0.3),
      draw("#fd-req-1", 0.3, 0.3),
      fade(".fd-t-req", 0.3, 0.3),
      animate(
        "#fd-dot",
        { opacity: [0, 1, 1, 0], transform: ["translateX(0px)", "translateX(105px)"] },
        { delay: 0.3, duration: 0.3, ease: "linear" },
      ),
      draw("#fd-ik", 0.6, 0.3),
      fade(".fd-t-ik", 0.6, 0.3),
      fade(".fd-t-ik1", 0.9),
      fade(".fd-t-ik2", 1.02),
      draw("#fd-req-2", 1.2, 0.25),
      draw("#fd-pack", 1.45, 0.3),
      fade(".fd-t-pack", 1.45, 0.3),
      draw("#fd-res-1", 1.8, 0.3),
      draw("#fd-res-2", 2.1, 0.3),
      fade(".fd-t-res", 1.8, 0.3),
    ] as Controls[];
    clock.current = { offset: 0, resumedAt: performance.now() };
    setPhase("playing");
    schedule();
  }, [animate, schedule, setAttr, stop]);

  // Arm after hydration and play once when >= 50% visible.
  useEffect(() => {
    const el = scope.current;
    if (!el) return;
    setAttr("data-ready", "true");
    if (reduced) return;
    setAttr("data-flow", "armed");
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !startedRef.current) {
          io.disconnect();
          play();
        }
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- arm/observe once per reduced-motion value
  }, [reduced]);

  const onReplay = () => {
    setAnnounce("Replaying the flow.");
    play();
  };

  const onPause = () => {
    if (phase === "playing") {
      // Pause only animations that are still running. Calling play() on an already finished animation (what the
      // motion controls' play() does for every part) restarts it from 0, which re-hid finished parts (P7-27).
      const live = (scope.current?.getAnimations({ subtree: true }) ?? []).filter((a) => a.playState === "running");
      for (const a of live) a.pause();
      pausedAnims.current = live;
      clearTimers();
      clock.current.offset += performance.now() - clock.current.resumedAt;
      setPhase("paused");
      setAnnounce(STATUS.paused);
    } else if (phase === "paused") {
      for (const a of pausedAnims.current) if (a.playState === "paused") a.play();
      pausedAnims.current = [];
      clock.current.resumedAt = performance.now();
      schedule();
      setPhase("playing");
      setAnnounce("Resumed.");
    }
  };

  return (
    <div ref={scope} className="fd-root">
      {children}
      {/* Always rendered so server and first client render match; motion-flow.css hides it under reduced motion. */}
      <div className="fd-ctl mt-4 flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" className="min-h-11 sm:min-h-8" onClick={onReplay}>
          Replay
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 sm:min-h-8"
          onClick={onPause}
          disabled={phase !== "playing" && phase !== "paused"}
        >
          {phase === "paused" ? "Resume" : "Pause"}
        </Button>
        <p role="status" aria-live="polite" className="sr-only">
          {announce}
        </p>
      </div>
    </div>
  );
}
