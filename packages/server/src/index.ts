import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig, ConfigError } from "./config/load-config.js";
import { createAuditLog } from "./core/audit.js";
import { resolveLimits } from "./core/limits.js";
import { createLogger } from "./core/logger.js";
import { collectSecretValues, createRedactor } from "./core/redact.js";
import { createServer } from "./server/create-server.js";

/** stdout is reserved for MCP JSON-RPC; everything here logs to stderr. */
async function main(): Promise<void> {
  const loaded = loadConfig();
  const { config } = loaded;

  const secretEnvNames: string[] = [];
  if (config.github.tokenEnv) secretEnvNames.push(config.github.tokenEnv);
  for (const db of config.databases) {
    if (db.type === "postgres") {
      if (db.connectionStringEnv) secretEnvNames.push(db.connectionStringEnv);
      if (db.passwordEnv) secretEnvNames.push(db.passwordEnv);
    }
  }
  for (const api of config.customApis) {
    if (api.auth.type === "bearer") secretEnvNames.push(api.auth.tokenEnv);
    if (api.auth.type === "header") secretEnvNames.push(api.auth.valueEnv);
  }
  const redactor = createRedactor({
    secretValues: collectSecretValues(secretEnvNames),
    sensitiveFields: config.customApis.flatMap((a) => a.sensitiveFields),
  });
  const logger = createLogger({ level: config.server.logLevel, redactor });
  const audit = createAuditLog({
    ...(config.server.auditLogPath !== undefined ? { path: config.server.auditLogPath } : {}),
    redactor,
    onError: (m) => logger.warn(m),
  });
  const limits = resolveLimits(config.limits);
  const startedAtMs = Date.now();

  const handle = serveStdio(() => createServer({ config, limits, logger, audit, redactor, startedAtMs }), {
    onerror: (e) => logger.error("transport error", { error: e.message }),
  });
  logger.info("devworkspace-mcp ready on stdio");

  let closing = false;
  const shutdown = (reason: string): void => {
    if (closing) return;
    closing = true;
    logger.info("shutting down", { reason });
    handle.close().then(
      () => process.exit(0),
      () => process.exit(0),
    );
    // Safety net if close hangs.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.stdin.once("end", () => shutdown("stdin closed"));
  process.stdin.once("close", () => shutdown("stdin closed"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  const msg =
    err instanceof ConfigError
      ? err.message
      : `startup failed: ${err instanceof Error ? err.message : "unknown error"}`;
  process.stderr.write(`devworkspace-mcp: ${msg}\n`);
  process.exit(1);
});
