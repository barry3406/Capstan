import { describe, it, expect } from "bun:test";
// relative src import so Stryker mutation bites (fact (b)).
import { executeModelAndTools } from "../../packages/ai/src/loop/streaming-executor.ts";
import type {
  AgentTool,
  LLMMessage,
  LLMOptions,
  LLMProvider,
  LLMResponse,
  LLMStreamChunk,
} from "../../packages/ai/src/types.ts";

const msgs: LLMMessage[] = [{ role: "user", content: "hi" }];

function echoTool(overrides?: Partial<AgentTool>): AgentTool {
  return {
    name: "echo",
    description: "echoes args",
    isConcurrencySafe: true,
    execute: async (args) => args,
    ...overrides,
  };
}

/** chat-only fake (no stream) => non-streaming path. */
function chatLLM(response: Partial<LLMResponse>): LLMProvider {
  return {
    name: "fake-chat",
    async chat(_m: LLMMessage[], _o?: LLMOptions): Promise<LLMResponse> {
      return { content: "", model: "m", ...response };
    },
  };
}

/** stream-yielding fake. chat throws to prove the stream path is taken. */
function streamLLM(chunks: LLMStreamChunk[]): LLMProvider {
  return {
    name: "fake-stream",
    // Native-capable: the loop defers dispatch to stream-end and consumes
    // terminal chunk.toolCalls (D3 gating keys on this flag).
    nativeToolCalls: "terminal",
    async chat(): Promise<LLMResponse> {
      throw new Error("chat should not be called on stream path");
    },
    async *stream(_m: LLMMessage[], _o?: LLMOptions): AsyncIterable<LLMStreamChunk> {
      for (const c of chunks) yield c;
    },
  };
}

// ===========================================================================
// §1h — Loop outcome mapping (chat path)
// ===========================================================================

describe("§1h loop mapping (chat path)", () => {
  it("U-LOOP-NATIVE-01 — builds toolRequests from response.toolCalls and executes", async () => {
    const llm = chatLLM({
      content: "",
      toolCalls: [{ id: "call_1", name: "echo", args: { msg: "hi" } }],
    });
    const result = await executeModelAndTools(llm, msgs, [echoTool()], undefined, undefined);

    expect(result.toolRecords).toHaveLength(1);
    expect(result.toolRecords[0]!.tool).toBe("echo");
    expect(result.toolRecords[0]!.result).toEqual({ msg: "hi" });
    expect(result.toolRecords[0]!.status).toBe("success");
    expect(result.outcome.finishReason).toBe("tool_use");
  });

  it("U-LOOP-NATIVE-02 — native precedence over text in the same response", async () => {
    const llm = chatLLM({
      content: JSON.stringify({ tool: "echo", arguments: { msg: "FROMTEXT" } }),
      toolCalls: [{ id: "c1", name: "echo", args: { msg: "FROMNATIVE" } }],
    });
    const result = await executeModelAndTools(llm, msgs, [echoTool()], undefined, undefined);

    expect(result.toolRecords).toHaveLength(1);
    expect((result.toolRecords[0]!.result as { msg: string }).msg).toBe("FROMNATIVE");
  });

  it("U-LOOP-NATIVE-03 — empty-but-defined toolCalls:[] suppresses text parse (D1)", async () => {
    const llm = chatLLM({
      content: JSON.stringify({ tool: "echo", arguments: { msg: "hi" } }),
      toolCalls: [],
    });
    const result = await executeModelAndTools(llm, msgs, [echoTool()], undefined, undefined);

    expect(result.toolRecords).toHaveLength(0);
    expect(result.outcome.toolRequests.length).toBe(0);
  });

  it("U-LOOP-TEXT-01 — toolCalls field absent => unchanged text path", async () => {
    const llm = chatLLM({
      content: JSON.stringify({ tool: "echo", arguments: { msg: "hi" } }),
    });
    const result = await executeModelAndTools(llm, msgs, [echoTool()], undefined, undefined);

    expect(result.toolRecords).toHaveLength(1);
    expect((result.toolRecords[0]!.result as { msg: string }).msg).toBe("hi");
  });

  it("U-LOOP-FINISH-01 — non-empty toolRequests => finishReason tool_use regardless of provider string", async () => {
    const llm = chatLLM({
      content: "",
      finishReason: "stop",
      toolCalls: [{ id: "c1", name: "echo", args: { msg: "hi" } }],
    });
    const result = await executeModelAndTools(llm, msgs, [echoTool()], undefined, undefined);

    expect(result.outcome.toolRequests.length).toBeGreaterThan(0);
    expect(result.outcome.finishReason).toBe("tool_use");
  });

  it("rejects a guessed hidden tool name before execution", async () => {
    let executeCount = 0;
    const hidden = echoTool({
      async execute(args) {
        executeCount++;
        return args;
      },
    });
    const llm = chatLLM({
      toolCalls: [{ id: "hidden_1", name: "echo", args: { msg: "guessed" } }],
    });

    const result = await executeModelAndTools(
      llm,
      msgs,
      [hidden],
      undefined,
      undefined,
      undefined,
      undefined,
      [],
    );

    expect(executeCount).toBe(0);
    expect(result.toolRecords[0]!.status).toBe("error");
    expect(result.toolRecords[0]!.result).toMatchObject({ code: "TOOL_NOT_DISCLOSED" });
  });

  it("rejects provider-native disclosure when the catalog budget denies it", async () => {
    let executeCount = 0;
    const hidden = echoTool({
      async execute(args) {
        executeCount++;
        return args;
      },
    });
    const llm = chatLLM({
      disclosedTools: ["echo"],
      toolCalls: [{ id: "hidden_2", name: "echo", args: { msg: "too large" } }],
    });

    const result = await executeModelAndTools(
      llm,
      msgs,
      [hidden],
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      () => [],
    );

    expect(executeCount).toBe(0);
    expect(result.outcome.disclosedTools).toEqual([]);
    expect(result.toolRecords[0]!.result).toMatchObject({ code: "TOOL_NOT_DISCLOSED" });
  });

  it("executes a hidden tool after provider-native disclosure is authorized", async () => {
    let authorizedNames: readonly string[] = [];
    const hidden = echoTool();
    const llm = chatLLM({
      disclosedTools: ["echo"],
      toolCalls: [{ id: "hidden_3", name: "echo", args: { msg: "authorized" } }],
    });

    const result = await executeModelAndTools(
      llm,
      msgs,
      [hidden],
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      (names) => {
        authorizedNames = names;
        return ["echo"];
      },
    );

    expect(authorizedNames).toEqual(["echo"]);
    expect(result.outcome.disclosedTools).toEqual(["echo"]);
    expect(result.toolRecords[0]!.result).toEqual({ msg: "authorized" });
  });
});

