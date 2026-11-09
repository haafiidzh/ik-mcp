import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-24 sm:px-6">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 className="mt-2 text-3xl font-semibold">That page does not exist</h1>
      <p className="mt-4 text-muted-foreground">
        The page may have moved, or the link is wrong. Start from one of these instead.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Button asChild className="h-10 px-4"><Link href="/install">Install</Link></Button>
        <Button asChild variant="outline" className="h-10 px-4"><Link href="/tools">Tools reference</Link></Button>
        <Button asChild variant="outline" className="h-10 px-4"><Link href="/">Home</Link></Button>
      </div>
    </div>
  );
}
