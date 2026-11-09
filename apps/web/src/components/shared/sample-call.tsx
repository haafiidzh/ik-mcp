import { CodeBlock } from "./code-block";

const CALL = `fs_search_content
{ "workspace": "acme-shop", "query": "retryCount", "limit": 3 }`;

const RESULT = `{
  "success": true,
  "data": [
    { "relPath": "src/orders/checkout.ts", "line": 42,
      "snippet": "if (retryCount > MAX_RETRIES) {" }
  ],
  "meta": { "source": "filesystem", "returnedCount": 1,
            "truncated": false, "nextPageAvailable": false },
  "warnings": []
}`;

/** Static, hard-coded sample. Nothing here is read from a real workspace. */
export async function SampleCall() {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">Sample data, not a live call</p>
      <CodeBlock code={CALL} lang="text" label="Sample tool call" noCopy />
      <CodeBlock code={RESULT} lang="json" label="Sample structured result" noCopy />
    </div>
  );
}
