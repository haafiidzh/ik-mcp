import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRedactor, type Redactor } from "./redact.js";
import type { ErrorCode } from "./errors.js";

/** Metadata-only JSONL audit (doc 05 section 6, D14). No arguments, SQL text or contents. */
export interface AuditEntry {
  tool: string;
  integration: string;
  resourceRef?: string;
  outcome: "success" | "error" | "denied";
  errorCode?: ErrorCode;
  durationMs: number;
  write: boolean;
}

export interface AuditLog {
  record(entry: AuditEntry): void;
}

export interface AuditOptions {
  /** Absolute path of the JSONL file; undefined disables auditing. */
  path?: string;
  redactor?: Redactor;
  now?: () => Date;
  /** Called on write failure (e.g. logger.warn); auditing must never crash a tool call. */
  onError?: (message: string) => void;
}

export function createAuditLog(options: AuditOptions = {}): AuditLog {
  const redactor = options.redactor ?? createRedactor();
  const now = options.now ?? (() => new Date());
  let dirReady = false;

  return {
    record(entry) {
      if (!options.path) return;
      // Explicit field copy: nothing beyond the metadata schema is ever persisted.
      const line = redactor.redactValue({
        ts: now().toISOString(),
        tool: entry.tool,
        integration: entry.integration,
        resourceRef: entry.resourceRef ?? null,
        outcome: entry.outcome,
        errorCode: entry.errorCode ?? null,
        durationMs: entry.durationMs,
        write: entry.write,
      });
      try {
        if (!dirReady) {
          mkdirSync(dirname(options.path), { recursive: true });
          dirReady = true;
        }
        appendFileSync(options.path, JSON.stringify(line) + "\n", { encoding: "utf8", mode: 0o600 });
      } catch {
        options.onError?.("audit write failed");
      }
    },
  };
}
