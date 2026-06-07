import type {
  AgentCheckpoint,
  AgentEvent,
  AgentRunResult,
  LLMMessage,
  LLMContentPart,
  SmartAgentConfig,
} from "../types.js";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createEngineState, buildCheckpoint, goalText } from "./state.js";
import { createToolCatalog } from "./tool-catalog.js";
import { composeSystemPrompt } from "./prompt-composer.js";
import { estimateTokens, snipMessages, microcompactMessages, clearStaleToolResults, autocompact } from "./compaction.js";
import { executeModelAndTools } from "./streaming-executor.js";
import { extractImageEnvelope, buildToolResultMessageWithImage } from "./content-helpers.js";
import { runStopHooks } from "./stop-hooks.js";
import {
  decideContinuation,
  getEscalatedMaxTokens,
  applyContinuationPrompt,
  reactiveCompact,
  type ModelOutcome,
} from "./continuation.js";
import { formatSkillDescriptions } from "../skill.js";
import { createSkillTools } from "../skill-bundle.js";
import { memoryFreshnessText } from "./memory-age.js";
import { normalizeMessages } from "./normalize-messages.js";
import { LlmMemoryReconciler, reconcileAndStore } from "../memory-reconciler.js";

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

/** Default threshold (as percent 0-100 of budget) at which to inject a nudge */
const DEFAULT_NUDGE_THRESHOLD = 80;

/** Interval (in iterations) at which dynamic memory enrichment runs */
const MEMORY_ENRICHMENT_INTERVAL = 5;

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function formatToolResult(tool: string, result: unknown, maxChars?: number, persistDir?: string): string {
  // Strip the inline image envelope before serialising — the bytes are huge
  // and meaningless as JSON; the engine surfaces them via a multimodal user
  // message instead.
  const sanitised = stripImageEnvelopeForText(result);
  let json: string;
  try {
    json = JSON.stringify(sanitised, null, 2);
  } catch {
    json = `[Unserializable tool result: ${typeof sanitised}]`;
  }
  if (maxChars === undefined || json.length <= maxChars) {
    return `Tool "${tool}" returned:\n${json}`;
  }

  let persistRef = "";
  if (persistDir) {
    const id = `tr_${crypto.randomUUID().slice(0, 8)}`;
    if (!existsSync(persistDir)) mkdirSync(persistDir, { recursive: true });
    writeFileSync(join(persistDir, `tool-result-${id}.json`), json, "utf-8");
    persistRef = `\nFull result saved. Use read_persisted_result tool with id "${id}" to access.`;
  }

  const truncated = json.slice(0, maxChars);
  return `Tool "${tool}" returned (truncated, ${json.length} chars total):\n${truncated}\n[...${json.length - maxChars} chars omitted]${persistRef}`;
}

/**
 * 稳定序列化(key 排序),用于 loop guard 的调用签名:同一 (tool, args) 不因 key 顺序
 * 不同被当成两次。
 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function stripImageEnvelopeForText(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (
    record["image"] &&
    typeof record["image"] === "object" &&
    !Array.isArray(record["image"])
  ) {
    const img = record["image"] as Record<string, unknown>;
    if (typeof img["base64"] === "string") {
      // Replace base64 with a length marker so the JSON stays compact.
      const { image: _omit, ...rest } = record;
      return {
        ...rest,
        image_inlined: true,
        image_size_bytes: Math.floor((img["base64"] as string).length * 0.75),
      };
    }
  }
  return value;
}

function isContextLimitError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /prompt too long|context limit|context window|token limit|input too large/i.test(msg);
}

/**
 * Estimate output tokens from a model response.
 * Uses usage data if available, otherwise falls back to content length heuristic.
 */
function estimateOutputTokens(outcome: ModelOutcome): number {
  if (outcome.usage?.completionTokens != null && outcome.usage.completionTokens > 0) {
    return outcome.usage.completionTokens;
  }
  // Heuristic: ~4 chars per token
  return Math.ceil(outcome.content.length / 4);
}

/**
 * Simple hash for deduplication of memory content.
 */
function hashContent(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(36);
}

/**
 * Strip thinking block markers from messages before fallback model retry.
 * Thinking signatures are model-bound — replaying them to a different model
 * may cause 400 errors.
 */
function stripThinkingContent(messages: LLMMessage[]): LLMMessage[] {
  return messages.map(m => {
    if (m.role !== "assistant") return m;
    if (typeof m.content !== "string") return m;
    const cleaned = m.content
      .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
      .replace(/<redacted_thinking>[\s\S]*?<\/redacted_thinking>/g, "")
      .trim();
    if (cleaned === m.content) return m;
    return { ...m, content: cleaned || "[thinking content removed for model compatibility]" };
  });
}

/**
 * Store a memory entry, routing through the reconciler when configured.
 * Falls back to direct store when no reconciler is set.
 */
async function storeMemoryWithReconcile(
  config: SmartAgentConfig,
  content: string,
): Promise<void> {
  if (!config.memory) return;

  if (config.memory.reconciler) {
    const reconciler = config.memory.reconciler === "llm"
      ? new LlmMemoryReconciler(config.llm)
      : config.memory.reconciler;
    await reconcileAndStore(config.memory.store, config.memory.scope, content, reconciler);
  } else {
    await config.memory.store.store({ content, scope: config.memory.scope });
  }
}

