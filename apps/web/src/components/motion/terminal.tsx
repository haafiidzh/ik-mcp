"use client";

import { Check, RotateCcw, ShieldAlert } from "lucide-react";
import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { HERO_BEATS, HERO_FICTIONAL_NOTE, REDACTED_LITERAL, type HeroBeat } from "@/data/hero-script";

// Hero terminal (web-motion-spec 4.1 S1, M-05). Every beat's full text is in the server HTML inside <pre>; the
// server render and the first client render are the final state of beat 1. The sequence is CSS only (keyframes in
// motion-hero.css, applied inside prefers-reduced-motion: no-preference) and starts once, when the figure is >= 60%
// visible, or when the user picks a beat or presses Replay. It never loops. Timing numbers below are animation
// timings, not shown on screen.

const TYPE_RATE_MS = 25;
const TYPE_MAX_MS = 1200;
const MAX_STAGGER_LINES = 12;
const LINE_MS = 50;

export interface Timeline {
  typeMs: number;
  toolAt: number;
  argsAt: number;
  resultAt: number;
  linesAt: number;
  badgeAt: number;
  totalMs: number;
}

/** Pure timeline for one beat (ms from t=0). Total stays under 4 s for every beat. */
export function timelineFor(b: Pick<HeroBeat, "prompt" | "resultLines">): Timeline {
  const typeMs = Math.min(TYPE_MAX_MS, b.prompt.length * TYPE_RATE_MS);
  const toolAt = typeMs + 200;
  const argsAt = toolAt + 100;
  const resultAt = argsAt + 300 + 300;
  const linesAt = resultAt + 100;
  const staggered = Math.min(b.resultLines.length, MAX_STAGGER_LINES);
  const badgeAt = linesAt + staggered * LINE_MS + 150;
  return { typeMs, toolAt, argsAt, resultAt, linesAt, badgeAt, totalMs: badgeAt + 240 };
}

function withRedaction(line: string) {
  const parts = line.split(REDACTED_LITERAL);
  return parts.map((p, i) => (
    <Fragment key={i}>
      {p}
      {i < parts.length - 1 ? <mark className="ht-redact">{REDACTED_LITERAL}</mark> : null}
    </Fragment>
  ));
}

function BeatView({ beat, active, playing }: { beat: HeroBeat; active: boolean; playing: boolean }) {
  const t = timelineFor(beat);
  const style = {
    "--t-type": `${t.typeMs}ms`,
    "--t-steps": Math.max(1, beat.prompt.length),
    "--t-tool": `${t.toolAt}ms`,
    "--t-args": `${t.argsAt}ms`,
    "--t-result": `${t.resultAt}ms`,
    "--t-lines": `${t.linesAt}ms`,
    "--t-badge": `${t.badgeAt}ms`,
  } as React.CSSProperties;
  const danger = beat.outcome === "rejected";
  return (
    <div
      className="ht-beat"
      data-active={active ? "true" : "false"}
      data-playing={active && playing ? "true" : "false"}
      data-outcome={beat.outcome}
      style={style}
    >
      <pre className="ht-pre" tabIndex={active ? 0 : -1} role="group" aria-label={`Example: ${beat.label}`}>
        <span className="ht-line ht-prompt">
          <span className="ht-caret" aria-hidden={true}>{"> "}</span>
          {beat.prompt}
        </span>
        <span className="ht-line ht-tool">
          <span className="ht-label">Tool call </span>
          {beat.tool}
        </span>
        <span className="ht-line ht-args">{beat.args}</span>
        <span className="ht-result">
          {beat.resultLines.map((line, i) => (
            <span key={i} className="ht-line ht-rline" style={{ "--i": Math.min(i, MAX_STAGGER_LINES - 1) } as React.CSSProperties}>
              {withRedaction(line)}
            </span>
          ))}
        </span>
      </pre>
      <p className="ht-badge" data-danger={danger ? "true" : "false"}>
        {danger ? <ShieldAlert className="size-4" aria-hidden={true} /> : <Check className="size-4" aria-hidden={true} />}
        <span>{beat.badge}</span>
      </p>
    </div>
  );
}

const subscribeNever = () => () => {};

export function Terminal() {
  const [active, setActive] = useState(0);
  const [run, setRun] = useState(0);
  const [playing, setPlaying] = useState(false);
  // false on the server and during hydration, true afterwards (no setState in an effect).
  const ready = useSyncExternalStore(subscribeNever, () => true, () => false);
  const [announce, setAnnounce] = useState("");
  const figRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = figRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.intersectionRatio >= 0.6 || e.intersectionRect.height >= window.innerHeight * 0.6) {
            setPlaying(true);
            setRun((r) => r + 1);
            io.disconnect();
            return;
          }
        }
      },
      { threshold: [0.3, 0.6, 1] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const pick = (i: number) => {
    setActive(i);
    setPlaying(true);
    setRun((r) => r + 1);
    setAnnounce(`Showing example: ${HERO_BEATS[i]!.label}`);
  };
  const replay = () => {
    setPlaying(true);
    setRun((r) => r + 1);
    setAnnounce(`Replaying example: ${HERO_BEATS[active]!.label}`);
  };

  return (
    <div className="ht-wrap">
      <figure ref={figRef} role="region" aria-labelledby="ht-cap" className="ht-window m-0">
        <figcaption id="ht-cap" className="ht-cap">
          <span className="ht-sample">Sample data</span>
          <span>, not a live call. {HERO_FICTIONAL_NOTE}</span>
        </figcaption>
        <div className="ht-stage">
          {HERO_BEATS.map((b, i) => (
            <BeatView key={`${b.id}-${i === active ? run : 0}`} beat={b} active={i === active} playing={playing} />
          ))}
        </div>
        <div className="ht-controls" data-ready={ready ? "true" : "false"}>
          <div role="group" aria-label="Example calls" className="ht-chips">
            {HERO_BEATS.map((b, i) => (
              <button key={b.id} type="button" className="ht-chip" aria-pressed={i === active} onClick={() => pick(i)}>
                {b.label}
              </button>
            ))}
          </div>
          <button type="button" className="ht-chip ht-replay" onClick={replay}>
            <RotateCcw className="size-4" aria-hidden={true} /> Replay
          </button>
        </div>
        <p role="status" className="sr-only">{announce}</p>
      </figure>
    </div>
  );
}
