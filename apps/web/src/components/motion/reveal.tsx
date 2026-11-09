"use client";

import * as m from "motion/react-m";
import type { ElementType, ReactNode } from "react";
import { useArmedReveal } from "@/lib/motion/use-armed-reveal";

const TAGS = { div: m.div, section: m.section, article: m.article, li: m.li, p: m.p, span: m.span, ul: m.ul, ol: m.ol } as const;

export interface RevealProps {
  children: ReactNode;
  as?: keyof typeof TAGS;
  className?: string;
  /** Extra delay in ms once in view. */
  delay?: number;
  /** Override the enter distance in px (default: --shift-md). */
  y?: number;
  /** Reveal only the first time (default true). */
  once?: boolean;
}

// Server HTML and first render are the final state (initial={false}); the element hides itself only after
// hydration and only when it starts below the fold (see use-armed-reveal; reduced motion never arms, so it stays static).
// The element type and props must not depend on useReducedMotion(): it is null on the server and true on the first
// client render, so branching on it here made the first client render differ from the server HTML (React #418). Animates opacity and transform only.
export function Reveal({ children, as = "div", className, delay = 0, y, once = true }: RevealProps) {
  const { ref, phase, tokens } = useArmedReveal<HTMLElement>({ once });
  const Tag = TAGS[as] as unknown as ElementType;

  const shift = y ?? tokens.y;
  const hidden = phase === "armed";
  return (
    <Tag
      ref={ref}
      className={className}
      initial={false}
      animate={hidden ? { opacity: 0, y: shift } : { opacity: 1, y: 0 }}
      transition={
        hidden ? { duration: 0 } : { duration: tokens.duration, ease: tokens.ease, delay: phase === "revealed" ? delay / 1000 : 0 }
      }
    >
      {children}
    </Tag>
  );
}
