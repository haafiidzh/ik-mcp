# OPEN-QUESTIONS — P0-01 research (2026-11-03)

Research only. Every claim cites the page it came from. "UNVERIFIED" = not confirmed on an official page. Fetched 2026-11-03 via WebFetch (a small model summarises pages, so snippets marked "from docs" were copied/derived from the cited page; confirm against the source before relying on exact wording).

## 0. Headline finding (changes the plan)
The MCP TypeScript SDK is now **v2, split into new packages**. The old single package `@modelcontextprotocol/sdk` is the **v1.x maintenance line**. v2 implements MCP spec **2026-07-28** (modern era: no `initialize` handshake, per-request `_meta`, `server/discover`) and still serves the 2025-era `initialize` handshake. **Correction (P0-10):** the installed SDK 2.4.0 reports `LATEST_PROTOCOL_VERSION = "2025-11-25"` (legacy line; `SUPPORTED_PROTOCOL_VERSIONS` = 2025-11-25 ... 2024-10-07), verified in `node_modules/.pnpm/@modelcontextprotocol+server@2.4.0/node_modules/@modelcontextprotocol/core/dist/schemas-DscsoNZN.mjs` lines 4-6. The modern revision `2026-07-28` is listed separately (`SUPPORTED_MODERN_PROTOCOL_VERSIONS` in `server/dist/src-DdvbAHrR.mjs`) and is only negotiated through `server/discover`. `server_get_status` therefore reports `protocol.latest = 2025-11-25`. Doc 11 and the PRD name `@modelcontextprotocol/sdk`; the human must choose v2 (recommended) or v1. See Q-A in section 8.

**Implementation note (P0-05/P0-10):** the stdio entry uses the SDK's `serveStdio(factory)` (ADR-024). It handles both openings: `initialize` (2025-era) and `server/discover` (2026-07-28), the latter covered by a test in `packages/server/test/server/server.test.ts`.

## 1. SDK package, version, zod
| Item | Finding | Source |
|---|---|---|
| Repo `main` | v2 = "the stable release line", implements spec 2026-07-28. Packages `@modelcontextprotocol/server`, `@modelcontextprotocol/client`; optional `@modelcontextprotocol/node`, `express`, `fastify`, `hono` | https://github.com/modelcontextprotocol/typescript-sdk |
| v1 | `@modelcontextprotocol/sdk` lives on branch `v1.x`; gets bug/security fixes "for at least six months after the v2 release (2026-07-27)"; spec 2026-07-28 not planned for v1 | https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/README.md |
| v2 npm | `@modelcontextprotocol/server` dist-tag `latest` = **2.4.0** (published 2026-10-23); 2.0.0 on 2026-07-27 | https://registry.npmjs.org/@modelcontextprotocol/server |
| v2 deps | `zod ^4.2.0` as a regular **dependency** (not peer); `@modelcontextprotocol/core 2.4.0`; engines `node >=20`; exports `.`, `./stdio`, `./validators/ajv`, ... | https://registry.npmjs.org/@modelcontextprotocol/server/latest |
| v1 npm | `@modelcontextprotocol/sdk` `latest` = **1.32.2**; engines `node >=18`; peerDependency `zod ^3.25 \|\| ^4.0` (required) | https://registry.npmjs.org/@modelcontextprotocol/sdk (dist-tags), https://registry.npmjs.org/@modelcontextprotocol/sdk/1.32.2 |
| zod import | v2 docs import `import * as z from 'zod/v4'`; tool/prompt schemas use Standard Schema (zod v4, Valibot, ArkType) | https://github.com/modelcontextprotocol/typescript-sdk , https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/docs/servers/tools.md |
| v1 zod note | "SDK internally imports from `zod/v4`, but maintains backwards compatibility with projects using Zod v3.25 or later" | v1.x README (above) |

