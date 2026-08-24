# API Reference

Complete reference for all Capstan framework packages. The AI agent package is documented first and in greatest detail; other packages follow in condensed form.

---

## @zauso-ai/capstan-ai (Smart Agent)

Standalone AI toolkit. Works independently or with the Capstan framework. Includes the smart agent loop, tool validation, token budgets, skills, memory, evolution, compression, harness mode, and utility functions.

### createSmartAgent(config)

Create a fully-configured smart agent with tool validation, token budgets, skills, evolution, and lifecycle hooks.

```typescript
function createSmartAgent(config: SmartAgentConfig): SmartAgent
```

**SmartAgentConfig** — full configuration:

```typescript
interface SmartAgentConfig {
  /** Primary LLM provider (required). */
  llm: LLMProvider;

  /** Available tools the agent can invoke (required). */
  tools: AgentTool[];

  /** Background tasks submitted via the task fabric. */
  tasks?: AgentTask[] | undefined;

  /** Memory backend and scoping configuration. */
  memory?: SmartAgentMemoryConfig | undefined;

  /** System prompt layering via the prompt composer. */
  prompt?: PromptComposerConfig | undefined;

  /** Post-response evaluators that can force re-prompting. */
  stopHooks?: StopHook[] | undefined;

  /** Maximum loop iterations before returning "max_iterations". */
  maxIterations?: number | undefined;

  /** Context window size in tokens for compression decisions. */
  contextWindowSize?: number | undefined;

  /** Compaction strategies for managing context length. */
  compaction?: Partial<{
    snip: SnipConfig;
    microcompact: MicrocompactConfig;
    autocompact: AutocompactConfig;
  }> | undefined;

  /** Concurrent tool execution configuration. */
  streaming?: StreamingExecutorConfig | undefined;

  /** Token-budgeted progressive disclosure for large tool schemas. */
  toolCatalog?: ToolCatalogConfig | undefined;

  /** Lifecycle hooks for observability and policy enforcement. */
  hooks?: SmartAgentHooks | undefined;

  /** Fallback LLM provider used when the primary fails. */
  fallbackLlm?: LLMProvider | undefined;

  /** Per-turn output token budget. Plain number treated as maxOutputTokensPerTurn. */
  tokenBudget?: number | TokenBudgetConfig | undefined;

  /** Tool result size limits and overflow persistence. */
  toolResultBudget?: ToolResultBudgetConfig | undefined;

  /** Registered skills the agent can activate at runtime. */
  skills?: AgentSkill[] | undefined;

  /** Self-evolution configuration: experience capture, distillation, pruning. */
  evolution?: EvolutionConfig | undefined;

  /** Timeout and stall detection for LLM calls. */
  llmTimeout?: LLMTimeoutConfig | undefined;
}
```

**Usage:**

```typescript
import { createSmartAgent, defineSkill } from "@zauso-ai/capstan-ai";

const agent = createSmartAgent({
  llm: myProvider,
  tools: [readFile, writeFile],
  maxIterations: 20,
  fallbackLlm: cheaperProvider,
  tokenBudget: { maxOutputTokensPerTurn: 8192, nudgeAtPercent: 85 },
  toolResultBudget: { maxChars: 50_000, persistDir: "./overflow" },
  llmTimeout: { chatTimeoutMs: 120_000, streamIdleTimeoutMs: 90_000 },
  skills: [codeReviewSkill],
  evolution: {
    store: myEvolutionStore,
    capture: "every-run",
    distillation: "post-run",
  },
});

const result = await agent.run("Refactor the auth module");
```

---

### SmartAgent

The agent interface returned by `createSmartAgent`.

```typescript
interface SmartAgent {
  /** Execute a goal from scratch. */
  run(goal: string): Promise<AgentRunResult>;

  /** Resume from a saved checkpoint with a new user message. */
  resume(checkpoint: AgentCheckpoint, message: string): Promise<AgentRunResult>;
}
```

---

### AgentTool

Tool definition with optional input validation and per-tool timeout.

```typescript
interface AgentTool {
  /** Unique tool identifier. */
  name: string;

  /** LLM-facing description of what this tool does. */
  description: string;

  /** JSON Schema for tool input arguments. */
  parameters?: Record<string, unknown> | undefined;

  /** Initial visibility and deterministic catalog search metadata. */
  disclosure?: {
    mode?: "always" | "deferred" | undefined;
    namespace?: string | undefined;
    keywords?: string[] | undefined;
  } | undefined;

  /** Whether this tool is safe for parallel execution (default: false). */
  isConcurrencySafe?: boolean | undefined;

  /**
   * Failure handling mode.
   * - "soft": error is reported to the LLM, loop continues.
   * - "hard": error aborts the run immediately.
   */
  failureMode?: "soft" | "hard" | undefined;

  /** Tool implementation. Receives validated arguments. */
  execute(args: Record<string, unknown>): Promise<unknown>;

  /**
   * Pre-execution validation. Runs before execute().
   * If { valid: false }, the tool call is rejected without executing.
   */
  validate?: ((args: Record<string, unknown>) => {
    valid: boolean;
    error?: string;
  }) | undefined;

  /** Per-tool timeout in milliseconds. Aborts execution if exceeded. */
  timeout?: number | undefined;
}
```

---

### AgentTask

Background task submitted via the task fabric.

```typescript
type AgentTaskKind = "shell" | "workflow" | "remote" | "subagent" | "custom";

interface AgentTaskExecutionContext {
  signal: AbortSignal;
  runId?: string | undefined;
  requestId: string;
  taskId: string;
  order: number;
  callStack?: ReadonlySet<string> | undefined;
}

interface AgentTask {
  name: string;
  description: string;
  kind?: AgentTaskKind | undefined;
  parameters?: Record<string, unknown> | undefined;
  isConcurrencySafe?: boolean | undefined;
  failureMode?: "soft" | "hard" | undefined;
  execute(
    args: Record<string, unknown>,
    context: AgentTaskExecutionContext,
  ): Promise<unknown>;
}
```

Task factory helpers:

```typescript
import {
  createShellTask,
  createWorkflowTask,
  createRemoteTask,
  createSubagentTask,
} from "@zauso-ai/capstan-ai";
```

---

### AgentSkill

A skill is a high-level strategy that the agent can activate at runtime. Unlike tools (operations with defined inputs/outputs), skills inject strategic guidance into the conversation.

```typescript
interface AgentSkill {
  /** Unique skill identifier. */
  name: string;

  /** What the skill does. */
  description: string;

  /** When to use this skill (shown in system prompt). */
  trigger: string;

  /** Guidance text injected into the conversation on activation. */
  prompt: string;

  /** Preferred tool names when this skill is active. */
  tools?: string[] | undefined;

  /** Origin: hand-authored or auto-promoted from evolution. */
  source?: "developer" | "evolved" | undefined;

  /** Effectiveness score (0.0 - 1.0). */
  utility?: number | undefined;

  /** Arbitrary extra data. */
  metadata?: Record<string, unknown> | undefined;

  /** Absolute path to the skill's bundle directory, for code-bearing skills
   * loaded via loadSkill/loadSkillsFrom. Guidance-only skills leave it unset. */
  bundleDir?: string | undefined;

  /** Manifest of files bundled with the skill (relative to bundleDir). */
  files?: { path: string; bytes: number; executable: boolean }[] | undefined;
}
```

---

### Skill Functions

#### defineSkill(def)

Create a skill with sensible defaults (`source: "developer"`, `utility: 1.0`).

```typescript
function defineSkill(def: AgentSkill): AgentSkill
```

**Usage:**

```typescript
import { defineSkill } from "@zauso-ai/capstan-ai";

const codeReviewSkill = defineSkill({
  name: "code-review",
  description: "Systematic code review with security and performance checks",
  trigger: "When reviewing code changes or pull requests",
  prompt: "Follow this review checklist: 1) Security vulnerabilities...",
  tools: ["read_file", "grep_codebase"],
});
```

#### createActivateSkillTool(skills)

Create a meta-tool named `activate_skill` that lets the agent activate a skill by name during a run.

```typescript
function createActivateSkillTool(skills: AgentSkill[]): AgentTool
```

The returned tool is concurrency-safe and uses soft failure mode. When invoked with `{ skill_name: "..." }`, it returns the skill's `description`, `guidance` (prompt text), and `preferredTools` list.

#### formatSkillDescriptions(skills)

Format skill descriptions for inclusion in the system prompt. Returns a markdown block listing available skills and their triggers. Returns an empty string when the skills array is empty.

```typescript
function formatSkillDescriptions(skills: AgentSkill[]): string
```

#### loadSkill(dir) / loadSkillsFrom(parentDir)

Load **code-bearing skills** from disk. A skill directory holds a `SKILL.md` (YAML-ish frontmatter `name`/`description`/`trigger`/`tools` + a guidance body) plus any scripts/resources. `loadSkill(dir)` returns one `AgentSkill` with `bundleDir` + a `files` manifest; `loadSkillsFrom(parentDir)` loads every immediate sub-directory containing a `SKILL.md`.

```typescript
function loadSkill(dir: string): AgentSkill
function loadSkillsFrom(parentDir: string): AgentSkill[]
```

#### createSkillTools(skills, options?)

Build the skill tool-set: `activate_skill` plus — when any skill carries a bundle — `read_skill_file` and `run_skill_script`. A drop-in superset of `createActivateSkillTool` that the agent loop uses automatically when `skills` is set. Scripts run ONLY from an ACTIVATED skill's bundle, path-confined (no `..` escape), interpreter-allowlisted (`.py`→python3, `.sh`→bash, `.js`/`.mjs`/`.cjs`→node, `.ts`→bun), with a timeout (`options.scriptTimeoutMs`, default `30000`) and output caps. `read_skill_file({ skill, path })` reads a bundled file; `run_skill_script({ skill, script, args? })` executes one and returns `{ exitCode, stdout, stderr }`.

```typescript
function createSkillTools(skills: AgentSkill[], options?: { scriptTimeoutMs?: number }): AgentTool[]
```

---

### LLM Providers (@zauso-ai/capstan-agent)

Concrete `LLMProvider` implementations. All return an object satisfying the `LLMProvider` interface below.

```typescript
function openaiProvider(config: { apiKey: string; baseUrl?: string; model?: string }): LLMProvider      // Chat Completions; multimodal + native tools
function anthropicProvider(config: { apiKey: string; baseUrl?: string; model?: string }): LLMProvider    // Messages API; chat + streaming, multimodal, native tools
function responsesProvider(config: { apiKey: string; baseUrl?: string; model?: string; reasoningEffort?: string }): LLMProvider  // OpenAI Responses API (/v1/responses) — reasoning models (gpt-5.x) + Responses-compatible proxies; JSON + SSE
```

---

### LLMProvider

The provider interface used by the agent loop, think/generate, and distiller.

```typescript
interface LLMProvider {
  /** Provider name (e.g. "openai", "anthropic"). */
  name: string;

  /** Send messages and receive a complete response. */
  chat(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse>;

  /** Stream response tokens. Optional — not all providers support streaming. */
  stream?(
    messages: LLMMessage[],
    options?: LLMOptions,
  ): AsyncIterable<LLMStreamChunk>;
}

interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LLMResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | undefined;
  finishReason?: string | undefined;
}

interface LLMStreamChunk {
  content: string;
  done: boolean;
  finishReason?: string | undefined;
}
```

