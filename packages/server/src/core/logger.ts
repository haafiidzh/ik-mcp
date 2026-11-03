import { createRedactor, type Redactor } from "./redact.js";

/** JSON-lines logger writing to stderr ONLY (stdout is reserved for MCP JSON-RPC). D13. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  redactor?: Redactor;
  /** Injectable sink for tests; defaults to process.stderr. */
  write?: (line: string) => void;
  now?: () => Date;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const min = ORDER[options.level ?? "info"];
  const redactor = options.redactor ?? createRedactor();
  const write = options.write ?? ((line: string) => void process.stderr.write(line));
  const now = options.now ?? (() => new Date());

  function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < min) return;
    const entry = redactor.redactValue({ ts: now().toISOString(), level, msg, ...fields });
    write(JSON.stringify(entry) + "\n");
  }

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
