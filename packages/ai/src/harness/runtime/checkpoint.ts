import type {
  AgentCheckpoint,
  AgentToolCallRecord,
  LLMMessage,
  ToolRequest,
} from "../../types.js";
import type { HarnessRunCheckpointRecord } from "../types.js";

const CHECKPOINT_STAGES = new Set<string>([
  "initialized",
  "assistant_response",
  "tool_result",
  "task_wait",
  "approval_required",
  "completed",
  "max_iterations",
  "canceled",
  // Forward-compatible pause boundary for richer turn engines.
  "paused",
]);

export function assertValidCheckpointRecord(
  runId: string,
  record: unknown,
): asserts record is HarnessRunCheckpointRecord {
  if (!isPlainObject(record)) {
    throw new Error(`Harness run ${runId} checkpoint record is invalid: expected object`);
  }

  if (record.runId !== runId) {
    throw new Error(
      `Harness run ${runId} checkpoint record is invalid: expected runId "${runId}"`,
    );
  }

  if (typeof record.updatedAt !== "string" || !record.updatedAt.trim()) {
    throw new Error(
      `Harness run ${runId} checkpoint record is invalid: missing updatedAt`,
    );
  }

  assertValidAgentCheckpoint(
    record.checkpoint,
    `Harness run ${runId} checkpoint`,
  );
}

export function assertValidAgentCheckpoint(
  checkpoint: unknown,
  context = "Agent loop checkpoint",
): asserts checkpoint is AgentCheckpoint {
  if (!isPlainObject(checkpoint)) {
    throw new Error(`${context} is invalid: expected object`);
  }

  if (
    typeof checkpoint.stage !== "string" ||
    !CHECKPOINT_STAGES.has(checkpoint.stage)
  ) {
    throw new Error(`${context} is invalid: unsupported stage`);
  }

  if (typeof checkpoint.goal !== "string" || !checkpoint.goal.trim()) {
    throw new Error(`${context} is invalid: goal must be a non-empty string`);
  }

  if (!Array.isArray(checkpoint.messages)) {
    throw new Error(`${context} is invalid: messages must be an array`);
  }
  for (const [index, message] of checkpoint.messages.entries()) {
    if (!isPlainObject(message)) {
      throw new Error(`${context} is invalid: messages[${index}] must be an object`);
    }
    if (typeof message.role !== "string" || !message.role.trim()) {
      throw new Error(`${context} is invalid: messages[${index}].role must be a non-empty string`);
    }
    if (typeof message.content !== "string" && !Array.isArray(message.content)) {
      throw new Error(
        `${context} is invalid: messages[${index}].content must be a string or LLMContentPart[]`,
      );
    }
  }

  if (!Number.isInteger(checkpoint.iterations) || checkpoint.iterations < 0) {
    throw new Error(`${context} is invalid: iterations must be a non-negative integer`);
  }

  if (!Array.isArray(checkpoint.toolCalls)) {
    throw new Error(`${context} is invalid: toolCalls must be an array`);
  }
  for (const [index, call] of checkpoint.toolCalls.entries()) {
    if (!isPlainObject(call)) {
      throw new Error(`${context} is invalid: toolCalls[${index}] must be an object`);
    }
    if (typeof call.tool !== "string" || !call.tool.trim()) {
      throw new Error(`${context} is invalid: toolCalls[${index}].tool must be a string`);
    }
  }

  if (checkpoint.taskCalls != null && !Array.isArray(checkpoint.taskCalls)) {
    throw new Error(`${context} is invalid: taskCalls must be an array`);
  }
  for (const [index, call] of (checkpoint.taskCalls ?? []).entries()) {
    if (!isPlainObject(call)) {
      throw new Error(`${context} is invalid: taskCalls[${index}] must be an object`);
    }
    if (typeof call.task !== "string" || !call.task.trim()) {
      throw new Error(`${context} is invalid: taskCalls[${index}].task must be a string`);
    }
  }

  if (checkpoint.maxOutputTokens != null) {
    if (!Number.isInteger(checkpoint.maxOutputTokens) || checkpoint.maxOutputTokens < 0) {
      throw new Error(`${context} is invalid: maxOutputTokens must be a non-negative integer`);
    }
  }

  if (checkpoint.compaction != null) {
    if (!isPlainObject(checkpoint.compaction)) {
      throw new Error(`${context} is invalid: compaction must be an object`);
    }
    for (const field of [
      "autocompactFailures",
      "reactiveCompactRetries",
      "tokenEscalations",
    ] as const) {
      const value = checkpoint.compaction[field];
      if (value != null && (!Number.isInteger(value) || value < 0)) {
        throw new Error(
          `${context} is invalid: compaction.${field} must be a non-negative integer`,
        );
      }
    }
  }

  if (checkpoint.toolCatalog != null) {
    if (!isPlainObject(checkpoint.toolCatalog)) {
      throw new Error(`${context} is invalid: toolCatalog must be an object`);
    }
    if (typeof checkpoint.toolCatalog.version !== "string" || !checkpoint.toolCatalog.version.trim()) {
      throw new Error(`${context} is invalid: toolCatalog.version must be a non-empty string`);
    }
    if (
      !Array.isArray(checkpoint.toolCatalog.disclosed) ||
      checkpoint.toolCatalog.disclosed.some((name: unknown) => typeof name !== "string" || !name.trim())
    ) {
      throw new Error(`${context} is invalid: toolCatalog.disclosed must contain tool names`);
    }
  }
}

export function getCheckpointStage(checkpoint: AgentCheckpoint): string {
  return checkpoint.stage;
}

export function getCheckpointMessages(checkpoint: AgentCheckpoint): LLMMessage[] {
  return checkpoint.messages;
}

export function getCheckpointToolCalls(
  checkpoint: AgentCheckpoint,
): AgentToolCallRecord[] {
  return checkpoint.toolCalls;
}

export function getCheckpointLastAssistantResponse(
  checkpoint: AgentCheckpoint,
): string | undefined {
  for (let index = checkpoint.messages.length - 1; index >= 0; index--) {
    const message = checkpoint.messages[index];
    if (!message || message.role !== "assistant") continue;
    // Multimodal assistant content is rare but possible; flatten to text.
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("\n");
    if (text.trim()) return text;
  }

  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
