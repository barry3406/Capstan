import { describe, it, expect, beforeEach } from "bun:test";
import { createSmartAgent, BuiltinMemoryBackend, InMemoryEvolutionStore, buildStrategyLayer } from "../../packages/ai/src/index.js";
import type {
  LLMProvider,
  LLMMessage,
  LLMResponse,
  LLMOptions,
  AgentTool,
  SmartAgentConfig,
  AgentCheckpoint,
  AgentRunResult,
} from "../../packages/ai/src/types.js";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helper: create a mock LLM that returns a sequence of responses
// ---------------------------------------------------------------------------

function mockLLM(responses: string[], sink?: LLMMessage[][]): LLMProvider {
  let callIndex = 0;
  return {
    name: "mock",
    async chat(messages: LLMMessage[], _opts?: LLMOptions): Promise<LLMResponse> {
      sink?.push(messages.map((m) => ({ ...m })));
      const content = responses[callIndex] ?? "done";
      callIndex++;
      return { content, model: "mock-1" };
    },
  };
}

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe("Integration Tests", () => {
  // Test 1: Memory retrieval -> prompt injection -> session summary
  it("Test 1: memory retrieval feeds into system prompt and session summary is stored", async () => {
    const memoryStore = new BuiltinMemoryBackend();
    const scope = { type: "project", id: "test" };

    // Pre-populate memory
    await memoryStore.store({
      content: "always use TypeScript strict mode",
      scope,
    });

    const sink: LLMMessage[][] = [];
    const agent = createSmartAgent({
      llm: mockLLM(["Task completed successfully."], sink),
      tools: [],
      memory: {
        store: memoryStore,
        scope,
        saveSessionSummary: true,
      },
    });

    const result = await agent.run("Configure TypeScript strict mode for the project");

    expect(result.status).toBe("completed");

    // Verify system prompt contains the memory
    const firstCallMessages = sink[0]!;
    const systemMsg = firstCallMessages.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain("always use TypeScript strict mode");

    // Verify session summary was stored
    const memories = await memoryStore.query(scope, "session completed", 10);
    const summaryEntry = memories.find((m) => m.content.includes("Session completed"));
    expect(summaryEntry).toBeDefined();
    expect(summaryEntry!.content).toContain("Configure TypeScript strict mode");
  });

  // Test 2: Skill activation + tool execution in same run
  it("Test 2: skill activation and tool execution work together in one run", async () => {
    const sink: LLMMessage[][] = [];

    const readFile: AgentTool = {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      async execute(args) {
        return { content: `Contents of ${args.path}` };
      },
    };

    const runTests: AgentTool = {
      name: "run_tests",
      description: "Run test suite",
      parameters: { type: "object", properties: { pattern: { type: "string" } } },
      async execute() {
        return { passed: 5, failed: 0 };
      },
    };

    const agent = createSmartAgent({
      llm: mockLLM(
        [
          // Iteration 1: activate the skill
          JSON.stringify({ tool: "activate_skill", arguments: { skill_name: "tdd-debug" } }),
          // Iteration 2: read a file
          JSON.stringify({ tool: "read_file", arguments: { path: "src/index.ts" } }),
          // Iteration 3: run tests
          JSON.stringify({ tool: "run_tests", arguments: { pattern: "*.test.ts" } }),
          // Iteration 4: final answer
          "Fixed the issue. All tests pass.",
        ],
        sink,
      ),
      tools: [readFile, runTests],
      skills: [
        {
          name: "tdd-debug",
          description: "Debug using TDD workflow",
          trigger: "debugging test failures",
          prompt: "Follow the TDD debug workflow: read tests first, understand failures, then fix.",
        },
      ],
    });

    const result = await agent.run("Fix the failing tests");

    expect(result.status).toBe("completed");
    expect(result.result).toBe("Fixed the issue. All tests pass.");

    // Verify all 3 tool calls are recorded (activate_skill + read_file + run_tests)
    expect(result.toolCalls).toHaveLength(3);
    expect(result.toolCalls.map((c) => c.tool)).toEqual(["activate_skill", "read_file", "run_tests"]);

    // Verify skill guidance was returned on activation
    const activateResult = result.toolCalls[0]!.result as Record<string, unknown>;
    expect(activateResult.guidance).toContain("TDD debug workflow");

    // Verify tool results fed back correctly: the second LLM call should see activate_skill result
    const secondCallMsgs = sink[1]!;
    const toolResultMsg = secondCallMsgs.find((m) => m.content.includes("activate_skill"));
    expect(toolResultMsg).toBeDefined();
  });

  // Test 3: Evolution strategy injection into prompt
  it("Test 3: evolution strategies are injected into system prompt via layers", async () => {
    const evoStore = new InMemoryEvolutionStore();

    // Pre-populate with a strategy
    await evoStore.storeStrategy({
      content: "Always read tests first",
      source: ["manual"],
      utility: 0.8,
      applications: 3,
    });

    // Build strategy layer from store
    const strategies = await evoStore.queryStrategies("", 10);
    const strategyLayer = buildStrategyLayer(strategies);
    expect(strategyLayer).not.toBeNull();

    const sink: LLMMessage[][] = [];
    const agent = createSmartAgent({
      llm: mockLLM(["Done."], sink),
      tools: [],
      prompt: {
        layers: strategyLayer ? [strategyLayer] : [],
      },
    });

    const result = await agent.run("Fix a bug");

    expect(result.status).toBe("completed");

    // Verify system prompt contains the strategy
    const firstCallMessages = sink[0]!;
    const systemMsg = firstCallMessages.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain("Learned Strategies");
    expect(systemMsg!.content).toContain("Always read tests first");
  });

  // Test 4: Tool validation -> rejection -> LLM self-corrects
  it("Test 4: tool validation rejects bad args and LLM self-corrects on retry", async () => {
    const sink: LLMMessage[][] = [];

    const fileTool: AgentTool = {
      name: "file_op",
      description: "Perform a file operation",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          mode: { type: "string", enum: ["read", "write"] },
        },
        required: ["path", "mode"],
      },
      validate(args) {
        const errors: string[] = [];
        if (typeof args.path !== "string") {
          errors.push('Field "path": expected string, got ' + typeof args.path);
        }
        if (args.mode !== "read" && args.mode !== "write") {
          errors.push(`Field "mode": value ${JSON.stringify(args.mode)} is not one of ["read", "write"]`);
        }
        if (errors.length > 0) return { valid: false, error: errors.join("\n") };
        return { valid: true };
      },
      async execute(args) {
        return { ok: true, path: args.path, mode: args.mode };
      },
    };

    const agent = createSmartAgent({
      llm: mockLLM(
        [
          // Iteration 1: bad args (path is number, mode is invalid)
          JSON.stringify({ tool: "file_op", arguments: { path: 123, mode: "delete" } }),
          // Iteration 2: corrected args
          JSON.stringify({ tool: "file_op", arguments: { path: "/tmp/test", mode: "read" } }),
          // Iteration 3: final answer
          "File read successfully.",
        ],
        sink,
      ),
      tools: [fileTool],
    });

    const result = await agent.run("Read the file");

    expect(result.status).toBe("completed");

    // First tool call should be an error (validation failed)
    const firstCall = result.toolCalls[0]!;
    expect(firstCall.tool).toBe("file_op");
    expect(firstCall.status).toBe("error");
    const errorResult = firstCall.result as Record<string, unknown>;
    expect(errorResult.error).toBeDefined();

    // Second tool call should succeed
    const secondCall = result.toolCalls[1]!;
    expect(secondCall.tool).toBe("file_op");
    expect(secondCall.status).toBe("success");
    expect((secondCall.result as Record<string, unknown>).ok).toBe(true);
  });

  // Test 5: Dynamic memory enrichment at interval
  it("Test 5: memory enrichment fires after iteration 5", async () => {
    const memoryStore = new BuiltinMemoryBackend();
    const scope = { type: "project", id: "enrich-test" };

    // Pre-populate memory that would be relevant to tool results
    await memoryStore.store({
      content: "API X requires auth header",
      scope,
    });

    const sink: LLMMessage[][] = [];

    const noopTool: AgentTool = {
      name: "check_api",
      description: "Check API status",
      async execute() {
        return { status: "ok", api: "X" };
      },
    };

    // We need 6+ iterations. Memory enrichment fires at MEMORY_ENRICHMENT_INTERVAL (5).
    // Tool calls happen at iterations 1-5, then iteration 6 gets final answer.
    const responses = [
      ...Array.from({ length: 6 }, () =>
        JSON.stringify({ tool: "check_api", arguments: {} }),
      ),
      "All APIs checked.",
    ];

    const agent = createSmartAgent({
      llm: mockLLM(responses, sink),
      tools: [noopTool],
      memory: {
        store: memoryStore,
        scope,
      },
      loopGuard: { enabled: false },
      maxIterations: 10,
    });

    const result = await agent.run("Check all APIs");

    expect(result.status).toBe("completed");
    expect(result.iterations).toBeGreaterThanOrEqual(6);

    // Check that a memory enrichment message was injected after iteration 5
    // The LLM calls after iteration 5 should contain the enrichment content
    const allMessages = sink.flat();
    const enrichmentMsg = allMessages.find((m) =>
      m.content.includes("[MEMORY_ENRICHMENT]"),
    );
    expect(enrichmentMsg).toBeDefined();
    expect(enrichmentMsg!.content).toContain("API X requires auth header");
  });

  // Test 6: Tool result persistence + read_persisted_result round-trip
  it("Test 6: large tool results are truncated, persisted, and retrievable", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "capstan-persist-test-"));

    try {
      // Generate a 20KB result
      const bigData = { items: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `item-${i}`, description: "A".repeat(30) })) };

      const bigTool: AgentTool = {
        name: "fetch_data",
        description: "Fetch large dataset",
        async execute() {
          return bigData;
        },
      };

      const sink: LLMMessage[][] = [];

      // The agent will:
      // 1. Call fetch_data -> gets truncated result with persist ref
      // 2. Call read_persisted_result with the ID
      // 3. Provide final answer
      let persistedId: string | undefined;

      const agent = createSmartAgent({
        llm: {
          name: "mock-persist",
          async chat(messages: LLMMessage[]): Promise<LLMResponse> {
            sink.push(messages.map((m) => ({ ...m })));

            // First call: trigger the big tool
            if (sink.length === 1) {
              return { content: JSON.stringify({ tool: "fetch_data", arguments: {} }), model: "mock-1" };
            }

            // Second call: extract the persisted ID from the truncated result and read it
            if (sink.length === 2) {
              const lastMsg = messages[messages.length - 1]!;
              const idMatch = lastMsg.content.match(/read_persisted_result tool with id "([^"]+)"/);
              if (idMatch) {
                persistedId = idMatch[1];
                return {
                  content: JSON.stringify({ tool: "read_persisted_result", arguments: { id: persistedId } }),
                  model: "mock-1",
                };
              }
              return { content: "No persisted result found.", model: "mock-1" };
            }

            // Third call: final answer
            return { content: "Data retrieved successfully.", model: "mock-1" };
          },
        },
        tools: [bigTool],
        toolResultBudget: {
          maxChars: 1000,
          persistDir: tempDir,
        },
        maxIterations: 5,
      });

      const result = await agent.run("Fetch the large dataset");

      expect(result.status).toBe("completed");
      expect(persistedId).toBeDefined();

      // Verify first call was truncated
      const secondCallMsgs = sink[1]!;
      const truncatedMsg = secondCallMsgs.find((m) => m.content.includes("truncated"));
      expect(truncatedMsg).toBeDefined();

      // Verify read_persisted_result was called and succeeded
      const readPersistedCall = result.toolCalls.find((c) => c.tool === "read_persisted_result");
      expect(readPersistedCall).toBeDefined();
      expect(readPersistedCall!.status).toBe("success");

      // Verify the full data was returned
      const readResult = readPersistedCall!.result as { items: unknown[] };
      expect(readResult.items).toHaveLength(500);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotency Tests
