// STATIC SAMPLE DATA. Five refusals taken from the server's own security tests. Codes and messages are copied
// from the code under test (packages/server/src/integrations/...), not invented. Names ("acme-shop", "sample-sqlite",
// "acme-billing", "internal-profile") are fictional. Nothing here was produced by a live run, and nothing here is a
// pass count or a rate.

export type GuardStep = "schema" | "target" | "guard";
export const GUARD_STEPS: readonly { id: GuardStep; label: string }[] = [
  { id: "schema", label: "Schema" },
  { id: "target", label: "Target in config" },
  { id: "guard", label: "Pack guard" },
];

export type GuardCase = {
  id: string;
  pack: "Filesystem" | "Database" | "Custom API";
  title: string;
  /** Plain words: what the "attacker" asks for. */
  attackLabel: string;
  tool: string;
  args: string;
  /** The first check that refuses; later checks are never reached (fail closed). */
  stoppedAt: GuardStep;
  code: "INVALID_INPUT" | "PERMISSION_DENIED" | "QUERY_REJECTED";
  message: string;
  retryable: boolean;
  why: string;
  /** "<file under packages/server/test/security> :: <describe name>" */
  testRef: string;
  /** Where the message comes from (source file under packages/server/src). */
  sourceRef: string;
};

export const GUARD_CASES: readonly GuardCase[] = [
  {
    id: "traversal",
    pack: "Filesystem",
    title: "Path traversal",
    attackLabel: "Read a file outside the workspace by climbing out with ..",
    tool: "fs_read_file",
    args: `{ "workspace": "acme-shop", "path": "../outside/notes.txt" }`,
    stoppedAt: "guard",
    code: "INVALID_INPUT",
    message: "Parent directory segments are not allowed.",
    retryable: false,
    why: "A path is parsed before anything touches the disk, and a .. segment is refused outright.",
    testRef: "filesystem-guard.test.ts :: S1 traversal",
    sourceRef: "integrations/filesystem/path-guard.ts",
  },
  {
    id: "blocked-file",
    pack: "Filesystem",
    title: "Secret file",
    attackLabel: "Read the .env file in the workspace",
    tool: "fs_read_file",
    args: `{ "workspace": "acme-shop", "path": ".env" }`,
    stoppedAt: "guard",
    code: "PERMISSION_DENIED",
    message: "Path is blocked by the sensitive-file policy.",
    retryable: false,
    why: "Names such as .env and private keys are blocked, so the file is never opened and no content is returned.",
    testRef: "filesystem-guard.test.ts :: S5 blocked names",
    sourceRef: "integrations/filesystem/path-guard.ts",
  },
  {
    id: "sql-write",
    pack: "Database",
    title: "Stacked statement",
    attackLabel: "Add a second statement that drops a table",
    tool: "db_execute_readonly_query",
    args: `{ "connection": "sample-sqlite", "sql": "SELECT 1; DROP TABLE customers" }`,
    stoppedAt: "guard",
    code: "QUERY_REJECTED",
    message: "Query rejected: multiple statements are not allowed. Only a single read-only SELECT statement is allowed.",
    retryable: false,
    why: "The SQL guard accepts one read-only SELECT and nothing else, before the database sees the text.",
    testRef: "db-tools-qa.test.ts :: QA-03 db tools on dist/index.js",
    sourceRef: "integrations/database/sql-guard.ts",
  },
  {
    id: "url-as-argument",
    pack: "Custom API",
    title: "URL instead of a name",
    attackLabel: "Pass a web address where an endpoint name belongs",
    tool: "api_call_endpoint",
    args: `{ "profile": "acme-billing", "endpoint": "http://169.254.169.254/x" }`,
    stoppedAt: "target",
    code: "INVALID_INPUT",
    message: "URLs are not accepted; use a configured profile and endpoint name.",
    retryable: false,
    why: "Only names from your config select a target. The message does not repeat the address that was sent.",
    testRef: "url-guard.test.ts :: S11 unconfigured profile / endpoint / arbitrary URL",
    sourceRef: "integrations/custom-api/url-guard.ts",
  },
  {
    id: "private-address",
    pack: "Custom API",
    title: "Host behind a private address",
    attackLabel: "Use a profile whose host name resolves to a private network address",
    tool: "api_call_endpoint",
    args: `{ "profile": "internal-profile", "endpoint": "get-status" }`,
    stoppedAt: "guard",
    code: "PERMISSION_DENIED",
    message: "The API host resolves to a blocked network address.",
    retryable: false,
    why: "The host is resolved and every answer is checked first; private, loopback and metadata ranges are refused unless the profile allows a private network.",
    testRef: "url-guard.test.ts :: S13 SSRF",
    sourceRef: "integrations/custom-api/url-guard.ts",
  },
];

/** The error envelope as the server returns it (same shape as data/demo.ts). */
export function guardEnvelope(c: GuardCase): string {
  return `{
  "success": false,
  "error": {
    "code": "${c.code}",
    "message": ${JSON.stringify(c.message)},
    "retryable": ${c.retryable},
    "retryAfterSeconds": null
  }
}`;
}

/** The one sentence announced after a replay. */
export function guardAnnouncement(c: GuardCase): string {
  return `Refused with ${c.code}: ${c.message} Nothing ran.`;
}
