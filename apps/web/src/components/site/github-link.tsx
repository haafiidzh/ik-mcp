"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { buttonVariants } from "@/components/ui/button";
import { REPO_URL } from "@/lib/site";
import { cn } from "@/lib/utils";

/** Tiny store: is the home hero GitHub button inside the viewport? Read by the header button. */
let heroVisible = true;
const listeners = new Set<() => void>();
function setHeroVisible(v: boolean) {
  if (heroVisible === v) return;
  heroVisible = v;
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** GitHub mark (lucide-react in this version ships no brand icons). */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" className={className}>
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.74.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.18 1.83 1.18 3.08 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

const LABEL = "GitHub repository (opens in a new tab)";

type Props = { className?: string; hidden?: boolean; size?: "hero" | "header"; observeHero?: boolean };

export function GithubLink({ className, hidden = false, size = "header", observeHero = false }: Props) {
  const ref = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (!observeHero) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    // The sticky header covers the top edge, so shrink the root by its height.
    const header = document.querySelector<HTMLElement>(".site-header");
    const top = header ? Math.round(header.getBoundingClientRect().height) : 0;
    const io = new IntersectionObserver((entries) => setHeroVisible(entries[entries.length - 1]?.isIntersecting ?? true), {
      rootMargin: `-${top}px 0px 0px 0px`,
    });
    io.observe(el);
    return () => {
      io.disconnect();
      setHeroVisible(false);
    };
  }, [observeHero]);

  return (
    <a
      ref={ref}
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={LABEL}
      title="GitHub"
      tabIndex={hidden ? -1 : undefined}
      aria-hidden={hidden ? true : undefined}
      // `inert` keeps the hidden copy out of focus and the accessibility tree.
      {...(hidden ? { inert: true } : {})}
      className={cn(
        buttonVariants({ variant: "outline" }),
        size === "hero" ? "h-11 gap-2 px-3 text-base md:px-5" : "h-8 px-2 md:px-3",
        className,
      )}
    >
      <GithubMark className={size === "hero" ? "size-5" : "size-4"} />
      <span className="hidden md:inline">GitHub</span>
    </a>
  );
}

/** Header copy: always shown off the home page; on `/` shown only once the hero button has left the viewport. */
export function HeaderGithubLink() {
  const pathname = usePathname();
  const hero = useSyncExternalStore(subscribe, () => heroVisible, () => true);
  const hidden = pathname === "/" && hero;
  return (
    <GithubLink
      hidden={hidden}
      className={cn(
        "motion-safe:transition-[opacity,transform] motion-safe:duration-200",
        hidden ? "invisible translate-y-1 opacity-0" : "visible translate-y-0 opacity-100",
      )}
    />
  );
}
