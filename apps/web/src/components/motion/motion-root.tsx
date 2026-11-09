"use client";

import { LazyMotion, MotionConfig } from "motion/react";

// Async feature load: the page hydrates first, animation features arrive in a separate chunk.
const loadFeatures = () => import("@/lib/motion/features-dom").then((mod) => mod.default);

// `strict` makes a stray `motion.*` component throw; use `m` (from "motion/react-m") only.
export function MotionRoot({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={loadFeatures} strict>
        {children}
      </LazyMotion>
    </MotionConfig>
  );
}