async function saveSessionSummary(
  config: SmartAgentConfig,
  goal: string,
  iterations: number,
  status: string,
): Promise<void> {
  if (!config.memory?.saveSessionSummary) return;
  try {
    const summary = `Session completed. Goal: ${goal}. Iterations: ${iterations}. Status: ${status}.`;
    await storeMemoryWithReconcile(config, summary);
  } catch {
    // Memory persistence is non-fatal
  }
}

async function retrieveMemories(
  config: SmartAgentConfig,
  goal: string,
): Promise<string[]> {
  if (!config.memory) return [];

  try {
    const memories = await config.memory.store.query(config.memory.scope, goal, 10);
    if (config.memory.readScopes) {
      for (const scope of config.memory.readScopes) {
        const extra = await config.memory.store.query(scope, goal, 5);
        memories.push(...extra);
      }
    }
    return memories.map((m) => {
      const freshnessNote = memoryFreshnessText(new Date(m.createdAt).getTime());
      if (freshnessNote) {
        return `${m.content}\n(${freshnessNote})`;
      }
      return m.content;
    });
  } catch {
    return []; // Memory failure is non-fatal
  }
}

/* ------------------------------------------------------------------ */
/*  Public API: runSmartLoop (wrapper + inner)                        */
/* ------------------------------------------------------------------ */

/**
 * Top-level entry point for the agent loop. Wraps `runSmartLoopStream` to
 * guarantee that `onRunComplete` fires reliably regardless of how the
 * inner loop terminates (success, fatal error, or exception).
 */
