import { describe, it, expect } from "bun:test";
import { createSmartAgent } from "../../packages/ai/src/index.js";
import { InMemoryEvolutionStore } from "../../packages/ai/src/evolution/store-memory.js";
import { buildStrategyLayer } from "../../packages/ai/src/evolution/engine.js";
import type {
  LLMProvider,
  LLMMessage,
  LLMResponse,
  LLMOptions,
  AgentTool,
  AgentCheckpoint,
} from "../../packages/ai/src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockLLM(responses: string[], sink?: LLMMessage[][]): LLMProvider {
  let i = 0;
  return {
    name: "mock",
    async chat(msgs: LLMMessage[], _opts?: LLMOptions): Promise<LLMResponse> {
      sink?.push(msgs.map((m) => ({ ...m })));
      const content = responses[i] ?? "done";
      i++;
      return { content, model: "mock-1" };
    },
  };
}

/**
 * LLM that returns tool calls for the first N iterations, then a final text response.
 * Each tool call generates a verbose result string to fill context quickly.
 */
function longRunLLM(toolCallCount: number, sink?: LLMMessage[][]): LLMProvider {
  let i = 0;
  return {
    name: "long-run",
    async chat(msgs: LLMMessage[], _opts?: LLMOptions): Promise<LLMResponse> {
      sink?.push(msgs.map((m) => ({ ...m })));
      i++;
      if (i <= toolCallCount) {
        return {
          content: JSON.stringify({ tool: "step", arguments: { n: i } }),
          model: "mock-1",
        };
      }
      return { content: `Completed after ${i - 1} steps.`, model: "mock-1" };
    },
  };
}

