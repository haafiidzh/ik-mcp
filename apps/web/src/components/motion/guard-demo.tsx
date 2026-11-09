"use client";

import { useReducedMotion } from "motion/react";
import { Ban, Check, Minus, RotateCcw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { StatusBadge } from "@/components/shared/status-badge";
import { GUARD_CASES, GUARD_STEPS, guardAnnouncement, guardEnvelope } from "@/data/guards";
import type { GuardCase } from "@/data/guards";

const RUN_MS = 2200;
const subscribe = () => () => {};

function chipState(c: GuardCase, index: number): "passed" | "rejected" | "skipped" {
  const stop = GUARD_STEPS.findIndex((s) => s.id === c.stoppedAt);
  return index < stop ? "passed" : index === stop ? "rejected" : "skipped";
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const AUTO_SUMMARY = "All five sample attempts were refused by a guard. Nothing ran.";

// Base layout is a plain list: every case, its checks, its answer and its test reference are in the server HTML and
// stay visible with no JS or reduced motion. After hydration (motion allowed) a card that starts below the fold is
// "armed" (shows the start frame of its sequence, set before first paint) and plays its short CSS sequence ONCE, the
// first time it is mostly in view (P7-31, human request; overrides "Replay only"). Cards in view at load, hash loads
// and reduced motion never arm. Replay stays available; a new Replay restarts that card. Nothing loops.
export function GuardDemo() {
  const reduced = useReducedMotion();
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  const canReplay = mounted && reduced === false;
  const [runs, setRuns] = useState<Record<string, number>>({});
  const [armed, setArmed] = useState<readonly string[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const nRef = useRef(0);
  const pending = useRef(0);
  const autoPlayed = useRef(false);
  const listRef = useRef<HTMLOListElement | null>(null);

  useEffect(() => {
    const t = timers.current;
    return () => { t.forEach((x) => clearTimeout(x)); t.clear(); };
  }, []);

  function start(id: string, onEnd: () => void) {
    const old = timers.current.get(id);
    if (old) clearTimeout(old);
    nRef.current += 1;
    const n = nRef.current;
    setRuns((r) => ({ ...r, [id]: n }));
    timers.current.set(id, setTimeout(() => {
      timers.current.delete(id);
      setRuns((r) => { const rest = { ...r }; delete rest[id]; return rest; });
      onEnd();
    }, RUN_MS));
  }

  // One polite announcement after the automatic pass has fully finished (not one per card).
  function maybeSummary() {
    if (pending.current === 0 && autoPlayed.current && timers.current.size === 0) {
      autoPlayed.current = false;
      setAnnouncement(AUTO_SUMMARY);
    }
  }

  function play(c: GuardCase) {
    setAnnouncement("");
    start(c.id, () => setAnnouncement(guardAnnouncement(c)));
  }

  // Arm cards that start below the fold, before first paint.
  useIsoLayoutEffect(() => {
    const list = listRef.current;
    if (!list || reduced !== false || typeof IntersectionObserver === "undefined") return;
    if (window.location.hash) return;
    const ids: string[] = [];
    list.querySelectorAll<HTMLElement>("[data-card-id]").forEach((el) => {
      if (el.getBoundingClientRect().top >= window.innerHeight) ids.push(el.dataset.cardId as string);
    });
    if (ids.length === 0) return;
    setArmed(ids);
    pending.current = ids.length;
    const left = new Set(ids);
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const el = e.target as HTMLElement;
          const id = el.dataset.cardId as string;
          if (!left.has(id)) continue;
          const seen = e.isIntersecting && (e.intersectionRatio >= 0.4 || e.intersectionRect.height >= window.innerHeight * 0.45);
          const passed = !e.isIntersecting && e.boundingClientRect.bottom < 0;
          if (!seen && !passed) continue;
          left.delete(id);
          io.unobserve(el);
          setArmed((a) => a.filter((x) => x !== id));
          pending.current -= 1;
          if (seen) {
            autoPlayed.current = true;
            start(id, maybeSummary);
          } else maybeSummary();
        }
        if (left.size === 0) io.disconnect();
      },
      { threshold: [0, 0.15, 0.25, 0.4, 0.6] },
    );
    list.querySelectorAll<HTMLElement>("[data-card-id]").forEach((el) => {
      if (left.has(el.dataset.cardId as string)) io.observe(el);
    });
    return () => io.disconnect();
  }, [reduced]);

  return (
    <div className="guard-demo">
      <p className="text-sm text-muted-foreground">
        Sample calls, sample data. Each case is covered by a test in the server repository; this page shows no pass count.
        {canReplay ? " Each case plays once as you scroll to it; use Replay to watch the order of the checks again." : null}
      </p>
      <ol ref={listRef} className="guard-list mt-4 space-y-4">
        {GUARD_CASES.map((c, i) => {
          const runN = runs[c.id];
          const playing = runN !== undefined;
          const phase = playing ? "playing" : armed.includes(c.id) ? "armed" : undefined;
          const h = `guard-${c.id}-h`;
          return (
            <li key={c.id} className="guard-card rounded-lg border border-border bg-card p-4" data-card-id={c.id} data-phase={phase} aria-labelledby={h}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{i + 1}. {c.pack}</p>
                  <h3 id={h} className="text-lg font-semibold">{c.title}</h3>
                </div>
                {canReplay ? (
                  <button type="button" className="guard-replay" onClick={() => play(c)} aria-label={`Replay: ${c.title}`}>
                    <RotateCcw className="size-4" aria-hidden={true} />
                    Replay
                  </button>
                ) : null}
              </div>

              <div key={runN ?? "idle"} className="guard-stage mt-3">
                <div className="guard-ask rounded-md border border-border p-3">
                  <p className="text-sm font-medium">The ask: {c.attackLabel}</p>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs"><code>{c.tool} {c.args}</code></pre>
                </div>

                <div className="guard-gate mt-3" role="group" aria-label="Checks, in order">
                  <span className="guard-packet" aria-hidden="true" />
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {GUARD_STEPS.map((s, k) => {
                      const st = chipState(c, k);
                      return (
                        <li key={s.id} className="guard-chip" data-state={st} style={{ "--k": k } as React.CSSProperties}>
                          {st === "passed" ? <Check className="size-3.5" aria-hidden={true} /> : st === "rejected" ? <X className="size-3.5" aria-hidden={true} /> : <Minus className="size-3.5" aria-hidden={true} />}
                          <span>{s.label}: {st === "passed" ? "passed" : st === "rejected" ? "refused here" : "not reached"}</span>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="guard-nothing mt-2 inline-flex items-center gap-1 text-sm text-muted-foreground">
                    <Ban className="size-4" aria-hidden={true} />
                    Nothing ran: the tool itself was never executed.
                  </p>
                </div>

                <div className="guard-answer mt-3 rounded-md border border-border p-3">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <StatusBadge kind="rejected" label="Refused by the guard" />
                    <span className="guard-code"><code>{c.code}</code></span>
                  </p>
                  <pre className="mt-2 overflow-x-auto font-mono text-xs"><code>{guardEnvelope(c)}</code></pre>
                  <p className="mt-2 text-sm">{c.why}</p>
                </div>
              </div>

              <p className="mt-3 text-xs text-muted-foreground">
                Sample call, sample data, covered by test: <code>{c.testRef}</code> (message from <code>{c.sourceRef}</code>)
              </p>
            </li>
          );
        })}
      </ol>
      <p role="status" className="sr-only">{announcement}</p>
    </div>
  );
}
