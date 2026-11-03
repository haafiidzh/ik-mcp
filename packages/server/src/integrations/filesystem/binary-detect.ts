import { AppError } from "../../core/errors.js";

/** Doc 05 section 2 step 6: inspect the first 8 KB. Not configurable in doc 03 section 5. */
export const BINARY_SNIFF_BYTES = 8192;
/** Share of control bytes (outside \t \n \r \f \b ESC) above which a buffer is treated as binary. */
const NON_TEXT_RATIO = 0.3;

export interface BinaryVerdict {
  binary: boolean;
  reason: "nul-byte" | "non-text-ratio" | null;
  sniffedBytes: number;
}

/** NUL byte or high control-byte ratio in the first `sniffBytes`. Bytes >= 0x80 are not counted (UTF-8 text). */
export function sniffBinary(buf: Uint8Array, sniffBytes: number = BINARY_SNIFF_BYTES): BinaryVerdict {
  const n = Math.min(buf.length, Math.max(0, sniffBytes));
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i] as number;
    if (b === 0) return { binary: true, reason: "nul-byte", sniffedBytes: n };
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x08 && b !== 0x1b) control++;
    else if (b === 0x7f) control++;
  }
  if (n > 0 && control / n > NON_TEXT_RATIO) return { binary: true, reason: "non-text-ratio", sniffedBytes: n };
  return { binary: false, reason: null, sniffedBytes: n };
}

/** Throws UNSUPPORTED (with no path in the message) when the sniffed bytes look binary. */
export function assertText(buf: Uint8Array, sniffBytes: number = BINARY_SNIFF_BYTES): void {
  const v = sniffBinary(buf, sniffBytes);
  if (v.binary) throw new AppError("UNSUPPORTED", `Binary file not supported (${v.reason ?? "binary"}).`);
}

export interface SizeVerdict {
  size: number;
  limit: number;
  exceeds: boolean;
  /** Bytes the caller may read: min(size, limit). Doc 05 S7: oversize files are truncated with meta, not rejected. */
  readBytes: number;
}

export function checkFileSize(size: number, maxFileBytes: number): SizeVerdict {
  const limit = Math.max(0, Math.floor(maxFileBytes));
  return { size, limit, exceeds: size > limit, readBytes: Math.min(size, limit) };
}

/** Strict variant for callers that must not truncate: throws LIMIT_EXCEEDED. */
export function assertWithinSize(size: number, maxFileBytes: number): void {
  if (size > maxFileBytes) throw new AppError("LIMIT_EXCEEDED", `File exceeds the ${maxFileBytes} byte limit.`);
}
