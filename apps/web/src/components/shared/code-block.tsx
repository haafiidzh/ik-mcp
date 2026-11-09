import { highlight, type CodeLang } from "@/lib/highlight";
import { CopyButton } from "./copy-button";

type Props = {
  code: string;
  lang?: CodeLang;
  /** Short label shown above the code, also used as the accessible name. */
  label: string;
  /** Hide the copy button for output that is not meant to be pasted. */
  noCopy?: boolean;
};

export async function CodeBlock({ code, lang = "bash", label, noCopy = false }: Props) {
  const html = await highlight(code, lang);
  return (
    <figure className="my-4 overflow-hidden rounded-lg border bg-muted">
      <figcaption className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
        <span>{label}</span>
        {noCopy ? null : <CopyButton text={code} what={label} />}
      </figcaption>
      <div
        role="group"
        aria-label={label}
        className="p-3 font-mono text-sm leading-relaxed [&_pre]:m-0 [&_pre]:overflow-x-auto [&_pre]:bg-transparent"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </figure>
  );
}
