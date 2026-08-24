# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Is Capstan

A Bun-native AI agent full-stack framework built around a shared application contract. One `defineAPI()` call can drive HTTP, MCP, A2A, and OpenAPI interfaces, while the wider product loop also includes durable harness execution, operator supervision, structured verification, and explicit release output. Bun is the primary runtime; Node.js is also supported.

## Commands

```bash
# Build all workspace packages in dependency order
npm run build

# Run the full repository suite (all tests/**/*.test.ts)
npm test

# Run the committed benchmark suite and enforce performance budgets
npm run perf
npm run perf:check


# Dev server
npm run dev

# Verify app (AI TDD self-loop — structured JSON diagnostics)
bunx capstan verify --json

# Scaffold features
bunx capstan add model <name>
bunx capstan add api <name>
bunx capstan add page <name>
bunx capstan add policy <name>

# MCP server (stdio transport for Claude Desktop / Cursor)
bunx capstan mcp

# Create new project
bunx create-capstan-app
```

## Architecture

### Packages (current runtime spine)

- `@zauso-ai/capstan-core` — shared contract and runtime primitives: `defineAPI`, `definePolicy`, approvals, server runtime, verification hooks, observability, caching, compliance
- `@zauso-ai/capstan-router` — file-based route discovery and route/runtime projection
- `@zauso-ai/capstan-db` — data modeling, Drizzle integration, migrations, vector search, and generated CRUD route helpers
- `@zauso-ai/capstan-auth` — human and agent auth primitives: JWT sessions, API keys, OAuth, DPoP, SPIFFE/mTLS
- `@zauso-ai/capstan-agent` — machine surfaces and interop: capability registry, MCP, A2A, OpenAPI, LangChain, testing helpers
- `@zauso-ai/capstan-ai` — AI toolkit plus durable harness runtime: think/generate, scoped memory primitives, host-driven agent loop, progressive tool disclosure, task fabric, context assembly, browser/filesystem sandboxes, persisted runs
- `@zauso-ai/capstan-cron` — recurring execution for agent jobs and long-running automation
- `@zauso-ai/capstan-ops` — semantic operations kernel: events, incidents, snapshots, SQLite persistence, querying, and CLI/operator consumption
- `@zauso-ai/capstan-react` — human application shell: streaming SSR, selective hydration, layouts, metadata, image/font helpers, error/loading boundaries
- `@zauso-ai/capstan-dev` — local development runtime, CSS pipeline, adapters, file watching
- `@zauso-ai/capstan-cli` — operator and developer entry point: dev/build/start/verify, ops inspection commands, deployment helpers, and scaffolding
- `create-capstan-app` — scaffolder that establishes the default project structure and generated agent guidance

### Multi-Protocol Architecture

```
defineAPI() → CapabilityRegistry
                ├── HTTP JSON API (Hono)
                ├── MCP Tools (@modelcontextprotocol/sdk)
                ├── A2A Skills (Google Agent-to-Agent)
                └── OpenAPI 3.1 Spec
```

Auto-generated endpoints:
- `GET /.well-known/capstan.json` — Capstan agent manifest
- `GET /.well-known/agent.json` — A2A agent card
- `POST /.well-known/a2a` — A2A JSON-RPC handler
- `POST /.well-known/mcp` — MCP tool discovery
- `GET /openapi.json` — OpenAPI spec
- `GET /capstan/approvals` — Approval workflow management

### Key File Locations

- CLI entry: `packages/cli/src/index.ts`
- Dev server: `packages/dev/src/server.ts`
- Core framework: `packages/core/src/` (api.ts, server.ts, policy.ts, verify.ts, approval.ts)
- Route scanner: `packages/router/src/scanner.ts`
- Multi-protocol registry: `packages/agent/src/registry.ts`
- A2A adapter: `packages/agent/src/a2a.ts`
- MCP adapter: `packages/agent/src/mcp.ts`
- Generated CRUD helpers: `packages/db/src/crud.ts`
- AI toolkit & harness: `packages/ai/src/` (ai.ts, memory.ts, agent.ts, loop/tool-catalog.ts, harness/)
- Cron scheduler: `packages/cron/src/` (cron.ts, ai-loop.ts)

## Verifier (AI TDD Self-Loop)

`capstan verify --json` runs an 8-step cascade:
1. **structure** — required files exist
2. **config** — capstan.config.ts loads
3. **routes** — API files export handlers, write endpoints have policies
4. **models** — model definitions valid
5. **typecheck** — tsc --noEmit
6. **contracts** — models ↔ routes consistency, policy references valid
7. **manifest** — agent manifest matches live routes
8. **cross-protocol** — HTTP ↔ MCP ↔ A2A ↔ OpenAPI schema consistency

Output includes `repairChecklist` with `fixCategory` and `autoFixable` for AI consumption.

## TypeScript Conventions

- ESM only, NodeNext module resolution, `.js` extensions in imports
- Strict mode with `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`
- Target: ES2022
- `import type` for type-only imports

## Documentation Sync

Whenever you add, change, or remove a user-facing framework capability (new API, new hook, new config option, behavioral change, etc.), you MUST update **all** of the following in the same commit:

1. **Scaffolding template** — `packages/create-capstan/src/templates.ts` → `agentsMd()` function. This generates the `AGENTS.md` that ships with every new Capstan project.
2. **README files** — `README.md`, `README.zh-CN.md`, `README.zh-TW.md`. Keep feature lists, code examples, and comparison tables current across all three languages.
3. **Docs** — the relevant file(s) under `docs/`:
   - `docs/getting-started.md` — setup & quick start
   - `docs/core-concepts.md` — defineAPI, multi-protocol
   - `docs/api-reference.md` — API surfaces across the Capstan packages
   - `docs/database.md` — defineModel, CRUD, migrations
   - `docs/authentication.md` — JWT sessions, API key auth
   - `docs/deployment.md` — production build & start
   - `docs/comparison.md` — Capstan vs Next.js feature table

Only update the files relevant to the change — not every file every time. The goal is that docs, READMEs, and scaffolded AGENTS.md never drift from the framework's actual capabilities.

## Testing

- Full repository suite: `npm test` or `bun run test:new`
- Targeted Bun runs: `bun test <file>` for narrow loops
- Node contract suite: `npm run test:node`
- Browser e2e: `npm run test:e2e -- tests/e2e/browser-flow.e2e.ts`
- Vitest-only workflow: `npm run test:vitest`
- Performance gate: `npm run perf:check`