**Q1 resolved:** use `@modelcontextprotocol/server@2.4.0` + `zod@^4.2.0` (v2), or fallback `@modelcontextprotocol/sdk@1.32.2` + `zod ^3.25||^4`. Do not pin from memory; re-check `npm view` at install time. Recommendation: v2, because it is the documented stable line and matches the current spec; v1 is explicitly in maintenance. Both packages are the "official TS SDK" so doc 11 "Approved" is arguably satisfied, but the package name differs from doc 11 text -> human confirmation requested (Q-A).

## 2. Minimal stdio server
### v2 (from https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/docs/get-started/first-server.md)
Install: `npm install @modelcontextprotocol/server zod tsx` (package `"type": "module"`; Node >= 20).
```ts
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

function buildServer(): McpServer {
    const server = new McpServer({ name: 'weather', version: '1.0.0' });
    server.registerTool(
        'get-alerts',
        {
            description: 'List active US weather alerts for a state',
            inputSchema: z.object({ state: z.string().length(2) })
        },
        async ({ state }) => {
            // ...
            return { content: [{ type: 'text', text: 'No active alerts.' }] };
            // failure: return { content: [{ type: 'text', text: '...' }], isError: true };
        }
    );
    return server;
}

void serveStdio(buildServer);
console.error('weather MCP server running on stdio');
```
Notes: `serveStdio(factory)` owns the transport and calls the factory to build the server; its handle has `close()` (https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/docs/serving/stdio.md). In v2 `inputSchema` is a full `z.object(...)`.

### v1 fallback (derived from https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/docs/server.md; the fetch tool paraphrased it, so treat as UNVERIFIED verbatim)
```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const server = new McpServer({ name: 'x', version: '0.1.0' });
server.registerTool('add', { description: '...', inputSchema: { a: z.number() } /* raw shape */ }, async ({ a }) => ({ content: [...] }));
await server.connect(new StdioServerTransport());
```
Difference: v1 uses a raw zod shape for `inputSchema`/`outputSchema`/`argsSchema`; v2 uses `z.object(...)`.

## 3. structuredContent / outputSchema
- Spec 2026-07-28: `structuredContent` may be any JSON value; "a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block"; if `outputSchema` is given, "Servers MUST provide structured results that conform", clients SHOULD validate. https://modelcontextprotocol.io/specification/latest/server/tools
- Errors: protocol errors (unknown tool, malformed) are JSON-RPC errors; tool execution errors (API failures, input validation, business logic) use result `isError: true` (same page).
- v2 SDK (https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/docs/servers/tools.md): `registerTool(name, { description, inputSchema: z.object(..), outputSchema: z.object(..) }, handler)`; handler returns `{ content: [{type:'text', text: JSON.stringify(output)}], structuredContent: output }`. "The SDK validates `structuredContent` against `outputSchema` before the result leaves the server, and it advertises the derived JSON Schema in `tools/list`." Argument validation failures return a normal result with `isError: true` and the handler never runs. Annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) supported via `annotations`.
- **D12 resolved:** supported in both lines. Mapping: success = `structuredContent` + JSON text content; failure = `isError: true` with text. CAVEAT: with `outputSchema` set, an `isError` result has no `structuredContent`; whether the SDK skips output validation for `isError` results is UNVERIFIED (the docs page did not show returning `isError` from a handler together with outputSchema). Test in P0. The docs example *throws* for not-found (see tools.md); how thrown errors are mapped is in docs/servers/errors.md (not read).

## 4. Resources and prompts (Phase 6 reference)
- Resource (v2, https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/docs/servers/resources.md, paraphrased by fetch tool): `server.registerResource(name, 'config://app', { title, description, mimeType }, async uri => ({ contents: [{ uri: uri.href, text }] }))`. Templates: `new ResourceTemplate('users://{userId}/profile', { list: undefined })` ("`list` is a required key - pass `undefined` when instances are unbounded"); matched variables arrive as 2nd callback arg. Registration auto-sends `notifications/resources/list_changed`. On 2026-07-28 connections clients use `subscriptions/listen` instead of `resources/subscribe`.
- Prompt (v2, https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/docs/servers/prompts.md): `server.registerPrompt(name, config, callback)`, callback returns `{ messages }`; example `review-code` with a `code` string argument; `completable()` for argument completion.
- v1 shapes (UNVERIFIED verbatim): `registerResource(name, uri, {title,description,mimeType}, async uri => ({contents:[{uri:uri.href,text}]}))`, `registerPrompt(name, {title,description,argsSchema:{...}}, args => ({messages:[{role:'user',content:{type:'text',text}}]}))`.
- Still to read before Phase 6: docs/servers/errors.md, docs/servers/logging-progress-cancellation.md.