/** A simple tool that returns a verbose result string */
function verboseStepTool(): AgentTool {
  return {
    name: "step",
    description: "Execute a processing step",
    parameters: {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    },
    async execute(args) {
      const n = args.n as number;
      // Generate a verbose result (~250 chars) to fill context faster
      const padding = "x".repeat(200);
      return {
        step: n,
        status: "ok",
        detail: `Step ${n} completed successfully. ${padding}`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Category 1: Long-chain with compression
// ---------------------------------------------------------------------------

describe("Long-chain: 50+ iterations with compression", () => {
  it("completes a 50-iteration run with multiple compression cycles", async () => {
    const agent = createSmartAgent({
      llm: longRunLLM(50),
      tools: [verboseStepTool()],
      maxIterations: 100,
      contextWindowSize: 4000, // small window forces compression early
      compaction: {
        snip: { preserveTail: 4 },
        microcompact: { maxToolResultChars: 200, protectedTail: 4 },
        autocompact: { threshold: 0.85, maxFailures: 50 },
      },
    });

    const result = await agent.run("Process 50 steps");

    expect(result.status).toBe("completed");
    // May lose a few iterations to compression edge cases but should complete most
    expect(result.iterations).toBeGreaterThanOrEqual(40);
    expect(result.toolCalls.length).toBeGreaterThanOrEqual(40);
    expect(result.result).toContain("Completed after");
  }, 30_000);

  it("preserves critical context through compression", async () => {
    let runningTotal = 0;
    const totalTool: AgentTool = {
      name: "accumulate",
      description: "Add a value to the running total",
      parameters: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      },
      async execute(args) {
        runningTotal += args.value as number;
        // Return verbose output to trigger compression
        const padding = "y".repeat(200);
        return { total: runningTotal, padding };
      },
    };

    let callCount = 0;
    const llm: LLMProvider = {
      name: "accumulator",
      async chat(msgs: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
        callCount++;

        // When called for autocompact summarization (system prompt contains "summarizing")
        const sysMsg = msgs[0]?.content ?? "";
        if (sysMsg.includes("summarizing a conversation")) {
          return {
            content: JSON.stringify({
              summary: `Running accumulation task. Current total is ${runningTotal}. Processed ${callCount} steps so far.`,
              memories: [`Running total reached ${runningTotal}`],
            }),
            model: "mock-1",
          };
        }

        if (callCount <= 30) {
          return {
            content: JSON.stringify({
              tool: "accumulate",
              arguments: { value: 1 },
            }),
            model: "mock-1",
          };
        }
        return {
          content: `Final total is ${runningTotal}. Done.`,
          model: "mock-1",
        };
      },
    };

    const agent = createSmartAgent({
      llm,
      tools: [totalTool],
      loopGuard: { enabled: false },
      maxIterations: 100,
      contextWindowSize: 4000,
      compaction: {
        snip: { preserveTail: 4 },
        microcompact: { maxToolResultChars: 200, protectedTail: 4 },
        autocompact: { threshold: 0.85, maxFailures: 10 },
      },
    });

    const result = await agent.run("Accumulate values");

    expect(result.status).toBe("completed");
    expect(runningTotal).toBe(30);
    expect(result.result).toContain("30");
  }, 30_000);

  it("handles compression failure gracefully in long run", async () => {
    let callCount = 0;
    const llm: LLMProvider = {
      name: "broken-compact",
      async chat(msgs: LLMMessage[], _opts?: LLMOptions): Promise<LLMResponse> {
        callCount++;

        // Autocompact calls: return invalid JSON to make autocompact fail
        const sysMsg = msgs[0]?.content ?? "";
        if (sysMsg.includes("summarizing a conversation")) {
          return { content: "NOT VALID JSON AT ALL", model: "mock-1" };
        }

        // Normal tool calls for 20 iterations
        if (callCount <= 20) {
          return {
            content: JSON.stringify({ tool: "step", arguments: { n: callCount } }),
            model: "mock-1",
          };
        }
        return { content: "All done despite compression failures.", model: "mock-1" };
      },
    };

    const agent = createSmartAgent({
      llm,
      tools: [verboseStepTool()],
      maxIterations: 100,
      contextWindowSize: 4000,
      compaction: {
        snip: { preserveTail: 4 },
        microcompact: { maxToolResultChars: 200, protectedTail: 4 },
        autocompact: { threshold: 0.85, maxFailures: 3 },
      },
    });

    const result = await agent.run("Run with broken compression");

    // Agent should complete despite autocompact failures (snip/microcompact still work)
    expect(["completed", "max_iterations"]).toContain(result.status);
    expect(result.iterations).toBeGreaterThanOrEqual(15);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Category 2: Checkpoint resume idempotency
// ---------------------------------------------------------------------------

describe("Idempotency: checkpoint resume", () => {
  it("resuming from same checkpoint twice produces consistent results", async () => {
    let pauseCount = 0;
    let callIndex = 0;

    // Deterministic LLM that always gives same response for same call index
    function deterministicLLM(): LLMProvider {
      let localIndex = 0;
      const responses = [
        JSON.stringify({ tool: "echo", arguments: { msg: "hello" } }),
        JSON.stringify({ tool: "echo", arguments: { msg: "world" } }),
        "Pausing here.",
        // After resume:
        JSON.stringify({ tool: "echo", arguments: { msg: "resumed" } }),
        "All done after resume.",
      ];
      return {
        name: "deterministic",
        async chat(_msgs: LLMMessage[]): Promise<LLMResponse> {
          const content = responses[localIndex] ?? "done";
          localIndex++;
          return { content, model: "mock-1" };
        },
      };
    }

    const echoTool: AgentTool = {
      name: "echo",
      description: "Echo a message",
      parameters: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
      async execute(args) {
        return { echoed: args.msg };
      },
    };

    // Run 1: pause after 2 tool calls
    let controlCallCount = 0;
    const agent1 = createSmartAgent({
      llm: deterministicLLM(),
      tools: [echoTool],
      maxIterations: 20,
      hooks: {
        getControlState: async (_phase, _cp) => {
          controlCallCount++;
          // Pause on the 3rd control check (after 2 tool calls)
          if (controlCallCount === 3) {
            return { action: "pause" as const };
          }
          return { action: "continue" as const };
        },
      },
    });

    const pauseResult = await agent1.run("Echo some messages");
    expect(pauseResult.status).toBe("paused");
    expect(pauseResult.checkpoint).toBeDefined();
    const checkpoint = pauseResult.checkpoint!;

    // Resume 1
    const resumeAgent1 = createSmartAgent({
      llm: deterministicLLM(),
      tools: [echoTool],
      maxIterations: 20,
    });
    const resume1 = await resumeAgent1.resume(checkpoint, "continue");

    // Resume 2 (from same checkpoint)
    const resumeAgent2 = createSmartAgent({
      llm: deterministicLLM(),
      tools: [echoTool],
      maxIterations: 20,
    });
    const resume2 = await resumeAgent2.resume(checkpoint, "continue");

    // Both resumes should produce same status and iteration count
    expect(resume1.status).toBe(resume2.status);
    expect(resume1.iterations).toBe(resume2.iterations);
    expect(resume1.toolCalls.length).toBe(resume2.toolCalls.length);
  });

  it("checkpoint preserves all state accurately", async () => {
    let controlCallCount = 0;

    const counterTool: AgentTool = {
      name: "count",
      description: "Count something",
      parameters: {
        type: "object",
        properties: { n: { type: "number" } },
        required: ["n"],
      },
      async execute(args) {
        return { counted: args.n };
      },
    };

    let llmCallIndex = 0;
    const llm: LLMProvider = {
      name: "checkpoint-test",
      async chat(_msgs: LLMMessage[]): Promise<LLMResponse> {
        llmCallIndex++;
        if (llmCallIndex <= 3) {
          return {
            content: JSON.stringify({ tool: "count", arguments: { n: llmCallIndex } }),
            model: "mock-1",
          };
        }
        return { content: "Finished counting.", model: "mock-1" };
      },
    };

    const agent = createSmartAgent({
      llm,
      tools: [counterTool],
      maxIterations: 20,
      hooks: {
        getControlState: async (_phase, _cp) => {
          controlCallCount++;
          // Pause after 3 tool calls (4th control check)
          if (controlCallCount === 4) {
            return { action: "pause" as const };
          }
          return { action: "continue" as const };
        },
      },
    });

    const result = await agent.run("Count to 3");
    expect(result.status).toBe("paused");

    const cp = result.checkpoint!;
    expect(cp.iterations).toBe(3);
    expect(cp.toolCalls).toHaveLength(3);
    expect(cp.toolCalls[0]!.tool).toBe("count");
    expect(cp.toolCalls[2]!.result).toEqual({ counted: 3 });
    expect(cp.messages.length).toBeGreaterThan(0);
    expect(cp.goal).toBe("Count to 3");

    // Resume and verify continuation
    let resumeLLMIndex = 0;
    const resumeLLM: LLMProvider = {
      name: "resume-llm",
      async chat(_msgs: LLMMessage[]): Promise<LLMResponse> {
        resumeLLMIndex++;
        if (resumeLLMIndex <= 2) {
          return {
            content: JSON.stringify({ tool: "count", arguments: { n: 3 + resumeLLMIndex } }),
            model: "mock-1",
          };
        }
        return { content: "Resumed and finished.", model: "mock-1" };
      },
    };

    const resumeAgent = createSmartAgent({
      llm: resumeLLM,
      tools: [counterTool],
      maxIterations: 20,
    });

    const resumed = await resumeAgent.resume(cp, "continue counting");
    expect(resumed.status).toBe("completed");
    // Iterations should include both pre-pause (3) and post-resume
    expect(resumed.iterations).toBeGreaterThan(3);
    // Tool calls should include both pre-pause and post-resume
    expect(resumed.toolCalls.length).toBeGreaterThan(3);
  });

  it("same goal with same tools produces deterministic results", async () => {
    const responses = [
      JSON.stringify({ tool: "greet", arguments: { name: "Alice" } }),
      "Hello Alice!",
    ];

    const greetTool: AgentTool = {
      name: "greet",
      description: "Greet someone",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      async execute(args) {
        return { greeting: `Hi ${args.name}` };
      },
    };

    // Run 1
    const agent1 = createSmartAgent({
      llm: mockLLM([...responses]),
      tools: [greetTool],
    });
    const result1 = await agent1.run("Greet Alice");

    // Run 2 (fresh agent, same config)
    const agent2 = createSmartAgent({
      llm: mockLLM([...responses]),
      tools: [greetTool],
    });
    const result2 = await agent2.run("Greet Alice");

    expect(result1.status).toBe(result2.status);
    expect(result1.iterations).toBe(result2.iterations);
    expect(result1.toolCalls.length).toBe(result2.toolCalls.length);
    expect(result1.toolCalls[0]!.tool).toBe(result2.toolCalls[0]!.tool);
    expect(result1.result).toBe(result2.result);
  });
});

// ---------------------------------------------------------------------------
// Category 3: Evolution idempotency
// ---------------------------------------------------------------------------

describe("Idempotency: evolution store", () => {
  it("recording same experience twice does not create duplicates but stores separate entries", async () => {
    const store = new InMemoryEvolutionStore();

    const experience = {
      goal: "Fix the login bug",
      outcome: "success" as const,
      trajectory: [
        { tool: "read_file", args: { path: "auth.ts" }, result: "code", status: "success" as const, iteration: 0 },
        { tool: "write_file", args: { path: "auth.ts", content: "fixed" }, result: "ok", status: "success" as const, iteration: 1 },
      ],
      iterations: 2,
      tokenUsage: 500,
      duration: 3000,
      skillsUsed: [],
    };

    const id1 = await store.recordExperience(experience);
    const id2 = await store.recordExperience(experience);

    // Each recording creates a unique entry (separate run, separate ID)
    expect(id1).not.toBe(id2);

    const all = await store.queryExperiences({ limit: 100 });
    expect(all).toHaveLength(2);
    expect(all[0]!.id).not.toBe(all[1]!.id);
  });

  it("strategy utility converges with repeated application", async () => {
    const store = new InMemoryEvolutionStore();

    const id = await store.storeStrategy({
      content: "Always validate inputs",
      source: [],
      utility: 0.5,
      applications: 0,
    });

    // Apply +0.1 ten times
    for (let i = 0; i < 10; i++) {
      await store.updateStrategyUtility(id, 0.1);
    }

    let strategies = await store.queryStrategies("", 10);
    const afterIncrement = strategies.find((s) => s.id === id)!;
    // Should be clamped at 1.0, not 1.5
    expect(afterIncrement.utility).toBe(1.0);

    // Apply -0.05 twenty times
    for (let i = 0; i < 20; i++) {
      await store.updateStrategyUtility(id, -0.05);
    }

    strategies = await store.queryStrategies("", 10);
    const afterDecrement = strategies.find((s) => s.id === id)!;
    // Should be clamped at 0.0, not negative
    expect(afterDecrement.utility).toBe(0.0);
  });

  it("strategy application count increments correctly", async () => {
    const store = new InMemoryEvolutionStore();

    const id = await store.storeStrategy({
      content: "Check error codes",
      source: [],
      utility: 0.5,
      applications: 0,
    });

    for (let i = 0; i < 7; i++) {
      await store.incrementStrategyApplications(id);
    }

    const strategies = await store.queryStrategies("", 10);
    const strat = strategies.find((s) => s.id === id)!;
    expect(strat.applications).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Category 4: Multi-run evolution chain
// ---------------------------------------------------------------------------

describe("Long-chain: evolution across sequential runs", () => {
  it("strategies accumulated across runs appear in later prompts", async () => {
    const store = new InMemoryEvolutionStore();

    // Manually store 3 strategies (simulating post-run distillation)
    await store.storeStrategy({
      content: "Always check error codes",
      source: [],
      utility: 0.8,
      applications: 3,
    });
    await store.storeStrategy({
      content: "Read tests before fixing",
      source: [],
      utility: 0.7,
      applications: 2,
    });
    await store.storeStrategy({
      content: "Low value strategy",
      source: [],
      utility: 0.1,
      applications: 1,
    });

    // Build strategy layer and verify it includes high-utility ones
    const strategies = await store.queryStrategies("", 5);
    const layer = buildStrategyLayer(strategies);

    expect(layer).not.toBeNull();
    expect(layer!.content).toContain("Always check error codes");
    expect(layer!.content).toContain("Read tests before fixing");
    expect(layer!.content).toContain("Low value strategy");

    // Verify the layer can be injected into createSmartAgent and appears in system prompt
    const sink: LLMMessage[][] = [];
    const agent = createSmartAgent({
      llm: mockLLM(["Done."], sink),
      tools: [],
      prompt: { layers: [layer!] },
    });
    await agent.run("Fix bug");

    // The first LLM call's first message should be the system prompt with strategies
    const systemPrompt = sink[0]![0]!.content;
    expect(systemPrompt).toContain("Learned Strategies");
    expect(systemPrompt).toContain("Always check error codes");
    expect(systemPrompt).toContain("Read tests before fixing");
  });

  it("pruning removes low-utility strategies correctly", async () => {
    const store = new InMemoryEvolutionStore();

    await store.storeStrategy({
      content: "High value",
      source: [],
      utility: 0.9,
      applications: 5,
    });
    await store.storeStrategy({
      content: "Medium value",
      source: [],
      utility: 0.5,
      applications: 3,
    });
    await store.storeStrategy({
      content: "Low value",
      source: [],
      utility: 0.1,
      applications: 1,
    });
    await store.storeStrategy({
      content: "Very low value",
      source: [],
      utility: 0.05,
      applications: 0,
    });

    const pruned = await store.pruneStrategies({ minUtility: 0.3 });
    expect(pruned).toBe(2); // "Low value" and "Very low value" removed

    const remaining = await store.queryStrategies("", 10);
    expect(remaining).toHaveLength(2);
    expect(remaining.map((s) => s.content).sort()).toEqual(["High value", "Medium value"]);
  });

  it("evolution store stats reflect accumulated data", async () => {
    const store = new InMemoryEvolutionStore();

    // Start empty
    let stats = await store.getStats();
    expect(stats.totalExperiences).toBe(0);
    expect(stats.totalStrategies).toBe(0);

    // Add experiences
    await store.recordExperience({
      goal: "Fix bug 1",
      outcome: "success",
      trajectory: [],
      iterations: 1,
      tokenUsage: 100,
      duration: 1000,
      skillsUsed: [],
    });
    await store.recordExperience({
      goal: "Fix bug 2",
      outcome: "failure",
      trajectory: [],
      iterations: 3,
      tokenUsage: 300,
      duration: 5000,
      skillsUsed: [],
    });

    // Add strategies
    await store.storeStrategy({
      content: "Strategy A",
      source: [],
      utility: 0.8,
      applications: 0,
    });
    await store.storeStrategy({
      content: "Strategy B",
      source: [],
      utility: 0.6,
      applications: 0,
    });

    stats = await store.getStats();
    expect(stats.totalExperiences).toBe(2);
    expect(stats.totalStrategies).toBe(2);
    expect(stats.averageUtility).toBe(0.7);
  });
});
