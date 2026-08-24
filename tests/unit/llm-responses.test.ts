import { describe, it, expect, afterEach } from "bun:test";
import { responsesProvider, parseResponsesPayload } from "../../packages/agent/src/llm.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function captureResponses(responseBody: string, cap: { url?: string; body?: any; headers?: Record<string, string> }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    cap.url = typeof url === "string" ? url : url.toString();
    cap.headers = init?.headers as Record<string, string>;
    cap.body = JSON.parse(init?.body as string);
    return new Response(responseBody, { status: 200 });
  }) as unknown as typeof fetch;
}

const JSON_OK = JSON.stringify({ model: "gpt-5.5", output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }] });

describe("responsesProvider — request shape", () => {
  it("posts to /v1/responses, maps system->instructions and roles->input blocks", async () => {
    const cap: { url?: string; body?: any; headers?: Record<string, string> } = {};
    globalThis.fetch = captureResponses(JSON_OK, cap);
    const p = responsesProvider({ apiKey: "sk-x", baseUrl: "https://cocode.cc", model: "gpt-5.5", reasoningEffort: "low" });
    await p.chat([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "prior" },
    ], { maxTokens: 1024 });

    expect(cap.url).toBe("https://cocode.cc/v1/responses");
    expect(cap.headers!["Authorization"]).toBe("Bearer sk-x");
    expect(cap.body.instructions).toBe("be terse");
    // system excluded from input; user->input_text, assistant->output_text
    expect(cap.body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { role: "assistant", content: [{ type: "output_text", text: "prior" }] },
    ]);
    expect(cap.body.reasoning).toEqual({ effort: "low" });
    expect(cap.body.max_output_tokens).toBe(1024);
    expect(cap.body.store).toBe(false);
  });

  it("baseUrl already ending in /v1 is not double-versioned", async () => {
    const cap: { url?: string } = {};
    globalThis.fetch = captureResponses(JSON_OK, cap as any);
    const p = responsesProvider({ apiKey: "sk", baseUrl: "https://api.openai.com/v1" });
    await p.chat([{ role: "user", content: "hi" }]);
    expect(cap.url).toBe("https://api.openai.com/v1/responses");
  });

  it("omits reasoning when no effort configured (non-reasoning models)", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureResponses(JSON_OK, cap as any);
    const p = responsesProvider({ apiKey: "sk" });
    await p.chat([{ role: "user", content: "hi" }]);
    expect("reasoning" in cap.body).toBe(false);
  });

  it("never sends temperature (reasoning models reject it)", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureResponses(JSON_OK, cap as any);
    const p = responsesProvider({ apiKey: "sk", reasoningEffort: "low" });
    await p.chat([{ role: "user", content: "hi" }], { temperature: 0 });
    expect("temperature" in cap.body).toBe(false);
  });
});

describe("responsesProvider — response parsing", () => {
  it("parses plain JSON output blocks", async () => {
    globalThis.fetch = captureResponses(JSON_OK, {});
    const p = responsesProvider({ apiKey: "sk" });
    const r = await p.chat([{ role: "user", content: "hi" }]);
    expect(r.content).toBe("hello");
    expect(r.model).toBe("gpt-5.5");
  });

  it("parses the output_text shorthand", async () => {
    globalThis.fetch = captureResponses(JSON.stringify({ model: "m", output_text: "short" }), {});
    const p = responsesProvider({ apiKey: "sk" });
    expect((await p.chat([{ role: "user", content: "hi" }])).content).toBe("short");
  });

  it("parses an SSE response.completed payload", async () => {
    const sse =
      "event: response.created\n" +
      'data: {"type":"response.created"}\n\n' +
      "event: response.completed\n" +
      'data: {"response":{"model":"gpt-5.5","output":[{"type":"message","content":[{"type":"output_text","text":"streamed-final"}]}]}}\n\n';
    globalThis.fetch = captureResponses(sse, {});
    const p = responsesProvider({ apiKey: "sk" });
    expect((await p.chat([{ role: "user", content: "hi" }])).content).toBe("streamed-final");
  });

  it("falls back to accumulated SSE deltas when no completed event", () => {
    const sse =
      "event: response.output_text.delta\n" + 'data: {"delta":"He"}\n\n' +
      "event: response.output_text.delta\n" + 'data: {"delta":"llo"}\n\n';
    expect(parseResponsesPayload(sse, "m").content).toBe("Hello");
  });

  it("throws on non-200", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 429 })) as unknown as typeof fetch;
    const p = responsesProvider({ apiKey: "sk" });
    await expect(p.chat([{ role: "user", content: "hi" }])).rejects.toThrow("Responses API error 429");
  });
});

