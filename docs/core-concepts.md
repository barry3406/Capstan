# Core Concepts

## Overview

Capstan serves two roles:

1. **An AI agent framework** for building Claude Code-level intelligent agents with durable execution, self-evolution, and production robustness.
2. **A full-stack web framework** for building typed HTTP/MCP/A2A/OpenAPI applications.

Both roles share the same Bun-native runtime. This document covers the agent framework first (Part 1) because it is the primary use case, then the web framework (Part 2).

---

# Part 1: Smart Agent

## createSmartAgent

`createSmartAgent` is the central API. It takes a configuration object and returns a `SmartAgent` with two methods: `run(goal)` and `resume(checkpoint, message)`.

Here is a production agent in 30 lines:

```typescript
import { createSmartAgent } from "@zauso-ai/capstan-ai";
import { anthropicProvider } from "@zauso-ai/capstan-agent";

const agent = createSmartAgent({
  // 1. LLM provider (required)
  llm: anthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: "claude-sonnet-4-20250514",
  }),

  // 2. Tools the agent can use
  tools: [readFile, writeFile, runCommand, searchCode],

  // 3. Skills (strategic guidance, not operations)
  skills: [debuggingSkill, refactoringSkill],

  // 4. Self-evolution (learn from every run)
  evolution: {
    store: myEvolutionStore,
    capture: "every-run",
    distillation: "post-run",
  },

  // 5. Production settings
  maxIterations: 200,
  contextWindowSize: 200_000,
  fallbackLlm: openaiProvider({ apiKey: process.env.OPENAI_API_KEY!, model: "gpt-4o" }),
  llmTimeout: { chatTimeoutMs: 120_000, streamIdleTimeoutMs: 90_000 },
});

const result = await agent.run("Fix the failing test in src/parser.test.ts");

console.log(result.status);      // "completed" | "max_iterations" | "fatal" | ...
console.log(result.iterations);  // how many loop iterations it took
console.log(result.toolCalls);   // full tool call trace
```

### SmartAgentConfig Reference

| Property            | Type                      | Required | Description                                           |
| ------------------- | ------------------------- | -------- | ----------------------------------------------------- |
| `llm`               | `LLMProvider`             | Yes      | Primary language model                                |
| `tools`             | `AgentTool[]`             | Yes      | Operations the agent can invoke                       |
| `tasks`             | `AgentTask[]`             | No       | Long-running tasks (shell, workflow, remote, subagent) |
| `skills`            | `AgentSkill[]`            | No       | Strategic guidance the agent can activate              |
| `memory`            | `SmartAgentMemoryConfig`  | No       | Scoped memory with pluggable backend                  |
| `evolution`         | `EvolutionConfig`         | No       | Self-evolution: experience capture, distillation       |
| `prompt`            | `PromptComposerConfig`    | No       | Custom system prompt composition                      |
| `stopHooks`         | `StopHook[]`              | No       | Quality gates on final responses                      |
| `hooks`             | `SmartAgentHooks`         | No       | Lifecycle hooks (before/after tool calls, etc.)       |
| `maxIterations`     | `number`                  | No       | Max loop iterations (default: 10)                     |
| `contextWindowSize` | `number`                  | No       | Context window size for compression decisions          |
| `compaction`        | `Partial<CompactionConfig>` | No    | Compression tuning (snip, microcompact, autocompact)   |
| `streaming`         | `StreamingExecutorConfig` | No       | Concurrent tool execution settings                    |
| `toolCatalog`       | `ToolCatalogConfig`       | No       | Token-budgeted progressive tool disclosure              |
| `fallbackLlm`      | `LLMProvider`             | No       | Backup model when primary fails                       |
| `tokenBudget`       | `number \| TokenBudgetConfig` | No   | Output token budget with nudge + force-complete        |
| `toolResultBudget`  | `ToolResultBudgetConfig`  | No       | Per-result and aggregate truncation limits              |
| `llmTimeout`        | `LLMTimeoutConfig`        | No       | Watchdog timeouts for chat and streaming               |

### AgentRunResult

Every `run()` and `resume()` call returns an `AgentRunResult`:

```typescript
interface AgentRunResult {
  result: unknown;              // The agent's final output (usually a string)
  iterations: number;           // Total loop iterations
  toolCalls: AgentToolCallRecord[];   // Full tool call trace
  taskCalls: AgentTaskCallRecord[];   // Full task call trace
  status: AgentRunStatus;       // "completed" | "max_iterations" | "approval_required" | "paused" | "canceled" | "fatal"
  error?: string;               // Error message if status is "fatal"
  checkpoint?: AgentCheckpoint; // Resumable checkpoint
  pendingApproval?: { kind: "tool" | "task"; tool: string; args: unknown; reason: string };
}
```

---

## The Agent Loop

`runSmartLoop` is the engine inside `createSmartAgent`. It implements an 8-phase iteration cycle:

### Phase 1: Initialization

Before the first iteration:

1. Create engine state from config (tools, messages, counters)
2. Build tool catalog (inline all tools, or defer large schemas behind the `discover_tools` meta-tool)
3. Inject `activate_skill` synthetic tool if skills are configured
4. Inject `read_persisted_result` tool if tool result persistence is configured
5. Retrieve relevant memories from memory store
6. Compose system prompt (base prompt + tool descriptions + skill catalog + memories + strategies)
7. Set initial messages: `[system prompt, user goal]`
8. Fire `onCheckpoint("initialized")` hook

