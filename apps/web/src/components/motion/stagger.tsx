"use client";

import * as m from "motion/react-m";
import { createContext, useContext } from "react";
import type { ElementType, ReactNode } from "react";
import { DEFAULT_REVEAL_TOKENS, useArmedReveal } from "@/lib/motion/use-armed-reveal";
import type { RevealTokens } from "@/lib/motion/use-armed-reveal";

const TAGS = { div: m.div, section: m.section, article: m.article, li: m.li, p: m.p, span: m.span, ul: m.ul, ol: m.ol } as const;
type Tag = keyof typeof TAGS;

/** Spec section 1: at most 10 staggered items (<= 400 ms total); item 11+ has no delay. */
const MAX_STAGGERED = 10;

const StaggerContext = createContext<RevealTokens>(DEFAULT_REVEAL_TOKENS);

export interface StaggerProps {
  children: ReactNode;
  as?: Tag;
  className?: string;
  once?: boolean;
}

// The container arms once (in view of the whole group, not each item); StaggerItem children follow it via variants.
export function Stagger({ children, as = "div", className, once = true }: StaggerProps) {
  const { ref, phase, tokens } = useArmedReveal<HTMLElement>({ once });
  const Tag = TAGS[as] as unknown as ElementType;
  return (
    <StaggerContext.Provider value={tokens}>
      <Tag ref={ref} className={className} initial={false} animate={phase === "armed" ? "hidden" : "shown"}>
        {children}
      </Tag>
    </StaggerContext.Provider>
  );
}

export interface StaggerItemProps {
  children: ReactNode;
  as?: Tag;
  className?: string;
  /** Position in the group; delay = index * --stagger for the first 10, none after. */
  index?: number;
}

export function StaggerItem({ children, as = "div", className, index = 0 }: StaggerItemProps) {
  const tokens = useContext(StaggerContext);
  const Tag = TAGS[as] as unknown as ElementType;
  const delay = index >= 0 && index < MAX_STAGGERED ? index * tokens.stagger : 0;
  const variants = {
    hidden: { opacity: 0, y: tokens.y, transition: { duration: 0 } },
    shown: { opacity: 1, y: 0, transition: { duration: tokens.duration, ease: tokens.ease, delay } },
  };
  return (
    <Tag className={className} variants={variants}>
      {children}
    </Tag>
  );
}