---

### LLMOptions

Options passed to `LLMProvider.chat()` and `LLMProvider.stream()`.

```typescript
interface LLMOptions {
  /** Override model for this call. */
  model?: string | undefined;

  /** Sampling temperature. */
  temperature?: number | undefined;

  /** Maximum tokens to generate. */
  maxTokens?: number | undefined;

  /** System prompt (prepended as a system message). */
  systemPrompt?: string | undefined;

  /** Response format hint (e.g. for JSON mode). */
  responseFormat?: Record<string, unknown> | undefined;

  /** AbortSignal for cancellation support. */
  signal?: AbortSignal | undefined;
}
```

---

### LLMTimeoutConfig

Timeout and stall detection for LLM calls.

```typescript
interface LLMTimeoutConfig {
  /** Max wait for chat() response. Default: 120_000 (2 minutes). */
  chatTimeoutMs?: number | undefined;

  /** Max idle gap between stream chunks. Default: 90_000 (90 seconds). */
  streamIdleTimeoutMs?: number | undefined;

  /** Emit warning after this idle gap. Default: 30_000 (30 seconds). */
  stallWarningMs?: number | undefined;
}
```

---

### TokenBudgetConfig

Per-turn output token budget with nudge behavior.

```typescript
interface TokenBudgetConfig {
  /** Hard cap on output tokens per LLM call. */
  maxOutputTokensPerTurn: number;

  /** Inject a "wrapping up" nudge at this percentage of budget. */
  nudgeAtPercent?: number | undefined;
}
```

When `SmartAgentConfig.tokenBudget` is set to a plain `number`, it is treated as `{ maxOutputTokensPerTurn: n }`.

---

### ToolResultBudgetConfig

Limits on tool result sizes to prevent context overflow.

```typescript
interface ToolResultBudgetConfig {
  /** Max characters per individual tool result. */
  maxChars: number;

  /** Attempt to preserve JSON structure when truncating. */
  preserveStructure?: boolean | undefined;

  /** Directory to persist overflow results to disk. Oversized results are
   *  written to a file and replaced with a reference in the conversation. */
  persistDir?: string | undefined;

  /** Total characters across all tool results per iteration. Default: 200_000. */
  maxAggregateCharsPerIteration?: number | undefined;
}
```

---

### SmartAgentHooks

Lifecycle hooks for observability, policy enforcement, and post-run processing.

```typescript
interface SmartAgentHooks {
  /** Before each tool execution. Return { allowed: false } to block. */
  beforeToolCall?: ((
    tool: string,
    args: unknown,
  ) => Promise<{ allowed: boolean; reason?: string | undefined }>) | undefined;

  /** After each tool execution. Receives status indicating success or error. */
  afterToolCall?: ((
    tool: string,
    args: unknown,
    result: unknown,
    status: "success" | "error",
  ) => Promise<void>) | undefined;

  /** Before each background task submission. Return { allowed: false } to block. */
  beforeTaskCall?: ((
    task: string,
    args: unknown,
  ) => Promise<{ allowed: boolean; reason?: string | undefined }>) | undefined;

  /** After each background task completes. */
  afterTaskCall?: ((
    task: string,
    args: unknown,
    result: unknown,
  ) => Promise<void>) | undefined;

  /** After each checkpoint is created. May mutate and return it. */
  onCheckpoint?: ((
    checkpoint: AgentCheckpoint,
  ) => Promise<AgentCheckpoint | void>) | undefined;

  /** When a memory-worthy event occurs. */
  onMemoryEvent?: ((content: string) => Promise<void>) | undefined;

  /** At each phase boundary. Return "pause" or "cancel" to interrupt the run. */
  getControlState?: ((
    phase: "before_llm" | "before_tool" | "after_tool" | "during_task_wait",
    checkpoint: AgentCheckpoint,
  ) => Promise<{
    action: "continue" | "pause" | "cancel";
    reason?: string | undefined;
  }>) | undefined;

  /** After the run finishes (any status). Useful for logging or evolution. */
  onRunComplete?: ((result: AgentRunResult) => Promise<void>) | undefined;

  /** After each loop iteration. Receives a snapshot with token estimates. */
  afterIteration?: ((snapshot: IterationSnapshot) => Promise<void>) | undefined;
}
```

| Hook | When it fires |
|------|---------------|
| `beforeToolCall` | Before each tool execution. Return `allowed: false` to block. |
| `afterToolCall` | After each tool execution. Receives `status` indicating success or error. |
| `beforeTaskCall` | Before each background task submission. |
| `afterTaskCall` | After each background task completes. |
| `onCheckpoint` | After each checkpoint is created. May mutate and return it. |
| `onMemoryEvent` | When a memory-worthy event occurs. |
| `getControlState` | At each phase boundary. Return `"pause"` or `"cancel"` to interrupt. |
| `onRunComplete` | After the run finishes (any status). |
| `afterIteration` | After each loop iteration with token estimates. |

---

### AgentRunResult

Result returned by `SmartAgent.run()` and `SmartAgent.resume()`.

```typescript
type AgentRunStatus =
  | "completed"
  | "max_iterations"
  | "approval_required"
  | "paused"
  | "canceled"
  | "fatal";

interface AgentRunResult {
  /** The agent's final output (text or structured). */
  result: unknown;

  /** Number of loop iterations executed. */
  iterations: number;

  /** All tool calls made during the run. */
  toolCalls: AgentToolCallRecord[];

  /** All task calls made during the run. */
  taskCalls: AgentTaskCallRecord[];

  /** Terminal status of the run. */
  status: AgentRunStatus;

  /** Error message when status is "fatal". */
  error?: string | undefined;

  /** Resumable checkpoint (present for paused/canceled/approval_required). */
  checkpoint?: AgentCheckpoint | undefined;

  /** Details of the blocked approval (when status is "approval_required"). */
  pendingApproval?: {
    kind: "tool" | "task";
    tool: string;
    args: unknown;
    reason: string;
  } | undefined;
}

interface AgentToolCallRecord {
  tool: string;
  args: unknown;
  result: unknown;
  requestId?: string | undefined;
  order?: number | undefined;
  status?: "success" | "error" | undefined;
}

interface AgentTaskCallRecord {
  task: string;
  args: unknown;
  result: unknown;
  requestId?: string | undefined;
  taskId?: string | undefined;
  order?: number | undefined;
  status?: "success" | "error" | "canceled" | undefined;
  kind?: AgentTaskKind | undefined;
}
```

---

### AgentCheckpoint

Serializable checkpoint for pause/resume workflows.

```typescript
interface AgentCheckpoint {
  /** Current stage of the agent run. */
  stage:
    | "initialized"
    | "tool_result"
    | "task_wait"
    | "approval_required"
    | "paused"
    | "completed"
    | "max_iterations"
    | "canceled";

  /** The original goal. */
  goal: string;

  /** Full message history at checkpoint time. */
  messages: LLMMessage[];

  /** Number of iterations completed. */
  iterations: number;

  /** All tool calls up to this point. */
  toolCalls: AgentToolCallRecord[];

  /** All task calls up to this point. */
  taskCalls: AgentTaskCallRecord[];

  /** Current max output tokens setting (may have been escalated). */
  maxOutputTokens: number;

  /** Compaction state counters. */
  compaction: {
    autocompactFailures: number;
    reactiveCompactRetries: number;
    tokenEscalations: number;
  };

  /** Append-only visible tool set used for deterministic resume. */
  toolCatalog?: {
    version: string;
    disclosed: string[];
  } | undefined;

  /** Details of the pending approval, if any. */
  pendingApproval?: {
    kind: "tool" | "task";
    tool: string;
    args: unknown;
    reason: string;
  } | undefined;
}
```

---

### Compression Config

Three compaction strategies for managing context window usage.

#### SnipConfig

Drop middle messages, keeping the system prompt and a tail window.

```typescript
interface SnipConfig {
  /** Number of recent messages to preserve. */
  preserveTail: number;
}
```

#### MicrocompactConfig

Truncate individual tool results that exceed a character limit.

```typescript
interface MicrocompactConfig {
  /** Max characters per tool result before truncation. */
  maxToolResultChars: number;

  /** Number of recent messages whose tool results are protected. */
  protectedTail: number;
}
```

#### AutocompactConfig

LLM-driven summarization when context usage exceeds a threshold.

```typescript
interface AutocompactConfig {
  /** Context usage ratio (0.0 - 1.0) that triggers compaction. */
  threshold: number;

  /** Max consecutive compaction failures before giving up. */
  maxFailures: number;

  /** Extra token headroom to maintain after compaction. */
  bufferTokens?: number | undefined;
}
```

#### StreamingExecutorConfig

```typescript
interface StreamingExecutorConfig {
  /** Max concurrent tool executions per iteration. */
  maxConcurrency: number;
}
```

#### ToolCatalogConfig

```typescript
interface ToolCatalogConfig {
  /** Auto switches by schema tokens; inline preserves legacy behavior. */
  mode?: "auto" | "inline" | "progressive" | undefined;

  /** Initial schema budget used by auto mode. Default: 4096. */
  inlineSchemaTokenLimit?: number | undefined;

  /** Compact matches per discovery. Default: 5, maximum: 10. */
  maxSearchResults?: number | undefined;

  /** Maximum visible schema tokens accumulated in a run. Default: 8192. */
  maxDisclosedSchemaTokens?: number | undefined;

  /** @deprecated Use mode and inlineSchemaTokenLimit. */
  deferThreshold?: number | undefined;
}
```

In progressive mode, `discover_tools({ query, limit? })` searches deferred
definitions and makes accepted schemas visible on the next turn. A hidden tool
cannot execute merely because a model guessed its name. OpenAI and Anthropic
native tool search use the same disclosure budget and execution gate. See
[Progressive Tool Disclosure](./progressive-tool-disclosure.md) for the complete
contract.

---

### IterationSnapshot

Snapshot provided to the `afterIteration` hook.

```typescript
interface IterationSnapshot {
  iteration: number;
  messages: LLMMessage[];
  toolCalls: AgentToolCallRecord[];
  estimatedTokens: number;
}
```

---

### Model Finish Reason

```typescript
type ModelFinishReason =
  | "stop"
  | "tool_use"
  | "max_output_tokens"
  | "context_limit"
  | "error";
```

---

### ToolRequest

Internal type used by the streaming executor and engine.

```typescript
interface ToolRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
  order: number;
}
```

---

### Stop Hooks

Post-response evaluators that can force re-prompting.

```typescript
interface StopHook {
  name: string;
  evaluate(context: StopHookContext): Promise<StopHookResult>;
}

interface StopHookContext {
  response: string;
  messages: LLMMessage[];
  toolCalls: AgentToolCallRecord[];
  goal: string;
}

interface StopHookResult {
  /** true = response accepted, false = inject feedback and re-prompt. */
  pass: boolean;
  feedback?: string | undefined;
}
```

---

### Prompt Composer

Layered system prompt composition.

```typescript
interface PromptComposerConfig {
  /** Base system prompt text. */
  base?: string | undefined;

  /** Static prompt layers. */
  layers?: PromptLayer[] | undefined;

  /** Dynamic layers computed at each iteration. */
  dynamicLayers?: ((context: PromptContext) => PromptLayer[]) | undefined;
}

interface PromptLayer {
  /** Unique layer identifier. */
  id: string;

  /** Layer content text. */
  content: string;

  /** Where to place this layer relative to the base prompt. */
  position: "prepend" | "append" | "replace_base";

  /** Higher priority layers are placed first within their position group. */
  priority?: number | undefined;
}

interface PromptContext {
  tools: AgentTool[];
  iteration: number;
  memories: string[];
  tokenBudget: number;
}
```