// ===========================================================================
// §1i — Loop outcome mapping (stream path)
// Gating (exit-notes): tools are advertised, so the stream path defers ALL
// dispatch to stream-end and consumes terminal chunk.toolCalls first.
// ===========================================================================

describe("§1i loop mapping (stream path)", () => {
  it("U-LOOP-STREAM-NATIVE-01 — terminal chunk.toolCalls drives execution (native precedence)", async () => {
    const llm = streamLLM([
      { content: "some text", done: false },
      { content: "", done: true, toolCalls: [{ id: "c1", name: "echo", args: { msg: "hi" } }] },
    ]);
    const result = await executeModelAndTools(llm, msgs, [echoTool()], undefined, undefined);

    expect(result.toolRecords).toHaveLength(1);
    expect(result.toolRecords[0]!.tool).toBe("echo");
    expect(result.toolRecords[0]!.result).toEqual({ msg: "hi" });
  });

  it("U-LOOP-STREAM-TEXT-01 — no toolCalls on any chunk => text parse fallback (regression)", async () => {
    const json = JSON.stringify({ tool: "echo", arguments: { msg: "hi" } });
    const half = Math.floor(json.length / 2);
    const llm = streamLLM([
      { content: json.slice(0, half), done: false },
      { content: json.slice(half), done: false },
      { content: "", done: true },
    ]);
    const result = await executeModelAndTools(llm, msgs, [echoTool()], undefined, undefined);

    expect(result.toolRecords).toHaveLength(1);
    expect((result.toolRecords[0]!.result as { msg: string }).msg).toBe("hi");
  });

  it("U-LOOP-STREAM-NATIVE-02 — terminal chunk.toolCalls:[] suppresses text parse (D1 on stream)", async () => {
    const llm = streamLLM([
      { content: JSON.stringify({ tool: "echo", arguments: { msg: "FROMTEXT" } }), done: false },
      { content: "", done: true, toolCalls: [] },
    ]);
    const result = await executeModelAndTools(llm, msgs, [echoTool()], undefined, undefined);

    expect(result.outcome.toolRequests.length).toBe(0);
    expect(result.toolRecords).toHaveLength(0);
  });

  it("U-LOOP-STREAM-NATIVE-03 — no double-dispatch: execute count===1 with native args", async () => {
    let executeCount = 0;
    const counting = echoTool({
      isConcurrencySafe: true,
      async execute(args) {
        executeCount++;
        return args;
      },
    });
    const llm = streamLLM([
      { content: JSON.stringify({ tool: "echo", arguments: { msg: "FROMTEXT" } }), done: false },
      { content: "", done: false },
      { content: "", done: true, toolCalls: [{ id: "c1", name: "echo", args: { msg: "FROMNATIVE" } }] },
    ]);
    const result = await executeModelAndTools(llm, msgs, [counting], undefined, undefined);

    expect(executeCount).toBe(1);
    expect(result.toolRecords).toHaveLength(1);
    expect((result.toolRecords[0]!.result as { msg: string }).msg).toBe("FROMNATIVE");
  });
});
