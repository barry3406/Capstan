import { describe, it, expect, afterEach } from "bun:test";
// IMPORTANT: relative src import so Stryker mutation bites (fact (b)).
import { openaiProvider, anthropicProvider } from "../../packages/agent/src/llm.ts";
import type { LLMStreamChunk } from "../../packages/agent/src/llm.ts";

// ---------------------------------------------------------------------------
// fetch capture/restore (mirrors tests/unit/llm.test.ts style)
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Build a one-shot ReadableStream that emits all SSE lines in a single chunk. */
function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = lines.join("\n") + "\n";
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

/** Build a ReadableStream that emits a pre-segmented list of raw string
 * fragments (used to simulate transport-level fragmentation where a single
 * logical SSE frame is split across multiple reads). */
function rawStream(fragments: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of fragments) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
}

/** Capture-fetch returning a JSON body; records the parsed request body/url/headers. */
function captureJson(
  responseBody: unknown,
  capture: { body?: any; url?: string; headers?: Record<string, string> },
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture.url = typeof url === "string" ? url : url.toString();
    capture.headers = init?.headers as Record<string, string>;
    capture.body = JSON.parse(init?.body as string);
    return new Response(JSON.stringify(responseBody), { status: 200 });
  }) as unknown as typeof fetch;
}

/** Capture-fetch returning an SSE stream from string lines. */
function captureSse(
  lines: string[],
  capture: { body?: any; url?: string; headers?: Record<string, string> },
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture.url = typeof url === "string" ? url : url.toString();
    capture.headers = init?.headers as Record<string, string>;
    capture.body = JSON.parse(init?.body as string);
    return new Response(sseStream(lines), { status: 200 });
  }) as unknown as typeof fetch;
}

async function collectStream(
  iter: AsyncIterable<LLMStreamChunk>,
): Promise<LLMStreamChunk[]> {
  const out: LLMStreamChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

// ===========================================================================
// §1a — Multimodal serialization on chat()
// ===========================================================================

describe("§1a multimodal chat() serialization", () => {
  it("U-OA-IMG-01 — OpenAI chat serializes text+image to image_url", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureJson(
      { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], model: "gpt-4o" },
      cap,
    );
    const provider = openaiProvider({ apiKey: "sk" });
    await provider.chat([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mediaType: "image/png", data: "AAAB" },
        ],
      },
    ] as any);

    expect(cap.body.messages[0].content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAB" } },
    ]);
  });

  it("U-OA-IMG-02 — OpenAI chat leaves string content untouched", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureJson(
      { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], model: "gpt-4o" },
      cap,
    );
    const provider = openaiProvider({ apiKey: "sk" });
    await provider.chat([{ role: "user", content: "hello" }]);

    expect(cap.body.messages[0]).toEqual({ role: "user", content: "hello" });
    expect(typeof cap.body.messages[0].content).toBe("string");
  });

  it("U-AN-IMG-01 — Anthropic chat serializes image to source.base64", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureJson(
      { content: [{ type: "text", text: "ok" }], model: "claude", stop_reason: "end_turn" },
      cap,
    );
    const provider = anthropicProvider({ apiKey: "sk" });
    await provider.chat([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mediaType: "image/jpeg", data: "ZZZ" },
        ],
      },
    ] as any);

    expect(cap.body.messages[0].content).toEqual([
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "ZZZ" } },
    ]);
  });

  it("U-AN-IMG-02 — Anthropic chat leaves string content untouched", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureJson(
      { content: [{ type: "text", text: "ok" }], model: "claude", stop_reason: "end_turn" },
      cap,
    );
    const provider = anthropicProvider({ apiKey: "sk" });
    await provider.chat([{ role: "user", content: "hello" }]);

    expect(cap.body.messages[0]).toEqual({ role: "user", content: "hello" });
    expect(typeof cap.body.messages[0].content).toBe("string");
  });

  it("U-AN-IMG-03 — Anthropic system stays top-level, user multimodal array preserved", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureJson(
      { content: [{ type: "text", text: "ok" }], model: "claude", stop_reason: "end_turn" },
      cap,
    );
    const provider = anthropicProvider({ apiKey: "sk" });
    await provider.chat([
      { role: "system", content: "sys" },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mediaType: "image/png", data: "Q" },
        ],
      },
    ] as any);

    expect(cap.body.system).toBe("sys");
    expect(cap.body.messages.length).toBe(1);
  });
});

// ===========================================================================
// §1b — Multimodal serialization on stream() (D3)
// ===========================================================================

