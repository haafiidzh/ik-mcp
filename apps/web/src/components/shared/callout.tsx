import { AlertTriangle, Info } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Callout({
  title,
  tone = "info",
  children,
}: {
  title: string;
  tone?: "info" | "warn";
  children: ReactNode;
}) {
  const Icon = tone === "warn" ? AlertTriangle : Info;
  return (
    <aside
      aria-label={title}
      className={cn(
        "my-6 flex gap-3 rounded-lg border p-4 text-sm",
        tone === "warn" ? "border-warn/50 bg-warn/5" : "bg-card",
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", tone === "warn" ? "text-warn" : "text-primary")} aria-hidden={true} />
      <div className="space-y-1">
        <p className="font-semibold">{title}</p>
        <div className="text-muted-foreground [&_a]:text-primary [&_a]:underline [&_code]:font-mono [&_code]:text-foreground">
          {children}
        </div>
      </div>
    </aside>
  );
}