### Phase 2: Main Loop (repeats until completion)

Each iteration runs these steps:

#### Step 1: Compression Check

If estimated tokens exceed 60% of the context window:
- **Snip**: Remove old messages from the middle, preserving the tail
- **Microcompact**: Truncate oversized tool results in non-protected messages

If tokens still exceed 85%:
- **Autocompact**: LLM-driven summarization that compresses the conversation while extracting memory candidates

#### Step 2: Control Check

The `getControlState` hook is called with phase `"before_llm"`. The operator can return `"pause"` or `"cancel"` to halt execution.

#### Step 3: Model + Tool Execution

1. Normalize messages (merge adjacent same-role, filter empties)
2. Call the LLM with the current message history
3. Parse tool call requests from the response
4. Validate tool arguments (JSON Schema + custom `validate` function)
5. Execute tools (with per-tool timeout, concurrent dispatch for safe tools)
6. Record tool results with budgeting (per-result truncation, aggregate cap, optional disk persistence)

#### Step 4: Error Handling

On LLM failure:
- **Context limit error**: Try autocompact recovery, then reactive compact, then fatal
- **Other error + fallback configured**: Strip thinking blocks, retry with `fallbackLlm`
- **Other error, no fallback**: Fatal exit

#### Step 5: Token Budget Management

If a `tokenBudget` is configured:
- At the nudge threshold (default 80%): inject a message telling the agent to wrap up
- At 100%: force-complete and return whatever output exists

#### Step 6: Result Processing

- Error withholding: retry failed tools once before exposing errors to the LLM
- Aggregate tool result budgeting: tighten per-result limits as aggregate approaches the cap
- Memory event hook fires for each tool call

#### Step 7: Dynamic Context Enrichment

Every 5 iterations, query the memory store for fresh memories relevant to recent tool results. Deduplicate against already-seen memories. Inject new memories as `[MEMORY_ENRICHMENT]` messages.

#### Step 8: Continuation Decision

When the model produces a final response (no tool calls):
- Run stop hooks (quality gates)
- If stop hooks reject: inject feedback, increment rejection count, continue (max 3 rejections before force-complete)
- If `max_output_tokens` was hit: escalate token limit and continue
- Otherwise: complete, save session summary, return result

### Phase 3: Post-Loop

If the loop exits due to `maxIterations`, the last assistant message becomes the result with status `"max_iterations"`.

---

## Tools

Tools are operations with defined inputs and outputs. They represent concrete actions the agent can perform: reading files, running commands, calling APIs, searching databases.

### Defining a Tool

```typescript
import type { AgentTool } from "@zauso-ai/capstan-ai";

const readFile: AgentTool = {
  name: "read_file",
  description: "Read the contents of a file at the given path",

  // JSON Schema for input validation (auto-validated before execute)
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute file path" },
      offset: { type: "integer", description: "Line to start reading from" },
      limit: { type: "integer", description: "Max lines to read" },
    },
    required: ["path"],
  },

  // Custom validation (runs after schema validation)
  validate(args) {
    const path = args.path as string;
    if (path.includes("..")) {
      return { valid: false, error: "Path traversal not allowed" };
    }
    return { valid: true };
  },

  // Per-tool timeout in milliseconds
  timeout: 10_000,

  // Concurrency safety: can this tool run in parallel with others?
  isConcurrencySafe: true,

  // Failure mode: "soft" = error is non-fatal, "hard" = halts iteration
  failureMode: "soft",

  async execute(args) {
    const content = await Bun.file(args.path as string).text();
    return { content, lines: content.split("\n").length };
  },
};
```

### AgentTool Properties

| Property             | Type       | Required | Description                                              |
| -------------------- | ---------- | -------- | -------------------------------------------------------- |
| `name`               | `string`   | Yes      | Unique tool identifier                                   |
| `description`        | `string`   | Yes      | What the tool does (shown to the LLM)                    |
| `parameters`         | `object`   | No       | JSON Schema for input validation                         |
| `disclosure`         | `object`   | No       | Initial visibility plus discovery namespace and keywords |
| `validate`           | `function` | No       | Custom validation: `(args) => { valid, error? }`         |
| `timeout`            | `number`   | No       | Per-tool execution timeout in milliseconds               |
| `isConcurrencySafe`  | `boolean`  | No       | Whether this tool can run concurrently with others       |
| `failureMode`        | `"soft" \| "hard"` | No | `"soft"` = non-fatal error, `"hard"` = halts iteration |
| `execute`            | `function` | Yes      | `(args) => Promise<unknown>` -- the tool implementation  |

### Input Validation

Tools are validated in two phases before `execute` is called:

1. **JSON Schema validation** (`parameters`): Checks required fields, types (`string`, `number`, `integer`, `boolean`, `array`, `object`), and `enum` constraints. All errors are collected, not fail-fast.

2. **Custom validation** (`validate`): Arbitrary logic like path traversal checks, permission verification, or cross-field validation.

