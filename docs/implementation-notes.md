# Implementation notes (PRD 23.1, 23.3)

## Deviations from the PRD
- Monorepo layout: PRD 9.3 shows a single package. The repo is a pnpm workspace with the server in
  `packages/server` (name `devworkspace-mcp`) so a later web package can sit beside it. No `apps/web` yet.
- SDK line: the PRD names `@modelcontextprotocol/sdk` (v1 line, now maintenance). The human chose the
  v2 package `@modelcontextprotocol/server` (see `OPEN-QUESTIONS.md` section 1). v1 is not installed.
- Node floor: `engines.node >=22`. OPEN-QUESTIONS Q14/Q-B: Node 22 EOL dates were unverified; SDK v2 needs
  >=20, MCP Inspector needs >=22.19. Revisit if Node 22 is confirmed EOL.
- TypeScript is pinned to `^6` because `typescript-eslint` 8.72.1 rejects TypeScript 7 ("does not support
  TS 7.0"). Move to 7 when typescript-eslint supports it.
- `@types/node` is `^22` to match the Node floor, not the newest major.
- Test layout (ADR-021): tests live in `packages/server/test/<module>/` or colocated as `src/**/*.test.ts`,
  matching the `vitest.config.ts` include. Docs that say `tests/` (doc 07) mean `test/`.
- Stdio entry (ADR-024): uses SDK v2 `serveStdio(factory)` from `@modelcontextprotocol/server/stdio`
  (one `McpServer` per connection, built in `src/server/create-server.ts`) instead of hand-wiring a
  transport. It serves both the legacy `initialize` opening and the `server/discover` opening.
- Split limit names: the PRD/doc 03 single per-page and redirect limits are split per integration:
  `githubPerPage` / `githubPerPageMax` and `maxRedirectsCustomApi` / `maxRedirectsGithub`.
- Extra file `src/config/errors.ts` (`ConfigError` with `issues: [{path,message}]`), separate from the
  loader to avoid an import cycle. Not in the PRD 9.3 tree.
- Extra config rules added by P0-03 beyond doc 03 section 2 (all fail closed at load):
  1. Endpoint `method` must be listed in its profile's `allowedMethods`.
  2. Every workspace path must resolve (realpath, symlinks followed) inside an `allowedRoots` entry.
  3. Inline secrets are rejected: unknown keys such as `token`/`password` fail the strict schema, and
     `*Env` fields must be env var NAMES (values shaped like `ghp_`, `github_pat_`, `sk-` are rejected).
  4. `github.apiBaseUrl` is the literal `https://api.github.com` (no GitHub Enterprise); custom API
     `baseUrl` and path placeholders are validated, and duplicate names are rejected.
  Also: `readOnly` must be the literal `true`; `enabled` defaults to `false`; invalid JSON errors never
  echo file content.

## Dependencies (all free, open source)
Runtime (`packages/server`):
- `@modelcontextprotocol/server` 2.4.0 (Apache-2.0): official MCP SDK v2 server, stdio.
- `zod` 4.6.7 (MIT): validation at every boundary; required by the SDK (`^4.2.0`).

Dev:
- `typescript` 6.0.3 (Apache-2.0): compiler.
- `@types/node` 22.20.5 (MIT): Node typings.
- `vitest` 5.1.0 (MIT): tests.
- `eslint` 10.14.0 (MIT), `typescript-eslint` 8.72.1 (MIT): lint.
- `prettier` 3.9.10 (MIT): formatting.
- `tsx` 4.23.15 (MIT): dev runner only, never used by the host at runtime.

pnpm skipped the `esbuild` build script (not approved); vitest and tsx work without it.

## Filesystem pack assumptions (P0-11, P1-01, P1-02)
- Limit override rule: `limits` overrides may only tighten the defaults. For every limit, max = default,
  except `githubPerPage`, whose max is `githubPerPageMax` (100). Config rejects larger values and
  `filesystem.createFilesystemService` re-clamps defensively.
- P1-01: encoded sequences (`%2e`, `%2f`, `%5c`, `%00`) are rejected, not decoded. Blocked matching is
  case-insensitive on all platforms. The binary sniff window (8192 bytes) and 30% control-byte threshold
  are constants, not limits. Residual TOCTOU risk between realpath and open is mitigated (O_NOFOLLOW,
  dev/ino check, second realpath) but not eliminated.
- P1-02: the workspace root (not the outer `allowedRoots`) is the containment root for every call; config
  already requires it to sit inside an allowed root. Blocked and ignored entries are hidden (not marked)
  from list/search/tree. `ignoreDirs` affect enumeration and direct access to paths inside them
  (NOT_FOUND on list/info/read); they are not a security control. `allowedExtensions` hides non-matching
  files from list/search/tree and denies reads (PERMISSION_DENIED). Symlinks appear in list/tree as type
  `symlink` only when their target is inside the root and not blocked/ignored, and are never followed or
  searched. Oversize files are read up to `maxFileBytes` and flagged `truncated` (line ranges apply within
  that window; `totalLines` is null when truncated). Content search reads at most `maxFileBytes` per file,
  skips binary and unreadable files with a warning, and stops at `maxFilesScanned` or the search deadline
  (`workflowTimeoutMs`) with `partial: true`. Non-UTF-8 text is decoded with replacement and a warning.
  Audit logging is left to the tool layer (doc 02 call flow); the service does not import core/audit.
- P1-05: the committed sample-workspace fixture holds no .env, node_modules, dist or .git; fs-tools stdio tests create them (with a fake canary) in a temp copy at test time (commit rules).

## P1-03 deviations and assumptions (recorded in P1-07)
- No `outputSchema` on the fs_* tools: the SDK behaviour when `isError` is set together with an `outputSchema` is unverified, so results use `structuredContent` plus the JSON text item (doc 04 section 2) without a declared schema.
- Audit `resourceRef` for fs_* calls is the workspace id (or `unknown-workspace` for ids not in config), never a path or file name.
- The committed sample fixture (`test/fixtures/sample-workspace`) holds no `.git`, `.env`, `node_modules` or `dist`; tests build those in temp copies. `.env.example` is committed (allowed by design).
- The example config points at the sample fixture.

## P1-08 hardening of the filesystem pack (QA-02 backlog B1-B4)
- B1 hard links: a regular file with `nlink > 1` is refused. `PathGuard.resolve` denies it (PERMISSION_DENIED, message "File has multiple hard links and is refused by policy.", no paths) and `openFile` re-checks `nlink` on the opened handle. list/search/tree hide such files (ADR-032: hidden, not marked). Deliberate over-blocking: legitimate hard-linked files inside the root are refused too, because realpath cannot tell an outside alias from an in-root one. Directories are not affected.
- B2 backup/editor variants: every blocked pattern (built-in and `blockedNames`) also matches a segment after repeatedly stripping trailing `~`, `#name#` wrappers, and the suffixes `.bak .backup .orig .old .save .swp .swo .swx .tmp .temp .copy .rej` (vim `.name.swp` also tries the name without the leading dot). Matching stays case-insensitive. `.env.example` stays allowed; `.env.example~` and `.env.example.bak` are blocked (stricter). A trailing `~` alone does not block names whose stripped form is not blocked (`notes~` is allowed). `unblock` entries exempt the stripped name only when the raw name does not itself match a pattern.
- B3 control characters: names and relative paths returned by list, info, search and tree are escaped (`escapeName`): C0, DEL, C1, soft hyphen, ALM, Mongolian vowel separator, zero-width and bidi format characters, line/paragraph separators, invisible operators, BOM, interlinear annotation characters become `\u{HEX}` text, and a literal backslash becomes `\u{5C}` so the output is unambiguous. Guards run on the raw names before escaping. The escaped form cannot be used as input (backslashes and control characters are rejected by `parseRelativePath`), so files with such names are listable but not readable. File content and snippets are not escaped (content is not a name).
- B4 response budget: `fitToBudget` (core/response.ts) measures the serialized MCP result (structuredContent plus the text copy plus 512 bytes envelope reserve) and, when over `maxResponseBytes`, cuts array entries, text `content` or tree nodes by binary search and sets `meta.truncated`, `meta.partial`, `meta.responseBudgetBytes`, a warning, and recomputes `returnedCount`, `lines.end` and tree `counts`. The doc 04 shape is kept, so each copy carries at most about half of the budget (a max read returns roughly 95 KB of content). `toMcpResult` applies it after redaction with the default limit when no `maxBytes` is passed; the fs tool layer pre-applies the configured (possibly tighter) `limits.maxResponseBytes`. Errors and payload shapes other than array/content/tree are not cut.

