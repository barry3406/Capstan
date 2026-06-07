import type { SmartAgentConfig, SmartAgent, AgentRunResult, AgentCheckpoint, AgentEvent, LLMContentPart } from "./types.js";
import { runSmartLoop, runSmartLoopStream } from "./loop/engine.js";

export function createSmartAgent(config: SmartAgentConfig): SmartAgent {
  return {
    async run(goal: string | LLMContentPart[]): Promise<AgentRunResult> {
      return runSmartLoop(config, goal);
    },
    async *stream(goal: string | LLMContentPart[]): AsyncGenerator<AgentEvent, AgentRunResult, undefined> {
      return yield* runSmartLoopStream(config, goal);
    },
    async resume(checkpoint: AgentCheckpoint, message: string | LLMContentPart[]): Promise<AgentRunResult> {
      return runSmartLoop(config, checkpoint.goal, checkpoint, message);
    },
    async *resumeStream(checkpoint: AgentCheckpoint, message: string | LLMContentPart[]): AsyncGenerator<AgentEvent, AgentRunResult, undefined> {
      return yield* runSmartLoopStream(config, checkpoint.goal, checkpoint, message);
    },
  };
}