If validation fails, the error is returned to the LLM as a tool result so it can correct its arguments.

### Tool Result Budgeting

Large tool results can blow out the context window. Configure `toolResultBudget` to control this:

```typescript
const agent = createSmartAgent({
  // ...
  toolResultBudget: {
    maxChars: 50_000,           // Truncate individual results beyond this
    persistDir: ".capstan/results", // Save full results to disk for later retrieval
    maxAggregateCharsPerIteration: 200_000, // Cap total result chars per iteration
  },
});
```

When a result exceeds `maxChars`, it is truncated and (if `persistDir` is set) the full result is saved to disk. The agent receives a `read_persisted_result` tool automatically so it can retrieve the full data when needed.

### Concurrent Execution

Tools marked `isConcurrencySafe: true` can execute in parallel when the model requests multiple tool calls in one turn. Configure max parallelism:

```typescript
const agent = createSmartAgent({
  // ...
  streaming: { maxConcurrency: 4 },
});
```

Non-concurrent-safe tools are executed sequentially in the order requested.

---

## Skills

Skills are **strategies, not operations**. They provide high-level guidance for how to approach a class of problems. When activated, a skill's prompt is injected into the conversation as strategic context.

### How Skills Differ from Tools

| Aspect       | Tool                              | Skill                                    |
| ------------ | --------------------------------- | ---------------------------------------- |
| What it is   | An operation with I/O             | A strategy with guidance text            |
| Invocation   | Model calls it with arguments     | Model activates it by name               |
| Result       | Concrete data (file contents, etc.) | Injected guidance prompt                |
| Side effects | Yes (reads/writes/network)        | No (read-only prompt injection)          |
| Source       | Developer-defined                 | Developer-defined or auto-evolved        |
| Example      | `read_file`, `run_command`        | `debugging`, `code_review`, `refactoring` |

### Defining a Skill

```typescript
import { defineSkill } from "@zauso-ai/capstan-ai";

const debuggingSkill = defineSkill({
  name: "debugging",
  description: "Systematic debugging methodology",
  trigger: "When encountering bugs, test failures, or unexpected behavior",
  prompt: `## Debugging Strategy

1. REPRODUCE: Confirm the failure by running the exact failing test or command.
2. ISOLATE: Narrow down to the smallest reproducing case.
3. HYPOTHESIZE: Form a specific hypothesis about the root cause.
4. VERIFY: Test the hypothesis with targeted reads/searches.
5. FIX: Apply the minimal fix that addresses the root cause.
6. CONFIRM: Re-run the original failing test to verify.

Never guess. Always verify before and after changes.`,
  tools: ["read_file", "run_command", "search_code"], // Preferred tools when active
});
```

### How Skills Work at Runtime

1. Skills are listed in the system prompt: `"Available Skills: debugging (When encountering bugs...)"`
2. The runtime injects a synthetic `activate_skill` tool into the agent's tool set
3. When the agent decides it needs a skill, it calls `activate_skill({ skill_name: "debugging" })`
4. The skill's `prompt` is returned as the tool result, injecting strategic guidance into the conversation
5. The agent incorporates the guidance into its subsequent reasoning and tool use

### Evolved Skills

