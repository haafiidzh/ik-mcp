"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

// Below-the-fold arming for Reveal/Stagger (web-motion-spec section 3.1).
// Server HTML and the first client render are always the final, visible state. Only after hydration, and only for
// an element whose top is below the viewport, does the hook switch to "armed" (hidden) and then to "revealed" once
// it scrolls into view. Reduced motion, a #hash in the URL, and elements already in or above the viewport never arm.

export type RevealPhase = "visible" | "armed" | "revealed";

export interface RevealTokens {
  /** Enter translate distance in px (CSS --shift-md). */
  y: number;
  /** Seconds (CSS --dur-base). */
  duration: number;
  /** Cubic-bezier control points (CSS --ease-out). */
  ease: [number, number, number, number];
  /** Per-item stagger in seconds (CSS --stagger). */
  stagger: number;
}

export const DEFAULT_REVEAL_TOKENS: RevealTokens = { y: 12, duration: 0.24, ease: [0.16, 1, 0.3, 1], stagger: 0.04 };

/** IntersectionObserver rootMargin: reveal when the element is 10% inside the viewport bottom. */
export const REVEAL_ROOT_MARGIN = "0px 0px -10% 0px";

function cssVar(style: CSSStyleDeclaration, name: string): string {
  return style.getPropertyValue(name).trim();
}

function parseMs(v: string, fallback: number): number {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return (v.endsWith("ms") ? n : v.endsWith("s") ? n * 1000 : n) / 1000;
}

function parsePx(v: string, fallback: number): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseEase(v: string, fallback: RevealTokens["ease"]): RevealTokens["ease"] {
  const m = /^cubic-bezier\(([^)]+)\)$/.exec(v);
  if (!m?.[1]) return fallback;
  const parts = m[1].split(",").map((p) => parseFloat(p));
  const [a, b, c, d] = parts;
  if (parts.length !== 4 || [a, b, c, d].some((x) => x === undefined || !Number.isFinite(x))) return fallback;
  return [a as number, b as number, c as number, d as number];
}

export function readRevealTokens(el: Element): RevealTokens {
  const s = getComputedStyle(el);
  return {
    y: parsePx(cssVar(s, "--shift-md"), DEFAULT_REVEAL_TOKENS.y),
    duration: parseMs(cssVar(s, "--dur-base"), DEFAULT_REVEAL_TOKENS.duration),
    ease: parseEase(cssVar(s, "--ease-out"), DEFAULT_REVEAL_TOKENS.ease),
    stagger: parseMs(cssVar(s, "--stagger"), DEFAULT_REVEAL_TOKENS.stagger),
  };
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface ArmedReveal<T extends HTMLElement> {
  ref: RefObject<T | null>;
  phase: RevealPhase;
  tokens: RevealTokens;
}

export function useArmedReveal<T extends HTMLElement = HTMLElement>(options: { once?: boolean } = {}): ArmedReveal<T> {
  const once = options.once ?? true;
  const reduced = useReducedMotion();
  const ref = useRef<T | null>(null);
  const [phase, setPhase] = useState<RevealPhase>("visible");
  const [tokens, setTokens] = useState<RevealTokens>(DEFAULT_REVEAL_TOKENS);

  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el || reduced || typeof IntersectionObserver === "undefined") return;
    // Anchored loads and anything already in or above the viewport stay visible.
    if (window.location.hash || el.getBoundingClientRect().top < window.innerHeight) return;

    setTokens(readRevealTokens(el));
    setPhase("armed");
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setPhase("revealed");
            if (once) io.disconnect();
          } else if (!once) {
            setPhase("armed");
          }
        }
      },
      { rootMargin: REVEAL_ROOT_MARGIN },
    );
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, [reduced, once]);

  return { ref, phase, tokens };
}
