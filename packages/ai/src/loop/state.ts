import type {
  LLMMessage,
  LLMContentPart,
  AgentTool,
  AgentTask,
  AgentToolCallRecord,
  AgentTaskCallRecord,
  AgentCheckpoint,
  SmartAgentConfig,
} from "../types.js";
import type { CompactionState } from "./continuation.js";

/** 把 goal(可能是多模态 content parts)取成纯文本 —— 用于 summary / memory 查询 / 事件展示。 */
export function goalText(goal: string | LLMContentPart[]): string {
  return typeof goal === "string" ? goal : goal.map((p) => (p.type === "text" ? p.text : "[image]")).join("");
}

export interface EngineState {
  goal: string | LLMContentPart[];
  maxIterations: number;
  contextWindowSize: number;
  messages: LLMMessage[];
  tools: AgentTool[];
  tasks: AgentTask[];
  toolCalls: AgentToolCallRecord[];
  taskCalls: AgentTaskCallRecord[];
  iterations: number;
  maxOutputTokens: number;
  compaction: CompactionState;
  continuationPrompt?: string | undefined;
  lastAssistantContent?: string | undefined;
  /** Accumulated output tokens across iterations for token budget tracking */
  outputTokensUsed: number;
  /** Whether the budget nudge warning has been sent this run */
  budgetNudgeSent: boolean;
  /** Epoch timestamp when the run started */
  runStartTime: number;
  /** Set of memory content hashes already injected (dedup for dynamic enrichment) */
  seenMemoryHashes: Set<string>;
  /** Cache for microcompact — avoids re-truncating already-processed messages */
  microcompactCache: Map<string, string>;
  /** Retry counts for tool error withholding — toolRequestId → retry count */
  toolRetries: Map<string, number>;
  /** Loop guard:`tool:argsHash` → 本轮该签名被调用的次数(防呆,运行态、不进 checkpoint) */
  callSignatures: Map<string, number>;
  /** Loop guard:已对哪些签名发过 [LOOP_GUARD] 提醒(每签名只提醒一次) */
  loopNudged: Set<string>;
}

export function createEngineState(
  config: SmartAgentConfig,
  goal: string | LLMContentPart[],
  checkpoint?: AgentCheckpoint,
  resumeMessage?: string | LLMContentPart[],
): EngineState {
  if (checkpoint) {
    const state: EngineState = {
      goal: checkpoint.goal,
      maxIterations: config.maxIterations ?? 200,
      contextWindowSize: config.contextWindowSize ?? 200_000,
      messages: checkpoint.messages.map((m) => ({ ...m })),
      tools: config.tools,
      tasks: config.tasks ?? [],
      toolCalls: checkpoint.toolCalls.map((c) => ({ ...c })),
      taskCalls: checkpoint.taskCalls.map((c) => ({ ...c })),
      iterations: checkpoint.iterations,
      maxOutputTokens: checkpoint.maxOutputTokens,
      compaction: { ...checkpoint.compaction },
      outputTokensUsed: 0,
      budgetNudgeSent: false,
      runStartTime: Date.now(),
      seenMemoryHashes: new Set(),
      microcompactCache: new Map(),
      toolRetries: new Map(),
      callSignatures: new Map(),
      loopNudged: new Set(),
    };
    // If resuming with a new message, append it
    if (resumeMessage) {
      state.messages.push({ role: "user", content: resumeMessage });
    }
    return state;
  }

  return {
    goal,
    maxIterations: config.maxIterations ?? 200,
    contextWindowSize: config.contextWindowSize ?? 200_000,
    messages: [], // Engine will set system prompt + user goal
    tools: config.tools,
    tasks: config.tasks ?? [],
    toolCalls: [],
    taskCalls: [],
    iterations: 0,
    maxOutputTokens: 8192,
    compaction: {
      autocompactFailures: 0,
      reactiveCompactRetries: 0,
      tokenEscalations: 0,
    },
    outputTokensUsed: 0,
    budgetNudgeSent: false,
    runStartTime: Date.now(),
    seenMemoryHashes: new Set(),
    microcompactCache: new Map(),
    toolRetries: new Map(),
    callSignatures: new Map(),
    loopNudged: new Set(),
  };
}

export function buildCheckpoint(state: EngineState, stage: AgentCheckpoint["stage"] = "initialized"): AgentCheckpoint {
  return {
    stage,
    goal: state.goal,
    messages: state.messages.map((m) => ({ ...m })),
    iterations: state.iterations,
    toolCalls: state.toolCalls.map((c) => ({ ...c })),
    taskCalls: state.taskCalls.map((c) => ({ ...c })),
    maxOutputTokens: state.maxOutputTokens,
    compaction: { ...state.compaction },
  };
}
