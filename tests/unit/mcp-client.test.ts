import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createMcpClient } from "@zauso-ai/capstan-agent";

// ---------------------------------------------------------------------------
// Fetch mock infrastructure
// ---------------------------------------------------------------------------

type FetchFn = typeof globalThis.fetch;

interface CapturedCall {
  url: string;
  init: RequestInit;
}

let originalFetch: FetchFn;
let calls: CapturedCall[];
/** Tracks whether the SDK has already attempted (and failed) its connection. */
let sdkFailed: boolean;

function jsonResponse(
  body: unknown,
  headers?: Record<string, string>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function sseResponse(
  events: unknown[],
  headers?: Record<string, string>,
): Response {
  const body = events
    .map((e) => `data: ${JSON.stringify(e)}`)
    .join("\n");
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      ...headers,
    },
  });
}

/**
 * Install a mock fetch that:
 * 1. Rejects the FIRST POST (from the SDK transport) with 405 so
 *    createMcpClient falls back to RawMcpClient.
 * 2. Routes all subsequent calls via the provided handler.
 *
 * Only calls AFTER the SDK failure are captured in `calls`.
 */
function installMockFetch(
  handler: (body: Record<string, unknown>, url: string, init: RequestInit) => Response | Promise<Response>,
): void {
  calls = [];
  sdkFailed = false;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;

    // The SDK transport sends its own POST for connect/initialize.
    // Reject it so the factory falls back to the raw client.
    if (!sdkFailed && init?.method === "POST") {
      sdkFailed = true;
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { "content-type": "text/plain" },
      });
    }

    calls.push({ url: urlStr, init: init! });

    // For DELETE requests there is no JSON body
    if (init?.method === "DELETE") {
      return handler({}, urlStr, init);
    }

    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    return handler(body, urlStr, init!);
  }) as FetchFn;
}

/**
 * Standard mock that handles the initialize + initialized handshake plus
 * any additional methods via a map.
 */
function installStandardMock(
  methods: Record<string, (body: Record<string, unknown>) => Response>,
  sessionId = "test-session-123",
): void {
  installMockFetch((body, _url, init) => {
    if (init?.method === "DELETE") {
      return jsonResponse({}, {}, 200);
    }

    const method = body.method as string;

    // notifications have no id — return 202 Accepted
    if (!("id" in body)) {
      return new Response(null, {
        status: 202,
        headers: { "mcp-session-id": sessionId },
      });
    }

    if (method === "initialize") {
      return jsonResponse(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            serverInfo: { name: "test-server", version: "1.0.0" },
          },
        },
        { "mcp-session-id": sessionId },
      );
    }

    if (methods[method]) {
      return methods[method]!(body);
    }

    return jsonResponse(
      {
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: "Method not found" },
      },
      { "mcp-session-id": sessionId },
    );
  });
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
  sdkFailed = false;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// createMcpClient() factory
// ---------------------------------------------------------------------------

