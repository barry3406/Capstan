// === LLM Types ===
export interface MemoryEmbedder { embed(texts: string[]): Promise<number[][]>; dimensions: number; }

/** Multimodal content part. Inline base64 is preferred for images so the
 * downstream provider has no separate fetch. */
export type LLMContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string };

/** A single conversation message. Content can be a plain string (legacy /
 * cheap path) or an array of multimodal parts (text + image). */
export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string | LLMContentPart[];
}

export interface LLMResponse { content: string; model: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined; finishReason?: string | undefined; toolCalls?: { id: string; name: string; args: Record<string, unknown> }[] | undefined; }
/** Native tool calls are carried ONLY on the terminal `done:true` chunk. */
export interface LLMStreamChunk { content: string; done: boolean; finishReason?: string | undefined; toolCalls?: { id: string; name: string; args: Record<string, unknown> }[] | undefined; }

/** Tool spec passed to the LLM provider. The provider can use this to
 * advertise native function calling (OpenAI / Anthropic) so the model
 * picks tool names from the canonical list instead of hallucinating. */
export interface LLMToolSpec {
  name: string;
  description: string;
  parameters?: Record<string, unknown> | undefined;
}

export interface LLMOptions {
  model?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  systemPrompt?: string | undefined;
  responseFormat?: Record<string, unknown> | undefined;
  signal?: AbortSignal | undefined;
  /** Tools available this turn. Native-function-call providers will
   * present them; text-only providers may ignore. */
  tools?: LLMToolSpec[] | undefined;
}
export interface LLMProvider {
  name: string;
  chat(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse>;
  stream?(messages: LLMMessage[], options?: LLMOptions): AsyncIterable<LLMStreamChunk>;
  /** When `"terminal"`, the provider parses native tool calls and surfaces them
   * on the terminal stream chunk's `toolCalls` (and on chat() `LLMResponse.toolCalls`).
   * The loop uses this to DEFER tool dispatch to stream-end for native providers,
   * while text-only providers (flag absent) keep mid-stream eager dispatch. */
  nativeToolCalls?: "terminal" | undefined;
}

// === Think/Generate (unchanged) ===
export interface ThinkOptions<T = unknown> { schema?: { parse: (data: unknown) => T } | undefined; model?: string | undefined; temperature?: number | undefined; maxTokens?: number | undefined; systemPrompt?: string | undefined; }
export interface GenerateOptions { model?: string | undefined; temperature?: number | undefined; maxTokens?: number | undefined; systemPrompt?: string | undefined; }

// === Memory Types (simplified — NO importance, type, accessCount, lastAccessedAt, updatedAt) ===
export interface MemoryEntry {
  id: string;
  content: string;
  scope: MemoryScope;
  embedding?: number[] | undefined;
  createdAt: string;
  importance?: string | undefined;
  type?: string | undefined;
  accessCount?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

// === Memory Accessor Types ===
export interface RememberOptions {
  scope?: MemoryScope | undefined;
  importance?: string | undefined;
  type?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}
export interface RecallOptions {
  scope?: MemoryScope | undefined;
  limit?: number | undefined;
}
export interface AssembleContextOptions {
  query: string;
  maxTokens?: number | undefined;
  scopes?: MemoryScope[] | undefined;
}
export interface MemoryAccessor {
  remember(content: string, opts?: RememberOptions): Promise<string>;
  recall(query: string, opts?: RecallOptions): Promise<MemoryEntry[]>;
  forget(entryId: string): Promise<boolean>;
  about(type: string, id: string): MemoryAccessor;
  assembleContext(opts: AssembleContextOptions): Promise<string>;
}
export interface MemoryScope { type: string; id: string; }
export interface MemoryBackend {
  store(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<string>;
  query(scope: MemoryScope, text: string, k: number): Promise<MemoryEntry[]>;
  remove(id: string): Promise<boolean>;
  clear(scope: MemoryScope): Promise<void>;
}

// === Agent Tool/Task Types ===
export interface AgentTool {
  name: string;
  description: string;
  parameters?: Record<string, unknown> | undefined;
  isConcurrencySafe?: boolean | undefined;
  failureMode?: "soft" | "hard" | undefined;
  execute(args: Record<string, unknown>): Promise<unknown>;
  validate?: ((args: Record<string, unknown>) => { valid: boolean; error?: string }) | undefined;
  timeout?: number | undefined;
}
export type AgentTaskKind = "shell" | "workflow" | "remote" | "subagent" | "custom";
export interface AgentTaskExecutionContext {
  signal: AbortSignal;
  runId?: string | undefined;
  requestId: string;
  taskId: string;
  order: number;
  callStack?: ReadonlySet<string> | undefined;
}
export interface AgentTask {
  name: string;
  description: string;
  kind?: AgentTaskKind | undefined;
  parameters?: Record<string, unknown> | undefined;
  isConcurrencySafe?: boolean | undefined;
  failureMode?: "soft" | "hard" | undefined;
  execute(args: Record<string, unknown>, context: AgentTaskExecutionContext): Promise<unknown>;
}
export interface AgentToolCallRecord {
  tool: string;
  args: unknown;
  result: unknown;
  requestId?: string | undefined;
  order?: number | undefined;
  status?: "success" | "error" | undefined;
}
export interface AgentTaskCallRecord {
  task: string;
  args: unknown;
  result: unknown;
  requestId?: string | undefined;
  taskId?: string | undefined;
  order?: number | undefined;
  status?: "success" | "error" | "canceled" | undefined;
  kind?: AgentTaskKind | undefined;
}

// === Tool Request (used by streaming-executor, engine) ===
export interface ToolRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
  order: number;
}

// === Agent Run Status ===
export type AgentRunStatus = "completed" | "max_iterations" | "approval_required" | "paused" | "canceled" | "fatal";

// === Model Finish Reason ===
export type ModelFinishReason = "stop" | "tool_use" | "max_output_tokens" | "context_limit" | "error";

// === Checkpoint ===
export interface AgentCheckpoint {
  stage: "initialized" | "tool_result" | "task_wait" | "approval_required" | "paused" | "completed" | "max_iterations" | "canceled";
  goal: string | LLMContentPart[];
  messages: LLMMessage[];
  iterations: number;
  toolCalls: AgentToolCallRecord[];
  taskCalls: AgentTaskCallRecord[];
  maxOutputTokens: number;
  compaction: {
    autocompactFailures: number;
    reactiveCompactRetries: number;
    tokenEscalations: number;
  };
  pendingApproval?: { kind: "tool" | "task"; tool: string; args: unknown; reason: string } | undefined;
}

// === Stop Hook Types ===
export interface StopHook {
  name: string;
  evaluate(context: StopHookContext): Promise<StopHookResult>;
}
export interface StopHookContext {
  response: string;
  messages: LLMMessage[];
  toolCalls: AgentToolCallRecord[];
  goal: string;
}
export interface StopHookResult {
  pass: boolean;
  feedback?: string | undefined;
}

// === Prompt Composer Types ===
export interface PromptLayer {
  id: string;
  content: string;
  position: "prepend" | "append" | "replace_base";
  priority?: number | undefined;
}
export interface PromptComposerConfig {
  base?: string | undefined;
  layers?: PromptLayer[] | undefined;
  dynamicLayers?: ((context: PromptContext) => PromptLayer[]) | undefined;
}
export interface PromptContext {
  tools: AgentTool[];
  iteration: number;
  memories: string[];
  tokenBudget: number;
}

// === Memory Reconciler ===
export type MemoryOperationAction = "keep" | "supersede" | "revise" | "remove";

export interface MemoryOperation {
  id: string;
  action: MemoryOperationAction;
  reason: string;
  revised?: string | undefined;   // new content when action is "revise"
  context?: string | undefined;   // annotation when action is "keep"
}

export interface ReconcileResult {
  operations: MemoryOperation[];
  newMemories: string[];           // additional memories the LLM wants to create
}

export interface MemoryReconciler {
  reconcile(
    newContent: string,
    existingMemories: MemoryEntry[],
  ): Promise<ReconcileResult>;
}

// === Memory Config ===
export interface SmartAgentMemoryConfig {
  store: MemoryBackend;
  scope: MemoryScope;
  readScopes?: MemoryScope[] | undefined;
  embedding?: MemoryEmbedder | undefined;
  maxMemoryTokens?: number | undefined;
  saveSessionSummary?: boolean | undefined;
  reconciler?: "llm" | MemoryReconciler | undefined;  // "llm" uses the agent's LLM
}

// === Compaction Config ===
export interface SnipConfig { preserveTail: number; }
export interface MicrocompactConfig { maxToolResultChars: number; protectedTail: number; }
export interface AutocompactConfig { threshold: number; maxFailures: number; bufferTokens?: number | undefined; }
/**
 * Tool result clearing(参考 Anthropic `clear_tool_uses_20250919`):压缩时保留最近
 * `keep` 个工具结果完整,更早的工具结果消息内容替换成占位符(只剔返回结果,不动工具
 * 调用本身)。默认启用、keep=3,对齐 Anthropic 官方默认。`enabled: false` 退回旧的
 * microcompact 截断行为。
 */
export interface ToolClearConfig { keep?: number | undefined; enabled?: boolean | undefined; }

// === Streaming Config ===
export interface StreamingExecutorConfig { maxConcurrency: number; }

// === Tool Catalog Config ===
export interface ToolCatalogConfig { deferThreshold: number; }

// === Token Budget ===
export interface TokenBudgetConfig {
  maxOutputTokensPerTurn: number;
  nudgeAtPercent?: number | undefined;
}

// === Tool Result Budget ===
export interface ToolResultBudgetConfig {
  maxChars: number;
  preserveStructure?: boolean | undefined;
  persistDir?: string | undefined;
  maxAggregateCharsPerIteration?: number | undefined;  // default 200_000
}

// === LLM Timeout Config ===
export interface LLMTimeoutConfig {
  chatTimeoutMs?: number | undefined;         // default 120_000
  streamIdleTimeoutMs?: number | undefined;    // default 90_000
  stallWarningMs?: number | undefined;         // default 30_000
}

// === Skill Layer ===
/** A file bundled inside a code-bearing skill directory. */
export interface SkillFile {
  /** Bundle-relative POSIX path (e.g. "scripts/extract.py"). */
  path: string;
  bytes: number;
  /** True if the file has a Unix executable bit set. */
  executable: boolean;
}

export interface AgentSkill {
  name: string;
  description: string;
  trigger: string;
  prompt: string;
  tools?: string[] | undefined;
  source?: "developer" | "evolved" | undefined;
  utility?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
  /** Absolute path to the skill's bundle directory, when the skill carries
   * code/resources (loaded via loadSkill/loadSkillsFrom). Guidance-only skills
   * leave this undefined. */
  bundleDir?: string | undefined;
  /** Manifest of files bundled with the skill (relative to bundleDir). */
  files?: SkillFile[] | undefined;
}

// === Iteration Snapshot ===
export interface IterationSnapshot {
  iteration: number;
  messages: LLMMessage[];
  toolCalls: AgentToolCallRecord[];
  estimatedTokens: number;
}

// === Lifecycle Hooks ===
export interface SmartAgentHooks {
  beforeToolCall?: ((tool: string, args: unknown) => Promise<{ allowed: boolean; reason?: string | undefined }>) | undefined;
  afterToolCall?: ((tool: string, args: unknown, result: unknown, status: "success" | "error") => Promise<void>) | undefined;
  beforeTaskCall?: ((task: string, args: unknown) => Promise<{ allowed: boolean; reason?: string | undefined }>) | undefined;
  afterTaskCall?: ((task: string, args: unknown, result: unknown) => Promise<void>) | undefined;
  onCheckpoint?: ((checkpoint: AgentCheckpoint) => Promise<AgentCheckpoint | void>) | undefined;
  onMemoryEvent?: ((content: string) => Promise<void>) | undefined;
  getControlState?: ((phase: "before_llm" | "before_tool" | "after_tool" | "during_task_wait", checkpoint: AgentCheckpoint) => Promise<{ action: "continue" | "pause" | "cancel"; reason?: string | undefined }>) | undefined;
  onRunComplete?: ((result: AgentRunResult) => Promise<void>) | undefined;
  afterIteration?: ((snapshot: IterationSnapshot) => Promise<void>) | undefined;
}

// === Smart Agent Config ===
export interface SmartAgentConfig {
  llm: LLMProvider;
  tools: AgentTool[];
  tasks?: AgentTask[] | undefined;
  memory?: SmartAgentMemoryConfig | undefined;
  prompt?: PromptComposerConfig | undefined;
  stopHooks?: StopHook[] | undefined;
  maxIterations?: number | undefined;
  contextWindowSize?: number | undefined;
  compaction?: Partial<{ snip: SnipConfig; microcompact: MicrocompactConfig; autocompact: AutocompactConfig; toolClear: ToolClearConfig }> | undefined;
  streaming?: StreamingExecutorConfig | undefined;
  toolCatalog?: ToolCatalogConfig | undefined;
  hooks?: SmartAgentHooks | undefined;
  fallbackLlm?: LLMProvider | undefined;
  tokenBudget?: number | TokenBudgetConfig | undefined;
  toolResultBudget?: ToolResultBudgetConfig | undefined;
  skills?: AgentSkill[] | undefined;
  evolution?: import("./evolution/types.js").EvolutionConfig | undefined;
  llmTimeout?: LLMTimeoutConfig | undefined;
  /**
   * Loop guard(防呆):同一工具用**完全相同的参数**重复调用、未取得进展时,先注入
   * 一条 `[LOOP_GUARD]` 提醒让模型自纠,再到硬上限强制收尾 —— 防止"查不到↔已存在"这类
   * 矛盾把 agent 拖进几十轮空转。只认完全相同参数,合法批量(每次参数不同)/分页不误伤。
   * 默认启用,repeatThreshold=3(提醒)、hardStopThreshold=5(强制收尾)。
   */
  loopGuard?: { enabled?: boolean | undefined; repeatThreshold?: number | undefined; hardStopThreshold?: number | undefined } | undefined;
}

// === Agent Run Result ===
export interface AgentRunResult {
  result: unknown;
  iterations: number;
  toolCalls: AgentToolCallRecord[];
  taskCalls: AgentTaskCallRecord[];
  status: AgentRunStatus;
  error?: string | undefined;
  checkpoint?: AgentCheckpoint | undefined;
  pendingApproval?: { kind: "tool" | "task"; tool: string; args: unknown; reason: string } | undefined;
}

// === Agent Event Types (streaming primitive) ===
export type AgentEvent =
  | { type: "run_start"; goal: string; timestamp: number }
  | { type: "iteration_start"; iteration: number; estimatedTokens: number; timestamp: number }
  | { type: "llm_call_start"; iteration: number; messageCount: number; timestamp: number }
  | { type: "llm_call_end"; iteration: number; content: string; finishReason: string; tokensUsed?: { input: number; output: number } | undefined; durationMs: number; timestamp: number }
  /** Note: emitted after tool execution completes (retrospective notification, not pre-execution signal) */
  | { type: "tool_call_start"; tool: string; args: unknown; iteration: number; timestamp: number }
  | { type: "tool_call_end"; tool: string; args: unknown; result: unknown; status: "success" | "error"; durationMs?: number; iteration: number; timestamp: number }
  | { type: "skill_activated"; skill: string; iteration: number; timestamp: number }
  | { type: "compression"; strategy: "snip" | "microcompact" | "autocompact" | "reactive" | "tool_clear"; tokensBefore: number; tokensAfter: number; timestamp: number }
  | { type: "memory_enrichment"; memoriesInjected: number; iteration: number; timestamp: number }
  | { type: "token_budget_warning"; usedPercent: number; iteration: number; timestamp: number }
  | { type: "model_fallback"; primaryError: string; fallbackModel: string; timestamp: number }
  | { type: "error_recovery"; strategy: string; details: string; timestamp: number }
  | { type: "run_end"; result: AgentRunResult; durationMs: number; timestamp: number };

// === Smart Agent Interface ===
export interface SmartAgent {
  run(goal: string | LLMContentPart[]): Promise<AgentRunResult>;
  stream(goal: string | LLMContentPart[]): AsyncGenerator<AgentEvent, AgentRunResult, undefined>;
  resume(checkpoint: AgentCheckpoint, message: string | LLMContentPart[]): Promise<AgentRunResult>;
  resumeStream(checkpoint: AgentCheckpoint, message: string | LLMContentPart[]): AsyncGenerator<AgentEvent, AgentRunResult, undefined>;
}
