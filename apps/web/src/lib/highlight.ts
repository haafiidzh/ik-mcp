import { codeToHtml } from "shiki";

export type CodeLang = "bash" | "json" | "text" | "ts";

/** Build-time highlighting only (server components); nothing from shiki ships to the browser. */
export async function highlight(code: string, lang: CodeLang): Promise<string> {
  return codeToHtml(code, {
    lang,
    themes: { light: "github-light-high-contrast", dark: "github-dark-high-contrast" },
    defaultColor: false,
  });
}