describe("createMcpClient() factory", () => {
  it("falls back to RawMcpClient when SDK transport fails", async () => {
    installStandardMock({
      "tools/list": (body) =>
        jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [] },
        }),
    });

    const client = await createMcpClient({
      url: "http://localhost:9999/mcp",
    });

    // If we got here, the factory succeeded via fallback.
    expect(client).toBeDefined();
    expect(typeof client.listTools).toBe("function");
    expect(typeof client.callTool).toBe("function");
    expect(typeof client.close).toBe("function");

    // Verify the raw client's initialize handshake happened
    const initCall = calls.find((c) => {
      try {
        const b = JSON.parse(c.init.body as string);
        return b.method === "initialize";
      } catch {
        return false;
      }
    });
    expect(initCall).toBeDefined();

    await client.close();
  });

  it("passes authorization option through", async () => {
    installStandardMock({});

    const client = await createMcpClient({
      url: "http://localhost:9999/mcp",
      authorization: "Bearer secret-token-42",
    });

    // Every raw-client request should carry the Authorization header
    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer secret-token-42");
    }

    await client.close();
  });

  it("passes clientName option through", async () => {
    installStandardMock({});

    await createMcpClient({
      url: "http://localhost:9999/mcp",
      clientName: "my-custom-agent",
    });

    const initCall = calls.find((c) => {
      try {
        const b = JSON.parse(c.init.body as string);
        return b.method === "initialize";
      } catch {
        return false;
      }
    });
    expect(initCall).toBeDefined();
    const initBody = JSON.parse(initCall!.init.body as string);
    expect(initBody.params.clientInfo.name).toBe("my-custom-agent");
  });

  it("assigns a deterministic serverId and accepts an explicit override", async () => {
    installStandardMock({});
    const derived = await createMcpClient({
      url: "http://LOCALHOST:9999/mcp/?token=ignored",
    });
    expect(derived.serverId).toBe("localhost_9999_mcp");
    await derived.close();

    installStandardMock({});
    const explicit = await createMcpClient({
      url: "http://localhost:9999/mcp",
      serverId: " payments ",
    });
    expect(explicit.serverId).toBe("payments");
    await explicit.close();
  });
});

// ---------------------------------------------------------------------------
// RawMcpClient.listTools()
// ---------------------------------------------------------------------------