export async function runSmartLoop(
  config: SmartAgentConfig,
  goal: string | LLMContentPart[],
  checkpoint?: AgentCheckpoint,
  resumeMessage?: string | LLMContentPart[],
): Promise<AgentRunResult> {
  let result: AgentRunResult;
  try {
    const stream = runSmartLoopStream(config, goal, checkpoint, resumeMessage);
    let iterResult: IteratorResult<AgentEvent, AgentRunResult>;
    do {
      iterResult = await stream.next();
    } while (!iterResult.done);
    result = iterResult.value;
  } catch (error) {
    result = {
      result: null,
      iterations: 0,
      toolCalls: [],
      taskCalls: [],
      status: "fatal",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // Fire onRunComplete reliably — errors in the hook must never mask the result
  if (config.hooks?.onRunComplete) {
    try {
      await config.hooks.onRunComplete(result);
    } catch {
      // Non-fatal: the hook crashing must not prevent result delivery
    }
  }

  return result;
}

/* ------------------------------------------------------------------ */
/*  Streaming loop implementation                                     */
/* ------------------------------------------------------------------ */

/**
 * Core agent loop as an async generator that yields AgentEvent at every
 * significant point. The return value is the final AgentRunResult.
 *
 * Handles:
 * - Tool catalog setup and skill injection
 * - Prompt composition with memory and skill context
 * - Iterative model + tool execution with compression management
 * - Tool result budgeting (truncation of oversized results)
 * - Token budget management (nudge at threshold, force-complete at limit)
 * - Model fallback (retry with fallbackLlm on non-context errors)
 * - Enhanced reactive compact (autocompact first, then aggressive compact)
 * - Dynamic context enrichment (periodic memory injection)
 * - afterIteration lifecycle hook
 */
export async function* runSmartLoopStream(
  config: SmartAgentConfig,
  goal: string | LLMContentPart[],
  checkpoint?: AgentCheckpoint,
  resumeMessage?: string | LLMContentPart[],
): AsyncGenerator<AgentEvent, AgentRunResult, undefined> {
  /* ================================================================ */
  /* Phase 1: Initialization                                          */
  /* ================================================================ */

  const runStartTime = Date.now();
  let finalResultYielded = false;
  let state: ReturnType<typeof createEngineState> | undefined;

  try {

  // 1a. Create engine state from config (or checkpoint for resume)
  state = createEngineState(config, goal, checkpoint, resumeMessage);

  // 1b. Build tool catalog (inline or deferred)
  const catalog = createToolCatalog(state.tools, config.toolCatalog);
  const allTools = catalog.discoverTool
    ? [...state.tools, catalog.discoverTool]
    : [...state.tools];

  // 1c. Skill injection
  if (config.skills && config.skills.length > 0) {
    allTools.push(...createSkillTools(config.skills));
  }

  // 1d. Inject read_persisted_result tool when persistence is configured
  if (config.toolResultBudget?.persistDir) {
    const dir = config.toolResultBudget.persistDir;
    allTools.push({
      name: "read_persisted_result",
      description: "Read a full tool result that was previously truncated and persisted.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      isConcurrencySafe: true,
      async execute(args) {
        const safeId = (args.id as string).replace(/[^a-zA-Z0-9_-]/g, "");
        if (!safeId) return { error: "Invalid result ID" };
        try {
          return JSON.parse(readFileSync(join(dir, `tool-result-${safeId}.json`), "utf-8"));
        } catch { return { error: `Persisted result "${safeId}" not found` }; }
      },
    });
  }

  // 1e. Retrieve memories from store if configured
  const memoryStrings = await retrieveMemories(config, goalText(state.goal));

  // Seed seen memory hashes with initial memories
  for (const mem of memoryStrings) {
    state.seenMemoryHashes.add(hashContent(mem));
  }

  // 1e. Compose system prompt and set initial messages (only for fresh runs)
  if (!checkpoint) {
    // Build prompt config with catalog layer injected for deferred mode
    const promptConfig = config.prompt ? { ...config.prompt } : {};
    if (catalog.mode === "deferred") {
      const catalogLayer = {
        id: "tool-catalog",
        content: catalog.promptSection,
        position: "append" as const,
        priority: 90,
      };
      promptConfig.layers = [...(promptConfig.layers ?? []), catalogLayer];
    }

    // Inject skills section as a prompt layer if skills are configured
    if (config.skills && config.skills.length > 0) {
      const skillsLayer = {
        id: "skills-catalog",
        content: formatSkillDescriptions(config.skills),
        position: "append" as const,
        priority: 85,
      };
      promptConfig.layers = [...(promptConfig.layers ?? []), skillsLayer];
    }

    const systemPrompt = composeSystemPrompt(promptConfig, {
      tools: state.tools,
      iteration: 0,
      memories: memoryStrings,
      tokenBudget: Math.floor(state.contextWindowSize * 0.25),
    });

    state.messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: state.goal },
    ];
  }

  // 1f. Checkpoint at initialization
  if (config.hooks?.onCheckpoint) {
    const updated = await config.hooks.onCheckpoint(buildCheckpoint(state, "initialized"));
    if (updated?.messages) state.messages = updated.messages;
  }

  yield { type: "run_start" as const, goal: goalText(state.goal), timestamp: Date.now() };

  /* ================================================================ */
  /* Phase 2: Main loop                                               */
  /* ================================================================ */

  let stopHookRejections = 0;
  const MAX_STOP_HOOK_REJECTIONS = 3;
  let forceCompleted = false;

  while (state.iterations < state.maxIterations) {
    /* -------------------------------------------------------------- */
    /* 2a. COMPRESSION CHECK                                          */
    /* -------------------------------------------------------------- */
    let estimatedTokensNow = estimateTokens(state.messages);

    if (estimatedTokensNow > state.contextWindowSize * 0.6) {
      const tokensBefore = estimatedTokensNow;

      // Apply snip + microcompact
      const snipResult = snipMessages(state.messages, {
        preserveTail: config.compaction?.snip?.preserveTail ?? 10,
      });
      state.messages = snipResult.messages;

      if (snipResult.snippedCount > 0) {
        yield { type: "compression" as const, strategy: "snip" as const, tokensBefore, tokensAfter: estimateTokens(state.messages), timestamp: Date.now() };
      }

      // Tool result clearing(默认,参考 Anthropic clear_tool_uses):保留最近 keep 个
      // 工具结果完整,更早的剔成占位符。比旧的「截断到 N 字符」回收更多 context。
      // `toolClear.enabled: false` 退回旧的 microcompact 截断行为。
      const toolClearEnabled = config.compaction?.toolClear?.enabled !== false;
      const preMicroTokens = estimateTokens(state.messages);
      if (toolClearEnabled) {
        const clearResult = clearStaleToolResults(
          state.messages,
          config.compaction?.toolClear?.keep ?? 3,
        );
        state.messages = clearResult.messages;
        const postClearTokens = estimateTokens(state.messages);
        if (clearResult.clearedCount > 0) {
          yield { type: "compression" as const, strategy: "tool_clear" as const, tokensBefore: preMicroTokens, tokensAfter: postClearTokens, timestamp: Date.now() };
        }
      } else {
        const microResult = microcompactMessages(state.messages, {
          maxToolResultChars: config.compaction?.microcompact?.maxToolResultChars ?? 2000,
          protectedTail: config.compaction?.microcompact?.protectedTail ?? 6,
        }, state.microcompactCache);
        state.messages = microResult.messages;
        const postMicroTokens = estimateTokens(state.messages);
        if (postMicroTokens < preMicroTokens) {
          yield { type: "compression" as const, strategy: "microcompact" as const, tokensBefore: preMicroTokens, tokensAfter: postMicroTokens, timestamp: Date.now() };
        }
      }

      // Re-estimate after snip + microcompact to avoid stale threshold checks
      estimatedTokensNow = estimateTokens(state.messages);
    }

    if (estimatedTokensNow > state.contextWindowSize * 0.85) {
      const maxFailures = config.compaction?.autocompact?.maxFailures ?? 3;
      if (state.compaction.autocompactFailures < maxFailures) {
        const preAutocompactTokens = estimatedTokensNow;
        try {
          const acResult = await autocompact(config.llm, state.messages, {
            threshold: config.compaction?.autocompact?.threshold ?? 0.85,
            maxFailures,
          });
          if (acResult.failed) {
            state.compaction.autocompactFailures++;
          } else {
            state.messages = acResult.messages;
            state.compaction.autocompactFailures = 0;
            yield { type: "compression" as const, strategy: "autocompact" as const, tokensBefore: preAutocompactTokens, tokensAfter: estimateTokens(state.messages), timestamp: Date.now() };
            // Post-compact cleanup: reset caches that hold stale references
            state.microcompactCache.clear();
            state.seenMemoryHashes.clear();
            // Persist memory candidates to store
            if (config.memory && acResult.memoryCandidates.length > 0) {
              for (const candidate of acResult.memoryCandidates) {
                try {
                  await storeMemoryWithReconcile(config, candidate);
                } catch {
                  // Memory persistence failure during compaction is non-fatal
                }
              }
            }
          }
        } catch {
          // Autocompact LLM failure is non-fatal — increment failure count
          state.compaction.autocompactFailures++;
        }
      }
    }

    /* -------------------------------------------------------------- */
    /* 2b. CONTROL CHECK (pause/cancel)                               */
    /* -------------------------------------------------------------- */
    if (config.hooks?.getControlState) {
      try {
        const cp = buildCheckpoint(state);
        const decision = await config.hooks.getControlState("before_llm", cp);
        if (decision.action === "pause") {
          const pausedResult: AgentRunResult = {
            result: null,
            iterations: state.iterations,
            toolCalls: state.toolCalls,
            taskCalls: state.taskCalls,
            status: "paused",
            checkpoint: buildCheckpoint(state, "paused"),
          };
          finalResultYielded = true; yield { type: "run_end" as const, result: pausedResult, durationMs: Date.now() - state.runStartTime, timestamp: Date.now() };
          return pausedResult;
        }
        if (decision.action === "cancel") {
          const canceledResult: AgentRunResult = {
            result: decision.reason ?? null,
            iterations: state.iterations,
            toolCalls: state.toolCalls,
            taskCalls: state.taskCalls,
            status: "canceled",
            checkpoint: buildCheckpoint(state, "canceled"),
          };
          finalResultYielded = true; yield { type: "run_end" as const, result: canceledResult, durationMs: Date.now() - state.runStartTime, timestamp: Date.now() };
          return canceledResult;
        }
      } catch {
        // Control state hook failure is non-fatal — continue execution
      }
    }

    // Inject continuation prompt if set
    const messagesForCall = state.continuationPrompt
      ? [...state.messages, { role: "user" as const, content: state.continuationPrompt }]
      : state.messages;
    state.continuationPrompt = undefined;

    /* -------------------------------------------------------------- */
    /* 2c. MODEL + TOOL EXECUTION                                     */
    /* -------------------------------------------------------------- */
    state.iterations++;

    yield { type: "iteration_start" as const, iteration: state.iterations, estimatedTokens: estimateTokens(state.messages), timestamp: Date.now() };

    let executionResult: Awaited<ReturnType<typeof executeModelAndTools>>;

    // Normalize messages before API call (merge adjacent same-role, filter empties)
    const normalizedMessages = normalizeMessages(messagesForCall);

    const llmStartTime = Date.now();
    yield { type: "llm_call_start" as const, iteration: state.iterations, messageCount: normalizedMessages.length, timestamp: llmStartTime };

    try {
      executionResult = await executeModelAndTools(
        config.llm,
        normalizedMessages,
        allTools,
        config.hooks,
        config.streaming,
        { maxTokens: state.maxOutputTokens },
        config.llmTimeout,
      );
    } catch (error) {
      /* ------------------------------------------------------------ */
      /* 2d. ERROR HANDLING — Model Fallback + Enhanced Reactive       */
      /* ------------------------------------------------------------ */

      const isContextErr = isContextLimitError(error);

      // MODEL FALLBACK: For non-context errors, try fallback LLM before giving up
      if (!isContextErr && config.fallbackLlm) {
        yield { type: "model_fallback" as const, primaryError: error instanceof Error ? error.message : String(error), fallbackModel: config.fallbackLlm.name, timestamp: Date.now() };
        try {
          const cleanedMessages = normalizeMessages(stripThinkingContent(messagesForCall));
          executionResult = await executeModelAndTools(
            config.fallbackLlm,
            cleanedMessages,
            allTools,
            config.hooks,
            config.streaming,
            { maxTokens: state.maxOutputTokens },
            config.llmTimeout,
          );
          // Fallback succeeded — continue to result processing below
        } catch (fallbackError) {
          // Both primary and fallback failed — return fatal with combined info
          const primaryMsg = error instanceof Error ? error.message : String(error);
          const fallbackMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          const fatalResult: AgentRunResult = {
            result: null,
            iterations: state.iterations,
            toolCalls: state.toolCalls,
            taskCalls: state.taskCalls,
            status: "fatal",
            error: `Primary LLM failed: ${primaryMsg}. Fallback LLM also failed: ${fallbackMsg}`,
            checkpoint: buildCheckpoint(state),
          };
          finalResultYielded = true; yield { type: "run_end" as const, result: fatalResult, durationMs: Date.now() - state.runStartTime, timestamp: Date.now() };
          return fatalResult;
        }
        // If we reach here, fallback succeeded — skip the context_limit path
        // and fall through to result processing
      } else if (isContextErr) {
        // ENHANCED REACTIVE COMPACT: Three-phase recovery for context limit errors
        // Phase 1: Try autocompact (LLM-driven summarization) first
        const maxFailures = config.compaction?.autocompact?.maxFailures ?? 3;
        let autocompactSucceeded = false;

        if (state.compaction.autocompactFailures < maxFailures) {
          try {
            const acResult = await autocompact(config.llm, state.messages, {
              threshold: config.compaction?.autocompact?.threshold ?? 0.85,
              maxFailures,
            });
            // Autocompact must have actually freed tokens to count as success.
            // When messages are too short (<=5), autocompact returns early with
            // tokensFreed=0 and failed=undefined — that is NOT a real recovery.
            if (!acResult.failed && acResult.tokensFreed > 0) {
              state.messages = acResult.messages;
              autocompactSucceeded = true;
              state.microcompactCache.clear();
              state.seenMemoryHashes.clear();
              // Persist memory candidates from compaction
              if (config.memory && acResult.memoryCandidates.length > 0) {
                for (const candidate of acResult.memoryCandidates) {
                  try {
                    await storeMemoryWithReconcile(config, candidate);
                  } catch {
                    // Non-fatal
                  }
                }
              }
            } else {
              state.compaction.autocompactFailures++;
            }
          } catch {
            state.compaction.autocompactFailures++;
          }
        }

        if (autocompactSucceeded) {
          // Autocompact recovered — set continuation and retry
          yield { type: "error_recovery" as const, strategy: "autocompact", details: "Context limit recovered via autocompact", timestamp: Date.now() };
          state.continuationPrompt = applyContinuationPrompt("autocompact_recovery");
          continue;
        }

        // Phase 2: Fall back to aggressive reactiveCompact
        const MAX_REACTIVE_RETRIES = 2;
        if (state.compaction.reactiveCompactRetries < MAX_REACTIVE_RETRIES) {
          const preReactiveTokens = estimateTokens(state.messages);
          state.messages = reactiveCompact(state.messages);
          state.compaction.reactiveCompactRetries++;
          state.microcompactCache.clear();
          state.seenMemoryHashes.clear();
          yield { type: "compression" as const, strategy: "reactive" as const, tokensBefore: preReactiveTokens, tokensAfter: estimateTokens(state.messages), timestamp: Date.now() };
          yield { type: "error_recovery" as const, strategy: "reactive_compact", details: "Context limit recovered via reactive compact", timestamp: Date.now() };
          state.continuationPrompt = applyContinuationPrompt("reactive_compact_retry");
          continue;
        }

        // Phase 3: All recovery exhausted — fatal
        const contextFatalResult: AgentRunResult = {
          result: null,
          iterations: state.iterations,
          toolCalls: state.toolCalls,
          taskCalls: state.taskCalls,
          status: "fatal",
          error: "Context overflow unrecoverable: autocompact and reactive compact both exhausted",
          checkpoint: buildCheckpoint(state),
        };
        finalResultYielded = true; yield { type: "run_end" as const, result: contextFatalResult, durationMs: Date.now() - state.runStartTime, timestamp: Date.now() };
        return contextFatalResult;
      } else {
        // Non-context error with no fallback configured — use decideContinuation
        const errorOutcome: ModelOutcome = {
          content: "",
          toolRequests: [],
          finishReason: "error" as const,
        };
        const contAction = decideContinuation(errorOutcome, state.compaction);
        if (contAction.action === "fatal") {
          const errorMsg = error instanceof Error ? error.message : String(error);
          const errFatalResult: AgentRunResult = {
            result: null,
            iterations: state.iterations,
            toolCalls: state.toolCalls,
            taskCalls: state.taskCalls,
            status: "fatal",
            error: errorMsg || contAction.error,
            checkpoint: buildCheckpoint(state),
          };
          finalResultYielded = true; yield { type: "run_end" as const, result: errFatalResult, durationMs: Date.now() - state.runStartTime, timestamp: Date.now() };
          return errFatalResult;
        }
        // Should not reach here for "error" finishReason (decideContinuation returns fatal)
        throw error;
      }
    }

    const { outcome, toolRecords, blockedApproval, haltedByHardFailure } = executionResult;

    yield {
      type: "llm_call_end" as const,
      iteration: state.iterations,
      content: outcome.content.slice(0, 200),
      finishReason: outcome.finishReason ?? "stop",
      tokensUsed: outcome.usage ? { input: outcome.usage.promptTokens, output: outcome.usage.completionTokens } : undefined,
      durationMs: Date.now() - llmStartTime,
      timestamp: Date.now(),
    };

    /* -------------------------------------------------------------- */
    /* 2e. TOKEN BUDGET MANAGEMENT                                    */
    /* -------------------------------------------------------------- */
    if (config.tokenBudget) {
      const outputTokensDelta = estimateOutputTokens(outcome);
      state.outputTokensUsed += outputTokensDelta;

      // Normalize: tokenBudget can be a plain number or a TokenBudgetConfig object
      const budget = typeof config.tokenBudget === "number"
        ? { maxOutputTokensPerTurn: config.tokenBudget, nudgeAtPercent: DEFAULT_NUDGE_THRESHOLD }
        : config.tokenBudget;

      const budgetMax = budget.maxOutputTokensPerTurn;
      const nudgePercent = budget.nudgeAtPercent ?? DEFAULT_NUDGE_THRESHOLD;
      const usagePct = (state.outputTokensUsed / budgetMax) * 100;

      // Nudge at threshold (send once)
      if (usagePct >= nudgePercent && usagePct < 100 && !state.budgetNudgeSent) {
        state.budgetNudgeSent = true;
        const pct = Math.round(usagePct);
        yield { type: "token_budget_warning" as const, usedPercent: pct, iteration: state.iterations, timestamp: Date.now() };
        state.messages.push({
          role: "user",
          content: `[TOKEN_BUDGET] You have used ${pct}% of your output token budget (${state.outputTokensUsed}/${budgetMax}). Begin wrapping up your work and provide a final response.`,
        });
      }

      // Force-complete at 100%
      if (usagePct >= 100) {
        // Append whatever content we got as the final response
        if (outcome.content.trim()) {
          state.messages.push({ role: "assistant", content: outcome.content });
        }
        await saveSessionSummary(config, goalText(state.goal), state.iterations, "completed");
        const budgetResult: AgentRunResult = {
          result: outcome.content || state.lastAssistantContent || null,
          iterations: state.iterations,
          toolCalls: state.toolCalls,
          taskCalls: state.taskCalls,
          status: "completed",
          checkpoint: buildCheckpoint(state, "completed"),
        };
        finalResultYielded = true; yield { type: "run_end" as const, result: budgetResult, durationMs: Date.now() - state.runStartTime, timestamp: Date.now() };
        return budgetResult;
      }
    }

    /* -------------------------------------------------------------- */
    /* 2f. PROCESS RESULTS                                            */
    /* -------------------------------------------------------------- */

    // Yield tool events FIRST (even if some tools were blocked by approval)
    if (toolRecords.length > 0) {
      // Only yield tool_call_start for tools that have a matching record (avoids orphans on hard failure)
      const recordedToolIds = new Set(toolRecords.map(r => r.requestId));
      for (const req of outcome.toolRequests) {
        if (recordedToolIds.has(req.id)) {
          yield { type: "tool_call_start" as const, tool: req.name, args: req.args, iteration: state.iterations, timestamp: Date.now() };
        }
      }

      // Yield tool_call_end events for each tool execution
      for (const record of toolRecords) {
        // Detect skill activation
        if (record.tool === "activate_skill" && record.status !== "error") {
          const skillResult = record.result as Record<string, unknown>;
          yield { type: "skill_activated" as const, skill: (skillResult?.skill as string) ?? "unknown", iteration: state.iterations, timestamp: Date.now() };
        }

        yield { type: "tool_call_end" as const, tool: record.tool, args: record.args, result: record.result, status: (record.status ?? "success") as "success" | "error", iteration: state.iterations, timestamp: Date.now() };
      }
    }

    // Blocked by approval policy (checked AFTER tool events so successfully executed tools are reported)
    if (blockedApproval) {
      const cp = buildCheckpoint(state, "approval_required");
      cp.pendingApproval = blockedApproval;
      if (config.hooks?.onCheckpoint) {
        const updated = await config.hooks.onCheckpoint(cp);
        if (updated) Object.assign(cp, updated);
      }
      const approvalResult: AgentRunResult = {
        result: null,
        iterations: state.iterations,
        toolCalls: state.toolCalls,
        taskCalls: state.taskCalls,
        status: "approval_required",
        pendingApproval: blockedApproval,
        checkpoint: cp,
      };
      finalResultYielded = true; yield { type: "run_end" as const, result: approvalResult, durationMs: Date.now() - state.runStartTime, timestamp: Date.now() };
      return approvalResult;
    }

    // Tool calls were made
    if (toolRecords.length > 0) {
      // Append assistant message
      if (outcome.content.trim()) {
        state.messages.push({ role: "assistant", content: outcome.content });
      }
      state.lastAssistantContent = outcome.content;

      // --- Error withholding: separate successful, retriable, and exhausted tool results ---
      const MAX_TOOL_RETRIES = 1; // Retry each failed tool once before exposing error

      const successRecords: typeof toolRecords = [];
      const failedRecords: typeof toolRecords = [];
      const retriableRecords: typeof toolRecords = [];

      for (const record of toolRecords) {
        if (record.status === "error") {
          // Track retries by tool name + iteration + requestId for call-specific context
          const retryKey = `${record.tool}_iter${state.iterations}_${record.requestId ?? ""}`;
          const retryCount = state.toolRetries.get(retryKey) ?? 0;
          if (retryCount < MAX_TOOL_RETRIES && record.tool !== "activate_skill" && record.tool !== "read_persisted_result") {
            // This error is retriable — don't expose yet
            retriableRecords.push(record);
            state.toolRetries.set(retryKey, retryCount + 1);
          } else {
            // Retries exhausted or non-retriable — expose error
            failedRecords.push(record);
          }
        } else {
          successRecords.push(record);
        }
      }

      // Check for tool errors and set on outcome for continuation decisions
      const hasToolErrors = failedRecords.length > 0;
      outcome.hasToolErrors = hasToolErrors;

      // Append successful + exhausted-failure results with aggregate budget tracking
      const maxAggregate = config.toolResultBudget?.maxAggregateCharsPerIteration ?? 200_000;
      const perResultMax = config.toolResultBudget?.maxChars;
      const persistDir = config.toolResultBudget?.persistDir;
      let aggregateChars = 0;

      const allResultRecords = [...successRecords, ...failedRecords];
      for (const record of allResultRecords) {
        // Tighten per-result limit when approaching aggregate budget
        let effectiveMax = perResultMax;
        if (aggregateChars > maxAggregate * 0.8) {
          effectiveMax = Math.min(effectiveMax ?? Infinity, 500);
        }

        let formatted = formatToolResult(record.tool, record.result, effectiveMax, persistDir);

        // Hard-truncate if aggregate busted
        if (aggregateChars + formatted.length > maxAggregate && aggregateChars > 0) {
          const remaining = Math.max(200, maxAggregate - aggregateChars);
          formatted = formatted.slice(0, remaining)
            + `\n[...aggregate tool result budget exceeded (${aggregateChars + formatted.length} chars, limit ${maxAggregate})]`;
        }

        aggregateChars += formatted.length;
        // Detect inline-image envelope: when present, ship a multimodal user
        // message so providers like OpenAI deliver the actual screenshot
        // bytes back to the model on the next turn.
        const imageEnvelope = extractImageEnvelope(record.result);
        if (imageEnvelope) {
          state.messages.push(
            buildToolResultMessageWithImage(formatted, imageEnvelope),
          );
        } else {
          state.messages.push({ role: "user", content: formatted });
        }
        state.toolCalls.push({ ...record });

        // Memory event hook
        if (config.hooks?.onMemoryEvent) {
          try {
            await config.hooks.onMemoryEvent(
              `Tool ${record.tool} called with ${JSON.stringify(record.args)} => ${JSON.stringify(record.result)}`,
            );
          } catch {
            // Memory event hook failure is non-fatal
          }
        }
      }

      // For retriable errors, record in toolCalls but withhold raw error from LLM messages.
      // Instead, inject a retry hint so the LLM can re-attempt the tool.
      for (const record of retriableRecords) {
        state.toolCalls.push({ ...record });
      }
      if (retriableRecords.length > 0) {
        const retryHint = retriableRecords.map(r =>
          `Tool "${r.tool}" encountered a transient error and will be retried. Previous error: ${JSON.stringify((r.result as any)?.error ?? r.result)}`
        ).join("\n");
        state.messages.push({
          role: "user",
          content: `[TOOL_RETRY] ${retryHint}\nPlease retry these tool calls.`,
        });
      }

      // --- Loop guard(防呆):同一 (tool, args) 完全相同重复调用、无进展时,先注入
      // [LOOP_GUARD] 提醒让模型自纠,到硬上限再强制收尾。只认完全相同参数,合法批量
      // (每次参数不同)/分页(page 变)不会误伤。 ---
      const lg = config.loopGuard;
      if (lg?.enabled !== false) {
        const nudgeAt = lg?.repeatThreshold ?? 3;
        const stopAt = lg?.hardStopThreshold ?? 5;
        for (const record of toolRecords) {
          const sig = `${record.tool}:${stableStringify(record.args)}`;
          const seen = (state.callSignatures.get(sig) ?? 0) + 1;
          state.callSignatures.set(sig, seen);

          if (seen >= stopAt) {
            const detail = `工具「${record.tool}」用完全相同的参数重复调用了 ${seen} 次仍无进展,自动停止以免空转。`;
            yield { type: "error_recovery" as const, strategy: "loop_guard", details: detail, timestamp: Date.now() };
            const finalText = `${detail}\n可能是这次请求本就无法满足(例如查询条件与已有数据不匹配),请换一种方式或检查参数后再试。`;
            state.messages.push({ role: "assistant", content: finalText });
            await saveSessionSummary(config, goalText(state.goal), state.iterations, "completed");
            const loopResult: AgentRunResult = {
              result: finalText,
              iterations: state.iterations,
              toolCalls: state.toolCalls,
              taskCalls: state.taskCalls,
              status: "completed",
              checkpoint: buildCheckpoint(state, "completed"),
            };
            finalResultYielded = true;
            yield { type: "run_end" as const, result: loopResult, durationMs: Date.now() - state.runStartTime, timestamp: Date.now() };
            return loopResult;
          }

          if (seen === nudgeAt && !state.loopNudged.has(sig)) {
            state.loopNudged.add(sig);
            yield { type: "error_recovery" as const, strategy: "loop_guard", details: `工具「${record.tool}」已用相同参数调用 ${seen} 次,结果未变化。`, timestamp: Date.now() };
            state.messages.push({
              role: "user",
              content:
                `[LOOP_GUARD] 你已用完全相同的参数调用「${record.tool}」${seen} 次,结果没有变化。` +
                `停止重复同一调用 —— 要么换不同的参数/工具,要么如实告诉用户当前无法完成及原因` +
                `(例如查询条件与已有数据不匹配)。不要再重复这次失败的调用。`,
            });
          }
        }
      }

      // If halted by hard failure, clear continuation and let LLM see the error
      if (haltedByHardFailure) {
        state.continuationPrompt = undefined;
      }

      /* ------------------------------------------------------------ */
      /* 2g. DYNAMIC CONTEXT ENRICHMENT                               */
      /* ------------------------------------------------------------ */
      if (
        config.memory &&
        state.iterations > 0 &&
        state.iterations % MEMORY_ENRICHMENT_INTERVAL === 0
      ) {
        try {
          // Build query context from recent tool results
          const recentResults = toolRecords
            .slice(-3)
            .map((r) => `${r.tool}: ${JSON.stringify(r.result)}`.slice(0, 200))
            .join(" ");
          const queryText = recentResults || goalText(state.goal);

          const freshMemories = await config.memory.store.query(
            config.memory.scope,
            queryText,
            5,
          );

          // Filter out already-seen memories
          const newMemories = freshMemories.filter((m) => {
            const h = hashContent(m.content);
            if (state!.seenMemoryHashes.has(h)) return false;
            state!.seenMemoryHashes.add(h);
            return true;
          });

          if (newMemories.length > 0) {
            yield { type: "memory_enrichment" as const, memoriesInjected: newMemories.length, iteration: state.iterations, timestamp: Date.now() };
            const memoryContent = newMemories
              .map((m) => m.content)
              .join("\n");
            state.messages.push({
              role: "user",
              content: `[MEMORY_ENRICHMENT] Relevant observations from past experience:\n${memoryContent}`,
            });
          }
        } catch {
          // Dynamic memory enrichment failure is non-fatal
        }
      }

      /* ------------------------------------------------------------ */
      /* 2h. afterIteration HOOK                                      */
      /* ------------------------------------------------------------ */
      if (config.hooks?.afterIteration) {
        try {
          await config.hooks.afterIteration({
            iteration: state.iterations,
            messages: state.messages,
            toolCalls: state.toolCalls,
            estimatedTokens: estimateTokens(state.messages),
          });
        } catch {
          // afterIteration hook failure is non-fatal
        }
      }

      // Checkpoint after tool execution
      if (config.hooks?.onCheckpoint) {
        const updated = await config.hooks.onCheckpoint(buildCheckpoint(state, "tool_result"));
        if (updated?.messages) state.messages = updated.messages;
      }

      continue;
    }

    /* -------------------------------------------------------------- */
    /* 2i. FINAL RESPONSE (no tool calls)                             */
    /* -------------------------------------------------------------- */

    // Run stop hooks
    const stopHookResult =
      config.stopHooks && config.stopHooks.length > 0
        ? await runStopHooks(config.stopHooks, {
            response: outcome.content,
            messages: state.messages,
            toolCalls: state.toolCalls,
            goal: goalText(state.goal),
          })
        : { pass: true };

    // Decide continuation
    const contAction = decideContinuation(outcome, state.compaction, stopHookResult);

    if (contAction.action === "continue") {
      if (contAction.reason === "stop_hook_rejected") {
        stopHookRejections++;
        if (stopHookRejections >= MAX_STOP_HOOK_REJECTIONS) {
          // Force complete despite hook rejection
          state.messages.push({ role: "assistant", content: outcome.content });
          forceCompleted = true;
          break;
        }
        // Inject feedback from stop hook
        const feedback = stopHookResult.feedback ?? "Response did not pass quality check.";
        state.messages.push({ role: "assistant", content: outcome.content });
        state.messages.push({ role: "user", content: feedback });
        const prompt = applyContinuationPrompt(contAction.reason);
        if (prompt) {
          state.continuationPrompt = prompt;
        }
        continue;
      }

      if (contAction.reason === "token_budget_continuation") {
        // Escalate max output tokens
        state.compaction.tokenEscalations++;
        state.maxOutputTokens = getEscalatedMaxTokens(state.compaction);
        // Append partial response as assistant message
        if (outcome.content.trim()) {
          state.messages.push({ role: "assistant", content: outcome.content });
        }
        const prompt = applyContinuationPrompt(contAction.reason);
        if (prompt) {
          state.continuationPrompt = prompt;
        }
        continue;
      }

      // Generic continuation — apply prompt and continue
      const prompt = applyContinuationPrompt(contAction.reason);
      if (prompt) {
        state.continuationPrompt = prompt;
      }
      continue;
    }

    // afterIteration hook for final response iteration
    if (config.hooks?.afterIteration) {
      try {
        await config.hooks.afterIteration({
          iteration: state.iterations,
          messages: [...state.messages, { role: "assistant", content: outcome.content }],
          toolCalls: state.toolCalls,
          estimatedTokens: estimateTokens(state.messages),
        });
      } catch {
        // Non-fatal
      }
    }

    // Complete — persist session summary and return
    state.messages.push({ role: "assistant", content: outcome.content });

    if (config.hooks?.onCheckpoint) {
      await config.hooks.onCheckpoint(buildCheckpoint(state, "completed"));
    }

    await saveSessionSummary(config, goalText(state.goal), state.iterations, "completed");

    const completedResult: AgentRunResult = {
      result: outcome.content,
      iterations: state.iterations,
      toolCalls: state.toolCalls,
      taskCalls: state.taskCalls,
      status: "completed",
      checkpoint: buildCheckpoint(state, "completed"),
    };
    finalResultYielded = true; yield { type: "run_end" as const, result: completedResult, durationMs: Date.now() - state.runStartTime, timestamp: Date.now() };
    return completedResult;
  }

  /* ================================================================ */
  /* Phase 3: Post-loop (force completed or max iterations)           */
  /* ================================================================ */

  if (forceCompleted) {
    await saveSessionSummary(config, goalText(state.goal), state.iterations, "completed");
    const forceResult: AgentRunResult = {
      result: state.lastAssistantContent ?? null,
      iterations: state.iterations,
      toolCalls: state.toolCalls,
      taskCalls: state.taskCalls,
      status: "completed",
      checkpoint: buildCheckpoint(state, "completed"),
    };
    finalResultYielded = true; yield { type: "run_end" as const, result: forceResult, durationMs: Date.now() - state.runStartTime, timestamp: Date.now() };
    return forceResult;
  }

  await saveSessionSummary(config, goalText(state.goal), state.iterations, "max_iterations");

  const maxIterResult: AgentRunResult = {
    result: state.lastAssistantContent ?? null,
    iterations: state.iterations,
    toolCalls: state.toolCalls,
    taskCalls: state.taskCalls,
    status: "max_iterations",
    checkpoint: buildCheckpoint(state, "max_iterations"),
  };
  finalResultYielded = true; yield { type: "run_end" as const, result: maxIterResult, durationMs: Date.now() - state.runStartTime, timestamp: Date.now() };
  return maxIterResult;

  } finally {
    if (!finalResultYielded) {
      yield { type: "run_end" as const, result: {
        result: null,
        iterations: state?.iterations ?? 0,
        toolCalls: state?.toolCalls ?? [],
        taskCalls: state?.taskCalls ?? [],
        status: "fatal" as const,
        error: "Stream terminated early",
      }, durationMs: Date.now() - runStartTime, timestamp: Date.now() };
    }
  }
}
