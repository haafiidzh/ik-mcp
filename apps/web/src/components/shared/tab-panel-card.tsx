import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** Designed card for a tab panel: header (icon, title, trailing badge) and icon rows. Same look as "Guards per pack". */
export function TabPanelCard({
  Icon,
  title,
  badge,
  rows,
}: {
  Icon: LucideIcon;
  title: string;
  badge: ReactNode;
  rows: { Icon: LucideIcon; text: ReactNode }[];
}) {
  return (
    <div className="rounded-xl border bg-card p-4 text-card-foreground sm:p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b pb-3">
        <span className="inline-flex size-9 items-center justify-center rounded-lg bg-muted text-foreground" aria-hidden="true">
          <Icon className="size-5" />
        </span>
        <h3 className="text-lg font-semibold">{title}</h3>
        {badge}
      </div>
      <ul className="mt-3 space-y-2.5 text-sm leading-relaxed sm:text-base">
        {rows.map((r, i) => (
          <li key={i} className="flex items-start gap-2.5">
            <r.Icon className="mt-[0.3em] size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0">{r.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