describe("RawMcpClient.listTools()", () => {
  it("sends initialize request first, then tools/list", async () => {
    installStandardMock({
      "tools/list": (body) =>
        jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              { name: "echo", description: "Echo input", inputSchema: { type: "object" } },
            ],
          },
        }),
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    await client.listTools();

    const methods = calls
      .filter((c) => c.init.body)
      .map((c) => {
        try {
          return (JSON.parse(c.init.body as string) as Record<string, unknown>).method;
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const initIdx = methods.indexOf("initialize");
    const listIdx = methods.indexOf("tools/list");
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(listIdx).toBeGreaterThan(initIdx);

    await client.close();
  });

  it("returns tool array with name, description, inputSchema", async () => {
    const schema = { type: "object", properties: { msg: { type: "string" } } };
    installStandardMock({
      "tools/list": (body) =>
        jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              { name: "greet", description: "Say hello", inputSchema: schema },
              { name: "bye", description: "Say goodbye", inputSchema: { type: "object" } },
            ],
          },
        }),
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    const tools = await client.listTools();

    expect(tools.length).toBe(2);
    expect(tools[0]!.name).toBe("greet");
    expect(tools[0]!.serverId).toBe("localhost_9999_mcp");
    expect(tools[0]!.description).toBe("Say hello");
    expect(tools[0]!.inputSchema).toEqual(schema);
    expect(tools[1]!.name).toBe("bye");
    expect(tools[1]!.description).toBe("Say goodbye");

    await client.close();
  });

  it("follows nextCursor until the complete tool snapshot is loaded", async () => {
    installStandardMock({
      "tools/list": (body) => {
        const params = body.params as { cursor?: string };
        return params.cursor === undefined
          ? jsonResponse({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                tools: [{ name: "first", inputSchema: { type: "object" } }],
                nextCursor: "page-2",
              },
            })
          : jsonResponse({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                tools: [{ name: "second", inputSchema: { type: "object" } }],
              },
            });
      },
    });

    const client = await createMcpClient({
      url: "http://localhost:9999/mcp",
      serverId: "catalog",
    });
    const tools = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["first", "second"]);
    expect(tools.map((tool) => tool.serverId)).toEqual(["catalog", "catalog"]);
    const listRequests = calls
      .map((call) => {
        try {
          return JSON.parse(call.init.body as string) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .filter((body) => body?.method === "tools/list");
    expect(listRequests.map((body) => body?.["params"])).toEqual([
      {},
      { cursor: "page-2" },
    ]);

    await client.close();
  });

  it("refreshes the complete snapshot after a tools/list_changed notification", async () => {
    calls = [];
    sdkFailed = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (!sdkFailed && init?.method === "POST") {
        sdkFailed = true;
        return new Response("Method Not Allowed", { status: 405 });
      }
      calls.push({ url: urlStr, init: init! });
      if (init?.method === "GET") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      if (init?.method === "DELETE") return jsonResponse({});

      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      if (!("id" in body)) return new Response(null, { status: 202 });
      if (body.method === "initialize") {
        return jsonResponse(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: "changing", version: "1.0.0" },
            },
          },
          { "mcp-session-id": "changing-session" },
        );
      }
      if (body.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [{ name: "updated", inputSchema: { type: "object" } }],
          },
        });
      }
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} });
    }) as FetchFn;

    const client = await createMcpClient({
      url: "http://localhost:9999/mcp",
      serverId: "changing",
    });
    const changed = new Promise<Awaited<ReturnType<typeof client.listTools>>>((resolve) => {
      client.onToolsChanged(resolve);
    });
    streamController!.enqueue(
      new TextEncoder().encode(
        'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}',
      ),
    );
    streamController!.close();

    await expect(changed).resolves.toEqual([
      {
        serverId: "changing",
        name: "updated",
        description: undefined,
        inputSchema: { type: "object" },
      },
    ]);
    await client.close();
  });

  it("captures session ID from response headers", async () => {
    installStandardMock(
      {
        "tools/list": (body) =>
          jsonResponse(
            { jsonrpc: "2.0", id: body.id, result: { tools: [] } },
            { "mcp-session-id": "session-abc" },
          ),
      },
      "session-abc",
    );

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    await client.listTools();

    // The tools/list call should have the session ID from initialize
    const toolsCall = calls.find((c) => {
      try {
        return (JSON.parse(c.init.body as string) as Record<string, unknown>).method === "tools/list";
      } catch {
        return false;
      }
    });
    const headers = toolsCall!.init.headers as Record<string, string>;
    expect(headers["Mcp-Session-Id"]).toBe("session-abc");

    await client.close();
  });

  it("sends initialized notification after initialize", async () => {
    installStandardMock({});

    await createMcpClient({ url: "http://localhost:9999/mcp" });

    const notifCall = calls.find((c) => {
      try {
        const b = JSON.parse(c.init.body as string);
        return b.method === "notifications/initialized" && !("id" in b);
      } catch {
        return false;
      }
    });
    expect(notifCall).toBeDefined();

    // notification must come after initialize
    const methods = calls
      .filter((c) => c.init.body)
      .map((c) => {
        try {
          return (JSON.parse(c.init.body as string) as Record<string, unknown>).method;
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const initIdx = methods.indexOf("initialize");
    const notifIdx = methods.indexOf("notifications/initialized");
    expect(notifIdx).toBeGreaterThan(initIdx);
  });

  it("empty tools list returns []", async () => {
    installStandardMock({
      "tools/list": (body) =>
        jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [] },
        }),
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    const tools = await client.listTools();
    expect(tools).toEqual([]);

    await client.close();
  });

  it("handles SSE response format (text/event-stream)", async () => {
    installStandardMock({
      "tools/list": (body) =>
        sseResponse(
          [
            {
              jsonrpc: "2.0",
              id: body.id,
              result: {
                tools: [
                  { name: "sse-tool", description: "From SSE", inputSchema: { type: "object" } },
                ],
              },
            },
          ],
          { "mcp-session-id": "test-session-123" },
        ),
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    const tools = await client.listTools();

    expect(tools.length).toBe(1);
    expect(tools[0]!.name).toBe("sse-tool");
    expect(tools[0]!.description).toBe("From SSE");

    await client.close();
  });

  it("handles JSON response format (application/json)", async () => {
    installStandardMock({
      "tools/list": (body) =>
        jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              { name: "json-tool", description: "From JSON", inputSchema: { type: "object" } },
            ],
          },
        }),
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    const tools = await client.listTools();

    expect(tools.length).toBe(1);
    expect(tools[0]!.name).toBe("json-tool");

    await client.close();
  });

  it("handles missing tools field gracefully (returns [])", async () => {
    installStandardMock({
      "tools/list": (body) =>
        jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {},
        }),
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    const tools = await client.listTools();
    expect(tools).toEqual([]);

    await client.close();
  });
});