---

### Memory

#### MemoryBackend

Pluggable backend interface for memory storage. Implement for custom backends (Redis, Mem0, etc.).

```typescript
interface MemoryBackend {
  store(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<string>;
  query(scope: MemoryScope, text: string, k: number): Promise<MemoryEntry[]>;
  remove(id: string): Promise<boolean>;
  clear(scope: MemoryScope): Promise<void>;
}
```

#### MemoryEntry

```typescript
interface MemoryEntry {
  id: string;
  content: string;
  scope: MemoryScope;
  embedding?: number[] | undefined;
  createdAt: string;
  importance?: string | undefined;
  type?: string | undefined;
  accessCount?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
  status?: "active" | "superseded" | undefined;
  supersededBy?: string | undefined;
}
```

#### MemoryScope

```typescript
interface MemoryScope {
  type: string;
  id: string;
}
```

#### MemoryAccessor

Developer-facing memory interface returned by `createMemoryAccessor()`.

```typescript
interface MemoryAccessor {
  /** Store a memory. Returns the memory ID. */
  remember(content: string, opts?: RememberOptions): Promise<string>;

  /** Retrieve relevant memories via hybrid search. */
  recall(query: string, opts?: RecallOptions): Promise<MemoryEntry[]>;

  /** Delete a memory by ID. */
  forget(entryId: string): Promise<boolean>;

  /** Return a new MemoryAccessor scoped to a specific entity. */
  about(type: string, id: string): MemoryAccessor;

  /** Build an LLM-ready context string from stored memories within a token budget. */
  assembleContext(opts: AssembleContextOptions): Promise<string>;
}

interface RememberOptions {
  scope?: MemoryScope | undefined;
  importance?: string | undefined;
  type?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

interface RecallOptions {
  scope?: MemoryScope | undefined;
  limit?: number | undefined;
}

interface AssembleContextOptions {
  query: string;
  maxTokens?: number | undefined;
  scopes?: MemoryScope[] | undefined;
}
```

#### MemoryEmbedder

```typescript
interface MemoryEmbedder {
  embed(texts: string[]): Promise<number[][]>;
  dimensions: number;
}
```

#### SmartAgentMemoryConfig

Memory configuration for the smart agent.

```typescript
interface SmartAgentMemoryConfig {
  /** Memory storage backend (required). */
  store: MemoryBackend;

  /** Default scope for memory operations. */
  scope: MemoryScope;

  /** Additional scopes to read from during context assembly. */
  readScopes?: MemoryScope[] | undefined;

  /** Embedding model for vector search. */
  embedding?: MemoryEmbedder | undefined;

  /** Max tokens for assembled memory context. */
  maxMemoryTokens?: number | undefined;

  /** Save a session summary after run completion. */
  saveSessionSummary?: boolean | undefined;

  /** Memory reconciler — "llm" uses the agent's LLM provider, or pass a custom MemoryReconciler. */
  reconciler?: "llm" | MemoryReconciler | undefined;
}
```

#### MemoryReconciler

LLM-driven memory lifecycle manager. When a new fact is stored, the reconciler sends ALL active memories in scope to the LLM and lets it decide which existing memories to keep, supersede, revise, or remove.

```typescript
interface MemoryReconciler {
  reconcile(
    newContent: string,
    existingMemories: MemoryEntry[],
  ): Promise<ReconcileResult>;
}

type MemoryOperationAction = "keep" | "supersede" | "revise" | "remove";

interface MemoryOperation {
  id: string;
  action: MemoryOperationAction;
  reason: string;
  revised?: string | undefined;
  context?: string | undefined;
}

interface ReconcileResult {
  operations: MemoryOperation[];
  newMemories: string[];
}
```

#### LlmMemoryReconciler

Built-in reconciler that uses the agent's LLM provider. Sends all active (non-superseded) memories plus the new fact to the model and parses the structured response.

```typescript
class LlmMemoryReconciler implements MemoryReconciler {
  constructor(llm: LLMProvider);
}
```

**Usage:**

```typescript
const agent = createSmartAgent({
  llm: myProvider,
  tools: [...],
  memory: {
    store: new BuiltinMemoryBackend(),
    scope: { type: "agent", id: "my-agent" },
    reconciler: "llm",  // shorthand — uses the agent's LLM
  },
});
```

#### reconcileAndStore

Reconcile a new fact against existing memories and store the result. Queries all active memories in scope, lets the reconciler judge relationships, applies operations, then stores the new fact and any derived memories.

```typescript
function reconcileAndStore(
  backend: MemoryBackend,
  scope: MemoryScope,
  newContent: string,
  reconciler: MemoryReconciler,
): Promise<{ storedId: string; operations: MemoryOperation[] }>
```

#### BuiltinMemoryBackend

Default in-memory backend with optional vector search. Suitable for development and testing.

```typescript
class BuiltinMemoryBackend implements MemoryBackend {
  constructor(opts?: { embedding?: MemoryEmbedder });
}
```

Features: keyword-only fallback when no embedder is provided, hybrid search (vector + keyword + recency decay) when embedder is present, auto-dedup at >0.92 cosine similarity.

#### SqliteMemoryBackend

```typescript
class SqliteMemoryBackend implements MemoryBackend { ... }

function createSqliteMemoryStore(path: string): SqliteMemoryBackend
```

#### createMemoryAccessor

```typescript
function createMemoryAccessor(
  backend: MemoryBackend,
  scope: MemoryScope,
  embedder?: MemoryEmbedder,
): MemoryAccessor
```

**Usage:**

```typescript
const customerMemory = createMemoryAccessor(backend, { type: "customer", id: "cust_123" });
await customerMemory.remember("Prefers email communication", { type: "preference" });
const relevant = await customerMemory.recall("communication preferences");
```

---

### Evolution

Self-evolving agent primitives. The evolution engine records run experiences, distills strategies from patterns, and promotes high-utility strategies into skills.

#### EvolutionConfig

```typescript
interface EvolutionConfig {
  /** Persistence backend for experiences, strategies, and skills (required). */
  store: EvolutionStore;

  /** When to record run experiences. */
  capture?:
    | "every-run"
    | "on-failure"
    | "on-success"
    | ((result: AgentRunResult) => boolean)
    | undefined;

  /** When to distill strategies from experiences. */
  distillation?: "post-run" | "manual" | undefined;

  /** Custom distiller implementation (default: LlmDistiller). */
  distiller?: Distiller | undefined;

  /** Strategy pruning rules. */
  pruning?: PruningConfig | undefined;

  /** Auto-promote high-utility strategies into skills. */
  skillPromotion?: SkillPromotionConfig | undefined;
}
```

#### EvolutionStore

Persistence interface for experiences, strategies, and evolved skills.

```typescript
interface EvolutionStore {
  recordExperience(
    exp: Omit<Experience, "id" | "recordedAt">,
  ): Promise<string>;
  queryExperiences(query: ExperienceQuery): Promise<Experience[]>;
  storeStrategy(
    strategy: Omit<Strategy, "id" | "createdAt" | "updatedAt">,
  ): Promise<string>;
  queryStrategies(query: string, k: number): Promise<Strategy[]>;
  updateStrategyUtility(id: string, delta: number): Promise<void>;
  incrementStrategyApplications(id: string): Promise<void>;
  storeSkill(skill: AgentSkill): Promise<string>;
  querySkills(query: string, k: number): Promise<AgentSkill[]>;
  pruneStrategies(config: PruningConfig): Promise<number>;
  getStats(): Promise<EvolutionStats>;
}
```

Two built-in store implementations:

```typescript
import {
  InMemoryEvolutionStore,
  SqliteEvolutionStore,
  createSqliteEvolutionStore,
} from "@zauso-ai/capstan-ai";

// In-memory (testing / ephemeral)
const memStore = new InMemoryEvolutionStore();

// SQLite (production persistence)
const sqliteStore = createSqliteEvolutionStore("./evolution.db");
```

#### Experience

Structured run trajectory recorded by the evolution engine.

```typescript
interface Experience {
  id: string;
  goal: string;
  outcome: "success" | "failure" | "partial";
  trajectory: TrajectoryStep[];
  iterations: number;
  tokenUsage: number;
  duration: number;                // Milliseconds
  skillsUsed: string[];
  recordedAt: string;             // ISO date
  metadata?: Record<string, unknown> | undefined;
}
```

#### Strategy

Distilled insight derived from multiple experiences.

```typescript
interface Strategy {
  id: string;
  content: string;                // Actionable strategy description
  source: string[];               // Which experiences it was derived from
  utility: number;                // Effectiveness score (higher = better)
  applications: number;           // Times this strategy has been applied
  createdAt: string;
  updatedAt: string;
}
```

#### TrajectoryStep

```typescript
interface TrajectoryStep {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  status: "success" | "error";
  iteration: number;
}
```

#### ExperienceQuery

```typescript
interface ExperienceQuery {
  goal?: string | undefined;
  outcome?: "success" | "failure" | "partial" | undefined;
  limit?: number | undefined;
  since?: string | undefined;   // ISO date string
}
```

#### PruningConfig

```typescript
interface PruningConfig {
  maxStrategies?: number | undefined;    // Cap on total strategies
  minUtility?: number | undefined;       // Prune below this utility score
  maxAgeDays?: number | undefined;       // Prune strategies older than this
}
```

#### SkillPromotionConfig

```typescript
interface SkillPromotionConfig {
  enabled?: boolean | undefined;         // Enable auto-promotion
  minApplications?: number | undefined;  // Min times applied before promotion (default: 5)
  minUtility?: number | undefined;       // Min utility score for promotion (default: 0.7)
}
```

#### EvolutionStats

```typescript
interface EvolutionStats {
  totalExperiences: number;
  totalStrategies: number;
  totalEvolvedSkills: number;
  averageUtility: number;
}
```

#### Distiller & LlmDistiller

The `Distiller` interface abstracts strategy extraction from experiences.

```typescript
interface Distiller {
  /** Extract generalizable strategies from a set of experiences. */
  distill(
    experiences: Experience[],
  ): Promise<Omit<Strategy, "id" | "createdAt" | "updatedAt">[]>;

  /** Merge overlapping/redundant strategies into a consolidated set (max 10). */
  consolidate(
    strategies: Strategy[],
  ): Promise<Omit<Strategy, "id" | "createdAt" | "updatedAt">[]>;
}
```

`LlmDistiller` is the built-in implementation that uses an LLM to analyze execution traces and produce strategies.

```typescript
import { LlmDistiller } from "@zauso-ai/capstan-ai";

const distiller = new LlmDistiller(myLlmProvider);
const strategies = await distiller.distill(experiences);
const consolidated = await distiller.consolidate(existingStrategies);
```

#### Evolution Engine Functions

