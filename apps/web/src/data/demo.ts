// STATIC SAMPLE DATA. Hand-written and fictional ("acme-shop"); nothing here was produced by a live run.
// The assistant text is authored, not generated. No tokens, keys or real paths.

export type DemoStep =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      tool: string;
      args: string;
      result: string;
      outcome: "ok" | "rejected";
      note?: string;
    };

export type DemoScenario = { id: string; title: string; summary: string; steps: DemoStep[] };

export const SCENARIOS: DemoScenario[] = [
  {
    id: "overview",
    title: "A. Project overview",
    summary: "Orient in an unfamiliar project using only read-only tools.",
    steps: [
      { kind: "user", text: "Give me a quick overview of the acme-shop workspace and its database." },
      {
        kind: "tool",
        tool: "fs_get_directory_tree",
        args: `{ "workspace": "acme-shop", "depth": 2 }`,
        outcome: "ok",
        result: `{
  "success": true,
  "data": {
    "name": ".", "type": "dir",
    "children": [
      { "name": "README.md", "type": "file" },
      { "name": "package.json", "type": "file" },
      { "name": "migrations", "type": "dir" },
      { "name": "src", "type": "dir" }
    ]
  },
  "meta": { "source": "filesystem", "returnedCount": 4, "truncated": false }
}`,
      },
      {
        kind: "tool",
        tool: "db_list_tables",
        args: `{ "connection": "sample-sqlite" }`,
        outcome: "ok",
        result: `{
  "success": true,
  "data": [
    { "schema": "main", "name": "customers", "kind": "table" },
    { "schema": "main", "name": "orders", "kind": "table" }
  ],
  "meta": { "source": "database", "returnedCount": 2, "truncated": false }
}`,
      },
      {
        kind: "tool",
        tool: "db_execute_readonly_query",
        args: `{ "connection": "sample-sqlite", "sql": "DELETE FROM orders" }`,
        outcome: "rejected",
        note: "Refusal step: the SQL guard rejects writes before anything runs.",
        result: `{
  "success": false,
  "error": { "code": "QUERY_REJECTED", "message": "Only read-only statements are allowed.",
             "retryable": false, "retryAfterSeconds": null }
}`,
      },
      {
        kind: "assistant",
        text: "Recorded sample narration: acme-shop is a small Node project with a src folder and migrations. The database has customers and orders tables. I tried a DELETE only to show the guard: it was refused, as designed. I did not check GitHub because that pack is not enabled in this sample.",
      },
    ],
  },
  {
    id: "issue",
    title: "B. Issue investigation",
    summary: "Read an issue, find related code, and stop at a plan. Nothing is modified.",
    steps: [
      { kind: "user", text: "Look at issue 12 in example-org/acme-shop and tell me where in the code it might come from. Do not change anything." },
      {
        kind: "tool",
        tool: "github_get_issue",
        args: `{ "owner": "example-org", "repo": "acme-shop", "number": 12 }`,
        outcome: "ok",
        result: `{
  "success": true,
  "data": {
    "number": 12, "state": "open",
    "title": "Checkout retries forever when payment times out",
    "labels": ["bug"], "comments": 2,
    "body": "After a timeout the checkout keeps retrying. See retryCount in checkout.ts."
  },
  "meta": { "source": "github", "returnedCount": 1, "truncated": false }
}`,
      },
      {
        kind: "tool",
        tool: "fs_search_content",
        args: `{ "workspace": "acme-shop", "query": "retryCount", "limit": 5 }`,
        outcome: "ok",
        result: `{
  "success": true,
  "data": [
    { "relPath": "src/orders/checkout.ts", "line": 42, "snippet": "if (retryCount > MAX_RETRIES) {" },
    { "relPath": "src/orders/checkout.test.ts", "line": 18, "snippet": "it('stops after MAX_RETRIES', () => {" }
  ],
  "meta": { "source": "filesystem", "returnedCount": 2, "truncated": false, "nextPageAvailable": false }
}`,
      },
      {
        kind: "tool",
        tool: "fs_read_file",
        args: `{ "workspace": "acme-shop", "path": ".env" }`,
        outcome: "rejected",
        note: "Refusal step: .env is a blocked name, so it is refused and never read.",
        result: `{
  "success": false,
  "error": { "code": "PERMISSION_DENIED", "message": "Access to this path is not allowed.",
             "retryable": false, "retryAfterSeconds": null }
}`,
      },
      {
        kind: "assistant",
        text: "Recorded sample narration. Confirmed: issue 12 mentions retryCount, and retryCount appears in src/orders/checkout.ts at line 42 with a test beside it. Inferred, not confirmed: the retry limit may not apply on the timeout path. I could not read .env (blocked), which is fine because I do not need it. Proposed next step: review checkout.ts around line 42 and add a test for the timeout case. Nothing was changed.",
      },
    ],
  },
];