// ---------------------------------------------------------------------------
// RawMcpClient.callTool()
// ---------------------------------------------------------------------------

describe("RawMcpClient.callTool()", () => {
  it("sends tools/call with correct method and params", async () => {
    installStandardMock({
      "tools/call": (body) =>
        jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: '{"ok":true}' }],
          },
        }),
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    await client.callTool("myTool", { key: "value" });

    const toolCall = calls.find((c) => {
      try {
        return (JSON.parse(c.init.body as string) as Record<string, unknown>).method === "tools/call";
      } catch {
        return false;
      }
    });
    expect(toolCall).toBeDefined();
    const body = JSON.parse(toolCall!.init.body as string);
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("myTool");
    expect(body.params.arguments).toEqual({ key: "value" });

    await client.close();
  });

  it("unwraps single text content result to parsed JSON", async () => {
    installStandardMock({
      "tools/call": (body) =>
        jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: '{"count":42,"items":["a","b"]}' }],
          },
        }),
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    const result = await client.callTool("counter");

    expect(result).toEqual({ count: 42, items: ["a", "b"] });

    await client.close();
  });

  it("returns raw content array when multiple items", async () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ];
    installStandardMock({
      "tools/call": (body) =>
        jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { content },
        }),
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    const result = await client.callTool("multi");

    expect(result).toEqual(content);

    await client.close();
  });

  it("handles non-text content items", async () => {
    const content = [
      { type: "image", data: "base64data", mimeType: "image/png" },
    ];
    installStandardMock({
      "tools/call": (body) =>
        jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { content },
        }),
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    const result = await client.callTool("screenshot");

    // Single non-text item: not unwrapped, returned as content array
    expect(result).toEqual(content);

    await client.close();
  });

  it("handles text content that is not valid JSON (returns raw string)", async () => {
    installStandardMock({
      "tools/call": (body) =>
        jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: "This is just plain text, not JSON." }],
          },
        }),
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    const result = await client.callTool("echo");

    expect(result).toBe("This is just plain text, not JSON.");

    await client.close();
  });

  it("includes session ID header on subsequent requests", async () => {
    installStandardMock({
      "tools/call": (body) =>
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: '"ok"' }] },
          },
          { "mcp-session-id": "sess-999" },
        ),
    }, "sess-999");

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    await client.callTool("ping");

    const toolCall = calls.find((c) => {
      try {
        return (JSON.parse(c.init.body as string) as Record<string, unknown>).method === "tools/call";
      } catch {
        return false;
      }
    });
    const headers = toolCall!.init.headers as Record<string, string>;
    expect(headers["Mcp-Session-Id"]).toBe("sess-999");

    await client.close();
  });

  it("handles JSON-RPC error response", async () => {
    installStandardMock({
      "tools/call": (body) =>
        jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32000, message: "Tool execution failed" },
        }),
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });

    await expect(client.callTool("broken")).rejects.toThrow(
      "MCP error -32000: Tool execution failed",
    );

    await client.close();
  });

  it("handles toolResult compatibility shape", async () => {
    installStandardMock({
      "tools/call": (body) =>
        jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { toolResult: { legacy: true } },
        }),
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    const result = await client.callTool("legacy-tool");

    expect(result).toEqual({ legacy: true });

    await client.close();
  });

  it("defaults arguments to empty object when not provided", async () => {
    installStandardMock({
      "tools/call": (body) =>
        jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: '"done"' }] },
        }),
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    await client.callTool("no-args");

    const toolCall = calls.find((c) => {
      try {
        return (JSON.parse(c.init.body as string) as Record<string, unknown>).method === "tools/call";
      } catch {
        return false;
      }
    });
    const body = JSON.parse(toolCall!.init.body as string);
    expect(body.params.arguments).toEqual({});

    await client.close();
  });
});