describe("§1b multimodal stream() serialization", () => {
  it("U-OA-STREAM-IMG-01 — OpenAI stream() serializes image to image_url in body", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureSse(
      ['data: {"choices":[{"delta":{"content":"x"}}]}', "data: [DONE]"],
      cap,
    );
    const provider = openaiProvider({ apiKey: "sk" });
    await collectStream(
      provider.stream!([
        {
          role: "user",
          content: [
            { type: "text", text: "x" },
            { type: "image", mediaType: "image/png", data: "Q" },
          ],
        },
      ] as any),
    );

    expect(cap.body.messages[0].content).toContainEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,Q" },
    });
    expect(cap.body.stream).toBe(true);
  });

  it("U-AN-STREAM-IMG-01 — Anthropic stream() serializes image to source.base64 in body", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureSse(
      [
        'event: message_start',
        'data: {"type":"message_start"}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ],
      cap,
    );
    const provider = anthropicProvider({ apiKey: "sk" });
    await collectStream(
      provider.stream!([
        {
          role: "user",
          content: [
            { type: "text", text: "x" },
            { type: "image", mediaType: "image/png", data: "Q" },
          ],
        },
      ] as any),
    );

    expect(cap.body.messages[0].content).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "Q" },
    });
    expect(cap.body.stream).toBe(true);
  });
});

// ===========================================================================
// §1c — Native tools request serialization
// ===========================================================================

describe("§1c native tool request serialization", () => {
  const params = { type: "object", properties: { city: { type: "string" } } };

  it("U-OA-TOOLREQ-01 — OpenAI chat advertises tools + tool_choice auto", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureJson(
      { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], model: "gpt-4o" },
      cap,
    );
    const provider = openaiProvider({ apiKey: "sk" });
    await provider.chat([{ role: "user", content: "hi" }], {
      tools: [{ name: "get_weather", description: "d", parameters: params }],
    } as any);

    expect(cap.body.tools).toEqual([
      { type: "function", function: { name: "get_weather", description: "d", parameters: params } },
    ]);
    expect(cap.body.tool_choice).toBe("auto");
  });

  it("U-OA-TOOLREQ-02 — OpenAI chat omits tools/tool_choice when tools absent OR []", async () => {
    const provider = openaiProvider({ apiKey: "sk" });

    // absent
    const capAbsent: { body?: any } = {};
    globalThis.fetch = captureJson(
      { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], model: "gpt-4o" },
      capAbsent,
    );
    await provider.chat([{ role: "user", content: "hi" }]);
    expect("tools" in capAbsent.body).toBe(false);
    expect("tool_choice" in capAbsent.body).toBe(false);

    // empty array
    const capEmpty: { body?: any } = {};
    globalThis.fetch = captureJson(
      { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], model: "gpt-4o" },
      capEmpty,
    );
    await provider.chat([{ role: "user", content: "hi" }], { tools: [] } as any);
    expect("tools" in capEmpty.body).toBe(false);
    expect("tool_choice" in capEmpty.body).toBe(false);
  });

  it("U-AN-TOOLREQ-01 — Anthropic chat tools use input_schema", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureJson(
      { content: [{ type: "text", text: "ok" }], model: "claude", stop_reason: "end_turn" },
      cap,
    );
    const provider = anthropicProvider({ apiKey: "sk" });
    await provider.chat([{ role: "user", content: "hi" }], {
      tools: [{ name: "x", description: "d", parameters: params }],
    } as any);

    expect(cap.body.tools).toEqual([{ name: "x", description: "d", input_schema: params }]);
  });

  it("U-AN-TOOLREQ-02 — Anthropic supplies default input_schema when parameters missing", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureJson(
      { content: [{ type: "text", text: "ok" }], model: "claude", stop_reason: "end_turn" },
      cap,
    );
    const provider = anthropicProvider({ apiKey: "sk" });
    await provider.chat([{ role: "user", content: "hi" }], {
      tools: [{ name: "x", description: "d" }],
    } as any);

    expect(cap.body.tools).toEqual([
      { name: "x", description: "d", input_schema: { type: "object", properties: {} } },
    ]);
  });

  it("U-AN-TOOLREQ-03 — Anthropic chat omits tools when tools absent OR []", async () => {
    const provider = anthropicProvider({ apiKey: "sk" });

    const capAbsent: { body?: any } = {};
    globalThis.fetch = captureJson(
      { content: [{ type: "text", text: "ok" }], model: "claude", stop_reason: "end_turn" },
      capAbsent,
    );
    await provider.chat([{ role: "user", content: "hi" }]);
    expect("tools" in capAbsent.body).toBe(false);

    const capEmpty: { body?: any } = {};
    globalThis.fetch = captureJson(
      { content: [{ type: "text", text: "ok" }], model: "claude", stop_reason: "end_turn" },
      capEmpty,
    );
    await provider.chat([{ role: "user", content: "hi" }], { tools: [] } as any);
    expect("tools" in capEmpty.body).toBe(false);
  });

  it("U-AN-TOOLSEARCH-01 — supported models send BM25 search and deferred tools", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureJson(
      { content: [{ type: "text", text: "ok" }], model: "claude-sonnet-4-5", stop_reason: "end_turn" },
      cap,
    );
    const provider = anthropicProvider({
      apiKey: "sk",
      model: "claude-sonnet-4-5-20250929",
    });
    await provider.chat([{ role: "user", content: "hi" }], {
      tools: [{ name: "discover_tools", description: "Find tools" }],
      deferredTools: [{ name: "get_weather", description: "Weather", parameters: params }],
    });

    expect(provider.nativeToolSearch).toBe("anthropic");
    expect(cap.body.tools).toEqual([
      { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" },
      {
        name: "discover_tools",
        description: "Find tools",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "get_weather",
        description: "Weather",
        input_schema: params,
        defer_loading: true,
      },
    ]);
  });

  it("U-AN-TOOLSEARCH-02 — unsupported models keep only visible discovery", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureJson(
      { content: [{ type: "text", text: "ok" }], model: "claude-sonnet-4", stop_reason: "end_turn" },
      cap,
    );
    const provider = anthropicProvider({
      apiKey: "sk",
      model: "claude-sonnet-4-20250514",
    });
    await provider.chat([{ role: "user", content: "hi" }], {
      tools: [{ name: "discover_tools", description: "Find tools" }],
      deferredTools: [{ name: "get_weather", description: "Weather", parameters: params }],
    });

    expect(cap.body.tools).toEqual([
      {
        name: "discover_tools",
        description: "Find tools",
        input_schema: { type: "object", properties: {} },
      },
    ]);
  });

  it("U-OA-STREAM-TOOLREQ-01 — OpenAI stream() sends tools + tool_choice when present (D3)", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureSse(["data: [DONE]"], cap);
    const provider = openaiProvider({ apiKey: "sk" });
    await collectStream(
      provider.stream!([{ role: "user", content: "hi" }], {
        tools: [{ name: "get_weather", description: "d", parameters: params }],
      } as any),
    );

    expect(cap.body.tools).toEqual([
      { type: "function", function: { name: "get_weather", description: "d", parameters: params } },
    ]);
    expect(cap.body.tool_choice).toBe("auto");
  });

  it("U-AN-STREAM-TOOLREQ-01 — Anthropic stream() sends tools when present (D3)", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureSse(
      [
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ],
      cap,
    );
    const provider = anthropicProvider({ apiKey: "sk" });
    await collectStream(
      provider.stream!([{ role: "user", content: "hi" }], {
        tools: [{ name: "x", description: "d", parameters: params }],
      } as any),
    );

    expect(cap.body.tools).toEqual([{ name: "x", description: "d", input_schema: params }]);
  });
});

