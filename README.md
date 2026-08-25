

**English** | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

<div align="center">

<h1>
Capstan
</h1>

**One framework. Human apps. Intelligent agents. Zero boundaries.**

Write your application contract once. Humans use it through browsers.
AI agents operate it through tools. The agent evolves with every run.
No glue code. No adapter layer. No walls.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/tests-full%20suite%20passing-brightgreen?logo=bun&logoColor=white)](https://bun.sh)
[![Version](https://img.shields.io/badge/version-0.3.0-orange)](https://github.com/barry3406/capstan)
[![ESM](https://img.shields.io/badge/ESM-only-blue)](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules)

[Demo](#-30-seconds-to-see-it) · [Why Zero Walls?](#-why-zero-walls) · [For Humans](#-for-humans--full-stack-web) · [For Agents](#-for-agents--smart-runtime) · [The Bridge](#-the-bridge--self-evolution) · [Docs](#-documentation)

</div>

---

## The Problem

Today, building a web app and building an AI agent are two completely separate worlds:

- **Web developers** write APIs, routes, auth, policies — agents cannot use any of it
- **Agent developers** write tool chains, prompts, memory — humans cannot interact
- **Connecting them** requires glue code, adapters, and duplicated logic everywhere

The result: two codebases, two auth systems, two sets of validation rules, and an adapter layer that breaks every time either side changes.

**Capstan eliminates this wall entirely.**

---

## 30 Seconds to See It

```typescript
// This single API definition serves BOTH humans and agents:
import { defineAPI } from "@zauso-ai/capstan-core";
import { z } from "zod";

export const POST = defineAPI({
  input: z.object({ title: z.string(), priority: z.enum(["low", "medium", "high"]) }),
  output: z.object({ id: z.string(), title: z.string() }),
  description: "Create a ticket",
  capability: "write",
  policy: "requireAuth",
  async handler({ input }) {
    const ticket = await db.insert(tickets).values(input).returning();
    return ticket;
  },
});
// Result: HTTP endpoint + MCP tool + A2A skill + OpenAPI spec — automatically
```

```typescript
// And THIS agent can operate it, learn from it, and get smarter:
import { createSmartAgent, defineSkill, SqliteEvolutionStore } from "@zauso-ai/capstan-ai";
import { openaiProvider } from "@zauso-ai/capstan-agent";

const agent = createSmartAgent({
  llm: openaiProvider({ apiKey, baseUrl, model: "gpt-4o" }),
  tools: [readFile, writeFile, runTests, searchCode],
  skills: [
    defineSkill({
      name: "tdd-debug",
      trigger: "when tests fail",
      prompt: "Read failing test -> Read source -> Fix -> Run tests -> Verify",
    }),
  ],
  evolution: {
    store: new SqliteEvolutionStore("./brain.db"),
    capture: "every-run",
    distillation: "post-run",
  },
  tokenBudget: 80_000,
  llmTimeout: { chatTimeoutMs: 120_000 },
});

await agent.run("Fix the login bug and create a ticket for the fix");
// Run 1: solves the task, records experience
// Run 10: has learned strategies, fixes bugs faster
// Run 50: has crystallized reusable skills from its own experience
```

Same framework. Same auth. Same policies. The agent operates the app that humans use — and gets smarter every time.

---

## Why Zero Walls?

No other framework bridges web development and agent development. They all force you to pick a side:

| | Next.js / Remix | LangChain / CrewAI | **Capstan** |
|---|---|---|---|
| Build web apps | Yes | No | **Yes** |
| Build AI agents | No | Yes | **Yes** |
| Agents use your APIs | Glue needed | Separate system | **Automatic** |
| Shared auth & policies | No | No | **Same rules** |
| Agent self-evolves | No | No | **Learns from runs** |
| One codebase for both | No | No | **Yes** |
| **Wall between web & agent** | **Total** | **Total** | **None** |

**Next.js** gives you a great web framework — but when you need an agent to interact with your app, you are on your own. **LangChain** gives you an agent toolkit — but it knows nothing about your web app, your routes, your policies.

**Capstan** is the only framework where the same `defineAPI()` call creates both the HTTP endpoint your React frontend calls and the MCP tool your agent uses. Same input validation. Same auth check. Same policy enforcement. Zero duplication.

---

## For Humans — Full-Stack Web

Everything you expect from a modern web framework. The difference: everything you define here is also available to agents, automatically.

### `defineAPI` — Write once, serve everywhere

```typescript
// app/routes/tickets/index.api.ts
import { defineAPI } from "@zauso-ai/capstan-core";
import { z } from "zod";

export const GET = defineAPI({
  input: z.object({
    status: z.enum(["open", "in_progress", "closed", "all"]).optional(),
  }),
  output: z.object({
    tickets: z.array(z.object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
    })),
  }),
  description: "List all tickets",
  capability: "read",
  resource: "ticket",
  async handler({ input, ctx }) {
    const tickets = await db.query.tickets.findMany();
    return { tickets };
  },
});
```

That single file automatically generates:

| Protocol | What you get |
|----------|-------------|
| REST API | `GET /tickets` with JSON response |
| MCP Tool | `get_tickets` with typed parameters for Claude Desktop |
| A2A Skill | `get_tickets` with SSE streaming for Google agent-to-agent |
| OpenAPI | Documented in `/openapi.json` |

```
                        defineAPI({ ... })
                               |
                      CapabilityRegistry
                               |
                +---------+---------+---------+---------+
                |         |         |         |         |
            HTTP/JSON    MCP      A2A     OpenAPI   Capstan
              API       Tools   Skills     3.1     Manifest
             (Hono)   (stdio/  (Google)   Spec      .json
                       HTTP)
```

When you run `capstan dev`, these endpoints are auto-generated:

| Endpoint | Protocol | Purpose |
|----------|----------|---------|
| `GET /.well-known/capstan.json` | Capstan | Agent manifest with all capabilities |
| `GET /.well-known/agent.json` | A2A | Google Agent-to-Agent agent card |
| `POST /.well-known/a2a` | A2A | JSON-RPC handler with SSE streaming |
| `GET /openapi.json` | OpenAPI 3.1 | Full API specification |
| `POST /.well-known/mcp` | MCP | Remote MCP tool access |
| `bunx capstan mcp` | MCP (stdio) | For Claude Desktop / Cursor |

### `defineModel` — Declarative data models

```typescript
import { defineModel, field } from "@zauso-ai/capstan-db";

export const Ticket = defineModel("ticket", {
  fields: {
    id:          field.id(),
    title:       field.string({ required: true, min: 1, max: 200 }),
    description: field.text(),
    status:      field.enum(["open", "in_progress", "closed"], { default: "open" }),
    priority:    field.enum(["low", "medium", "high"], { default: "medium" }),
    embedding:   field.vector(1536),  // built-in vector search
    createdAt:   field.datetime({ default: "now" }),
  },
});
```

Run `capstan add api tickets` and Capstan generates fully typed CRUD routes with Zod validation, policy enforcement, and agent metadata.

### `definePolicy` — Permission policies

```typescript
import { definePolicy } from "@zauso-ai/capstan-core";

export const requireAuth = definePolicy({
  key: "requireAuth",
  title: "Require Authentication",
  effect: "deny",
  async check({ ctx }) {
    if (!ctx.auth.isAuthenticated) {
      return { effect: "deny", reason: "Authentication required" };
    }
    return { effect: "allow" };
  },
});
```

Policy effects: **`allow`** | **`deny`** | **`approve`** (human-in-the-loop) | **`redact`** (filter sensitive fields). These same policies apply whether a human or an agent makes the request.

### AI TDD Self-Loop

`capstan verify --json` runs an 8-step verification cascade designed for AI coding agents:

1. **structure** — required files exist
2. **config** — `capstan.config.ts` loads
3. **routes** — API files export handlers, write endpoints have policies
4. **models** — model definitions valid
5. **typecheck** — `tsc --noEmit`
6. **contracts** — models/routes consistency, policy references valid
7. **manifest** — agent manifest matches live routes
8. **protocols** — HTTP/MCP/A2A/OpenAPI schema consistency

Output includes `repairChecklist` with `fixCategory` and `autoFixable` for AI consumption.

### Additional Web Features

- **React SSR** with streaming, selective hydration (`full` / `visible` / `none`), and React Server Components foundations
- **Vector fields & RAG** — `field.vector()`, `defineEmbedding`, hybrid search built into the ORM
- **OAuth providers** — built-in `googleProvider()`, `githubProvider()`, `createOAuthHandlers()`
- **DPoP (RFC 9449) & SPIFFE/mTLS** — proof-of-possession tokens and workload identity
- **Token-aware rate limiting** — separate buckets for human sessions vs agent API keys
- **OpenTelemetry** — cross-protocol tracing spanning HTTP, MCP, and A2A
- **Cache layer with ISR** — `cached()` decorator, stale-while-revalidate, tag-based invalidation
- **Client-side SPA router** — `<Link>` with prefetch, View Transitions, scroll restoration
- **WebSocket support** — `defineWebSocket()` for real-time, `WebSocketRoom` for pub/sub
- **Image & Font optimization** — responsive srcset, blur-up placeholders, `defineFont()`
- **CSS pipeline** — Lightning CSS built-in, Tailwind v4 auto-detection
- **EU AI Act compliance** — `defineCompliance()` with risk level, audit logging, transparency
- **Semantic ops** — events, incidents, health snapshots persisted to SQLite, CLI inspection
- **Plugin system** — `definePlugin()` to add routes, policies, and middleware
- **Deployment adapters** — Cloudflare Workers, Vercel (Edge + Node.js), Fly.io, Docker

---

## For Agents — Smart Runtime

`createSmartAgent()` from `@zauso-ai/capstan-ai` provides a production-grade autonomous agent runtime. Not a wrapper around an LLM — a full execution environment with 13 engineering features that separate toy demos from real-world agents.

And the key difference from other agent frameworks: these agents can operate the same Capstan web apps that humans use. Same APIs, same auth, same policies — no adapter layer.

### 1. Reactive 4-Layer Context Compression

Long-running agents accumulate context that exceeds the model window. Capstan compresses progressively:

```
Context grows -> snip (drop old tool results, preserve tail)
             -> microcompact (truncate large tool outputs, cached)
             -> autocompact (LLM-driven summarization)
             -> reactive compact (emergency compression on context_limit)
```

Each stage is more aggressive than the last. Microcompact results are cached so repeated compressions are instant. The system never loses the current goal or recent outputs.

### 2. Model Fallback with Thinking Strip

When the primary LLM fails (rate limit, server error), the runtime automatically retries with `fallbackLlm`. Thinking blocks are stripped when falling back to models that don't support extended thinking. No user intervention — the agent keeps working.

### 3. Tool Input Validation

Every tool call is validated before execution:

```
LLM calls tool -> JSON Schema check -> custom validate() -> execute
                       | fail                | fail
                  structured error      structured error
                  returned to LLM      returned to LLM
                  (self-correct)        (self-correct)
```

Validation failures are returned as feedback, not crashes. The LLM gets a chance to fix its arguments.

### 4. Per-Tool Timeout

Each tool can specify a `timeout` in milliseconds. Execution is cancelled via `Promise.race` if it exceeds the limit. A stuck `git log` or runaway shell command won't hang the agent forever.

### 5. LLM Watchdog

- **Chat timeout** (default 120s) — aborts if the LLM call takes too long
- **Stream idle timeout** (default 90s) — kills the connection if no tokens arrive
- **Stall warning** (default 30s) — detects when the LLM appears stuck

### 6. Token Budget Management

| Threshold | Action |
|-----------|--------|
| **80% of budget** | Nudge message injected: "Approaching token limit, wrap up" |
| **100% of budget** | Agent force-completed, partial results returned |

Configurable via `tokenBudget: number | TokenBudgetConfig`.

### 7. Tool Result Budgeting

Large tool outputs (file contents, search results, logs) are managed automatically:

- **Per-result truncation** at `maxChars`
- **Per-iteration aggregate limit** (default 200K characters)
- **Disk persistence** — oversized results written to `persistDir`, replaced with reference
- **`read_persisted_result` tool** — LLM retrieves persisted results on demand

### 8. Error Withholding & Recovery

Transient tool errors are retried once silently. If the retry succeeds, the LLM never sees the error. Only persistent failures are surfaced — keeping the agent focused.

### 9. Dynamic Context & Memory

- **Memory refresh** every 5 iterations to prevent context drift
- **Staleness annotations** on older memories
- **Message normalization** — adjacent same-role messages merged before API calls
- **Scoped memory** with `MemoryBackend` (in-memory or SQLite)
- **LLM-driven memory reconciler** — new facts are checked against all active memories; the model decides what to keep, supersede, revise, or remove (`reconciler: "llm"`)

### 10. Lifecycle Hooks

```typescript
createSmartAgent({
  hooks: {
    beforeToolCall: async (tool, args) => ({ allowed: true }),
    afterToolCall: async (tool, args, result, status) => { /* log */ },
    afterIteration: async (snapshot) => { /* checkpoint */ },
    onRunComplete: async (result) => { /* notify */ },
    getControlState: async (phase, checkpoint) => ({ action: "continue" }),
  },
});
```

### 11. Concurrent Tool Execution

Tools marked `isConcurrencySafe: true` execute in parallel when the LLM issues multiple tool calls. Non-safe tools run sequentially. Configurable via `streaming.maxConcurrency`.

### 12. Prompt Composition

Layered prompt system with `prepend`, `append`, and `replace_base` positions. Dynamic layers can inject context based on iteration count, available tools, and memory state.

### 13. Progressive Tool Disclosure

Large tool catalogs switch automatically from inline schemas to token-budgeted
discovery. `discover_tools` returns compact matches, and hidden tools cannot run
until disclosure succeeds. OpenAI and Anthropic native tool search use the same
budget and execution gate; checkpoints preserve the append-only visible set.
MCP clients follow paginated catalogs and publish complete snapshots after tool
change notifications. See [Progressive Tool Disclosure](docs/progressive-tool-disclosure.md).

### Skill Layer

Skills are **high-level strategies** — not individual operations like tools. They represent multi-step approaches to categories of problems.

```typescript
import { defineSkill } from "@zauso-ai/capstan-ai";

const debugSkill = defineSkill({
  name: "tdd-debug",
  trigger: "when tests fail or a bug needs fixing",
  prompt: `
    1. Read the failing test to understand expected behavior
    2. Read the source code under test
    3. Identify the root cause
    4. Fix the code
    5. Run the tests to verify
  `,
  tools: ["read_file", "write_file", "run_tests"],
});

const refactorSkill = defineSkill({
  name: "safe-refactor",
  trigger: "when refactoring or restructuring code",
  prompt: `
    1. Run all tests first to establish baseline
    2. Make one structural change at a time
    3. Run tests after each change
    4. If tests break, revert and try a different approach
  `,
});
```

**How it works:**

1. Skills are described in the system prompt so the model knows what strategies are available
2. The runtime injects a synthetic `activate_skill` tool
3. When the model calls `activate_skill({ name: "tdd-debug" })`, the skill's guidance is returned as a tool result
4. The model follows the strategy using the recommended tools

Skills bridge the gap between low-level tool use and high-level problem-solving. They can come from developers (`source: "developer"`) or be evolved automatically from the agent's own experience (`source: "evolved"`).

**Code-bearing skills.** A skill can also be a *directory* — a `SKILL.md` (guidance) plus bundled scripts/resources — loaded with `loadSkillsFrom("./skills")`. On activation the agent receives a manifest of the bundled files plus `read_skill_file` and `run_skill_script` tools to inspect and execute the bundled code (`.py`/`.sh`/`.js`/`.ts`), sandboxed to the skill directory (activation-gated, path-confined, timeout + output caps). This is the "Agent Skills" model — skills that carry executable code, not just guidance.

> LLM providers come from `@zauso-ai/capstan-agent`: `openaiProvider` (Chat Completions), `anthropicProvider` (Messages), and `responsesProvider` (OpenAI **Responses API** — for reasoning models like gpt-5.x and Responses-compatible proxies).

### Durable Harness Runtime

For agents that need sandboxing, persistence, and operator supervision, `createHarness()` provides a full durable execution environment:

- **Persisted runs** with checkpoints and event streams
- **Browser sandbox** (Playwright-based) with vision actions and guard registry
- **Filesystem sandbox** for isolated file operations
- **Artifact recording** — persist intermediate outputs
- **Task fabric** — shell, workflow, remote, and subagent tasks with status tracking
- **Verification hooks** — structured verification after agent runs
- **Observability** — metrics, events, and OpenTelemetry integration

```typescript
import { createHarness } from "@zauso-ai/capstan-ai";

const harness = createHarness({
  agent: mySmartAgent,
  sandbox: { fs: { root: "./workspace" } },
  verify: [myVerifier],
});

const handle = await harness.start({ goal: "Build the feature" });
const result = await handle.wait();
```

---

## The Bridge — Self-Evolution

This is where Capstan becomes something no other framework offers. The agent does not just execute — it **learns** from operating the application. Every run becomes training data for the next.

```
Run completes -> Experience recorded (goal, trajectory, outcome, token usage)
                        |
                        v
              Strategy distillation (LLM analyzes what worked)
                        |
                        v
              Utility scoring (+0.1 success, -0.05 failure)
                        |
                        v
              High-utility strategies auto-promoted to AgentSkill
                        |
                        v
              Agent literally evolves new capabilities
```

### Experience Recording

Each run produces a structured `Experience` record: what tools were called, in what order, what succeeded, what failed, the token cost, and the final outcome. This is the raw material for learning.

### Strategy Distillation

After a run, the `Distiller` (LLM-powered by default via `LlmDistiller`) analyzes the experience and extracts reusable rules — patterns like "always read the test file before modifying source" or "search for existing implementations before writing new code." These become `Strategy` objects with a utility score.

### Utility Feedback Loop

Strategies accumulate utility based on outcomes:
- **Success**: +0.1 to the utility score
- **Failure**: -0.05 to the utility score
- Scores are clamped to `[0, 1]`

Over time, effective strategies rise to the top while ineffective ones fade.

### Skill Crystallization

When a strategy's utility exceeds the promotion threshold, it is automatically promoted to a full `AgentSkill` — becoming a first-class skill that appears in the system prompt and can be activated by the model. The agent literally evolves new capabilities from its own experience.

### Persistent Storage

```typescript
import { SqliteEvolutionStore, InMemoryEvolutionStore } from "@zauso-ai/capstan-ai";

// Production: persist evolution across sessions
const store = new SqliteEvolutionStore("./agent-evolution.db");

// Development/testing: in-memory, no persistence
const store = new InMemoryEvolutionStore();
```

The evolution config:

```typescript
createSmartAgent({
  evolution: {
    store: new SqliteEvolutionStore("./agent-brain.db"),
    capture: "every-run",        // or "on-failure" | "on-success"
    distillation: "post-run",    // run distiller after each run
  },
});
```

---

## Architecture

```
                    Your Application Contract
                    (defineAPI + defineModel + definePolicy)
                              |
              +---------------------------------+------------------+
              |               |                 |                  |
         For Humans      For Agents        Self-Evolution     Verification
         +--------+     +----------+      +------------+     +-----------+
         | HTTP   |     | Smart    |      | Experience |     | 8-step    |
         | React  |     | Agent    |      | Strategy   |     | cascade   |
         | SSR    |     | Runtime  |      | Skill      |     | AI TDD    |
         +--------+     +----------+      +------------+     +-----------+
```

### Project Structure

```
capstan.config.ts           <- App configuration (DB, auth, agent settings)
app/
  routes/
    index.page.tsx          <- React pages (SSR with loaders)
    index.api.ts            <- API handlers (export GET, POST, PUT, DELETE)
    tickets/
      index.api.ts          <- File-based routing: /tickets
      [id].api.ts           <- Dynamic segments: /tickets/:id
    _layout.tsx             <- Layout wrappers
    _middleware.ts          <- Middleware
  models/
    ticket.model.ts         <- Drizzle ORM + defineModel()
  policies/
    index.ts                <- definePolicy() permission rules
  public/
    favicon.ico             <- Static assets (served automatically)
```

**Stack:** [Hono](https://hono.dev) (HTTP) . [Drizzle](https://orm.drizzle.team) (ORM) . [React](https://react.dev) (SSR) . [Zod](https://zod.dev) (validation) . [OpenTelemetry](https://opentelemetry.io) (tracing) . [Bun](https://bun.sh) or Node.js (runtime)

---

## Engineering Maturity

The `createSmartAgent` runtime includes 13 production features that make the difference between a demo and a system you can deploy:

1. **Reactive 4-layer context compression** — snip, microcompact, autocompact, reactive compact
2. **Model fallback with thinking strip** — auto-switch on failure, strip thinking blocks for non-thinking models
3. **Tool input validation** — JSON Schema + custom `validate()`, errors returned as feedback for self-correction
4. **Per-tool timeout** — millisecond-level `Promise.race` cancellation per tool
5. **LLM watchdog** — chat timeout (120s), stream idle timeout (90s), stall warning (30s)
6. **Token budget management** — nudge at 80%, force-complete at 100%
7. **Tool result budgeting** — per-result truncation, aggregate limits, disk persistence with on-demand retrieval
8. **Error withholding** — silent retry of transient errors before surfacing to the LLM
9. **Dynamic context & memory** — scoped memory, staleness annotations, periodic refresh, LLM-driven reconciler
10. **Lifecycle hooks** — `beforeToolCall`, `afterToolCall`, `afterIteration`, `onRunComplete`, `getControlState`
11. **Concurrent tool execution** — `isConcurrencySafe` flag, configurable `maxConcurrency`
12. **Layered prompt composition** — `prepend`, `append`, `replace_base` with dynamic layers
13. **Progressive tool disclosure** — schema-token budgets, deterministic discovery, execution isolation, native provider search, resumable catalog state

---

## Packages

Capstan ships 12 workspace packages:

| Package | Description |
|---------|-------------|
| `@zauso-ai/capstan-ai` | **Smart agent runtime**: `createSmartAgent` with progressive tool disclosure, 4-layer compression, model fallback, tool validation/timeouts, LLM watchdog, token budgets, tool result budgeting, error withholding, lifecycle hooks. `defineSkill` skill layer. Self-evolution engine with `SqliteEvolutionStore`. Durable `createHarness` with browser/fs sandboxes. Also: `think`/`generate`, scoped memory, task fabric. |
| `@zauso-ai/capstan-core` | Hono server, `defineAPI`, `defineMiddleware`, `definePolicy`, approval workflow, 8-step verifier |
| `@zauso-ai/capstan-agent` | `CapabilityRegistry`, MCP server (stdio + Streamable HTTP), MCP client, A2A adapter (SSE), OpenAPI generator, LangChain integration |
| `@zauso-ai/capstan-db` | Drizzle ORM, `defineModel`, field/relation helpers, migrations, auto CRUD, vector fields, `defineEmbedding`, hybrid search |
| `@zauso-ai/capstan-auth` | JWT sessions, API key auth, OAuth providers (Google, GitHub), DPoP (RFC 9449), SPIFFE/mTLS, token-aware rate limiting |
| `@zauso-ai/capstan-router` | File-based routing (`.page.tsx`, `.api.ts`, `_layout.tsx`, `_middleware.ts`, route groups) |
| `@zauso-ai/capstan-react` | SSR with loaders, layouts, selective hydration, ISR, `<Link>` SPA router, `Image`, `defineFont`, `defineMetadata`, `ErrorBoundary` |
| `@zauso-ai/capstan-cron` | Recurring job scheduler: `defineCron`, `createCronRunner`, `createAgentCron` |
| `@zauso-ai/capstan-ops` | Semantic ops runtime: events, incidents, snapshots, queries, SQLite persistence |
| `@zauso-ai/capstan-dev` | Dev server with file watching, hot route reload, MCP/A2A endpoints |
| `@zauso-ai/capstan-cli` | CLI: `dev`, `build`, `start`, `deploy:init`, `verify`, `ops:*`, `add`, `mcp`, `db:*` |
| `create-capstan-app` | Project scaffolder (`--template blank`, `--template tickets`) |

---

## Quick Start

### "I want to build a web app"

```bash
bunx create-capstan-app my-app
cd my-app
bun run dev
```

```bash
# Scaffold features
bunx capstan add model ticket
bunx capstan add api tickets
bunx capstan add page tickets
bunx capstan add policy requireAuth

# Verify everything is wired correctly
bunx capstan verify --json
```

Your app is live with all protocol surfaces:
- `http://localhost:3000` — Web app
- `http://localhost:3000/openapi.json` — OpenAPI spec
- `http://localhost:3000/.well-known/capstan.json` — Agent manifest
- `http://localhost:3000/.well-known/agent.json` — A2A agent card

### "I want to build an AI agent"

```bash
npm install @zauso-ai/capstan-ai @zauso-ai/capstan-agent
```

```typescript
import { createSmartAgent, defineSkill, SqliteEvolutionStore } from "@zauso-ai/capstan-ai";
import { openaiProvider } from "@zauso-ai/capstan-agent";

const agent = createSmartAgent({
  llm: openaiProvider({ apiKey: process.env.OPENAI_API_KEY!, model: "gpt-4o" }),
  tools: [/* your tools */],
  skills: [
    defineSkill({
      name: "my-strategy",
      trigger: "when the task requires...",
      prompt: "Step 1...\nStep 2...\nStep 3...",
    }),
  ],
  evolution: {
    store: new SqliteEvolutionStore("./agent-brain.db"),
    capture: "every-run",
    distillation: "post-run",
  },
  tokenBudget: 80_000,
});

const result = await agent.run("Your goal here");
console.log(result.status, result.iterations, result.toolCalls.length);
```

### "I want both"

Build an agent that operates your Capstan web app — using the same framework for both the agent brain and the application it works on. One codebase, zero walls.

> **Node.js also works:** replace `bunx` with `npx` and `bun run` with `npx`.

---

## Production Deployment

```bash
# Build for production
bunx capstan build

# Build for specific targets
bunx capstan build --target node-standalone
bunx capstan build --target docker
bunx capstan build --target vercel-node
bunx capstan build --target vercel-edge
bunx capstan build --target cloudflare
bunx capstan build --target fly

# Start the production server
bunx capstan start
```

---

## Documentation

### Online Docs

Visit the **[Capstan Documentation Site](https://capstan.dev)** for full interactive documentation with search, multi-language support, and AI-agent-queryable MCP tools.

### MCP Docs Service for Coding Agents

The docs site exposes MCP tools that coding agents (Claude Code, Cursor, etc.) can use to query documentation:

- **Search docs** — `GET /api/search?q=createSmartAgent`
- **Query docs** — `GET /api/docs?slug=core-concepts&section=defineAPI`
- **Code examples** — `GET /api/examples?topic=defineSkill`

### Markdown Docs

- [Getting Started](docs/getting-started.md) — Installation, first project, dev workflow
- [Core Concepts](docs/core-concepts.md) — `defineAPI`, `defineModel`, `definePolicy`, capabilities
- [Architecture](docs/architecture/core.md) — System design, multi-protocol registry, route scanning
- [Authentication](docs/authentication.md) — JWT sessions, API keys, auth types
- [Database](docs/database.md) — SQLite, PostgreSQL, MySQL setup and migrations
- [Deployment](docs/deployment.md) — `capstan build`, platform targets, `deploy:init`
- [Testing Strategy](docs/testing-strategy.md) — Unit, integration, and verifier testing
- [API Reference](docs/api-reference.md) — Full API surface documentation
- [Comparison](docs/comparison.md) — Capstan vs Next.js, FastAPI, and others

---

## Contributing

Capstan is in active development (`v0.3.0`). Contributions are welcome!

```bash
git clone https://github.com/barry3406/capstan.git
cd capstan
npm install
npm run build        # Build all workspace packages
npm test             # Run the full repository test suite
```

### Conventions

- ESM only, `.js` extensions in imports
- Strict TypeScript (`exactOptionalPropertyTypes`, `verbatimModuleSyntax`)
- All API handlers use `defineAPI()` with Zod schemas
- Write endpoints require a `policy` reference

### Help wanted

- More agent tool implementations (browser automation, API clients)
- Additional evolution store backends (PostgreSQL, Redis)
- More scaffolder templates (beyond `blank` and `tickets`)
- Additional OAuth providers (beyond Google and GitHub)
- Additional embedding adapters (Cohere, local models)
- More deployment adapters (AWS Lambda, Deno Deploy)

---

## License

[MIT](LICENSE)

---

**Capstan — where web development meets agent intelligence.**