describe("responsesProvider — native function-calling", () => {
  const TOOL_JSON = JSON.stringify({
    model: "gpt-5.5",
    output: [
      { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"sf"}' },
    ],
  });
  const weatherTool = { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } } } };

  it("parseResponsesPayload extracts function_call tool calls (JSON)", () => {
    expect(parseResponsesPayload(TOOL_JSON, "m").toolCalls).toEqual([
      { id: "call_1", name: "get_weather", args: { city: "sf" } },
    ]);
  });

  it("parseResponsesPayload extracts tool calls from an SSE completed event", () => {
    const inner = JSON.stringify({
      response: {
        model: "m",
        output: [{ type: "function_call", call_id: "c2", name: "search", arguments: JSON.stringify({ q: "x" }) }],
      },
    });
    const sse = `event: response.completed\ndata: ${inner}\n\n`;
    expect(parseResponsesPayload(sse, "m").toolCalls).toEqual([
      { id: "c2", name: "search", args: { q: "x" } },
    ]);
  });

  it("parseResponsesPayload returns undefined toolCalls for a plain-text payload", () => {
    expect(parseResponsesPayload(JSON_OK, "m").toolCalls).toBeUndefined();
  });

  it("advertises tools in the Responses flat function format + sets nativeToolCalls", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureResponses(JSON_OK, cap as any);
    const p = responsesProvider({ apiKey: "sk" });
    expect(p.nativeToolCalls).toBe("terminal");
    await p.chat([{ role: "user", content: "hi" }], { tools: [weatherTool] });
    expect(cap.body.tools).toEqual([
      { type: "function", name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
    ]);
  });

  it("uses native tool search for deferred tools on supported models", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureResponses(JSON_OK, cap as any);
    const p = responsesProvider({ apiKey: "sk", model: "gpt-5.5" });

    await p.chat([{ role: "user", content: "weather?" }], {
      tools: [{ name: "discover_tools", description: "Find tools" }],
      deferredTools: [weatherTool],
    });

    expect(p.nativeToolSearch).toBe("openai");
    expect(cap.body.tools).toEqual([
      { type: "tool_search" },
      {
        type: "function",
        name: "discover_tools",
        description: "Find tools",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "get_weather",
        description: "Get weather",
        parameters: weatherTool.parameters,
        defer_loading: true,
      },
    ]);
  });

  it("falls back to visible discovery on models without native tool search", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureResponses(JSON_OK, cap as any);
    const p = responsesProvider({ apiKey: "sk", model: "gpt-5.3" });

    await p.chat([{ role: "user", content: "weather?" }], {
      tools: [{ name: "discover_tools", description: "Find tools" }],
      deferredTools: [weatherTool],
    });

    expect(cap.body.tools).toEqual([
      {
        type: "function",
        name: "discover_tools",
        description: "Find tools",
        parameters: { type: "object", properties: {} },
      },
    ]);
  });

  it("extracts disclosed tool references from JSON and completed SSE payloads", () => {
    const output = [
      {
        type: "tool_search_call",
        results: [{ type: "tool_reference", tool_name: "get_weather" }],
      },
    ];
    expect(
      parseResponsesPayload(JSON.stringify({ model: "gpt-5.5", output }), "m")
        .disclosedTools,
    ).toEqual(["get_weather"]);

    const completed = JSON.stringify({ response: { model: "gpt-5.5", output } });
    expect(
      parseResponsesPayload(
        `event: response.completed\ndata: ${completed}\n\n`,
        "m",
      ).disclosedTools,
    ).toEqual(["get_weather"]);
  });

  it("returns the model's tool calls when tools were advertised", async () => {
    globalThis.fetch = captureResponses(TOOL_JSON, {});
    const p = responsesProvider({ apiKey: "sk" });
    const r = await p.chat([{ role: "user", content: "weather?" }], { tools: [weatherTool] });
    expect(r.toolCalls).toEqual([{ id: "call_1", name: "get_weather", args: { city: "sf" } }]);
  });

  it("toolCalls is [] (not undefined) when tools advertised but none called", async () => {
    globalThis.fetch = captureResponses(JSON_OK, {}); // plain text, no function_call
    const p = responsesProvider({ apiKey: "sk" });
    const r = await p.chat([{ role: "user", content: "hi" }], { tools: [weatherTool] });
    expect(r.toolCalls).toEqual([]); // contract: advertised => present (possibly [])
  });

  it("omits toolCalls (undefined) when no tools were advertised", async () => {
    globalThis.fetch = captureResponses(JSON_OK, {});
    const p = responsesProvider({ apiKey: "sk" });
    const r = await p.chat([{ role: "user", content: "hi" }]);
    expect(r.toolCalls).toBeUndefined();
  });
});