## 5. stdio lifecycle, shutdown, stdout/stderr (spec 2026-07-28)
Source: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio
- Server reads JSON-RPC from stdin, writes to stdout; newline-delimited, messages "MUST NOT contain embedded newlines".
- "The server MUST NOT write anything to its stdout that is not a valid MCP message." Server MAY write UTF-8 logs to stderr; clients MAY capture/ignore it and SHOULD NOT treat it as errors.
- Server MUST NOT write JSON-RPC *requests* to stdout (server-to-client asks use `InputRequiredResult`).
- Shutdown: client closes server's stdin, waits, then SIGTERM -> SIGKILL (Windows: TerminateProcess / Job Objects). "Servers SHOULD exit promptly when their standard input is closed or reads return end-of-file. This is the primary graceful-shutdown signal and the only portable one."
- Unexpected exit: client SHOULD restart; in-flight requests are lost (stateless protocol).
- SDK: stdin close ends the connection without a signal handler; pending requests are dropped; clear timers/pools in `server.server.onclose` so the process can exit; SIGINT handler may call `handle.close()`; "stdout is the JSON-RPC channel"; use `console.error` for logs; a `console.log` puts a non-JSON line ahead of the `initialize` response and breaks parsing (https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/docs/serving/stdio.md).
- Project rules confirmed: own logger to stderr (D13); no `console.log` in `src/`; audit to file; on stdin EOF flush audit log, close DB handles, exit 0. SIGTERM handler: UNVERIFIED in docs, add it anyway (cheap, matches spec's escalation).
- Backward compat: a modern client probes `server/discover`; a v1-era client uses `initialize`. v2 SDK handles both (docs/serving/legacy-clients.md not read). Claude Code / Desktop versions' supported spec era: UNVERIFIED.

## 6. Host configuration
### Claude Code (https://code.claude.com/docs/en/mcp)
```bash
claude mcp add --transport stdio --env KEY=value devworkspace -- node /abs/path/project/packages/server/dist/index.js --config /abs/path/devworkspace.config.json
```
- `--` separates Claude's flags from the server command. `--env` takes multiple pairs; put another option (e.g. `--transport stdio`) between `--env` and the name.
- Scopes: `local` (default, `~/.claude.json`), `project` (`.mcp.json` in project root), `user` (`~/.claude.json`); `-s/--scope`.
- `.mcp.json`:
```json
{ "mcpServers": { "devworkspace": { "command": "node", "args": ["/abs/path/dist/index.js", "--config", "/abs/path/config.json"], "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } } } }
```
- `${VAR}` and `${VAR:-default}` expand in command/args/env/url/headers; unset var without default loads with a warning and the literal `${VAR}` text. Good for D4/Q8: secrets are referenced by name, not stored (NO SECRETS rule). `CLAUDE_PROJECT_DIR` is set for project/local stdio servers.
- Manage: `claude mcp list` (health), `claude mcp get <name>`, `claude mcp remove <name>`, `/mcp` in session. Project-scoped servers need user approval; `claude mcp reset-project-choices`.
- Not read (page truncated at 100k chars): any `type` field requirement in `.mcp.json` for stdio; managed-config details. UNVERIFIED.

### Claude Desktop (https://modelcontextprotocol.io/docs/develop/connect-local-servers)
- Config file: macOS `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows `%APPDATA%\Claude\claude_desktop_config.json`; Linux `~/.config/Claude/claude_desktop_config.json`. Open via Settings -> Developer -> Edit Config; fully quit and restart after edits.
- Format: `{"mcpServers": {"name": {"command": "npx", "args": [...], "env": {...}}}}`; paths in args must be absolute.
- Logs: macOS `~/Library/Logs/Claude`, Windows `%APPDATA%\Claude\logs`, Linux `~/.config/Claude/logs`; `mcp.log` and `mcp-server-<NAME>.log` (stderr of the server).
- Windows note from same page: if `${APPDATA}` errors appear, add expanded `APPDATA` to `env`.

### Windows host -> WSL (Q7 / Q2)
- **Q7 and Q8 ANSWERED (ADR-035):** the acceptance host is Claude Code running in WSL (native, no `wsl.exe` wrapper needed). Environment variables come only from the host's MCP `env` block; there is no `.env` auto-load by the server. A `--env-file` option is optional and documented only. The Windows-host (Claude Desktop) notes below stay as unverified reference.
- **No official Anthropic/MCP example found.** Only community guides (UNVERIFIED, not official): https://scottspence.com/posts/getting-mcp-server-working-with-claude-desktop-in-wsl , https://medium.com/@mads_bruun_hovgaard/making-claude-mcp-work-on-windows-without-admin-rights-using-wsl-2-a88f8ec4ffd1 . They use `command: "wsl.exe"` (or `wsl`) with `args` starting `-e`/`--exec`, optionally `bash -lc` so nvm is sourced.
- Official WSL doc (https://learn.microsoft.com/en-us/windows/wsl/basic-commands) confirms `wsl --distribution <name>` and `wsl --user`; the page text I got does not list `--exec/-e/--cd`; check `wsl --help` on the host. UNVERIFIED.
- Proposed config (NOT TESTED; Windows host unavailable here; docs must mark "not verified on Windows"):
```json
{ "mcpServers": { "devworkspace": {
  "command": "wsl.exe",
  "args": ["-d", "Ubuntu", "--exec", "bash", "-lc", "exec node /home/<user>/workspace-mcp/project/packages/server/dist/index.js --config /home/<user>/devworkspace.config.json"],
  "env": {} } } }
```
Caveats: login shell (`-l`) must print nothing to stdout (profile echo would corrupt the stream); env vars set in the Windows `env` block are not forwarded into WSL unless named in `WSLENV` (general WSL behaviour, UNVERIFIED here) - prefer secrets exported inside WSL or in a WSL-side file the server reads by env-var name; `allowedRoots` must be Linux paths.
- Claude Code in WSL needs none of this (runs natively).

## 7. MCP Inspector (https://modelcontextprotocol.io/docs/tools/inspector)
- Package `@modelcontextprotocol/inspector`; "requires **Node 22.19.0 or newer**" (installed 22.21.0 satisfies it). Three clients, one binary: web (default), `--cli`, `--tui`.
- Web: `npx @modelcontextprotocol/inspector node path/to/server/index.js` (prints URL with per-launch token; `MCP_AUTO_OPEN_ENABLED=false` stops auto-open). Browser needed (WSL2: open printed URL from Windows browser; localhost forwarding UNVERIFIED).
- CLI (scriptable, good for QA/CI): `npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list`; call: `--method tools/call --tool-name NAME --tool-arg key=value --format json`. Server args go after the command; mode flags only at the front.
- Passing server config args: `npx @modelcontextprotocol/inspector --cli node dist/index.js --config cfg.json --method tools/list` is plausible (everything after the first non-mode token is forwarded) but flag collision between inspector and server `--config` is UNVERIFIED; test in P0-05/QA-01 (scripted client and Inspector check). Also `--config` is an Inspector flag (config file) per the docs, so prefer `DEVWORKSPACE_CONFIG` env var for Inspector runs.
- Secrets: Inspector stores stdio `env:` values in OS keychain, or unencrypted `~/.mcp-inspector/secrets.json` on keychain-less Linux/WSL. Do not put real tokens in Inspector env fields; use throwaway/no tokens.
- Not a project dependency (doc 11).

## 8. Unresolved gaps and questions
- **Q-A (human, blocking P0-02):** SDK line. Recommend `@modelcontextprotocol/server` 2.x + `zod ^4.2` (+ `@modelcontextprotocol/server/stdio`). Fallback v1 `@modelcontextprotocol/sdk` 1.32.2. Update doc 11 / PRD §9.1 wording.
- **Q-B:** Node line. Doc 06 D3 says Node >= 22. The Node releases page (https://nodejs.org/en/about/previous-releases) lists v26, v24, v22 as LTS but gave EOL dates all in Oct 2026 (v22: Oct 20, 2026), which is already past and looks wrong/odd; Active vs Maintenance split not shown. UNVERIFIED; check https://github.com/nodejs/release#release-schedule. SDK v2 needs >= 20, Inspector >= 22.19, so `>=22.19` is a safe engines floor; consider `>=24` if 22 is EOL.
- Does the v2 SDK validate `outputSchema` for `isError` results (section 3)? Test in P0.
- Claude Code and Desktop versions supporting spec 2026-07-28 vs `initialize`-era: UNVERIFIED; v2 SDK documents legacy-client support (docs/serving/legacy-clients.md, not read). Verify by connecting a real host (human, H-task).
- Whether `.mcp.json` stdio entries need `"type": "stdio"`: UNVERIFIED.
- Official WSL example for Claude Desktop: none found.
- v1 verbatim API snippets (registerResource/registerPrompt) UNVERIFIED verbatim.
- Impact on tests: MCP client for QA scripted tests: `@modelcontextprotocol/client` (v2) is NOT in doc 11 Approved; Inspector CLI (not a dependency) can serve instead. Propose to human if a programmatic client is wanted.

## 9. Database pack: SQLite query timeout (P2-02, 2026-11-03)
- better-sqlite3 13.0.3 exposes no `sqlite3_interrupt` or `sqlite3_progress_handler` (verified: no such symbol in `lib/` or the native sources except the `SQLITE_INTERRUPT` error code). A running `sqlite3_step` therefore cannot be cancelled in-process, and it blocks the Node event loop. The adapter enforces `dbQueryTimeoutMs` cooperatively (between rows and at statement end; see implementation-notes "P2-02"). Doc 05 S9 expects `TIMEOUT` for "slow query (recursive CTE)": met for row-streaming queries and reported after the fact for single long steps, but not preempted.
- Question for the human/PM: accept this for the MVP (local, read-only, single user) or schedule hard preemption (child-process executor that is killed on timeout, or a native build with a progress handler; both are outside the approved dependency list or sizeable). Official docs to check if pursued: https://sqlite.org/c3ref/interrupt.html, https://sqlite.org/c3ref/progress_handler.html.
- `ATTACH` is not refused by the read-only connection itself in SQLite (the attached file inherits read-only); the adapter's reader/readonly gate and sql-guard are what stop it (tested).

## 10. Database pack: pg `queryMode` option (P2-03, 2026-11-03)
- node-postgres 8.23.1 honours `queryMode: "extended"` on a query config (`lib/query.js`), but the docs list it under client config as "TODO: document" (https://node-postgres.com/apis/client) and `@types/pg` does not declare it per query. The adapter relies primarily on a non-empty `values` array (documented: parameterized queries use the extended protocol) and passes `queryMode` as an extra. If a future pg release drops the option nothing breaks; the Docker test "a chained COMMIT; INSERT ... is refused" would catch a regression of the single-statement guarantee.
- The P2-01 `DatabaseAdapter` interface has no way to return a catalog truncation flag or `cellsTruncated`; P2-03 exposes them as additive members (`listTablesPage`, `listRelationshipsPage`, `PostgresQueryResult.cellsTruncated`). P2-04 should decide whether to fold them into the interface (needed for `meta.truncated`).