```typescript
/** Build a structured experience from a run result. */
function buildExperience(
  goal: string,
  result: AgentRunResult,
  startTime: number,
  skillsUsed: string[],
): Omit<Experience, "id" | "recordedAt">

/** Decide whether to capture based on EvolutionConfig.capture. */
function shouldCapture(
  config: EvolutionConfig,
  result: AgentRunResult,
): boolean

/**
 * Full post-run pipeline: record experience, update strategy utilities,
 * distill new strategies, prune, and promote to skills.
 * Fire-and-forget safe -- evolution failures never crash the agent.
 */
async function runPostRunEvolution(
  config: EvolutionConfig,
  llm: LLMProvider,
  goal: string,
  result: AgentRunResult,
  startTime: number,
  skillsUsed: string[],
  retrievedStrategies: Strategy[],
): Promise<void>

/** Create a PromptLayer from learned strategies for injection into the system prompt.
 *  Returns null when no strategies are provided. */
function buildStrategyLayer(strategies: Strategy[]): PromptLayer | null
```

**Usage:**

```typescript
import {
  createSmartAgent,
  createSqliteEvolutionStore,
} from "@zauso-ai/capstan-ai";

const agent = createSmartAgent({
  llm: myProvider,
  tools: [readFile, writeFile, searchCode],
  evolution: {
    store: createSqliteEvolutionStore("./agent-evolution.db"),
    capture: "every-run",
    distillation: "post-run",
    pruning: { maxStrategies: 50, minUtility: 0.2, maxAgeDays: 90 },
    skillPromotion: { enabled: true, minApplications: 5, minUtility: 0.7 },
  },
});
```

---

### Utility Functions

#### validateArgs(args, schema)

Lightweight JSON Schema validator for tool input arguments. Checks required fields, types (`string`, `number`, `integer`, `boolean`, `array`, `object`), and `enum` constraints. Collects ALL errors rather than failing on the first.

```typescript
function validateArgs(
  args: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): { valid: boolean; error?: string }
```

Returns `{ valid: true }` when schema is `undefined` (no validation). Extra fields not in the schema are permissively ignored.

**Usage:**

```typescript
import { validateArgs } from "@zauso-ai/capstan-ai";

const result = validateArgs(
  { path: "/tmp/file.txt", mode: "read" },
  {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string" },
      mode: { type: "string", enum: ["read", "write"] },
    },
  },
);
// result.valid === true
```

#### normalizeMessages(messages)

Normalize an `LLMMessage[]` array before sending to the LLM API.

```typescript
function normalizeMessages(messages: LLMMessage[]): LLMMessage[]
```

Invariants enforced:
1. No consecutive messages with the same role (merged)
2. Empty-content messages filtered out
3. System messages after the first are converted to user messages (most APIs only allow one system message at the start)

#### estimateTokens(messages)

Rough token estimate: sums all message content lengths and divides by 4.

```typescript
function estimateTokens(messages: LLMMessage[]): number
```

#### memoryAgeDays(timestampMs)

Compute memory age in days from a Unix timestamp in milliseconds.

```typescript
function memoryAgeDays(timestampMs: number): number
```

#### memoryAge(timestampMs)

Human-readable age string: `"today"`, `"yesterday"`, or `"N days ago"`.

```typescript
function memoryAge(timestampMs: number): string
```

#### memoryFreshnessText(timestampMs)

Staleness caveat text for the LLM. Returns an empty string for memories one day old or less. For older memories, returns a warning to verify claims against current code before asserting as fact.

```typescript
function memoryFreshnessText(timestampMs: number): string
```

---

### think / generate

Standalone AI primitives. No agent loop -- single LLM call.

#### think(llm, prompt, opts?)

Structured reasoning: sends a prompt to the LLM and optionally parses the response against a schema.

```typescript
function think<T = string>(
  llm: LLMProvider,
  prompt: string,
  opts?: ThinkOptions<T>,
): Promise<T>

interface ThinkOptions<T = unknown> {
  schema?: { parse: (data: unknown) => T } | undefined;
  model?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  systemPrompt?: string | undefined;
}
```

When `schema` is provided, the LLM is asked for JSON output and the result is parsed and validated. Without a schema, the raw text is returned.

#### generate(llm, prompt, opts?)

Text generation: sends a prompt and returns the raw text response.

```typescript
function generate(
  llm: LLMProvider,
  prompt: string,
  opts?: GenerateOptions,
): Promise<string>

interface GenerateOptions {
  model?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  systemPrompt?: string | undefined;
}
```

#### thinkStream(llm, prompt, opts?)

Streaming text generation. Requires the LLM provider to support `stream()`. Yields text chunks as tokens are generated.

```typescript
function thinkStream(
  llm: LLMProvider,
  prompt: string,
  opts?: GenerateOptions,
): AsyncIterable<string>
```

#### generateStream(llm, prompt, opts?)

Alias for `thinkStream`.

```typescript
function generateStream(
  llm: LLMProvider,
  prompt: string,
  opts?: GenerateOptions,
): AsyncIterable<string>
```

---

### Harness

Durable harness runtime for long-running agents. Adds browser/filesystem sandboxes, verification hooks, persisted runs/events/artifacts/checkpoints, and runtime lifecycle control on top of the smart agent loop. See `docs/harness.md` for full documentation.

```typescript
function createHarness(config: HarnessConfig): Promise<Harness>

interface Harness {
  startRun(config: AgentRunConfig): Promise<HarnessRunHandle>;
  run(config: AgentRunConfig): Promise<HarnessRunResult>;
  pauseRun(runId: string): Promise<HarnessRunRecord>;
  cancelRun(runId: string): Promise<HarnessRunRecord>;
  resumeRun(runId: string, options?: HarnessResumeOptions): Promise<HarnessRunResult>;
  getRun(runId: string): Promise<HarnessRunRecord | undefined>;
  listRuns(): Promise<HarnessRunRecord[]>;
  getEvents(runId?: string): Promise<HarnessRunEventRecord[]>;
  getTasks(runId: string): Promise<HarnessTaskRecord[]>;
  getArtifacts(runId: string): Promise<HarnessArtifactRecord[]>;
  getCheckpoint(runId: string): Promise<AgentCheckpoint | undefined>;
  getSessionMemory(runId: string): Promise<HarnessSessionMemoryRecord | undefined>;
  getLatestSummary(runId: string): Promise<HarnessSummaryRecord | undefined>;
  listSummaries(runId?: string): Promise<HarnessSummaryRecord[]>;
  rememberMemory(input: HarnessMemoryInput): Promise<HarnessMemoryRecord>;
  recallMemory(query: HarnessMemoryQuery): Promise<HarnessMemoryMatch[]>;
  assembleContext(runId: string, options?: HarnessContextAssembleOptions): Promise<HarnessContextPackage>;
  replayRun(runId: string): Promise<HarnessReplayReport>;
  getPaths(): HarnessRuntimePaths;
  destroy(): Promise<void>;
}
```

**Usage:**

```typescript
import { createHarness } from "@zauso-ai/capstan-ai";

const harness = await createHarness({
  llm: openaiProvider({ apiKey: process.env.OPENAI_API_KEY! }),
  sandbox: {
    browser: { engine: "camoufox", platform: "jd", accountId: "price-monitor-01" },
    fs: { rootDir: "./workspace" },
  },
  runtime: { rootDir: process.cwd(), maxConcurrentRuns: 2 },
  verify: { enabled: true },
});

const started = await harness.startRun({ goal: "Research and save notes" });
const result = await started.result;
await harness.destroy();
```

**HarnessConfig:**

```typescript
interface HarnessConfig {
  llm: LLMProvider;
  sandbox?: {
    browser?: boolean | BrowserSandboxConfig;
    fs?: boolean | FsSandboxConfig;
  };
  verify?: {
    enabled?: boolean;
    maxRetries?: number;
    verifier?: HarnessVerifierFn;
  };
  observe?: {
    logger?: HarnessLogger;
    onEvent?: (event: HarnessEvent) => void;
  };
  context?: {
    enabled?: boolean;
    maxPromptTokens?: number;
    reserveOutputTokens?: number;
    maxMemories?: number;
    maxArtifacts?: number;
    maxRecentMessages?: number;
    maxRecentToolResults?: number;
    microcompactToolResultChars?: number;
    sessionCompactThreshold?: number;
    defaultScopes?: MemoryScope[];
    autoPromoteObservations?: boolean;
    autoPromoteSummaries?: boolean;
  };
  runtime?: {
    rootDir?: string;
    maxConcurrentRuns?: number;
    driver?: HarnessSandboxDriver;
    beforeToolCall?: HarnessToolPolicyFn;
    beforeTaskCall?: HarnessTaskPolicyFn;
  };
}

interface BrowserSandboxConfig {
  engine?: "playwright" | "camoufox";
  platform?: string;
  accountId?: string;
  guardMode?: "vision" | "hybrid";
  headless?: boolean;
  proxy?: string;
  viewport?: { width: number; height: number };
}

interface FsSandboxConfig {
  rootDir: string;
  allowWrite?: boolean;
  allowDelete?: boolean;
  maxFileSize?: number;
}
```

The runtime store persists under `.capstan/harness/`: `runs/`, `events/`, `tasks/`, `artifacts/`, `checkpoints/`, `session-memory/`, `summaries/`, `memory/`.

Use `openHarnessRuntime(rootDir?)` for an independent control plane that can inspect paused/completed runs without a live harness instance. Accepts an optional `authorize` callback for runtime supervision with auth.

Additional harness exports: `PlaywrightEngine`, `FsSandboxImpl`, `LocalHarnessSandboxDriver`, `FileHarnessRuntimeStore`, `buildHarnessRuntimePaths`, `openHarnessRuntime`, `HarnessContextKernel`, `HarnessVerifier`, `HarnessObserver`, `GuardRegistry`, `analyzeScreenshot`, `runVisionLoop`. See the harness types export for the complete type surface.

---

### createAI(config)

Factory function that creates a standalone AI instance with all capabilities. No Capstan framework required.

```typescript
function createAI(config: AIConfig): AIContext

interface AIConfig {
  llm: LLMProvider;
  memory?: {
    backend?: MemoryBackend;
    embedding?: MemoryEmbedder;
    autoExtract?: boolean;
  };
  defaultScope?: MemoryScope;
}

interface AIContext {
  think<T = string>(prompt: string, opts?: ThinkOptions<T>): Promise<T>;
  generate(prompt: string, opts?: GenerateOptions): Promise<string>;
  thinkStream(prompt: string, opts?: Omit<ThinkOptions, "schema">): AsyncIterable<string>;
  generateStream(prompt: string, opts?: GenerateOptions): AsyncIterable<string>;
  remember(content: string, opts?: RememberOptions): Promise<string>;
  recall(query: string, opts?: RecallOptions): Promise<MemoryEntry[]>;
  memory: {
    about(type: string, id: string): MemoryAccessor;
    forget(entryId: string): Promise<boolean>;
    assembleContext(opts: AssembleContextOptions): Promise<string>;
  };
  agent: {
    run(config: AgentRunConfig): Promise<AgentRunResult>;
  };
}
```

---

## @zauso-ai/capstan-core

The core framework package. Provides the server, routing primitives, policy engine, approval workflow, caching, compliance, and application verifier.

### defineAPI(def)

Define a typed API route handler with input/output validation and agent introspection.

```typescript
function defineAPI<TInput = unknown, TOutput = unknown>(
  def: APIDefinition<TInput, TOutput>,
): APIDefinition<TInput, TOutput>

interface APIDefinition<TInput = unknown, TOutput = unknown> {
  input?: z.ZodType<TInput>;
  output?: z.ZodType<TOutput>;
  description?: string;
  capability?: "read" | "write" | "external";
  resource?: string;
  policy?: string;
  handler: (args: { input: TInput; ctx: CapstanContext }) => Promise<TOutput>;
}
```