// ===========================================================================
// §1d — Native tool response parsing (chat())
// ===========================================================================

describe("§1d native tool response parsing (chat)", () => {
  it("U-OA-TOOLRESP-01 — OpenAI parses tool_calls (arguments JSON string -> object)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "get_weather", arguments: '{"city":"Paris"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          model: "gpt-4o",
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const provider = openaiProvider({ apiKey: "sk" });
    const result = await provider.chat([{ role: "user", content: "hi" }], {
      tools: [{ name: "get_weather", description: "d" }],
    } as any);

    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "get_weather", args: { city: "Paris" } },
    ]);
    expect(result.content).toBe("");
    expect(result.finishReason).toBe("tool_calls");
  });

  it("U-OA-TOOLRESP-02 — OpenAI no-call turn preserves D1 sentinel (Case A undefined / Case B [])", async () => {
    const provider = openaiProvider({ apiKey: "sk" });
    const body = { choices: [{ message: { content: "hi" }, finish_reason: "stop" }], model: "gpt-4o" };

    // Case A — tools absent => undefined
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const a = await provider.chat([{ role: "user", content: "hi" }]);
    expect(a.toolCalls).toBeUndefined();
    expect(a.content).toBe("hi");

    // Case B — tools present, no calls => []
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const b = await provider.chat([{ role: "user", content: "hi" }], {
      tools: [{ name: "get_weather", description: "d" }],
    } as any);
    expect(b.toolCalls).toEqual([]);
    expect(b.content).toBe("hi");
    expect(b.finishReason).toBe("stop");
  });

  it("U-AN-TOOLRESP-01 — Anthropic parses tool_use blocks", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: [
            { type: "text", text: "thinking" },
            { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Paris" } },
          ],
          model: "claude",
          stop_reason: "tool_use",
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const provider = anthropicProvider({ apiKey: "sk" });
    const result = await provider.chat([{ role: "user", content: "hi" }], {
      tools: [{ name: "get_weather", description: "d" }],
    } as any);

    expect(result.content).toBe("thinking");
    expect(result.toolCalls).toEqual([
      { id: "tu_1", name: "get_weather", args: { city: "Paris" } },
    ]);
    expect(result.finishReason).toBe("tool_use");
  });

  it("U-AN-TOOLSEARCH-03 — Anthropic parses nested tool references", async () => {
    globalThis.fetch = captureJson(
      {
        content: [
          {
            type: "tool_search_tool_result",
            content: [
              { type: "tool_reference", tool_name: "get_weather" },
              { type: "tool_reference", tool_name: "get_forecast" },
            ],
          },
        ],
        model: "claude-sonnet-4-5",
        stop_reason: "tool_use",
      },
      {},
    );
    const provider = anthropicProvider({
      apiKey: "sk",
      model: "claude-sonnet-4-5-20250929",
    });
    const result = await provider.chat([{ role: "user", content: "weather?" }], {
      tools: [{ name: "discover_tools", description: "Find tools" }],
      deferredTools: [
        { name: "get_weather", description: "Weather" },
        { name: "get_forecast", description: "Forecast" },
      ],
    });

    expect(result.disclosedTools).toEqual(["get_weather", "get_forecast"]);
  });

  it("U-AN-TOOLRESP-02 — Anthropic extract-text stays green, malformed tool_use dropped", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: [
            { type: "text", text: "First block" },
            { type: "tool_use", id: "123" },
            { type: "text", text: "Second block" },
          ],
          model: "claude",
          stop_reason: "end_turn",
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const provider = anthropicProvider({ apiKey: "sk" });
    const result = await provider.chat([{ role: "user", content: "hi" }], {
      tools: [{ name: "get_weather", description: "d" }],
    } as any);

    expect(result.content).toBe("First block");
    // malformed tool_use (no name/input) dropped => no native calls surfaced
    expect(result.toolCalls).toEqual([]);
  });

  it("U-AN-TOOLRESP-04 — Anthropic no-call turn preserves D1 sentinel (Case A undefined / Case B [])", async () => {
    const provider = anthropicProvider({ apiKey: "sk" });
    const body = {
      content: [{ type: "text", text: "hi" }],
      model: "claude",
      stop_reason: "end_turn",
    };

    // Case A — tools absent => undefined
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const a = await provider.chat([{ role: "user", content: "hi" }]);
    expect(a.toolCalls).toBeUndefined();

    // Case B — tools present, no calls => []
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const b = await provider.chat([{ role: "user", content: "hi" }], {
      tools: [{ name: "get_weather", description: "d" }],
    } as any);
    expect(b.toolCalls).toEqual([]);
    expect(b.content).toBe("hi");
    expect(b.finishReason).toBe("end_turn");
  });
});

