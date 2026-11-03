/**
 * Escaping of names/paths returned to the host (B3). Pure.
 * Control characters (C0, DEL, C1), bidi controls and zero-width/format characters are replaced by
 * a visible `\\u{XX}` text form; a literal backslash is escaped too so the output is unambiguous.
 * Guards always run on the RAW name before escaping, and the escaped form can never be used as
 * input: parseRelativePath rejects backslashes, so an escaped name cannot reach a file.
 */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\\]/g;

export function escapeName(name: string): string {
  return name.replace(UNSAFE, (c) => `\\u{${c.codePointAt(0)?.toString(16).toUpperCase() ?? "0"}}`);
}

/** Escape each segment of a `/`-joined relative path (separators stay). */
export function escapeSegments(segments: readonly string[]): string {
  return segments.map(escapeName).join("/");
}
