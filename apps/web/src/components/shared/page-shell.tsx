import type { ReactNode } from "react";

export function PageShell({ title, lead, children }: { title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-4xl px-4 py-12 sm:px-6 sm:py-16">
      <h1 className="text-3xl font-semibold sm:text-4xl">{title}</h1>
      {lead ? <p className="mt-4 max-w-[70ch] text-lg text-muted-foreground">{lead}</p> : null}
      <div className="mt-10">{children}</div>
    </div>
  );
}

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-h`} className="mt-12 scroll-mt-20 first:mt-0">
      <h2 id={`${id}-h`} className="text-2xl font-semibold">
        <a href={`#${id}-h`} className="hover:underline">{title}</a>
      </h2>
      <div className="mt-4 max-w-[75ch] space-y-4 leading-relaxed [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em]">
        {children}
      </div>
    </section>
  );
}