// ===========================================================================
// §1e — Tool-result serialization (D2)
// ===========================================================================

describe("§1e tool-result serialization (D2)", () => {
  it("U-OA-TOOLRESP-03 — OpenAI serializes a tool-role message", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureJson(
      { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], model: "gpt-4o" },
      cap,
    );
    const provider = openaiProvider({ apiKey: "sk" });
    await provider.chat([{ role: "tool", content: "ok", toolCallId: "call_1" }] as any);

    expect(cap.body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "ok",
    });
  });

  it("U-AN-TOOLRESP-03 — Anthropic serializes a tool_result content part", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureJson(
      { content: [{ type: "text", text: "ok" }], model: "claude", stop_reason: "end_turn" },
      cap,
    );
    const provider = anthropicProvider({ apiKey: "sk" });
    await provider.chat([
      { role: "user", content: [{ type: "tool_result", toolUseId: "tu_1", content: "ok" }] },
    ] as any);

    expect(cap.body.messages[0].content).toEqual([
      { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
    ]);
  });
});

// ===========================================================================
// §1f — Anthropic stream() basic SSE (NEW method)
// ===========================================================================

describe("§1f Anthropic stream() basic SSE", () => {
  it("U-AN-STREAM-01 — sends real request shape AND parses real text SSE frames", async () => {
    const cap: { body?: any; url?: string; headers?: Record<string, string> } = {};
    globalThis.fetch = captureSse(
      [
        'event: message_start',
        'data: {"type":"message_start"}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
        '',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ],
      cap,
    );

    const provider = anthropicProvider({ apiKey: "sk" });
    const chunks = await collectStream(
      provider.stream!([
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ]),
    );

    // Request shape
    expect(cap.url!.endsWith("/messages")).toBe(true);
    expect(cap.headers!["x-api-key"]).toBeDefined();
    expect(cap.headers!["anthropic-version"]).toBe("2023-06-01");
    expect(cap.headers!["Content-Type"]).toBeDefined();
    expect(cap.body.stream).toBe(true);
    expect(cap.body.max_tokens).toBe(4096);
    expect(cap.body.system).toBe("sys");
    expect(cap.body.messages).toEqual([{ role: "user", content: "hi" }]);

    // Parsed text chunks
    expect(chunks).toEqual([
      { content: "Hello", done: false },
      { content: " world", done: false },
      { content: "", done: true, finishReason: "end_turn" },
    ]);
  });
});