// ---------------------------------------------------------------------------
// RawMcpClient.close()
// ---------------------------------------------------------------------------

describe("RawMcpClient.close()", () => {
  it("sends HTTP DELETE to terminate session", async () => {
    installStandardMock({});

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    await client.close();

    const deleteCall = calls.find((c) => c.init.method === "DELETE");
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.url).toBe("http://localhost:9999/mcp");
  });

  it("includes session ID header on DELETE", async () => {
    installStandardMock({}, "close-session-id");

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    await client.close();

    const deleteCall = calls.find((c) => c.init.method === "DELETE");
    expect(deleteCall).toBeDefined();
    const headers = deleteCall!.init.headers as Record<string, string>;
    expect(headers["Mcp-Session-Id"]).toBe("close-session-id");
  });

  it("handles close failure gracefully (does not throw)", async () => {
    let callIndex = 0;
    calls = [];
    sdkFailed = false;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;

      // Reject SDK attempt
      if (!sdkFailed && init?.method === "POST") {
        sdkFailed = true;
        return new Response("Method Not Allowed", { status: 405 });
      }

      calls.push({ url: urlStr, init: init! });
      callIndex++;

      if (init?.method === "DELETE") {
        throw new Error("Network failure on close");
      }

      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      const method = body.method as string;

      if (!("id" in body)) {
        return new Response(null, {
          status: 202,
          headers: { "mcp-session-id": "s" },
        });
      }
      if (method === "initialize") {
        return jsonResponse(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              serverInfo: { name: "test", version: "1.0.0" },
            },
          },
          { "mcp-session-id": "s" },
        );
      }
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} });
    }) as FetchFn;

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    // Should not throw even though DELETE fails
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("handles close when no session established (no DELETE sent)", async () => {
    // Simulate: initialize response does not include mcp-session-id header
    calls = [];
    sdkFailed = false;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;

      // Reject SDK attempt
      if (!sdkFailed && init?.method === "POST") {
        sdkFailed = true;
        return new Response("Method Not Allowed", { status: 405 });
      }

      calls.push({ url: urlStr, init: init! });

      if (init?.method === "DELETE") {
        return jsonResponse({});
      }

      const body = JSON.parse(init?.body as string) as Record<string, unknown>;

      if (!("id" in body)) {
        // No mcp-session-id header on notification response
        return new Response(null, { status: 202 });
      }
      if ((body.method as string) === "initialize") {
        // No mcp-session-id header
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            serverInfo: { name: "test", version: "1.0.0" },
          },
        });
      }
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} });
    }) as FetchFn;

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    await client.close();

    const deleteCall = calls.find((c) => c.init.method === "DELETE");
    // No DELETE should be sent when there is no session ID
    expect(deleteCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

describe("Session management", () => {
  it("session ID captured from mcp-session-id response header", async () => {
    installStandardMock({
      "tools/list": (body) =>
        jsonResponse(
          { jsonrpc: "2.0", id: body.id, result: { tools: [] } },
          { "mcp-session-id": "captured-session" },
        ),
    }, "captured-session");

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    await client.listTools();

    // Verify session ID is included on close
    await client.close();
    const deleteCall = calls.find((c) => c.init.method === "DELETE");
    expect(deleteCall).toBeDefined();
    const headers = deleteCall!.init.headers as Record<string, string>;
    expect(headers["Mcp-Session-Id"]).toBe("captured-session");
  });

  it("session ID sent on subsequent requests after initial capture", async () => {
    installStandardMock({
      "tools/list": (body) =>
        jsonResponse(
          { jsonrpc: "2.0", id: body.id, result: { tools: [] } },
          { "mcp-session-id": "persisted-session" },
        ),
      "tools/call": (body) =>
        jsonResponse(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: '"ok"' }] },
          },
          { "mcp-session-id": "persisted-session" },
        ),
    }, "persisted-session");

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    await client.listTools();
    await client.callTool("test");

    // The tools/call request should include the session ID
    const callReq = calls.find((c) => {
      try {
        return (JSON.parse(c.init.body as string) as Record<string, unknown>).method === "tools/call";
      } catch {
        return false;
      }
    });
    const headers = callReq!.init.headers as Record<string, string>;
    expect(headers["Mcp-Session-Id"]).toBe("persisted-session");

    await client.close();
  });

  it("no session ID on first request", async () => {
    installStandardMock({});

    await createMcpClient({ url: "http://localhost:9999/mcp" });

    // The first raw-client call is initialize — it should NOT have Mcp-Session-Id
    const initCall = calls.find((c) => {
      try {
        return (JSON.parse(c.init.body as string) as Record<string, unknown>).method === "initialize";
      } catch {
        return false;
      }
    });
    const headers = initCall!.init.headers as Record<string, string>;
    expect(headers["Mcp-Session-Id"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("Error handling", () => {
  it("network error (fetch throws)", async () => {
    // Make ALL fetch calls fail — both SDK and raw
    calls = [];
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED: Connection refused");
    }) as FetchFn;

    await expect(
      createMcpClient({ url: "http://localhost:9999/mcp" }),
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("non-200 HTTP response on sendRequest", async () => {
    installMockFetch((body, _url, init) => {
      const method = body.method as string;

      if (!("id" in body)) {
        return new Response(null, {
          status: 202,
          headers: { "mcp-session-id": "s" },
        });
      }
      if (method === "initialize") {
        return jsonResponse(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              serverInfo: { name: "test", version: "1.0.0" },
            },
          },
          { "mcp-session-id": "s" },
        );
      }
      // tools/list returns 500
      return new Response("Internal Server Error", {
        status: 500,
        headers: { "content-type": "text/plain" },
      });
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });

    await expect(client.listTools()).rejects.toThrow(
      "MCP request tools/list failed: HTTP 500",
    );

    await client.close();
  });

  it("server returns error JSON-RPC response", async () => {
    installStandardMock({
      "tools/list": (body) =>
        jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32603, message: "Internal error" },
        }),
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });

    await expect(client.listTools()).rejects.toThrow(
      "MCP error -32603: Internal error",
    );

    await client.close();
  });

  it("SSE response with error JSON-RPC throws", async () => {
    installStandardMock({
      "tools/call": (body) =>
        sseResponse(
          [
            {
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32001, message: "Tool crashed" },
            },
          ],
          { "mcp-session-id": "test-session-123" },
        ),
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });

    await expect(client.callTool("crashy")).rejects.toThrow(
      "MCP error -32001: Tool crashed",
    );

    await client.close();
  });

  it("SSE response with no matching ID throws", async () => {
    installStandardMock({
      "tools/call": (body) =>
        sseResponse(
          [
            // Response with a different ID than the request
            {
              jsonrpc: "2.0",
              id: (body.id as number) + 999,
              result: { content: [] },
            },
          ],
          { "mcp-session-id": "test-session-123" },
        ),
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });

    await expect(client.callTool("ghost")).rejects.toThrow(
      "No matching JSON-RPC response found in SSE stream",
    );

    await client.close();
  });

  it("notification failure throws for non-2xx status", async () => {
    let initDone = false;
    calls = [];
    sdkFailed = false;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;

      // Reject SDK attempt
      if (!sdkFailed && init?.method === "POST") {
        sdkFailed = true;
        return new Response("Method Not Allowed", { status: 405 });
      }

      calls.push({ url: urlStr, init: init! });

      const body = JSON.parse(init?.body as string) as Record<string, unknown>;

      if (!("id" in body)) {
        if (initDone) {
          return new Response("Forbidden", { status: 403 });
        }
      }
      if ((body.method as string) === "initialize") {
        initDone = true;
        return jsonResponse(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              serverInfo: { name: "test", version: "1.0.0" },
            },
          },
          { "mcp-session-id": "s" },
        );
      }
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} });
    }) as FetchFn;

    await expect(
      createMcpClient({ url: "http://localhost:9999/mcp" }),
    ).rejects.toThrow("MCP notification notifications/initialized failed: HTTP 403");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  it("authorization header included when provided", async () => {
    installStandardMock({});

    await createMcpClient({
      url: "http://localhost:9999/mcp",
      authorization: "Bearer tok-123",
    });

    for (const call of calls) {
      if (call.init.method === "DELETE") continue;
      const headers = call.init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer tok-123");
    }
  });

  it("authorization header omitted when not provided", async () => {
    installStandardMock({});

    await createMcpClient({ url: "http://localhost:9999/mcp" });

    const initCall = calls.find((c) => {
      try {
        return (JSON.parse(c.init.body as string) as Record<string, unknown>).method === "initialize";
      } catch {
        return false;
      }
    });
    const headers = initCall!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("URL with trailing slash is preserved", async () => {
    installStandardMock({});

    await createMcpClient({ url: "http://localhost:9999/mcp/" });

    // Raw client uses the URL as-is for fetch calls
    const postCalls = calls.filter((c) => c.init.method === "POST");
    for (const call of postCalls) {
      expect(call.url).toBe("http://localhost:9999/mcp/");
    }
  });

  it("calling listTools multiple times works", async () => {
    let callCount = 0;
    installStandardMock({
      "tools/list": (body) => {
        callCount++;
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [{ name: `tool-${callCount}`, description: `Call ${callCount}`, inputSchema: { type: "object" } }],
          },
        });
      },
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });

    const first = await client.listTools();
    const second = await client.listTools();

    expect(first.length).toBe(1);
    expect(second.length).toBe(1);
    expect(first[0]!.name).toBe("tool-1");
    expect(second[0]!.name).toBe("tool-2");

    await client.close();
  });

  it("uses default clientName when not specified", async () => {
    installStandardMock({});

    await createMcpClient({ url: "http://localhost:9999/mcp" });

    const initCall = calls.find((c) => {
      try {
        return (JSON.parse(c.init.body as string) as Record<string, unknown>).method === "initialize";
      } catch {
        return false;
      }
    });
    const body = JSON.parse(initCall!.init.body as string);
    expect(body.params.clientInfo.name).toBe("capstan-mcp-client");
  });

  it("request IDs increment across calls", async () => {
    installStandardMock({
      "tools/list": (body) =>
        jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [] },
        }),
      "tools/call": (body) =>
        jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: '"ok"' }] },
        }),
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    await client.listTools();
    await client.callTool("a");

    // Collect IDs from all JSON-RPC requests (not notifications)
    const ids = calls
      .filter((c) => c.init.body)
      .map((c) => {
        try {
          const b = JSON.parse(c.init.body as string);
          return b.id as number | undefined;
        } catch {
          return undefined;
        }
      })
      .filter((id): id is number => id != null);

    // IDs should be strictly increasing
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]!).toBeGreaterThan(ids[i - 1]!);
    }

    await client.close();
  });

  it("initialize sends correct protocol version and capabilities", async () => {
    installStandardMock({});

    await createMcpClient({ url: "http://localhost:9999/mcp" });

    const initCall = calls.find((c) => {
      try {
        return (JSON.parse(c.init.body as string) as Record<string, unknown>).method === "initialize";
      } catch {
        return false;
      }
    });
    const body = JSON.parse(initCall!.init.body as string);
    expect(body.params.protocolVersion).toBe("2025-03-26");
    expect(body.params.capabilities).toEqual({});
    expect(body.params.clientInfo.version).toBe("1.0.0");
    expect(body.jsonrpc).toBe("2.0");
  });

  it("request headers include correct Content-Type and Accept", async () => {
    installStandardMock({
      "tools/list": (body) =>
        jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [] },
        }),
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    await client.listTools();

    const toolsCall = calls.find((c) => {
      try {
        return (JSON.parse(c.init.body as string) as Record<string, unknown>).method === "tools/list";
      } catch {
        return false;
      }
    });
    const headers = toolsCall!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Accept"]).toBe("application/json, text/event-stream");

    await client.close();
  });

  it("callTool via SSE response with valid JSON content", async () => {
    installStandardMock({
      "tools/call": (body) =>
        sseResponse(
          [
            {
              jsonrpc: "2.0",
              id: body.id,
              result: {
                content: [{ type: "text", text: '{"status":"success"}' }],
              },
            },
          ],
          { "mcp-session-id": "test-session-123" },
        ),
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    const result = await client.callTool("sse-tool");

    expect(result).toEqual({ status: "success" });

    await client.close();
  });

  it("SSE with multiple data lines picks the one matching request ID", async () => {
    installStandardMock({
      "tools/call": (body) =>
        sseResponse(
          [
            // First event: different ID (noise)
            { jsonrpc: "2.0", id: 9999, result: { content: [{ type: "text", text: '"wrong"' }] } },
            // Second event: matching ID
            {
              jsonrpc: "2.0",
              id: body.id,
              result: { content: [{ type: "text", text: '"correct"' }] },
            },
          ],
          { "mcp-session-id": "test-session-123" },
        ),
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    const result = await client.callTool("matcher");

    expect(result).toBe("correct");

    await client.close();
  });

  it("result with no content and no toolResult returns raw result object", async () => {
    installStandardMock({
      "tools/call": (body) =>
        jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { custom: "data", value: 7 },
        }),
    });

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    const result = await client.callTool("raw-result");

    expect(result).toEqual({ custom: "data", value: 7 });

    await client.close();
  });

  it("notification body has no id field", async () => {
    installStandardMock({});

    await createMcpClient({ url: "http://localhost:9999/mcp" });

    const notifCall = calls.find((c) => {
      try {
        const b = JSON.parse(c.init.body as string);
        return b.method === "notifications/initialized";
      } catch {
        return false;
      }
    });
    expect(notifCall).toBeDefined();
    const body = JSON.parse(notifCall!.init.body as string);
    expect(body.id).toBeUndefined();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.params).toEqual({});
  });

  it("SSE response skips unparseable data lines", async () => {
    // Build a response with a mix of good and bad data lines
    calls = [];
    sdkFailed = false;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;

      if (!sdkFailed && init?.method === "POST") {
        sdkFailed = true;
        return new Response("Method Not Allowed", { status: 405 });
      }

      calls.push({ url: urlStr, init: init! });

      if (init?.method === "DELETE") {
        return jsonResponse({});
      }

      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      const method = body.method as string;

      if (!("id" in body)) {
        return new Response(null, {
          status: 202,
          headers: { "mcp-session-id": "s" },
        });
      }

      if (method === "initialize") {
        return jsonResponse(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              serverInfo: { name: "test", version: "1.0.0" },
            },
          },
          { "mcp-session-id": "s" },
        );
      }

      if (method === "tools/call") {
        // Include garbage lines mixed with the real response
        const sseBody = [
          "data: not-valid-json",
          "data: {also bad}",
          `: this is a comment`,
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: '"found-it"' }] } })}`,
        ].join("\n");
        return new Response(sseBody, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "mcp-session-id": "s",
          },
        });
      }

      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} });
    }) as FetchFn;

    const client = await createMcpClient({ url: "http://localhost:9999/mcp" });
    const result = await client.callTool("noisy-sse");

    expect(result).toBe("found-it");

    await client.close();
  });
});