Skills can be auto-generated from the evolution system. When a learned strategy achieves high utility over many applications, it is promoted to a skill with `source: "evolved"`. See [Self-Evolution](#self-evolution) below.

---

## Memory

The memory system provides scoped, searchable memory that persists across agent runs.

### Configuration

```typescript
import { BuiltinMemoryBackend } from "@zauso-ai/capstan-ai";

const agent = createSmartAgent({
  // ...
  memory: {
    store: new BuiltinMemoryBackend(),        // In-memory (or SqliteMemoryBackend for persistence)
    scope: { type: "project", id: "my-app" }, // Primary memory scope
    readScopes: [                              // Additional scopes to read from
      { type: "global", id: "shared" },
    ],
    maxMemoryTokens: 4000,                    // Max tokens for memory in system prompt
    saveSessionSummary: true,                 // Auto-save session summary on completion
    reconciler: "llm",                        // LLM-driven memory reconciliation (optional)
  },
});
```

### Memory Reconciler

Models are smart but stateless. Organization facts change over time: a customer upgrades their plan, a team member leaves, a project changes scope. Without reconciliation, the memory store accumulates contradictory facts and the agent has no way to know which version is current.

The memory reconciler solves this by letting the LLM manage fact lifecycle. When a new fact is stored, the reconciler sends ALL active memories in scope to the LLM, which judges how each existing memory relates to the new fact:

| Action      | Effect                                                    | Example                                                        |
| ----------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| `keep`      | Memory is still valid (optionally annotated with context) | "Acme uses PostgreSQL" stays when storing "Acme hired a new DBA" |
| `supersede` | Old memory removed — new fact replaces it                 | "Acme is on free plan" removed when storing "Acme upgraded to enterprise" |
| `revise`    | Old memory removed, revised version stored                | "Team has 5 engineers" revised to "Team has 6 engineers (was 5)" |
| `remove`    | Memory deleted entirely (no value remaining)              | "Beta invite code: XYZ" removed when storing "Beta period ended" |

**Philosophy**: The model decides fact lifecycle; the framework just executes. The reconciler never invents its own heuristics -- it relies entirely on the LLM's judgment about semantic relationships between facts.

**Configuration**: Set `reconciler: "llm"` to use the agent's own LLM provider, or pass a custom `MemoryReconciler` implementation for specialized reconciliation logic (e.g., domain-specific rules, a different model, or a hybrid approach).

```typescript
// Use the agent's own LLM for reconciliation
memory: {
  store: new SqliteMemoryBackend("./memories.db"),
  scope: { type: "project", id: "acme" },
  reconciler: "llm",
},

// Or provide a custom reconciler
memory: {
  store: new SqliteMemoryBackend("./memories.db"),
  scope: { type: "project", id: "acme" },
  reconciler: new MyCustomReconciler(),
},
```

The reconciler produces a `ReconcileResult` containing an array of `MemoryOperation` objects. The framework applies these operations atomically -- removing superseded/revised/removed memories and storing the new fact plus any derived memories -- before the agent continues.

### How Memory Works in the Loop

**Initial retrieval**: Before the first iteration, the agent queries the memory store for memories relevant to the goal. These are included in the system prompt.

**Staleness annotations**: Memories older than 7 days get a freshness note appended:

- 7-30 days: `"(recorded weeks ago -- may be outdated)"`
- 30-90 days: `"(recorded months ago -- verify before relying on this)"`
- 90+ days: `"(recorded a long time ago -- likely outdated)"`

**Dynamic enrichment**: Every 5 iterations, the agent queries the memory store using recent tool results as context, and injects any new relevant memories it hasn't seen yet. This prevents the agent from missing memories that become relevant as work progresses.

**Session summaries**: When `saveSessionSummary` is enabled, a summary of the run (goal, iterations, status) is stored after completion.

### Memory Backends

| Backend                | Storage     | Use Case                         |
| ---------------------- | ----------- | -------------------------------- |
| `BuiltinMemoryBackend` | In-memory   | Testing, short-lived agents      |
| `SqliteMemoryBackend`  | SQLite file | Persistent agents, local dev     |
| Custom `MemoryBackend` | Anything    | Redis, Postgres, Mem0, Hindsight |

The `MemoryBackend` interface:

```typescript
interface MemoryBackend {
  store(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<string>;
  query(scope: MemoryScope, text: string, k: number): Promise<MemoryEntry[]>;
  remove(id: string): Promise<boolean>;
  clear(scope: MemoryScope): Promise<void>;
}
```

### Memory Accessor (High-Level API)

When using the `createAI` standalone toolkit, memory is accessed through a higher-level `MemoryAccessor`:

```typescript
const ai = createAI({ llm: myProvider });

// Store
await ai.remember("Customer prefers email communication");

// Recall (hybrid search: vector + keyword + recency)
const memories = await ai.recall("How does the customer want to be contacted?");

// Scope to an entity
const customerMemory = ai.memory.about("customer", "cust_123");
await customerMemory.remember("VIP customer since 2022");

// Build context string from memories
const context = await ai.memory.assembleContext({
  query: "customer preferences",
  maxTokens: 2000,
});
```

---

## Self-Evolution

Self-evolution enables agents to learn from their runs and improve over time. The pipeline is:

```
Experience (run trajectory) → Strategy (distilled pattern) → Skill (promoted guidance)
```

### The Pipeline

**Run 1-2: Raw experience capture.** Each run records a structured `Experience` containing the goal, outcome (success/failure/partial), full tool call trajectory, iterations, duration, and skills used.

**Run 3+: Strategy distillation.** Once 3+ experiences are recorded, the distiller (LLM-driven) analyzes the trajectories and extracts generalizable strategies. Example: `"When file paths fail, check working directory first"`.

**Run 10+: Strategy refinement.** As more experiences accumulate, the consolidator merges overlapping strategies, resolves contradictions, and removes redundant ones. Utility scores are updated: +0.1 for strategies used in successful runs, -0.05 for failures.

**Run 50+: Skill promotion.** Strategies that reach high utility (default >= 0.7) after sufficient applications (default >= 5) are automatically promoted to skills. These evolved skills appear alongside developer-defined skills and are injected into the agent's tool set.

### Configuration

```typescript
import type { EvolutionConfig } from "@zauso-ai/capstan-ai";

const evolution: EvolutionConfig = {
  // The store that persists experiences, strategies, and skills
  store: myEvolutionStore,

  // When to capture experiences
  capture: "every-run",       // "every-run" | "on-failure" | "on-success" | custom function

  // When to distill strategies from experiences
  distillation: "post-run",   // "post-run" | "manual"

  // Pruning: remove low-quality or old strategies
  pruning: {
    maxStrategies: 50,
    minUtility: 0.2,
    maxAgeDays: 90,
  },

  // Skill promotion: auto-promote high-utility strategies to skills
  skillPromotion: {
    enabled: true,
    minApplications: 5,      // Minimum times a strategy was applied
    minUtility: 0.7,         // Minimum utility score
  },
};
```

### EvolutionStore Interface

```typescript
interface EvolutionStore {
  recordExperience(exp: Omit<Experience, "id" | "recordedAt">): Promise<string>;
  queryExperiences(query: ExperienceQuery): Promise<Experience[]>;
  storeStrategy(strategy: Omit<Strategy, "id" | "createdAt" | "updatedAt">): Promise<string>;
  queryStrategies(query: string, k: number): Promise<Strategy[]>;
  updateStrategyUtility(id: string, delta: number): Promise<void>;
  incrementStrategyApplications(id: string): Promise<void>;
  storeSkill(skill: AgentSkill): Promise<string>;
  querySkills(query: string, k: number): Promise<AgentSkill[]>;
  pruneStrategies(config: PruningConfig): Promise<number>;
  getStats(): Promise<EvolutionStats>;
}
```

### How Strategies Enter the Prompt

At the start of each run, the evolution engine queries the store for strategies relevant to the current goal. Matching strategies are injected as a `PromptLayer` appended to the system prompt:

```
## Learned Strategies
Apply these strategies when relevant:
1. When file paths fail, check working directory first
2. Break multi-step tasks into subtasks with verification
3. Always read a file before editing to confirm current state
```

After the run, each retrieved strategy's utility is adjusted based on the outcome.

### Distiller

The distiller is LLM-driven by default (`LlmDistiller`). It has two operations:

- **`distill(experiences)`**: Analyzes execution traces and extracts generalizable strategies
- **`consolidate(strategies)`**: Merges overlapping strategies, resolves contradictions, caps at 10

You can implement a custom `Distiller` for rule-based or hybrid distillation.

---

## Production Robustness

The agent loop includes nine robustness mechanisms that prevent failures, manage resources, and recover from errors.

### Model Fallback

When the primary LLM fails with a non-context error and `fallbackLlm` is configured, the loop:

1. Strips thinking block markers (`<thinking>`, `<redacted_thinking>`) from all assistant messages -- thinking signatures are model-bound and cause 400 errors on different models
2. Retries the call with the fallback LLM
3. If the fallback also fails, returns `status: "fatal"` with both error messages

```typescript
const agent = createSmartAgent({
  llm: anthropicProvider({ model: "claude-sonnet-4-20250514" }),
  fallbackLlm: openaiProvider({ model: "gpt-4o" }),
  // ...
});
```

### Reactive Compression (3-Phase)

When the context window is exhausted (LLM returns a context limit error):

1. **Autocompact** (LLM-driven): Summarize the conversation, extract memory candidates, free tokens
2. **Reactive compact** (aggressive): Strip old messages, keep only essential context (up to 2 retries)
3. **Fatal**: If both phases are exhausted, return `status: "fatal"`

### Token Budget

Controls the agent's total output token usage across all iterations:

```typescript
const agent = createSmartAgent({
  // ...
  tokenBudget: {
    maxOutputTokensPerTurn: 50_000,
    nudgeAtPercent: 80,  // Inject "wrap up" message at 80%
  },
});
```

At the nudge threshold, the agent receives: `"[TOKEN_BUDGET] You have used 80% of your output token budget. Begin wrapping up."` At 100%, the loop force-completes.

### LLM Watchdog

Prevents the agent from hanging on unresponsive LLM calls:

```typescript
const agent = createSmartAgent({
  // ...
  llmTimeout: {
    chatTimeoutMs: 120_000,      // Max time for a non-streaming chat call
    streamIdleTimeoutMs: 90_000, // Max time between stream chunks
    stallWarningMs: 30_000,      // Warning threshold
  },
});
```

### Tool Timeout

Each tool can specify its own timeout:

```typescript
const runCommand: AgentTool = {
  name: "run_command",
  timeout: 30_000,  // Kill after 30 seconds
  // ...
};
```

### Error Withholding

Failed tool calls are retried once before the error is exposed to the LLM. This reduces noise from transient failures:

1. Tool fails -> record the error but inject a retry hint instead of the raw error
2. Tool fails again -> expose the full error to the LLM so it can reason about it

The `activate_skill` and `read_persisted_result` meta-tools are exempt from retry (they are inherently deterministic).

### Message Normalization

Before each LLM call, messages are normalized:

- Adjacent messages with the same role are merged
- Empty-content messages are filtered out

This prevents API errors from models that reject consecutive same-role messages.

### Input Validation

Two-layer validation before tool execution:

1. **JSON Schema**: Required fields, types, enum constraints (all errors collected)
2. **Custom `validate`**: Arbitrary validation logic per tool

Invalid arguments are returned as a tool result so the LLM can self-correct.

### Abort Handling

When a tool call is blocked by the `beforeToolCall` hook, the runtime synthesizes a `tool_result` message with the denial reason. This prevents the LLM from seeing a "missing result" error and allows it to adjust.

---

## Lifecycle Hooks

Hooks provide fine-grained control over agent execution. All hooks are optional and non-fatal (hook errors never crash the agent).

```typescript
const agent = createSmartAgent({
  // ...
  hooks: {
    // Gate tool execution. Return { allowed: false } to block.
    beforeToolCall: async (tool, args) => {
      if (tool === "delete_file") {
        return { allowed: false, reason: "Destructive operations disabled" };
      }
      return { allowed: true };
    },

    // Observe tool results. Status is "success" or "error".
    afterToolCall: async (tool, args, result, status) => {
      metrics.recordToolCall(tool, status);
    },

    // Gate task execution (same interface as beforeToolCall).
    beforeTaskCall: async (task, args) => ({ allowed: true }),

    // Observe task results.
    afterTaskCall: async (task, args, result) => {},

    // Called after each checkpoint save. Can modify the checkpoint.
    onCheckpoint: async (checkpoint) => {
      await db.saveCheckpoint(checkpoint);
      return checkpoint; // or modified version
    },

    // Called when a memory-worthy event occurs (tool calls).
    onMemoryEvent: async (content) => {
      await externalMemoryStore.ingest(content);
    },

    // Operator control: can pause or cancel the agent at any phase.
    // Phases: "before_llm", "before_tool", "after_tool", "during_task_wait"
    getControlState: async (phase, checkpoint) => {
      const control = await supervisorApi.checkControl(checkpoint);
      return { action: control.shouldPause ? "pause" : "continue" };
    },

    // Called once after the run completes (success or failure).
    onRunComplete: async (result) => {
      await notifySlack(`Agent finished: ${result.status}`);
    },

    // Called after each iteration with a snapshot.
    afterIteration: async (snapshot) => {
      console.log(`Iteration ${snapshot.iteration}: ${snapshot.estimatedTokens} tokens`);
    },
  },
});
```

### Hook Reference

| Hook               | When It Fires                    | Can Modify State | Return Value                           |
| ------------------- | -------------------------------- | ---------------- | -------------------------------------- |
| `beforeToolCall`    | Before each tool execution       | No (gate only)   | `{ allowed, reason? }`                |
| `afterToolCall`     | After each tool execution        | No               | `void`                                 |
| `beforeTaskCall`    | Before each task execution       | No (gate only)   | `{ allowed, reason? }`                |
| `afterTaskCall`     | After each task execution        | No               | `void`                                 |
| `onCheckpoint`      | At initialization, tool_result, completion | Yes    | `AgentCheckpoint \| void`             |
| `onMemoryEvent`     | After each tool call             | No               | `void`                                 |
| `getControlState`   | Before LLM, before/after tools   | No (control only) | `{ action: "continue" \| "pause" \| "cancel", reason? }` |
| `onRunComplete`     | Once at end of run               | No               | `void`                                 |
| `afterIteration`    | After each iteration             | No               | `void`                                 |

---

## System Prompt Composition

The system prompt is assembled from layers with priorities:

```typescript
const agent = createSmartAgent({
  // ...
  prompt: {
    base: "You are a coding assistant that helps fix bugs.",
    layers: [
      { id: "safety", content: "Never delete production data.", position: "prepend", priority: 100 },
      { id: "style", content: "Use TypeScript best practices.", position: "append", priority: 50 },
    ],
    dynamicLayers: (context) => {
      if (context.iteration > 50) {
        return [{ id: "urgency", content: "You are running low on iterations.", position: "append", priority: 95 }];
      }
      return [];
    },
  },
});
```

The runtime automatically appends additional layers:
- **Tool catalog** (priority 90): Tool descriptions for deferred tool sets
- **Skills catalog** (priority 85): Available skills listing
- **Evolution strategies** (priority 80): Learned strategies from past runs
- **Memories**: Relevant memories from the memory store

---

## Stop Hooks

Stop hooks are quality gates evaluated when the model produces a final response (no tool calls). If any hook fails, the response is rejected with feedback and the agent continues.

```typescript
import type { StopHook } from "@zauso-ai/capstan-ai";

const completenessCheck: StopHook = {
  name: "completeness",
  async evaluate({ response, messages, toolCalls, goal }) {
    if (!response.includes("DONE") && toolCalls.length === 0) {
      return {
        pass: false,
        feedback: "You did not perform any actions. Please use tools to accomplish the goal before responding.",
      };
    }
    return { pass: true };
  },
};
```

After 3 consecutive stop hook rejections, the agent is force-completed to prevent infinite loops.

---

## Checkpoints and Resume

Every agent run produces checkpoints that can be used to resume interrupted runs:

```typescript
// Start a run
const result = await agent.run("Deploy the new feature");

if (result.status === "paused") {
  // The operator paused the agent via getControlState
  const checkpoint = result.checkpoint!;

  // Later, resume with a message
  const resumed = await agent.resume(checkpoint, "Approved. Continue deployment.");
}

if (result.status === "approval_required") {
  // A tool was blocked by beforeToolCall or a policy
  const { tool, args, reason } = result.pendingApproval!;
  console.log(`Agent wants to call ${tool} -- reason: ${reason}`);

  // After human approval:
  const resumed = await agent.resume(result.checkpoint!, "Approved. Proceed.");
}
```

Checkpoint stages: `"initialized"`, `"tool_result"`, `"task_wait"`, `"approval_required"`, `"paused"`, `"completed"`, `"max_iterations"`, `"canceled"`.

---

## Task Fabric

Tasks are long-running operations that outlive a single tool call. They share the agent's orchestration state and feed results back into the next turn.

```typescript
import { createShellTask, createWorkflowTask, createRemoteTask, createSubagentTask } from "@zauso-ai/capstan-ai";

const agent = createSmartAgent({
  // ...
  tasks: [
    createShellTask({
      name: "run_tests",
      command: ["bun", "test"],
    }),
    createWorkflowTask({
      name: "generate_report",
      async handler() {
        return { summary: "All tests green." };
      },
    }),
  ],
});
```

Task kinds: `"shell"`, `"workflow"`, `"remote"`, `"subagent"`, `"custom"`.

---

## Harness Mode

`createHarness` wraps `createSmartAgent` with an isolated runtime for long-running agents that need sandboxing, persistence, and verification.

```typescript
import { createHarness } from "@zauso-ai/capstan-ai";

const harness = await createHarness({
  llm: myProvider,
  sandbox: {
    browser: { engine: "camoufox", platform: "jd", accountId: "monitor-01" },
    fs: { rootDir: "./workspace", allowDelete: false },
  },
  verify: { enabled: true },
});

const result = await harness.run({
  goal: "Check product prices and save a report",
});

await harness.destroy();
```

Harness adds:
- **Browser sandbox**: Playwright or Camoufox for anti-detection
- **Filesystem sandbox**: Scoped reads/writes with traversal protection
- **Durable runtime**: Persisted run records, event logs, task stores, artifact stores under `.capstan/harness/`
- **Lifecycle control**: `startRun()`, `pauseRun()`, `cancelRun()`, `resumeRun()`, `getCheckpoint()`, `replayRun()`
- **Verification layer**: Post-tool validation + LLM-based pass/fail classification
- **Scheduled runs**: Pair with `@zauso-ai/capstan-cron` for recurring execution

---

# Part 2: Full-Stack Web

## defineAPI()

`defineAPI()` is the central building block for web endpoints. A single call defines a typed handler that is simultaneously projected to HTTP, MCP, A2A, and OpenAPI.

```typescript
import { defineAPI } from "@zauso-ai/capstan-core";
import { z } from "zod";

export const POST = defineAPI({
  input: z.object({
    title: z.string().min(1).max(200),
    priority: z.enum(["low", "medium", "high"]).default("medium"),
  }),
  output: z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
  }),
  description: "Create a new ticket",
  capability: "write",
  resource: "ticket",
  policy: "requireAuth",
  async handler({ input, ctx }) {
    return { id: crypto.randomUUID(), title: input.title, status: "open" };
  },
});
```

### APIDefinition Properties

| Property      | Type                              | Required | Description                                     |
| ------------- | --------------------------------- | -------- | ----------------------------------------------- |
| `input`       | `z.ZodType`                       | No       | Request validation schema                       |
| `output`      | `z.ZodType`                       | No       | Response validation schema                      |
| `description` | `string`                          | No       | Human-readable description for agent surfaces   |
| `capability`  | `"read" \| "write" \| "external"` | No       | Capability mode for permission derivation        |
| `resource`    | `string`                          | No       | Domain resource this endpoint operates on        |
| `policy`      | `string`                          | No       | Named policy to enforce before handler execution |
| `handler`     | `(args) => Promise<T>`            | Yes      | Handler receiving `{ input, ctx }`               |

### Handler Context

Every handler receives a `ctx` object:

```typescript
interface CapstanContext {
  auth: {
    isAuthenticated: boolean;
    type: "human" | "agent" | "anonymous";
    userId?: string;
    role?: string;
    email?: string;
    agentId?: string;
    permissions?: string[];
  };
  request: Request;
  env: Record<string, string | undefined>;
}
```

---

## Multi-Protocol Projection

One `defineAPI()` call creates four protocol surfaces:

```
defineAPI() --> CapabilityRegistry
                  |-- HTTP JSON API (Hono)
                  |-- MCP Tools (@modelcontextprotocol/sdk)
                  |-- A2A Skills (Google Agent-to-Agent)
                  +-- OpenAPI 3.1 Spec
```

- **HTTP**: Input from query params (GET) or JSON body (POST/PUT/PATCH/DELETE)
- **MCP**: Each route becomes a tool. `GET /tickets` becomes `get_tickets`.
- **A2A**: Each route becomes a skill via JSON-RPC `tasks/send`.
- **OpenAPI**: Each route becomes an operation with full schema generation.

### Auto-Generated Endpoints

| Endpoint                         | Protocol | Description                          |
| -------------------------------- | -------- | ------------------------------------ |
| `GET /.well-known/capstan.json`  | Capstan  | Agent manifest with all capabilities |
| `GET /.well-known/agent.json`    | A2A      | Agent card with skills list          |
| `POST /.well-known/a2a`         | A2A      | JSON-RPC task handler                |
| `POST /.well-known/mcp`         | MCP      | Streamable HTTP MCP endpoint         |
| `GET /openapi.json`             | OpenAPI  | OpenAPI 3.1 specification            |
| `GET /capstan/approvals`        | Capstan  | Approval workflow management         |

### MCP Transports

- **stdio**: For local use with Claude Desktop and Cursor. Start with `npx capstan mcp`.
- **Streamable HTTP**: Auto-mounted at `POST /.well-known/mcp`. Supports sessions and SSE streaming.

### MCP Client

Consume tools from external MCP servers. The client follows every `tools/list`
cursor and emits complete replacement snapshots when the server reports a tool
catalog change:

```typescript
import { createMcpClient } from "@zauso-ai/capstan-agent";

const client = createMcpClient({
  url: "https://other-service.example.com/.well-known/mcp",
  serverId: "other-service",
});

const tools = await client.listTools();
const unsubscribe = client.onToolsChanged((nextTools) => {
  replaceToolsFromSource(client.serverId, nextTools);
});
const result = await client.callTool("get_weather", { city: "Tokyo" });
```

For the visibility model, search result contract, execution gate, events,
checkpoints, native provider support, and MCP synchronization semantics, see
[Progressive Tool Disclosure](./progressive-tool-disclosure.md).

### LangChain Integration

```typescript
import { toLangChainTools } from "@zauso-ai/capstan-agent";

const tools = toLangChainTools(registry, {
  filter: (route) => route.capability === "read",
});
```

---

## File-Based Routing

Routes live in `app/routes/`. The router scans the directory tree and maps files to URL patterns.

| File Pattern        | Route Type | Description                        |
| ------------------- | ---------- | ---------------------------------- |
| `*.api.ts`          | API        | API handler (exports HTTP methods) |
| `*.page.tsx`        | Page       | React page component (SSR)         |
| `_layout.tsx`       | Layout     | Wraps nested routes via `<Outlet>` |
| `_middleware.ts`    | Middleware | Runs before handlers in scope      |
| `_loading.tsx`      | Loading    | Suspense fallback for pages        |
| `_error.tsx`        | Error      | Error boundary for pages           |

URL mapping examples:

| File Path                                                 | URL Pattern                      |
| --------------------------------------------------------- | -------------------------------- |
| `app/routes/tickets/index.api.ts`                        | `/tickets`                       |
| `app/routes/tickets/[id].api.ts`                         | `/tickets/:id`                   |
| `app/routes/docs/[...rest].page.tsx`                     | `/docs/*`                        |
| `app/routes/(marketing)/pricing.page.tsx`                | `/pricing`                       |

Dynamic segments use `[param]`, catch-all uses `[...param]`, route groups use `(name)` (transparent in URL).

---

## definePolicy()

Policies define permission rules evaluated before route handlers.

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

export const approveHighValue = definePolicy({
  key: "approveHighValue",
  title: "Approve High Value Actions",
  effect: "approve",
  async check({ ctx }) {
    if (ctx.auth.type === "agent") {
      return { effect: "approve", reason: "Agent actions require human approval" };
    }
    return { effect: "allow" };
  },
});
```

### Policy Effects

| Effect    | Behavior                                                    |
| --------- | ----------------------------------------------------------- |
| `allow`   | Request proceeds                                            |
| `deny`    | Request rejected (403)                                      |
| `approve` | Request held for human approval (202 with poll URL)          |
| `redact`  | Request proceeds, response data may be filtered              |

When multiple policies apply, all are evaluated and the most restrictive effect wins: `allow < redact < approve < deny`.

### Approval Workflow

When a policy returns `{ effect: "approve" }`, the framework creates a pending approval:

```
Request → Policy: "approve" → 202 { approvalId, pollUrl }
                                    ↓
                          Human reviews → POST { decision: "approved" }
                                    ↓
                          Original handler re-executed → result stored
```

Approval API: `GET /capstan/approvals`, `GET /capstan/approvals/:id`, `POST /capstan/approvals/:id`.

---

## defineModel (Database)

Capstan uses Drizzle ORM for data modeling. `defineModel()` creates typed table definitions with auto-generated CRUD route helpers.

```typescript
import { defineModel } from "@zauso-ai/capstan-db";
import { text, integer } from "drizzle-orm/sqlite-core";

export const ticket = defineModel("ticket", {
  title: text("title").notNull(),
  priority: text("priority").default("medium"),
  status: text("status").default("open"),
});
```

Features: migrations, vector search, and generated CRUD endpoints that integrate with `defineAPI()` and the multi-protocol registry.

---

## Verification Loop

`capstan verify --json` runs an 8-step cascade against your application:

| Step        | Checks                                                            |
| ----------- | ----------------------------------------------------------------- |
| structure   | Required files exist                                              |
| config      | Config file loads and has a valid export                          |
| routes      | API files export handlers, write endpoints have policies          |
| models      | Model definitions valid                                           |
| typecheck   | `tsc --noEmit` passes                                            |
| contracts   | Models match routes, policy references valid                      |
| manifest    | Agent manifest matches live routes                                |
| protocols   | HTTP, MCP, A2A, OpenAPI schema consistency                        |

Output includes `repairChecklist` with `fixCategory` and `autoFixable` flags, enabling an AI self-repair loop: run verify, read diagnostics, apply fixes, re-verify.

---

## AI in Web Handlers

The AI toolkit integrates with web handlers via the request context:

```typescript
export const POST = defineAPI({
  // ...
  async handler({ input, ctx }) {
    const analysis = await ctx.think(input.message, {
      schema: z.object({ intent: z.string(), confidence: z.number() }),
    });

    await ctx.remember(`User asked about: ${analysis.intent}`);
    const history = await ctx.recall(input.message);

    return { analysis, relatedHistory: history };
  },
});
```

`think()` returns structured data via Zod schema parsing. `generate()` returns raw text. Both have streaming variants (`thinkStream`, `generateStream`).