// ===========================================================================
// §1g — Stream-aware native tool accumulation (D3)
// ===========================================================================

describe("§1g stream-aware native tool accumulation", () => {
  it("U-OA-STREAM-TOOLS-01 — OpenAI stream() accumulates delta.tool_calls into terminal toolCalls", async () => {
    globalThis.fetch = (async () =>
      new Response(
        sseStream([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"echo","arguments":""}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"msg\\":"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"hi\\"}"}}]}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
          "data: [DONE]",
        ]),
        { status: 200 },
      )) as unknown as typeof fetch;

    const provider = openaiProvider({ apiKey: "sk" });
    const chunks = await collectStream(
      provider.stream!([{ role: "user", content: "hi" }], {
        tools: [{ name: "echo", description: "d" }],
      } as any),
    );

    const terminal = chunks[chunks.length - 1]!;
    expect(terminal.done).toBe(true);
    expect(terminal.toolCalls).toEqual([{ id: "call_1", name: "echo", args: { msg: "hi" } }]);
  });

  it("U-OA-STREAM-TOOLS-02 — OpenAI stream() accumulates MULTIPLE interleaved tool_calls by index", async () => {
    globalThis.fetch = (async () =>
      new Response(
        sseStream([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_0","function":{"name":"echo","arguments":""}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_1","function":{"name":"sum","arguments":""}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"b\\":"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"2}"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
          "data: [DONE]",
        ]),
        { status: 200 },
      )) as unknown as typeof fetch;

    const provider = openaiProvider({ apiKey: "sk" });
    const chunks = await collectStream(
      provider.stream!([{ role: "user", content: "hi" }], {
        tools: [{ name: "echo", description: "d" }, { name: "sum", description: "d" }],
      } as any),
    );

    const terminal = chunks[chunks.length - 1]!;
    expect(terminal.toolCalls).toEqual([
      { id: "call_0", name: "echo", args: { a: 1 } },
      { id: "call_1", name: "sum", args: { b: 2 } },
    ]);
  });

  it("U-OA-STREAM-TOOLS-03 — OpenAI stream() with tools but no tool_call deltas yields terminal toolCalls:[]", async () => {
    globalThis.fetch = (async () =>
      new Response(
        sseStream([
          'data: {"choices":[{"delta":{"content":"hi"}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
          "data: [DONE]",
        ]),
        { status: 200 },
      )) as unknown as typeof fetch;

    const provider = openaiProvider({ apiKey: "sk" });
    const chunks = await collectStream(
      provider.stream!([{ role: "user", content: "hi" }], {
        tools: [{ name: "echo", description: "d" }],
      } as any),
    );

    expect(chunks).toContainEqual({ content: "hi", done: false });
    const terminal = chunks[chunks.length - 1]!;
    expect(terminal.done).toBe(true);
    expect(terminal.finishReason).toBe("stop");
    expect(terminal.toolCalls).toEqual([]);
  });

  it("U-AN-STREAM-TOOLS-01 — Anthropic stream() accumulates input_json_delta into terminal toolCalls", async () => {
    globalThis.fetch = (async () =>
      new Response(
        sseStream([
          'event: content_block_start',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"echo"}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"msg\\":"}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"hi\\"}"}}',
          '',
          'event: message_delta',
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
          '',
          'event: message_stop',
          'data: {"type":"message_stop"}',
          '',
        ]),
        { status: 200 },
      )) as unknown as typeof fetch;

    const provider = anthropicProvider({ apiKey: "sk" });
    const chunks = await collectStream(
      provider.stream!([{ role: "user", content: "hi" }], {
        tools: [{ name: "echo", description: "d" }],
      } as any),
    );

    const terminal = chunks[chunks.length - 1]!;
    expect(terminal.toolCalls).toEqual([{ id: "tu_1", name: "echo", args: { msg: "hi" } }]);
  });

  it("U-AN-STREAM-TOOLS-02 — Anthropic stream() accumulates MULTIPLE interleaved tool_use blocks by index", async () => {
    globalThis.fetch = (async () =>
      new Response(
        sseStream([
          'event: content_block_start',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_0","name":"echo"}}',
          '',
          'event: content_block_start',
          'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"sum"}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"b\\":"}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":"}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"2}"}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"1}"}}',
          '',
          'event: message_delta',
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
          '',
          'event: message_stop',
          'data: {"type":"message_stop"}',
          '',
        ]),
        { status: 200 },
      )) as unknown as typeof fetch;

    const provider = anthropicProvider({ apiKey: "sk" });
    const chunks = await collectStream(
      provider.stream!([{ role: "user", content: "hi" }], {
        tools: [{ name: "echo", description: "d" }, { name: "sum", description: "d" }],
      } as any),
    );

    const terminal = chunks[chunks.length - 1]!;
    expect(terminal.toolCalls).toEqual([
      { id: "tu_0", name: "echo", args: { a: 1 } },
      { id: "tu_1", name: "sum", args: { b: 2 } },
    ]);
  });

  it("U-AN-STREAM-TOOLS-03 — Anthropic stream() with tools but no tool_use yields terminal toolCalls:[]", async () => {
    globalThis.fetch = (async () =>
      new Response(
        sseStream([
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
          '',
          'event: message_delta',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
          '',
          'event: message_stop',
          'data: {"type":"message_stop"}',
          '',
        ]),
        { status: 200 },
      )) as unknown as typeof fetch;

    const provider = anthropicProvider({ apiKey: "sk" });
    const chunks = await collectStream(
      provider.stream!([{ role: "user", content: "hi" }], {
        tools: [{ name: "echo", description: "d" }],
      } as any),
    );

    const terminal = chunks[chunks.length - 1]!;
    expect(terminal.done).toBe(true);
    expect(terminal.finishReason).toBe("end_turn");
    expect(terminal.toolCalls).toEqual([]);
  });

  it("U-AN-STREAM-TOOLSEARCH-01 — Anthropic stream() surfaces tool references on the terminal chunk", async () => {
    globalThis.fetch = (async () =>
      new Response(
        sseStream([
          "event: content_block_start",
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_search_tool_result","content":[{"type":"tool_reference","tool_name":"get_weather"}]}}',
          "",
          "event: message_delta",
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
          "",
          "event: message_stop",
          'data: {"type":"message_stop"}',
          "",
        ]),
        { status: 200 },
      )) as unknown as typeof fetch;

    const provider = anthropicProvider({
      apiKey: "sk",
      model: "claude-sonnet-4-5-20250929",
    });
    const chunks = await collectStream(
      provider.stream!([{ role: "user", content: "weather?" }], {
        tools: [{ name: "discover_tools", description: "Find tools" }],
        deferredTools: [{ name: "get_weather", description: "Weather" }],
      }),
    );

    const terminal = chunks[chunks.length - 1]!;
    expect(terminal.done).toBe(true);
    expect(terminal.disclosedTools).toEqual(["get_weather"]);
    expect(terminal.toolCalls).toEqual([]);
  });
});

