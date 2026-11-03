import { describe, expect, it } from "vitest";
import { parseConfigText } from "../../src/config/load-config.js";
import { createAuditLog } from "../../src/core/audit.js";
import { DEFAULT_LIMITS } from "../../src/core/limits.js";
import { createLogger } from "../../src/core/logger.js";
import { createRedactor } from "../../src/core/redact.js";
import { ok } from "../../src/core/response.js";
import { runTool, type ServerDeps } from "../../src/server/register-tools.js";
import { buildStatus } from "../../src/server/status.js";

function deps(maxResponseBytes: number): ServerDeps {
  const config = parseConfigText("{}");
  return {
    config,
    limits: { ...DEFAULT_LIMITS, maxResponseBytes },
    logger: createLogger({ level: "error" }),
    audit: createAuditLog(),
    redactor: createRedactor(),
    startedAtMs: Date.now(),
  };
}

const wire = (r: unknown): number => Buffer.byteLength(JSON.stringify(r), "utf8");
const run = (d: ServerDeps) =>
  runTool(d, "server_get_status", "server", () =>
    ok(buildStatus({ config: d.config, limits: d.limits, startedAtMs: d.startedAtMs }), { source: "server" }),
  );

describe("runTool honours a tightened maxResponseBytes for non-fs tools (P1-10)", () => {
  it("passes through under a generous budget", async () => {
    const r = await run(deps(DEFAULT_LIMITS.maxResponseBytes));
    expect(r.isError).toBeUndefined();
  });

  it("returns a small LIMIT_EXCEEDED error that fits a tight budget", async () => {
    const full = wire(await run(deps(DEFAULT_LIMITS.maxResponseBytes)));
    const budget = Math.floor(full * 0.8);
    const r = await run(deps(budget));
    expect(r.isError).toBe(true);
    expect((r.structuredContent as { error: { code: string } }).error.code).toBe("LIMIT_EXCEEDED");
    expect(wire(r) + 512).toBeLessThanOrEqual(budget);
  });
});