---

### defineConfig(config)

Identity function that provides type-checking and editor auto-complete for the app configuration.

```typescript
function defineConfig(config: CapstanConfig): CapstanConfig

interface CapstanConfig {
  app?: { name?: string; title?: string; description?: string };
  database?: { provider?: "sqlite" | "postgres" | "mysql"; url?: string };
  auth?: {
    providers?: Array<{ type: string; [key: string]: unknown }>;
    session?: { strategy?: "jwt" | "database"; secret?: string; maxAge?: string };
  };
  agent?: {
    manifest?: boolean; mcp?: boolean; openapi?: boolean;
    rateLimit?: { default?: { requests: number; window: string }; perAgent?: boolean };
  };
  server?: { port?: number; host?: string };
}
```

---

### defineMiddleware(def)

Define a middleware for the request pipeline.

```typescript
function defineMiddleware(
  def: MiddlewareDefinition | MiddlewareDefinition["handler"],
): MiddlewareDefinition

interface MiddlewareDefinition {
  name?: string;
  handler: (args: {
    request: Request; ctx: CapstanContext; next: () => Promise<Response>;
  }) => Promise<Response>;
}
```

---

### definePolicy(def)

Define a named permission policy.

```typescript
function definePolicy(def: PolicyDefinition): PolicyDefinition

interface PolicyDefinition {
  key: string;
  title: string;
  effect: "allow" | "deny" | "approve" | "redact";
  check: (args: { ctx: CapstanContext; input?: unknown }) => Promise<PolicyCheckResult>;
}
```

---

### enforcePolicies(policies, ctx, input?)

Run all provided policies and return the most restrictive result. Severity order: `allow < redact < approve < deny`.

```typescript
function enforcePolicies(
  policies: PolicyDefinition[], ctx: CapstanContext, input?: unknown,
): Promise<PolicyCheckResult>
```

---

### defineRateLimit(config)

```typescript
function defineRateLimit(config: RateLimitConfig): RateLimitConfig

interface RateLimitConfig {
  default: { requests: number; window: string };
  perAuthType?: {
    anonymous?: { requests: number; window: string };
    human?: { requests: number; window: string };
    agent?: { requests: number; window: string };
  };
}
```

---

### createCapstanApp(config)

Build a fully-wired Capstan application backed by a Hono server.

```typescript
function createCapstanApp(config: CapstanConfig): CapstanApp

interface CapstanApp {
  app: Hono;
  routeRegistry: RouteMetadata[];
  registerAPI: (method: HttpMethod, path: string, apiDef: APIDefinition, policies?: PolicyDefinition[]) => void;
}
```

---

### Approval Functions

```typescript
function createApproval(opts: {
  method: string;
  path: string;
  input: unknown;
  policy: string;
  reason: string;
}): PendingApproval

function getApproval(id: string): PendingApproval | undefined

function listApprovals(
  status?: "pending" | "approved" | "denied",
): PendingApproval[]

function resolveApproval(
  id: string,
  decision: "approved" | "denied",
  resolvedBy?: string,
): PendingApproval | undefined

function clearApprovals(): void

function mountApprovalRoutes(app: Hono, handlerRegistry: HandlerRegistry): void

interface PendingApproval {
  id: string;
  method: string;
  path: string;
  input: unknown;
  policy: string;
  reason: string;
  status: "pending" | "approved" | "denied";
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  result?: unknown;
}
```

---

### Verification

```typescript
function verifyCapstanApp(appRoot: string): Promise<VerifyReport>

interface VerifyReport {
  status: "passed" | "failed";
  appRoot: string;
  timestamp: string;
  steps: VerifyStep[];
  repairChecklist: Array<{
    index: number; step: string; message: string;
    file?: string; line?: number; hint?: string;
    fixCategory?: string; autoFixable?: boolean;
  }>;
  summary: { totalSteps: number; passedSteps: number; failedSteps: number; skippedSteps: number; errorCount: number; warningCount: number };
}
```

---

### definePlugin(def)

```typescript
function definePlugin(def: PluginDefinition): PluginDefinition

interface PluginDefinition {
  name: string;
  version?: string;
  setup: (ctx: PluginSetupContext) => void;
}
```

---

### KeyValueStore\<T\>

Pluggable key-value store interface used by approvals, rate limiting, and DPoP replay detection.

```typescript
interface KeyValueStore<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  values(): Promise<T[]>;
  clear(): Promise<void>;
}
```

Implementations: `MemoryStore<T>` (in-memory), `RedisStore<T>` (Redis-backed, prefix-namespaced).

```typescript
function setApprovalStore(store: KeyValueStore<PendingApproval>): void
function setRateLimitStore(store: KeyValueStore<RateLimitEntry>): void
function setDpopReplayStore(store: KeyValueStore<boolean>): void
function setAuditStore(store: KeyValueStore<AuditEntry>): void
function setCacheStore(store: KeyValueStore<CacheEntry<unknown>>): void
function setResponseCacheStore(store: KeyValueStore<ResponseCacheEntry>): void
```

---

### Compliance

```typescript
function defineCompliance(config: ComplianceConfig): void

interface ComplianceConfig {
  riskLevel: "minimal" | "limited" | "high" | "unacceptable";
  auditLog?: boolean;
  transparency?: { description?: string; provider?: string; contact?: string };
}

function recordAuditEntry(entry: { action: string; authType?: string; userId?: string; resource?: string; detail?: unknown }): void
function getAuditLog(filter?: { action?: string; authType?: string; since?: string }): AuditEntry[]
function clearAuditLog(): void
```

---

### WebSocket

```typescript
function defineWebSocket(path: string, handler: WebSocketHandler): WebSocketRoute

interface WebSocketHandler {
  onOpen?: (ws: WebSocketClient) => void;
  onMessage?: (ws: WebSocketClient, message: string | ArrayBuffer) => void;
  onClose?: (ws: WebSocketClient, code: number, reason: string) => void;
  onError?: (ws: WebSocketClient, error: Error) => void;
}

interface WebSocketClient {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

class WebSocketRoom {
  join(client: WebSocketClient): void;
  leave(client: WebSocketClient): void;
  broadcast(message: string, exclude?: WebSocketClient): void;
  get size(): number;
  close(): void;
}
```

**Usage:**

```typescript
import { defineWebSocket, WebSocketRoom } from "@zauso-ai/capstan-core";

const lobby = new WebSocketRoom();

export const ws = defineWebSocket("/ws/lobby", {
  onOpen(ws) { lobby.join(ws); },
  onMessage(ws, msg) { lobby.broadcast(String(msg), ws); },
  onClose(ws) { lobby.leave(ws); },
});
```

---

### Caching

```typescript
function cacheSet<T>(key: string, data: T, opts?: CacheOptions): Promise<void>
function cacheGet<T>(key: string): Promise<T | undefined>
function cacheInvalidateTag(tag: string): Promise<void>
function cached<T>(fn: () => Promise<T>, opts?: CacheOptions & { key?: string }): () => Promise<T>

interface CacheOptions {
  ttl?: number;        // Time-to-live in seconds
  tags?: string[];     // Cache tags for bulk invalidation
  revalidate?: number; // Revalidate interval in seconds (ISR)
}
```

Response cache (used by ISR render strategies):

```typescript
function responseCacheGet(key: string): Promise<{ entry: ResponseCacheEntry; stale: boolean } | undefined>
function responseCacheSet(key: string, entry: ResponseCacheEntry, opts?: { ttlMs?: number }): Promise<void>
function responseCacheInvalidateTag(tag: string): Promise<number>
function responseCacheInvalidate(key: string): Promise<boolean>
function responseCacheClear(): Promise<void>

interface ResponseCacheEntry {
  html: string;
  headers: Record<string, string>;
  statusCode: number;
  createdAt: number;
  revalidateAfter: number | null;
  tags: string[];
}
```

Cache utilities:

```typescript
function cacheInvalidate(key: string): void
function cacheInvalidatePath(urlPath: string): void
function cacheClear(): void
function normalizeCacheTag(tag: string): string | undefined
function normalizeCacheTags(tags: string[]): string[]
function createPageCacheKey(urlPath: string): string
```

---

### Middleware

```typescript
function csrfProtection(): MiddlewareHandler
function createRequestLogger(): MiddlewareHandler
```

---

### Ops Context

```typescript
function createCapstanOpsContext(config?: {
  enabled?: boolean;
  appName?: string;
  source?: string;
  recentWindowMs?: number;
  retentionLimit?: number;
  sink?: {
    recordEvent(event: CapstanOpsEvent): Promise<void> | void;
    close?(): Promise<void> | void;
  };
}): CapstanOpsContext | undefined
```

When present on `CapstanContext`, the ops context records request, capability, policy, approval, and health lifecycle events.

### Other Utilities

```typescript
function env(key: string): string
function clearAPIRegistry(): void
function getAPIRegistry(): ReadonlyArray<APIDefinition>
function createContext(honoCtx: HonoContext): CapstanContext
function renderRuntimeVerifyText(report: VerifyReport): string
```

---

### Shared Types

```typescript
type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

interface CapstanAuthContext {
  isAuthenticated: boolean;
  type: "human" | "agent" | "anonymous";
  userId?: string;
  role?: string;
  email?: string;
  agentId?: string;
  agentName?: string;
  permissions?: string[];
}

interface CapstanContext {
  auth: CapstanAuthContext;
  request: Request;
  env: Record<string, string | undefined>;
  honoCtx: HonoContext;
}

interface RouteMetadata {
  method: HttpMethod;
  path: string;
  description?: string;
  capability?: "read" | "write" | "external";
  resource?: string;
  policy?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}
```

---

## @zauso-ai/capstan-ops

Semantic operations kernel used by the runtime and CLI.

### createCapstanOpsRuntime(options)

```typescript
function createCapstanOpsRuntime(options: {
  store: OpsStore;
  serviceName?: string;
  environment?: string;
}): {
  recordEvent(input: OpsRecordEventInput): Promise<OpsEventRecord>;
  recordIncident(input: OpsRecordIncidentInput): Promise<OpsIncidentRecord>;
  captureSnapshot(input: OpsCaptureSnapshotInput): Promise<OpsSnapshotRecord>;
  captureDerivedSnapshot(timestamp?: string): Promise<OpsSnapshotRecord>;
  createOverview(): OpsOverview;
}
```

### Store Implementations

```typescript
class InMemoryOpsStore implements OpsStore {
  constructor(options?: { retention?: OpsRetentionConfig });
}

class SqliteOpsStore implements OpsStore {
  constructor(options: { path: string; retention?: OpsRetentionConfig });
}
```

### Query & Health

```typescript
function createOpsQuery(store: OpsStore): {
  events(filter?: OpsEventFilter): OpsEventRecord[];
  incidents(filter?: OpsIncidentFilter): OpsIncidentRecord[];
  snapshots(filter?: OpsSnapshotFilter): OpsSnapshotRecord[];
}

function createOpsQueryIndex(store: OpsStore): OpsQueryIndex
function createOpsOverview(query: ..., index: OpsQueryIndex): OpsOverview
function deriveOpsHealthStatus(store: OpsStore, options?: { windowMs?: number }): {
  status: "healthy" | "degraded" | "unhealthy";
  summary: string;
  signals: OpsHealthSignal[];
}
```