// ===========================================================================
// §3 — Adversarial tests
// ===========================================================================

describe("§3 adversarial", () => {
  it("A-OA-01 — invalid JSON arguments => args:{} (no throw)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{not json" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          model: "gpt-4o",
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const provider = openaiProvider({ apiKey: "sk" });
    const result = await provider.chat([{ role: "user", content: "hi" }], {
      tools: [{ name: "get_weather", description: "d" }],
    } as any);

    expect(result.toolCalls).toEqual([{ id: "call_1", name: "get_weather", args: {} }]);
  });

  it("A-OA-02 — tool_calls entry missing/empty function.name dropped", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: "call_bad", type: "function", function: { name: "", arguments: "{}" } },
                  { id: "call_ok", type: "function", function: { name: "echo", arguments: "{}" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          model: "gpt-4o",
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const provider = openaiProvider({ apiKey: "sk" });
    const result = await provider.chat([{ role: "user", content: "hi" }], {
      tools: [{ name: "echo", description: "d" }],
    } as any);

    expect(result.toolCalls).toEqual([{ id: "call_ok", name: "echo", args: {} }]);
    expect(result.toolCalls!.some((c) => !c.name)).toBe(false);
  });

  it("A-AN-04 — Anthropic tool_use block missing name dropped; content unaffected; no throw", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: [
            { type: "text", text: "hello" },
            { type: "tool_use", id: "123" },
          ],
          model: "claude",
          stop_reason: "end_turn",
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const provider = anthropicProvider({ apiKey: "sk" });
    const result = await provider.chat([{ role: "user", content: "hi" }], {
      tools: [{ name: "echo", description: "d" }],
    } as any);

    expect(result.content).toBe("hello");
    expect(result.toolCalls).toEqual([]);
  });

  it("A-STREAM-01 — OpenAI stream arguments JSON split across 3 chunks at awkward boundaries", async () => {
    globalThis.fetch = (async () =>
      new Response(
        sseStream([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"ci"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"Par"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"is\\"}"}}]}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
          "data: [DONE]",
        ]),
        { status: 200 },
      )) as unknown as typeof fetch;

    const provider = openaiProvider({ apiKey: "sk" });
    const chunks = await collectStream(
      provider.stream!([{ role: "user", content: "hi" }], {
        tools: [{ name: "get_weather", description: "d" }],
      } as any),
    );

    const terminal = chunks[chunks.length - 1]!;
    expect(terminal.toolCalls![0]!.args).toEqual({ city: "Paris" });
  });

  it("A-STREAM-02 — OpenAI stream interleaves text content + tool_call deltas", async () => {
    globalThis.fetch = (async () =>
      new Response(
        sseStream([
          'data: {"choices":[{"delta":{"content":"thinking..."}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"echo","arguments":"{\\"msg\\":\\"hi\\"}"}}]}}]}',
          'data: {"choices":[{"delta":{"content":" more"}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
          "data: [DONE]",
        ]),
        { status: 200 },
      )) as unknown as typeof fetch;

    const provider = openaiProvider({ apiKey: "sk" });
    const chunks = await collectStream(
      provider.stream!([{ role: "user", content: "hi" }], {
        tools: [{ name: "echo", description: "d" }],
      } as any),
    );

    // text yielded as chunks
    expect(chunks.some((c) => c.content === "thinking...")).toBe(true);
    expect(chunks.some((c) => c.content === " more")).toBe(true);
    // terminal native toolCalls present
    const terminal = chunks[chunks.length - 1]!;
    expect(terminal.toolCalls).toEqual([{ id: "call_1", name: "echo", args: { msg: "hi" } }]);
  });

  it("A-STREAM-03 — accumulation (not finish_reason) is the trigger; surface toolCalls without tool_calls finish", async () => {
    globalThis.fetch = (async () =>
      new Response(
        sseStream([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"echo","arguments":"{\\"msg\\":\\"hi\\"}"}}]}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
          "data: [DONE]",
        ]),
        { status: 200 },
      )) as unknown as typeof fetch;

    const provider = openaiProvider({ apiKey: "sk" });
    const chunks = await collectStream(
      provider.stream!([{ role: "user", content: "hi" }], {
        tools: [{ name: "echo", description: "d" }],
      } as any),
    );

    const terminal = chunks[chunks.length - 1]!;
    expect(terminal.toolCalls).toEqual([{ id: "call_1", name: "echo", args: { msg: "hi" } }]);
  });

  it("A-IMG-01 — image part data:'' serialized as ...;base64, (empty), no throw", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureJson(
      { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], model: "gpt-4o" },
      cap,
    );
    const provider = openaiProvider({ apiKey: "sk" });
    await provider.chat([
      { role: "user", content: [{ type: "image", mediaType: "image/png", data: "" }] },
    ] as any);

    expect(cap.body.messages[0].content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64," } },
    ]);
  });

  it("A-IMG-02 — sibling text part with unicode + braces serialized verbatim; image intact", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureJson(
      { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], model: "gpt-4o" },
      cap,
    );
    const provider = openaiProvider({ apiKey: "sk" });
    await provider.chat([
      {
        role: "user",
        content: [
          { type: "text", text: "价格 { } 确认" },
          { type: "image", mediaType: "image/png", data: "ABCD" },
        ],
      },
    ] as any);

    expect(cap.body.messages[0].content).toEqual([
      { type: "text", text: "价格 { } 确认" },
      { type: "image_url", image_url: { url: "data:image/png;base64,ABCD" } },
    ]);
  });

  it("A-IMG-03 — oversized image base64 not truncated (byte-length equality)", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureJson(
      { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], model: "gpt-4o" },
      cap,
    );
    // ~1.5 MB base64 payload
    const big = "Q".repeat(1_500_000);
    const provider = openaiProvider({ apiKey: "sk" });
    await provider.chat(
      [{ role: "user", content: [{ type: "image", mediaType: "image/png", data: big }] }] as any,
      { maxAggregateCharsPerIteration: 10 } as any,
    );

    const url: string = cap.body.messages[0].content[0].image_url.url;
    const sentData = url.replace("data:image/png;base64,", "");
    expect(sentData.length).toBe(big.length);
    expect(sentData).toBe(big);
  });

  it("A-TOOLREQ-01 — tool name with spaces forwarded verbatim", async () => {
    const cap: { body?: any } = {};
    globalThis.fetch = captureJson(
      { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], model: "gpt-4o" },
      cap,
    );
    const provider = openaiProvider({ apiKey: "sk" });
    await provider.chat([{ role: "user", content: "hi" }], {
      tools: [{ name: "get weather now", description: "d" }],
    } as any);

    expect(cap.body.tools[0].function.name).toBe("get weather now");
  });

  it("A-STREAM-04 — OpenAI SSE frame fragmented across transport reads (no duplicate terminal)", async () => {
    const frame =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"echo","arguments":"{\\"msg\\":\\"hi\\"}"}}]}}]}\n\n';
    // split the single logical frame across 3 enqueues BEFORE the newline completes
    const a = frame.slice(0, 20);
    const b = frame.slice(20, 50);
    const c = frame.slice(50);
    globalThis.fetch = (async () =>
      new Response(
        rawStream([
          a,
          b,
          c,
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200 },
      )) as unknown as typeof fetch;

    const provider = openaiProvider({ apiKey: "sk" });
    const chunks = await collectStream(
      provider.stream!([{ role: "user", content: "hi" }], {
        tools: [{ name: "echo", description: "d" }],
      } as any),
    );

    const doneChunks = chunks.filter((c) => c.done);
    expect(doneChunks).toHaveLength(1);
    expect(doneChunks[0]!.toolCalls).toEqual([{ id: "call_1", name: "echo", args: { msg: "hi" } }]);
  });

  it("A-STREAM-05 — Anthropic SSE frame fragmented across transport reads", async () => {
    const frames =
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"echo"}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"msg\\":\\"hi\\"}"}}\n\n' +
      'event: message_delta\n' +
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';
    // chop into arbitrary 17-byte fragments
    const fragments: string[] = [];
    for (let i = 0; i < frames.length; i += 17) fragments.push(frames.slice(i, i + 17));

    globalThis.fetch = (async () =>
      new Response(rawStream(fragments), { status: 200 })) as unknown as typeof fetch;

    const provider = anthropicProvider({ apiKey: "sk" });
    const chunks = await collectStream(
      provider.stream!([{ role: "user", content: "hi" }], {
        tools: [{ name: "echo", description: "d" }],
      } as any),
    );

    const terminal = chunks[chunks.length - 1]!;
    expect(terminal.toolCalls).toEqual([{ id: "tu_1", name: "echo", args: { msg: "hi" } }]);
  });
});