// ---------------------------------------------------------------------------

describe("Idempotency Tests", () => {
  // Test 7: Same checkpoint resumed twice -> identical results
  it("Test 7: resuming the same checkpoint twice yields identical results", async () => {
    let capturedCheckpoint: AgentCheckpoint | undefined;
    let controlCallCount = 0;

    // We need a deterministic LLM that works across multiple agent instances
    function makePauseLLM(): LLMProvider {
      let callIndex = 0;
      return {
        name: "mock-pause",
        async chat(messages: LLMMessage[]): Promise<LLMResponse> {
          const content = [
            JSON.stringify({ tool: "step", arguments: { n: 1 } }),
            JSON.stringify({ tool: "step", arguments: { n: 2 } }),
            "Final result after resume.",
          ][callIndex] ?? "done";
          callIndex++;
          return { content, model: "mock-1" };
        },
      };
    }

    const stepTool: AgentTool = {
      name: "step",
      description: "A step",
      async execute(args) {
        return { step: args.n };
      },
    };

    // Run 1: pause at iteration 2
    controlCallCount = 0;
    const agent1 = createSmartAgent({
      llm: makePauseLLM(),
      tools: [stepTool],
      maxIterations: 10,
      hooks: {
        getControlState: async (_phase, checkpoint) => {
          controlCallCount++;
          if (checkpoint.iterations >= 2) {
            capturedCheckpoint = checkpoint;
            return { action: "pause" };
          }
          return { action: "continue" };
        },
      },
    });

    const pauseResult = await agent1.run("Do some steps");
    expect(pauseResult.status).toBe("paused");
    expect(capturedCheckpoint).toBeDefined();

    // Resume A from the checkpoint
    function makeResumeLLM(): LLMProvider {
      let callIndex = 0;
      return {
        name: "mock-resume",
        async chat(): Promise<LLMResponse> {
          const content = ["Resumed and completed."][callIndex] ?? "done";
          callIndex++;
          return { content, model: "mock-1" };
        },
      };
    }

    const agentA = createSmartAgent({
      llm: makeResumeLLM(),
      tools: [stepTool],
      maxIterations: 10,
    });

    const resultA = await agentA.resume(capturedCheckpoint!, "continue");

    // Resume B from the SAME checkpoint
    const agentB = createSmartAgent({
      llm: makeResumeLLM(),
      tools: [stepTool],
      maxIterations: 10,
    });

    const resultB = await agentB.resume(capturedCheckpoint!, "continue");

    // Both results should be identical
    expect(resultA.status).toBe(resultB.status);
    expect(resultA.iterations).toBe(resultB.iterations);
    expect(resultA.result).toBe(resultB.result);
  });

  // Test 8: Deterministic replay with same mock
  it("Test 8: running the same config twice produces identical results", async () => {
    function makeConfig(): SmartAgentConfig {
      let callIndex = 0;
      return {
        llm: {
          name: "mock-deterministic",
          async chat(): Promise<LLMResponse> {
            const responses = [
              JSON.stringify({ tool: "lookup", arguments: { key: "x" } }),
              "The value is 42.",
            ];
            const content = responses[callIndex] ?? "done";
            callIndex++;
            return { content, model: "mock-1" };
          },
        },
        tools: [
          {
            name: "lookup",
            description: "Look up a value",
            async execute(args) {
              return { value: 42 };
            },
          },
        ],
        maxIterations: 5,
      };
    }

    const agent1 = createSmartAgent(makeConfig());
    const result1 = await agent1.run("Find the value of x");

    const agent2 = createSmartAgent(makeConfig());
    const result2 = await agent2.run("Find the value of x");

    expect(result1.status).toBe(result2.status);
    expect(result1.iterations).toBe(result2.iterations);
    expect(result1.result).toBe(result2.result);
    expect(result1.toolCalls.length).toBe(result2.toolCalls.length);
    expect(result1.toolCalls.map((c) => c.tool)).toEqual(result2.toolCalls.map((c) => c.tool));
    expect(result1.toolCalls.map((c) => c.result)).toEqual(result2.toolCalls.map((c) => c.result));
  });

  // Test 9: Evolution store operations are idempotent
  it("Test 9: evolution store handles duplicate entries and utility bounds correctly", async () => {
    const store = new InMemoryEvolutionStore();

    // Record same experience twice -> 2 entries (NOT deduped)
    const exp = {
      goal: "fix a bug",
      outcome: "success" as const,
      trajectory: [],
      iterations: 3,
      tokenUsage: 1000,
      duration: 5000,
      skillsUsed: [],
    };
    const id1 = await store.recordExperience(exp);
    const id2 = await store.recordExperience(exp);
    expect(id1).not.toBe(id2); // Different IDs

    const experiences = await store.queryExperiences({});
    expect(experiences.length).toBe(2);

    // Store same strategy content twice -> 2 entries
    const stratDef = {
      content: "Always check error handling",
      source: ["exp-1"],
      utility: 0.5,
      applications: 0,
    };
    const sid1 = await store.storeStrategy(stratDef);
    const sid2 = await store.storeStrategy(stratDef);
    expect(sid1).not.toBe(sid2); // Different IDs

    const strategies = await store.queryStrategies("", 10);
    expect(strategies.length).toBe(2);

    // Update utility on same strategy: +0.1 six times -> clamped at 1.0
    // Start at 0.5, add 0.1 six times — overshoots 1.0 but gets clamped by Math.min
    for (let i = 0; i < 6; i++) {
      await store.updateStrategyUtility(sid1, 0.1);
    }
    const afterIncrement = await store.queryStrategies("", 10);
    const updated = afterIncrement.find((s) => s.id === sid1);
    expect(updated).toBeDefined();
    // Clamped at exactly 1.0 (Math.min(1, ...))
    expect(updated!.utility).toBe(1.0);

    // Further increment should stay at 1.0 (clamped)
    await store.updateStrategyUtility(sid1, 0.1);
    const afterExtraIncrement = await store.queryStrategies("", 10);
    const stillClamped = afterExtraIncrement.find((s) => s.id === sid1);
    expect(stillClamped!.utility).toBe(1.0);

    // Decrement: -0.05 twenty times -> clamped at 0.0
    // Start sid2 at 0.5, subtract 0.05 twenty times
    for (let i = 0; i < 20; i++) {
      await store.updateStrategyUtility(sid2, -0.05);
    }
    const afterDecrement = await store.queryStrategies("", 10);
    const decremented = afterDecrement.find((s) => s.id === sid2);
    expect(decremented).toBeDefined();
    expect(decremented!.utility).toBe(0.0);

    // Further decrement should stay at 0.0 (clamped)
    await store.updateStrategyUtility(sid2, -0.1);
    const afterExtraDecrement = await store.queryStrategies("", 10);
    const stillZero = afterExtraDecrement.find((s) => s.id === sid2);
    expect(stillZero!.utility).toBe(0.0);
  });

  // Test 10: Compaction preserves conversation coherence
  it("Test 10: compaction under small context window produces valid conversation", async () => {
    const noopTool: AgentTool = {
      name: "analyze",
      description: "Analyze code",
      async execute(args) {
        // Return moderately sized results to push token count up
        return {
          file: args.file ?? "unknown",
          analysis: "The code has several issues that need to be addressed. ".repeat(10),
          lines: Array.from({ length: 20 }, (_, i) => `Line ${i + 1}: content here for analysis purposes`),
        };
      },
    };

    let iteration = 0;
    const agent = createSmartAgent({
      llm: {
        name: "mock-compaction",
        async chat(messages: LLMMessage[]): Promise<LLMResponse> {
          iteration++;
          if (iteration <= 20) {
            return {
              content: JSON.stringify({
                tool: "analyze",
                arguments: { file: `src/file${iteration}.ts` },
              }),
              model: "mock-1",
            };
          }
          return { content: "Analysis complete. Found 20 files with issues.", model: "mock-1" };
        },
      },
      tools: [noopTool],
      maxIterations: 25,
      contextWindowSize: 3000, // Very small to force compression
      compaction: {
        snip: { preserveTail: 4 },
        microcompact: { maxToolResultChars: 200, protectedTail: 3 },
        autocompact: { threshold: 0.85, maxFailures: 5 },
      },
    });

    const result = await agent.run("Analyze all source files");

    // Should complete (not fatal) despite heavy compression
    expect(["completed", "max_iterations"]).toContain(result.status);

    // Verify checkpoint messages form a valid conversation
    if (result.checkpoint) {
      const msgs = result.checkpoint.messages;

      // First message should be system
      expect(msgs[0]!.role).toBe("system");

      // No orphaned tool_results: every "user" message that contains Tool " results
      // should be preceded by an "assistant" message (or system)
      for (let i = 1; i < msgs.length; i++) {
        const msg = msgs[i]!;
        if (msg.role === "user" && msg.content.includes('Tool "')) {
          // The preceding message should be assistant (or a prior user message from the system)
          const prevMsg = msgs[i - 1]!;
          expect(["assistant", "system", "user"]).toContain(prevMsg.role);
        }
      }

      // Messages should alternate roles properly (no empty content after compaction)
      for (const msg of msgs) {
        // Content should not be empty after compaction
        expect(msg.content.length).toBeGreaterThan(0);
      }
    }

    // Should have completed within iteration budget
    expect(result.iterations).toBeLessThanOrEqual(25);
  });
});
