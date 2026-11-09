"use client";

import * as React from "react";
import { LazyMotion, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const subscribeNever = () => () => {};

// web-motion-spec section 6 / M-07. Radix semantics (roles, roving tabindex, arrow keys, aria-selected) come from
// ui/tabs untouched. Two layers: (1) a sliding pill (m.span layoutId, transform only, needs domMax which is loaded
// only here, in a nested LazyMotion, so pages without tabs never fetch it); (2) a CSS-only panel crossfade
// (motion-tabs.css): every panel is force-mounted so all text is in the server HTML, panels share one grid cell, and
// inactive ones are visibility:hidden. Reduced motion: pill jumps (duration 0), CSS adds no transition or offset.

const loadMax = () => import("@/lib/motion/features-max").then((mod) => mod.default);

type Ctx = { value: string; pillId: string };
const TabsCtx = React.createContext<Ctx | null>(null);

export function AnimatedTabs({
  defaultValue,
  children,
  className,
  verticalFromMd = false,
}: {
  defaultValue: string;
  children: React.ReactNode;
  className?: string;
  /** Lay the list out vertically from the md breakpoint up; Radix orientation follows so arrow keys match the layout. */
  verticalFromMd?: boolean;
}) {
  const [value, setValue] = React.useState(defaultValue);
  const [orientation, setOrientation] = React.useState<"horizontal" | "vertical">("horizontal");
  React.useEffect(() => {
    if (!verticalFromMd) return;
    const mq = window.matchMedia("(min-width: 48rem)");
    const apply = () => setOrientation(mq.matches ? "vertical" : "horizontal");
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [verticalFromMd]);
  const pillId = `${React.useId()}-pill`;
  const ctx = React.useMemo(() => ({ value, pillId }), [value, pillId]);
  return (
    <LazyMotion features={loadMax} strict>
      <TabsCtx.Provider value={ctx}>
        <Tabs value={value} onValueChange={setValue} orientation={orientation} className={cn(verticalFromMd && "animated-tabs-split", className)}>
          {children}
        </Tabs>
      </TabsCtx.Provider>
    </LazyMotion>
  );
}

export type AnimatedTabsVariant = "default" | "segmented";

export function AnimatedTabsList({
  label,
  className,
  children,
  variant = "default",
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
  /** "segmented": full-width, evenly split control with two-line triggers (used by /demo). Default is unchanged. */
  variant?: AnimatedTabsVariant;
}) {
  return (
    <TabsList
      aria-label={label}
      className={cn("animated-tabs-list h-auto group-data-[orientation=horizontal]/tabs:h-auto flex-wrap", variant === "segmented" && "animated-tabs-seg", className)}
    >
      {children}
    </TabsList>
  );
}

export function AnimatedTabsTrigger({
  value,
  children,
  variant = "default",
}: {
  value: string;
  children: React.ReactNode;
  variant?: AnimatedTabsVariant;
}) {
  const ctx = React.useContext(TabsCtx);
  const reduce = useReducedMotion();
  // After-mount gate (ADR-129): useReducedMotion() is null on the server and true on the first client render, so it
  // may only affect markup/props once hydration is done.
  const ready = React.useSyncExternalStore(subscribeNever, () => true, () => false);
  const active = ctx?.value === value;
  return (
    <TabsTrigger
      value={value}
      className={cn(
        "data-active:bg-transparent dark:data-active:bg-transparent group-data-[variant=default]/tabs-list:data-active:shadow-none",
        variant === "segmented" ? "animated-tabs-seg-trigger" : "h-9 px-3",
      )}
    >
      {active && ctx ? (
        <m.span
          aria-hidden="true"
          layoutId={ctx.pillId}
          className="animated-tabs-pill"
          transition={ready && reduce ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 34 }}
        />
      ) : null}
      <span className={cn("relative z-10", variant === "segmented" && "tab-body")}>{children}</span>
    </TabsTrigger>
  );
}

export function AnimatedTabsPanels({ children }: { children: React.ReactNode }) {
  return <div className="animated-tabs-stack">{children}</div>;
}

export function AnimatedTabsContent({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: React.ReactNode;
}) {
  const ctx = React.useContext(TabsCtx);
  const inactive = ctx ? ctx.value !== value : false;
  return (
    <TabsContent value={value} forceMount inert={inactive} className={cn("animated-tabs-panel", className)}>
      {children}
    </TabsContent>
  );
}
