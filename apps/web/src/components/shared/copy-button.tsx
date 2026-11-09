"use client";

import { Check, Copy } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";

const subscribe = () => () => {};

export function CopyButton({ text, what }: { text: string; what: string }) {
  // Hidden until hydrated: without JS a copy button would do nothing.
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  if (!mounted) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2500);
  }

  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={copy} aria-label={`Copy ${what}`} data-copy-state={state} className="h-7 gap-1.5">
        {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        <span>{state === "copied" ? "Copied" : "Copy"}</span>
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {state === "copied" ? `${what} copied` : state === "failed" ? "Copy failed, select the text and copy manually" : ""}
      </span>
      {state === "failed" ? (
        <span className="text-xs text-danger">Copy failed, select and copy manually</span>
      ) : null}
    </>
  );
}