### Ops Types

```typescript
type OpsSeverity = "debug" | "info" | "warning" | "error" | "critical";
type OpsIncidentStatus = "open" | "acknowledged" | "suppressed" | "resolved";
type OpsTarget = "runtime" | "release" | "approval" | "policy" | "capability" | "cron" | "ops" | "cli";

interface OpsStore {
  addEvent(record: OpsEventRecord): OpsEventRecord;
  getEvent(id: string): OpsEventRecord | undefined;
  listEvents(filter?: OpsEventFilter): OpsEventRecord[];
  addIncident(record: OpsIncidentRecord): OpsIncidentRecord;
  getIncident(id: string): OpsIncidentRecord | undefined;
  listIncidents(filter?: OpsIncidentFilter): OpsIncidentRecord[];
  addSnapshot(record: OpsSnapshotRecord): OpsSnapshotRecord;
  listSnapshots(filter?: OpsSnapshotFilter): OpsSnapshotRecord[];
  compact(options?: OpsCompactionOptions): OpsCompactionResult;
  close(): void | Promise<void>;
}
```

---

## @zauso-ai/capstan-router

File-based routing: directory scanning, URL matching, and manifest generation.

### scanRoutes(routesDir)

```typescript
function scanRoutes(routesDir: string): Promise<RouteManifest>

interface RouteManifest {
  routes: RouteEntry[];
  scannedAt: string;
  rootDir: string;
}

interface RouteEntry {
  filePath: string;
  type: RouteType;
  urlPattern: string;
  methods?: string[];
  layouts: string[];
  middlewares: string[];
  params: string[];
  isCatchAll: boolean;
}

type RouteType = "page" | "api" | "layout" | "middleware" | "loading" | "error" | "not-found";
```

### matchRoute(manifest, method, urlPath)

```typescript
function matchRoute(manifest: RouteManifest, method: string, urlPath: string): MatchedRoute | null

interface MatchedRoute {
  route: RouteEntry;
  params: Record<string, string>;
}
```

Priority: static segments > dynamic segments > catch-all.

### generateRouteManifest(manifest)

Extract API route information for the agent surface layer.

```typescript
function generateRouteManifest(manifest: RouteManifest): { apiRoutes: AgentApiRoute[] }

interface AgentApiRoute {
  method: string;
  path: string;
  filePath: string;
}
```

### canonicalizeRouteManifest(routes, rootDir)

Canonicalize and validate route entries -- detect conflicts, sort by specificity, generate diagnostics.

```typescript
function canonicalizeRouteManifest(
  routes: RouteEntry[],
  rootDir: string,
): CanonicalizedRouteManifest

interface CanonicalizedRouteManifest {
  routes: RouteEntry[];
  diagnostics: RouteDiagnostic[];
}

interface RouteDiagnostic {
  code: RouteConflictReason;
  severity: "error" | "warning";
  message: string;
  routeType: RouteType;
  urlPattern: string;
  canonicalPattern: string;
  filePaths: string[];
  directoryDepth?: number;
}
```

### Other Functions

```typescript
function validateRouteManifest(routes: RouteEntry[], rootDir: string): CanonicalizedRouteManifest
function createRouteScanCache(): RouteScanCache
function createRouteConflictError(diagnostics: RouteDiagnostic[]): RouteConflictError

class RouteConflictError extends Error {
  code: "ROUTE_CONFLICT";
  conflicts: RouteConflict[];
  diagnostics: RouteDiagnostic[];
}

interface RouteStaticInfo {
  exportNames: string[];
  hasMetadata?: boolean;
  renderMode?: "ssr" | "ssg" | "isr" | "streaming";
  revalidate?: number;
  hasGenerateStaticParams?: boolean;
}
```

---

## @zauso-ai/capstan-db

Database layer with model definitions, schema generation, migrations, and CRUD route scaffolding.

### defineModel(name, config)

```typescript
function defineModel(name: string, config: {
  fields: Record<string, FieldDefinition>;
  relations?: Record<string, RelationDefinition>;
  indexes?: IndexDefinition[];
}): ModelDefinition
```

### Field Helpers

```typescript
const field: {
  id(): FieldDefinition;
  string(opts?: FieldOptions): FieldDefinition;
  text(opts?: FieldOptions): FieldDefinition;
  integer(opts?: FieldOptions): FieldDefinition;
  number(opts?: FieldOptions): FieldDefinition;
  boolean(opts?: FieldOptions): FieldDefinition;
  date(opts?: FieldOptions): FieldDefinition;
  datetime(opts?: FieldOptions): FieldDefinition;
  json<T = unknown>(opts?: FieldOptions): FieldDefinition;
  enum(values: readonly string[], opts?: FieldOptions): FieldDefinition;
  vector(dimensions: number): FieldDefinition;
}

const relation: {
  belongsTo(model: string, opts?: { foreignKey?: string; through?: string }): RelationDefinition;
  hasMany(model: string, opts?: { foreignKey?: string; through?: string }): RelationDefinition;
  hasOne(model: string, opts?: { foreignKey?: string; through?: string }): RelationDefinition;
  manyToMany(model: string, opts?: { foreignKey?: string; through?: string }): RelationDefinition;
}
```

### Database & Migrations

```typescript
function createDatabase(config: { provider: "sqlite" | "postgres" | "mysql"; url: string }): Promise<DatabaseInstance>
function generateMigration(fromModels: ModelDefinition[], toModels: ModelDefinition[]): string[]
function applyMigration(db: { $client: { exec: (sql: string) => void } }, sql: string[]): void
function ensureTrackingTable(client: MigrationDbClient, provider?: DbProvider): void
function getAppliedMigrations(client: MigrationDbClient): string[]
function getMigrationStatus(client: MigrationDbClient, allMigrationNames: string[], provider?: DbProvider): MigrationStatus
function applyTrackedMigrations(client: MigrationDbClient, migrations: Array<{ name: string; sql: string }>, provider?: DbProvider): string[]
function generateCrudRoutes(model: ModelDefinition): CrudRouteFiles[]
function generateDrizzleSchema(models: ModelDefinition[], provider: DbProvider): Record<string, DrizzleTable>
```

### Embedding & Vector Search

```typescript
function defineEmbedding(modelName: string, config: { dimensions: number; adapter: EmbeddingAdapter }): EmbeddingInstance
function openaiEmbeddings(opts: { apiKey: string; model?: string; baseUrl?: string }): EmbeddingAdapter
function cosineDistance(a: number[], b: number[]): number
function findNearest(query: number[], items: { id: string; vector: number[] }[], k: number): { id: string; score: number }[]
function hybridSearch(query: string, queryVector: number[], items: { id: string; text: string; vector: number[] }[], opts?: HybridSearchOptions): { id: string; score: number }[]
// HybridSearchOptions: { k?: number; keywordWeight?: number; vectorWeight?: number; bm25?: { k1?: number; b?: number } }
function setTokenizer(tokenizer?: (text: string) => string[]): void  // override the keyword tokeniser; call with no arg to reset
type Tokenizer = (text: string) => string[]
```

`hybridSearch` fuses **Okapi BM25** keyword relevance with vector cosine similarity. The keyword component is real BM25 — term-frequency saturation (`k1`, default 1.5), document-length normalisation (`b`, default 0.75), and probabilistic IDF computed over the candidate `items` — normalised to [0, 1] and combined via `keywordWeight` / `vectorWeight` (default 0.3 / 0.7).

**Tokenisation.** The keyword side tokenises with the runtime's built-in `Intl.Segmenter` (ICU word segmentation): it segments CJK / Japanese / Thai by dictionary (`机器学习` → `机器` / `学习`) as well as space-delimited languages, keeps numbers, and splits code identifiers / filenames on internal punctuation (`config.yaml` → `config` / `yaml`) — no extra dependency. To use a dictionary segmenter such as jieba, call `setTokenizer` once at startup (the same hook is exported from `@zauso-ai/capstan-ai` for memory recall):

```typescript
import { setTokenizer } from "@zauso-ai/capstan-db";
import { cut } from "@node-rs/jieba";
setTokenizer((text) => cut(text.toLowerCase(), true)); // HMM segmentation
```

### Data Preparation

```typescript
function prepareCreateData(model: ModelDefinition, input: Record<string, unknown>): Record<string, unknown>
function prepareUpdateData(model: ModelDefinition, input: Record<string, unknown>): Record<string, unknown>
```

### Database Runtime

```typescript
function createDatabaseRuntime(db: DrizzleClient, schema: Record<string, DrizzleTable>): DatabaseRuntime
function createCrudRepository(db: DrizzleClient, model: ModelDefinition, table: DrizzleTable): CrudRepository
function createCrudRuntime(db: DrizzleClient, models: ModelDefinition[], schema: Record<string, DrizzleTable>): CrudRuntime
```

### Types

```typescript
type ScalarType = "string" | "integer" | "number" | "boolean" | "date" | "datetime" | "text" | "json";
type DbProvider = "sqlite" | "postgres" | "mysql";
type RelationKind = "belongsTo" | "hasMany" | "hasOne" | "manyToMany";

interface FieldDefinition {
  type: ScalarType;
  required?: boolean;
  unique?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  enum?: readonly string[];
  updatedAt?: boolean;
  autoId?: boolean;
  references?: string;
}

interface RelationDefinition {
  kind: RelationKind;
  model: string;
  foreignKey?: string;
  through?: string;
}

interface IndexDefinition {
  fields: string[];
  unique?: boolean;
  order?: "asc" | "desc";
}

interface ModelDefinition {
  name: string;
  fields: Record<string, FieldDefinition>;
  relations: Record<string, RelationDefinition>;
  indexes: IndexDefinition[];
}
```

---

## @zauso-ai/capstan-auth

Authentication and authorization: JWT sessions, API keys, OAuth, DPoP, SPIFFE/mTLS, grants.

### Session Management

```typescript
function signSession(payload: Omit<SessionPayload, "iat" | "exp">, secret: string, maxAge?: string): string
function verifySession(token: string, secret: string): SessionPayload | null

interface SessionPayload {
  userId: string; email?: string; role?: string; iat: number; exp: number;
}
```

### API Keys

```typescript
function generateApiKey(prefix?: string): { key: string; hash: string; prefix: string }
function verifyApiKey(key: string, storedHash: string): Promise<boolean>
function extractApiKeyPrefix(key: string): string
```

### Auth Middleware

```typescript
function createAuthMiddleware(config: AuthConfig, deps: AuthResolverDeps): (request: Request) => Promise<AuthContext>

interface AuthConfig {
  session: { secret: string; maxAge?: string };
  apiKeys?: { prefix?: string; headerName?: string };
}
```

### Permissions

```typescript
function checkPermission(required: { resource: string; action: "read" | "write" | "delete" }, granted: string[]): boolean
function derivePermission(capability: "read" | "write" | "external", resource?: string): { resource: string; action: string }
```

### OAuth

```typescript
function googleProvider(opts: { clientId: string; clientSecret: string }): OAuthProvider
function githubProvider(opts: { clientId: string; clientSecret: string }): OAuthProvider
function createOAuthHandlers(config: OAuthConfig, fetchFn?: typeof fetch): OAuthHandlers

interface OAuthHandlers {
  login: (request: Request, providerName: string) => Response;
  callback: (request: Request) => Promise<Response>;
}
```

### Grant-Based Authorization

