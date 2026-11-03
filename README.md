# DevWorkspace MCP

Local-first MCP server (TypeScript, stdio) giving Claude Desktop and Claude Code controlled,
read-only-by-default access to database, GitHub, custom API, filesystem and workflow capabilities.

Status: Phase 0 (project setup). No tools are implemented yet.

## Commands (run from this directory)

```
pnpm install
pnpm build
pnpm dev
pnpm test
pnpm lint
pnpm typecheck
pnpm format
```

Requires Node >=22 and pnpm. Secrets come from environment variables only; see `.env.example`
(names only).
