/** Defaults for the config module (doc 03 §2, §5). Pure data, no I/O. */

export const DEFAULT_SERVER_NAME = "devworkspace-mcp";

export const DEFAULT_IGNORE_DIRS: readonly string[] = ["node_modules", ".git", "dist", "vendor"];

// Default limits live in src/core/limits.ts (single source of truth).

export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
export const DEFAULT_API_TIMEOUT_MS = 15000;
export const DEFAULT_API_MAX_RESPONSE_BYTES = 200000;