```typescript
function authorizeGrant(required: AuthGrant, granted: AuthGrant[]): AuthorizationDecision
function checkGrant(required: AuthGrant, granted: AuthGrant[]): boolean
function normalizePermissionsToGrants(permissions: (string | AuthGrant)[]): AuthGrant[]
function createGrant(resource: string, action: string, scope?: Record<string, string>): AuthGrant

interface AuthGrant { resource: string; action: string; scope?: Record<string, string> }
```

Runtime grant helpers:

```typescript
function grantRunActions(actions?: string[], runId?: string): AuthGrant[]
function grantRunCollectionActions(actions?: string[]): AuthGrant[]
function grantApprovalActions(actions?: string[], approvalId?: string): AuthGrant[]
function grantApprovalCollectionActions(actions?: string[]): AuthGrant[]
function grantEventActions(actions?: string[]): AuthGrant[]
function grantArtifactActions(actions?: string[]): AuthGrant[]
function grantCheckpointActions(actions?: string[]): AuthGrant[]
function grantTaskActions(actions?: string[]): AuthGrant[]
function grantSummaryActions(actions?: string[]): AuthGrant[]
function grantMemoryActions(actions?: string[]): AuthGrant[]
function grantContextActions(actions?: string[]): AuthGrant[]
function grantRuntimePathsActions(actions?: string[]): AuthGrant[]
```

Runtime authorizer:

```typescript
function deriveRuntimeGrantRequirements(request: RuntimeActionRequest): AuthGrant[]
function authorizeRuntimeAction(request: RuntimeActionRequest, granted: AuthGrant[]): AuthorizationResult
function createRuntimeGrantAuthorizer(granted: AuthGrant[]): RuntimeGrantAuthorizer
function createHarnessGrantAuthorizer(granted: AuthGrant[]): HarnessGrantAuthorizer
```

Execution identity:

```typescript
function createExecutionIdentity(kind: string, source: string): ExecutionIdentity
function createRequestExecution(request: Request): ExecutionIdentity
function createDelegationLink(from: Identity, to: Identity): DelegationLink
```

### DPoP & Workload Identity

```typescript
function validateDpopProof(proof: string, options: DpopValidationOptions): Promise<DpopResult>
function extractWorkloadIdentity(certOrClaim: string): WorkloadIdentity | null
function isValidSpiffeId(uri: string): boolean
```

---

## @zauso-ai/capstan-agent

Multi-protocol adapter layer: CapabilityRegistry, MCP server, A2A handler, OpenAPI spec, LangChain tools.

### CapabilityRegistry

```typescript
class CapabilityRegistry {
  constructor(config: AgentConfig);
  register(route: RouteRegistryEntry): void;
  registerAll(routes: RouteRegistryEntry[]): void;
  getRoutes(): readonly RouteRegistryEntry[];
  getConfig(): Readonly<AgentConfig>;
  toManifest(): AgentManifest;
  toOpenApi(): Record<string, unknown>;
  toMcp(executeRoute: RouteExecutor): { server: McpServer; getToolDefinitions: () => ToolDef[] };
  toA2A(executeRoute: RouteExecutor): { handleRequest: (body: unknown) => Promise<unknown>; getAgentCard: () => A2AAgentCard };
}
```

### LLM Providers

Built-in LLM provider adapters for `@zauso-ai/capstan-ai`.

```typescript
function openaiProvider(config: {
  apiKey: string;
  baseUrl?: string;  // default: "https://api.openai.com/v1"
  model?: string;    // default: "gpt-4o"
}): LLMProvider

function anthropicProvider(config: {
  apiKey: string;
  model?: string;    // default: "claude-sonnet-4-20250514"
  baseUrl?: string;  // default: "https://api.anthropic.com/v1"
}): LLMProvider
```

`openaiProvider` works with any OpenAI-compatible API (OpenAI, Azure OpenAI, Ollama, etc.) by setting `baseUrl`. Supports both `chat()` and `stream()`.

### MCP

```typescript
function createMcpServer(
  config: AgentConfig,
  routes: RouteRegistryEntry[],
  executeRoute: RouteExecutor,
): { server: McpServer; getToolDefinitions: () => ToolDef[] }

function serveMcpStdio(server: McpServer): Promise<void>

function routeToToolName(method: string, path: string): string
// GET /tickets -> get_tickets, GET /tickets/:id -> get_tickets_by_id

function createMcpClient(options: McpClientOptions): McpClient

interface McpClientOptions {
  url: string;                         // Streamable HTTP endpoint
  serverId?: string;                   // Stable source identity; derived from url by default
  authorization?: string;              // Authorization header value
  clientName?: string;                 // MCP client identity
}

interface McpTool {
  serverId: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpClient {
  readonly serverId: string;
  listTools(): Promise<McpTool[]>;
  onToolsChanged(listener: (tools: McpTool[]) => void | Promise<void>): () => void;
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

class McpTestHarness {
  constructor(registry: CapabilityRegistry);
  listTools(): ToolDef[];
  callTool(name: string, args?: unknown): Promise<unknown>;
}
```

`listTools()` follows `nextCursor` until the full catalog is loaded.
`onToolsChanged()` listens for `notifications/tools/list_changed`, refetches all
pages, and supplies a complete replacement snapshot for `serverId`.

### A2A

```typescript
function createA2AHandler(config: AgentConfig, routes: RouteRegistryEntry[], executeRoute: RouteExecutor): { handleRequest: (body: unknown) => Promise<A2AJsonRpcResponse>; getAgentCard: () => A2AAgentCard }
function generateA2AAgentCard(config: AgentConfig, routes: RouteRegistryEntry[]): A2AAgentCard
```

### OpenAPI

```typescript
function generateOpenApiSpec(config: AgentConfig, routes: RouteRegistryEntry[]): Record<string, unknown>
```

### LangChain

```typescript
function toLangChainTools(registry: CapabilityRegistry, options?: { filter?: (route: RouteRegistryEntry) => boolean }): StructuredTool[]
```

### Types

```typescript
interface AgentManifest {
  capstan: string; name: string; description?: string; baseUrl?: string;
  authentication: { schemes: Array<{ type: "bearer"; name: string; header: string; description: string }> };
  resources: Array<{ key: string; title: string; description?: string; fields: Record<string, { type: string; required?: boolean; enum?: string[] }> }>;
  capabilities: Array<{ key: string; title: string; description?: string; mode: "read" | "write" | "external"; resource?: string; endpoint: { method: string; path: string; inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown> }; policy?: string }>;
  mcp?: { endpoint: string; transport: string };
}

interface RouteRegistryEntry {
  method: string; path: string; description?: string;
  capability?: "read" | "write" | "external"; resource?: string; policy?: string;
  inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown>;
}

interface AgentConfig {
  name: string; description?: string; baseUrl?: string;
  resources?: Array<{ key: string; title: string; description?: string; fields: Record<string, { type: string; required?: boolean; enum?: string[] }> }>;
}
```

---

## @zauso-ai/capstan-react

React SSR with loaders, layouts, hydration, Image, Font, Metadata, and ErrorBoundary.

### Rendering

```typescript
function renderPage(options: RenderPageOptions): Promise<RenderResult>
function renderPartialStream(options: RenderPageOptions): Promise<RenderStreamResult>
```

### Data Loading

```typescript
function defineLoader(loader: LoaderFunction): LoaderFunction
function useLoaderData<T = unknown>(): T

type LoaderFunction = (args: { params: Record<string, string>; request: Request }) => Promise<unknown>;
```

### Layout & Routing

```typescript
function Outlet(): JSX.Element
function OutletProvider(props: { children: React.ReactNode }): JSX.Element
function ServerOnly(props: { children: React.ReactNode }): JSX.Element | null
function ClientOnly(props: { children: React.ReactNode; fallback?: React.ReactNode }): JSX.Element
function serverOnly(): void
function useAuth(): CapstanAuthContext
function useParams(): Record<string, string>
function hydrateCapstanPage(): void
```

**Usage:**

```typescript
import { ClientOnly, ServerOnly } from "@zauso-ai/capstan-react";

export default function Page() {
  return (
    <div>
      <ServerOnly><AnalyticsTag /></ServerOnly>
      <ClientOnly fallback={<p>Loading...</p>}>
        <RichTextEditor />
      </ClientOnly>
    </div>
  );
}
```

### Image

```typescript
function Image(props: ImageProps): ReactElement

interface ImageProps {
  src: string; alt: string; width?: number; height?: number;
  priority?: boolean; quality?: number; placeholder?: "blur" | "empty";
  blurDataURL?: string; sizes?: string; loading?: "lazy" | "eager";
  className?: string; style?: Record<string, string | number>;
}
```

### Font

```typescript
function defineFont(config: FontConfig): FontResult

interface FontConfig {
  family: string; src?: string; weight?: string | number; style?: string;
  display?: "auto" | "block" | "swap" | "fallback" | "optional";
  preload?: boolean; subsets?: string[]; variable?: string;
}

interface FontResult { className: string; style: { fontFamily: string }; variable?: string }
```

### Metadata

```typescript
function defineMetadata(metadata: Metadata): Metadata
function generateMetadataElements(metadata: Metadata): ReactElement[]
function mergeMetadata(parent: Metadata, child: Metadata): Metadata

interface Metadata {
  title?: string | { default: string; template?: string };
  description?: string; keywords?: string[];
  robots?: string | { index?: boolean; follow?: boolean };
  openGraph?: { title?: string; description?: string; type?: string; url?: string; image?: string; siteName?: string };
  twitter?: { card?: "summary" | "summary_large_image"; title?: string; description?: string; image?: string };
  icons?: { icon?: string; apple?: string };
  canonical?: string; alternates?: Record<string, string>;
}
```

### Error Boundaries

```typescript
class ErrorBoundary extends Component<ErrorBoundaryProps> {}

interface ErrorBoundaryProps {
  fallback: ReactElement | ((error: Error, reset: () => void) => ReactElement);
  children?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

function NotFound(): ReactElement
```

**Usage:**

```typescript
import { ErrorBoundary } from "@zauso-ai/capstan-react";

<ErrorBoundary fallback={(error, reset) => (
  <div>
    <p>Something went wrong: {error.message}</p>
    <button onClick={reset}>Try again</button>
  </div>
)}>
  <MyComponent />
</ErrorBoundary>
```

### Render Strategies

```typescript
type RenderMode = "ssr" | "ssg" | "isr" | "streaming"

class SSRStrategy implements RenderStrategy {}
class ISRStrategy implements RenderStrategy {}
class SSGStrategy implements RenderStrategy { constructor(staticDir?: string) }
function createStrategy(mode: RenderMode, opts?: { staticDir?: string }): RenderStrategy
```

### Client-Side Router (`@zauso-ai/capstan-react/client`)

