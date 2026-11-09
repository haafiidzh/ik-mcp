import { cn } from "@/lib/utils";

/** Geometric eye. Uses currentColor so it follows the theme. Decorative unless `title` is set. */
export function EyeMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("size-7", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path
        d="M2 16C6 9.5 11 6.5 16 6.5S26 9.5 30 16c-4 6.5-9 9.5-14 9.5S6 22.5 2 16Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="16" r="5.2" fill="currentColor" />
      <circle cx="17.9" cy="14.1" r="1.7" fill="var(--background)" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <EyeMark className="text-primary" />
      <span className="text-xl leading-none">ik</span>
    </span>
  );
}