// ===========================================================================
// §4 — Smoke tests (S-03, S-04)
// ===========================================================================

describe("§4 smoke", () => {
  it("S-03 — both providers expose a callable stream", () => {
    const oa = openaiProvider({ apiKey: "sk" });
    const an = anthropicProvider({ apiKey: "sk" });
    expect(typeof oa.stream).toBe("function");
    expect(typeof an.stream).toBe("function");
  });

  it("S-04 — string-only chat round-trips content:pong for OpenAI", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
          model: "gpt-4o",
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const provider = openaiProvider({ apiKey: "sk" });
    const result = await provider.chat([{ role: "user", content: "ping" }]);
    expect(result.content).toBe("pong");
  });

  it("S-04 — string-only chat round-trips content:pong for Anthropic", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "pong" }],
          model: "claude",
          stop_reason: "end_turn",
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const provider = anthropicProvider({ apiKey: "sk" });
    const result = await provider.chat([{ role: "user", content: "ping" }]);
    expect(result.content).toBe("pong");
  });
});

// ===========================================================================
// Stage-4 review fix (GPT-5.4 finding #1/#5): OpenAI stream() must flush a
// final `data:` frame that arrives WITHOUT a trailing newline — the old
// line-buffered parser dropped the residual buffer at EOF, losing the last
// finish_reason / tool-call fragment / [DONE].
// ===========================================================================