```typescript
function Link(props: LinkProps): ReactElement
function useNavigate(): (url: string, opts?: { replace?: boolean; scroll?: boolean }) => void
function useRouterState(): RouterState
function bootstrapClient(): void

class CapstanRouter {
  readonly state: RouterState;
  navigate(url: string, opts?: NavigateOptions): Promise<void>;
  prefetch(url: string): Promise<void>;
  subscribe(listener: (state: RouterState) => void): () => void;
  destroy(): void;
}

function NavigationProvider(props: { children: ReactNode; initialLoaderData?: unknown; initialParams?: Record<string, string> }): ReactElement

class NavigationCache {
  constructor(maxSize?: number, ttlMs?: number);  // defaults: 50, 5min
  get(url: string): NavigationPayload | undefined;
  set(url: string, payload: NavigationPayload): void;
  has(url: string): boolean;
  delete(url: string): boolean;
  clear(): void;
  readonly size: number;
}

class PrefetchManager {
  observe(element: Element, strategy: PrefetchStrategy): void;
  unobserve(element: Element): void;
  destroy(): void;
}

function withViewTransition(fn: () => void | Promise<void>): Promise<void>
function getManifest(): ClientRouteManifest | null
function initRouter(manifest: ClientRouteManifest): CapstanRouter

type PrefetchStrategy = "none" | "hover" | "viewport";
interface RouterState { url: string; status: "idle" | "loading" | "error"; error?: Error }
interface NavigateOptions { replace?: boolean; state?: unknown; scroll?: boolean; noCache?: boolean }
```

Prefetch strategies: `"viewport"` (IntersectionObserver, 200px margin), `"hover"` (80ms delay), `"none"`.

**Usage:**

```typescript
import { Link, useNavigate } from "@zauso-ai/capstan-react/client";

<Link href="/about">About</Link>
<Link href="/posts" prefetch="viewport">Posts</Link>
```

---

## @zauso-ai/capstan-cron

Recurring job scheduler for Capstan AI workflows.

```typescript
function defineCron(config: CronJobConfig): CronJobConfig
function createCronRunner(): CronRunner
function createBunCronRunner(): CronRunner
function createAgentCron(config: AgentCronConfig): CronJobConfig

interface CronJobConfig {
  name: string;
  pattern: string;
  handler: () => Promise<void>;
  timezone?: string;
  maxConcurrent?: number;
  onError?: (err: Error) => void;
  enabled?: boolean;
}

interface CronRunner {
  add(config: CronJobConfig): string;
  remove(id: string): boolean;
  start(): void;
  stop(): void;
  getJobs(): CronJobInfo[];
}

interface AgentCronConfig {
  cron: string;
  name: string;
  goal: string | (() => string);
  timezone?: string;
  llm?: unknown;
  harnessConfig?: Record<string, unknown>;
  run?: {
    about?: [string, string];
    maxIterations?: number;
    memory?: boolean;
    systemPrompt?: string;
    excludeRoutes?: string[];
  };
  triggerMetadata?: Record<string, unknown>;
  runtime?: {
    harness?: { startRun(config: unknown, options?: unknown): Promise<{ runId: string; result: Promise<unknown> }> };
    createHarness?: () => Promise<{ startRun(config: unknown, options?: unknown): Promise<{ runId: string; result: Promise<unknown> }> }>;
    reuseHarness?: boolean;
  };
  onQueued?: (meta: { runId: string; trigger: unknown }) => void;
  onResult?: (result: unknown, meta: { runId: string; trigger: unknown }) => void;
  onError?: (err: Error) => void;
}
```

`createCronRunner()` approximates cron patterns as intervals -- suitable for `*/N` minute/hour schedules. `createBunCronRunner()` uses Bun's native cron when available, falling back to the interval runner.

**Usage:**

```typescript
import { createCronRunner, createAgentCron } from "@zauso-ai/capstan-cron";

const runner = createCronRunner();
runner.add(createAgentCron({
  cron: "0 */2 * * *",
  name: "price-monitor",
  goal: "Check storefront and refresh report",
  runtime: { harness },
}));
runner.start();
```

---

## @zauso-ai/capstan-dev

Development server, Vite build pipeline, CSS processing, and deployment adapters.

### Dev Server

```typescript
function createDevServer(config: DevServerConfig): Promise<DevServerInstance>
function watchRoutes(routesDir: string, callback: () => void): void
function loadRouteModule(filePath: string): Promise<unknown>
function loadApiHandlers(filePath: string): Promise<Record<string, APIDefinition>>
function loadPageModule(filePath: string): Promise<PageModule>
function printStartupBanner(config: { port: number; routes: number }): void
```

### Vite Integration

```typescript
function createViteConfig(config: CapstanViteConfig): Record<string, unknown>
function createViteDevMiddleware(config: CapstanViteConfig): Promise<{ middleware: unknown; close: () => Promise<void> } | null>
function buildClient(config: CapstanViteConfig): Promise<void>
```

### CSS Pipeline

```typescript
function buildCSS(entryFile: string, outFile: string, isDev?: boolean): Promise<void>
function detectCSSMode(rootDir: string): "tailwind" | "lightningcss" | "none"
function buildTailwind(entryFile: string, outFile: string): Promise<void>
function startTailwindWatch(entryFile: string, outFile: string): ChildProcess
```

### Static Site Generation

```typescript
function buildStaticPages(options: BuildStaticOptions): Promise<BuildStaticResult>
```

### Deployment Adapters

```typescript
function createCloudflareHandler(app: { fetch: (req: Request) => Promise<Response> }): ExportedHandler
function createVercelHandler(app: { fetch: (req: Request) => Promise<Response> }): (req: Request) => Promise<Response>
function createVercelNodeHandler(app: { fetch: (req: Request) => Promise<Response> }): (req: IncomingMessage, res: ServerResponse) => Promise<void>
function createFlyAdapter(config?: FlyConfig): ServerAdapter
function createNodeAdapter(): ServerAdapter
function createBunAdapter(): ServerAdapter

function generateVercelConfig(): object
function generateFlyToml(config?: FlyConfig): string
function generateWranglerConfig(name: string): string
```

### Page Fetch

In-process fetch client for page loaders (avoids HTTP round-trips).

```typescript
function createPageFetch(request: Request, options?: PageFetchOptions): PageFetchClient

interface PageFetchClient {
  get(path: string, init?: RequestInit): Promise<Response>;
  post(path: string, body?: unknown, init?: RequestInit): Promise<Response>;
  put(path: string, body?: unknown, init?: RequestInit): Promise<Response>;
  delete(path: string, init?: RequestInit): Promise<Response>;
}
```

### Route Middleware

```typescript
function loadRouteMiddleware(filePath: string): Promise<MiddlewareHandler>
function loadRouteMiddlewares(filePaths: string[]): Promise<MiddlewareHandler[]>
function composeRouteMiddlewares(middlewares: MiddlewareHandler[], handler: RouteHandler): RouteHandler
function runRouteMiddlewares(filePaths: string[], args: RouteHandlerArgs, handler: RouteHandler): Promise<Response>
```

### Portable Runtime

```typescript
function buildPortableRuntimeApp(config: PortableRuntimeConfig): RuntimeAppBuild
```

### Virtual Route Modules (Testing)

```typescript
function registerVirtualRouteModule(filePath: string, mod: unknown): void
function registerVirtualRouteModules(modules: Map<string, unknown>): void
function clearVirtualRouteModules(filePath?: string): void
```

---

## @zauso-ai/capstan-cli

Command-line interface for development, building, deployment, verification, and operations.

### Development

```bash
capstan dev [--port <number>] [--host <string>]    # Start dev server with live reload
capstan build [--static] [--target <target>]       # Build for production
capstan start [--from <dir>] [--port <n>]          # Start production server
```

Build targets: `node-standalone`, `docker`, `vercel-node`, `vercel-edge`, `cloudflare`, `fly`.

### Scaffolding

```bash
capstan add model <name>    # app/models/<name>.model.ts
capstan add api <name>      # app/routes/<name>/index.api.ts
capstan add page <name>     # app/routes/<name>/index.page.tsx
capstan add policy <name>   # app/policies/index.ts (appends)
```

### Database

```bash
capstan db:migrate --name <migration-name>  # Generate migration SQL
capstan db:push                             # Apply pending migrations
capstan db:status                           # Show migration status
```

### Verification

```bash
capstan verify [<path>] [--json] [--deployment] [--target <target>]
```

8-step cascade: structure, config, routes, models, typecheck, contracts, manifest, cross-protocol. Output includes `repairChecklist` with `fixCategory` and `autoFixable` for AI consumption.

### Agent / Protocol

```bash
capstan mcp                # Start MCP server via stdio
capstan agent:manifest     # Print agent manifest JSON
capstan agent:openapi      # Print OpenAPI 3.1 spec JSON
```

### Operations

```bash
capstan ops:events [<path>] [--kind <kind>] [--severity <s>] [--limit <n>] [--json]
capstan ops:incidents [<path>] [--status <status>] [--severity <s>] [--json]
capstan ops:health [<path>] [--json]
capstan ops:tail [<path>] [--limit <n>] [--follow] [--json]
```

### Harness Runtime

```bash
capstan harness:list                           # List persisted runs
capstan harness:get <runId>                    # Read one run record
capstan harness:events [<runId>]               # Read runtime events
capstan harness:artifacts <runId>              # List artifacts
capstan harness:checkpoint <runId>             # Read loop checkpoint
capstan harness:approval <approvalId>          # Read one approval
capstan harness:approvals [<runId>]            # List approvals
capstan harness:approve <runId> [--note <t>]   # Approve blocked run
capstan harness:deny <runId> [--note <t>]      # Deny and cancel
capstan harness:pause <runId>                  # Request cooperative pause
capstan harness:cancel <runId>                 # Request cancellation
capstan harness:replay <runId>                 # Replay events and verify
capstan harness:paths                          # Print filesystem paths
```

All harness commands accept `--root <dir>`, `--grants <json>`, `--subject <json>`, `--json`.

### Deployment

```bash
capstan deploy:init [--target <target>] [--force]
```

Targets: `docker`, `vercel-node`, `vercel-edge`, `cloudflare`, `fly`.

---

## create-capstan-app

Project scaffolder CLI.

```bash
npx create-capstan-app                          # Interactive mode
npx create-capstan-app my-app --template blank  # Non-interactive
npx create-capstan-app my-app --template tickets --deploy docker
```

### Templates

| Template  | Includes |
| --------- | -------- |
| `blank`   | Health check API, home page, root layout, requireAuth policy, AGENTS.md |
| `tickets` | Everything in blank + Ticket model, CRUD routes, auth config, database config |

### Programmatic API

```typescript
function scaffoldProject(config: {
  projectName: string;
  template: "blank" | "tickets";
  outputDir: string;
}): Promise<void>

type DeployTarget = "none" | "docker" | "vercel-node" | "vercel-edge" | "cloudflare" | "fly"
```

### Template Generators

```typescript
function packageJson(projectName: string, template?: Template): string
function tsconfig(): string
function capstanConfig(projectName: string, title: string, template?: Template): string
function rootLayout(title: string): string
function indexPage(title: string, projectName: string, template?: Template): string
function healthApi(): string
function policiesIndex(): string
function gitignore(): string
function dockerfile(): string
function envExample(): string
function mainCss(): string
function agentsMd(projectName: string, template: Template): string
```

Template-specific (tickets):

```typescript
function ticketModel(): string
function ticketsIndexApi(): string
function ticketByIdApi(): string
```

Deployment config generators:

```typescript
function flyDockerfile(): string
function flyToml(appName: string): string
function vercelConfig(target: "vercel-node" | "vercel-edge"): string
function wranglerConfig(appName: string): string
```

### Interactive Prompts

```typescript
function runPrompts(): Promise<{ projectName: string; template: Template; deploy: DeployTarget }>
function detectPackageManagerRuntime(isBun?: boolean): PackageManagerRuntime

interface PackageManagerRuntime {
  installCommand: string;
  runCommand: string;
  devCommand: string;
}
```
