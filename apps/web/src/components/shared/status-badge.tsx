import { AlertTriangle, CheckCircle2, CircleDashed, Clock, Lock, ShieldCheck, XCircle } from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "@/lib/utils";

const KINDS = {
  "read-only": { label: "Read-only", Icon: ShieldCheck, cls: "text-safe border-safe/40" },
  writes: { label: "Writes (off by default)", Icon: AlertTriangle, cls: "text-warn border-warn/40" },
  "not-shipped": { label: "Not shipped", Icon: Lock, cls: "text-warn border-warn/40" },
  implemented: { label: "Implemented", Icon: CheckCircle2, cls: "text-safe border-safe/40" },
  "in-development": { label: "In development", Icon: Clock, cls: "text-muted-foreground border-border" },
  verified: { label: "Verified", Icon: CheckCircle2, cls: "text-safe border-safe/40" },
  "not-verified": { label: "Not yet verified", Icon: CircleDashed, cls: "text-muted-foreground border-border" },
  rejected: { label: "Rejected", Icon: XCircle, cls: "text-danger border-danger/40" },
  sample: { label: "Sample data", Icon: CircleDashed, cls: "text-muted-foreground border-border" },
} satisfies Record<string, { label: string; Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>; cls: string }>;

export type StatusKind = keyof typeof KINDS;

/** Status is always icon + text, never color alone. */
export function StatusBadge({ kind, label, className }: { kind: StatusKind; label?: string; className?: string }) {
  const { label: defaultLabel, Icon, cls } = KINDS[kind];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium", cls, className)}>
      <Icon className="size-3.5" aria-hidden={true} />
      {label ?? defaultLabel}
    </span>
  );
}