describe("OpenAI stream() EOF without trailing newline", () => {
  it("EOF-01 — flushes the final tool-call frame when the stream closes mid-line", async () => {
    globalThis.fetch = (async () =>
      new Response(
        rawStream([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"echo","arguments":"{\\"msg\\":\\"hi\\"}"}}]}}]}\n',
          // final frame — NO trailing newline:
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        ]),
        { status: 200 },
      )) as unknown as typeof fetch;

    const provider = openaiProvider({ apiKey: "sk" });
    const chunks = await collectStream(
      provider.stream!([{ role: "user", content: "hi" }], {
        tools: [{ name: "echo", description: "d" }],
      } as any),
    );

    const terminal = chunks[chunks.length - 1]!;
    expect(terminal.done).toBe(true);
    expect(terminal.finishReason).toBe("tool_calls");
    expect(terminal.toolCalls).toEqual([{ id: "call_1", name: "echo", args: { msg: "hi" } }]);
    expect(chunks.filter((c) => c.done).length).toBe(1); // exactly one terminal chunk
  });

  it("EOF-02 — flushes a final [DONE] that arrives without a trailing newline", async () => {
    globalThis.fetch = (async () =>
      new Response(
        rawStream([
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n',
          "data: [DONE]", // NO trailing newline
        ]),
        { status: 200 },
      )) as unknown as typeof fetch;

    const provider = openaiProvider({ apiKey: "sk" });
    const chunks = await collectStream(
      provider.stream!([{ role: "user", content: "hi" }]),
    );
    expect(chunks).toContainEqual({ content: "hi", done: false });
    expect(chunks[chunks.length - 1]!.done).toBe(true);
    expect(chunks.filter((c) => c.done).length).toBe(1);
  });
});
