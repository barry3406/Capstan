/**
 * Deep unit tests for the Capstan dev server (server.ts).
 *
 * Tests pure helper functions, HTML injection, route registration via
 * buildPortableRuntimeApp (which shares the same logic), framework
 * endpoint responses, middleware chain behavior, and error handling.
 */

import { describe, it, expect, beforeEach, mock, afterEach } from "bun:test";

import {
  buildPortableRuntimeApp,
  type RuntimeRouteRegistryEntry,
} from "@zauso-ai/capstan-dev";

import {
  resolveProjectOpsConfig,
} from "../../packages/dev/src/ops-sink.js";

import {
  createRuntimeDiagnostic,
} from "../../packages/dev/src/runtime-diagnostics.js";

// ---------------------------------------------------------------------------
// Helpers — reusable builders for common test data
// ---------------------------------------------------------------------------

function makeApiRoute(overrides: Record<string, unknown> = {}) {
  return {
    type: "api" as const,
    filePath: overrides.filePath ?? "app/routes/test.api.ts",
    urlPattern: overrides.urlPattern ?? "/test",
    params: (overrides.params ?? []) as string[],
    layouts: (overrides.layouts ?? []) as string[],
    middlewares: (overrides.middlewares ?? []) as string[],
    ...overrides,
  };
}

function makePageRoute(overrides: Record<string, unknown> = {}) {
  return {
    type: "page" as const,
    filePath: overrides.filePath ?? "app/routes/index.page.tsx",
    urlPattern: overrides.urlPattern ?? "/",
    params: (overrides.params ?? []) as string[],
    layouts: (overrides.layouts ?? []) as string[],
    middlewares: (overrides.middlewares ?? []) as string[],
    ...overrides,
  };
}

function buildApp(
  routes: Array<ReturnType<typeof makeApiRoute>>,
  routeModules: Record<string, Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) {
  return buildPortableRuntimeApp({
    rootDir: "/tmp",
    manifest: { routes },
    routeModules,
    ...extra,
  });
}

// ===================================================================
// Health endpoint
// ===================================================================

describe("server.ts — Health endpoint", () => {
  it("returns status ok", async () => {
    const { app } = await buildApp([], {});
    const res = await app.fetch(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("includes uptime field", async () => {
    const { app } = await buildApp([], {});
    const res = await app.fetch(new Request("http://localhost/health"));
    const body = (await res.json()) as { uptime: number };
    expect(typeof body.uptime).toBe("number");
  });

  it("includes timestamp field in ISO format", async () => {
    const { app } = await buildApp([], {});
    const res = await app.fetch(new Request("http://localhost/health"));
    const body = (await res.json()) as { timestamp: string };
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ===================================================================
// Agent manifest endpoint
// ===================================================================

describe("server.ts — Agent manifest (capstan.json)", () => {
  it("returns manifest with capstan version", async () => {
    const { app } = await buildApp([], {});
    const res = await app.fetch(new Request("http://localhost/.well-known/capstan.json"));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.capstan).toBe("1.0");
  });

  it("uses appName from config", async () => {
    const { app } = await buildApp([], {}, { appName: "my-service" });
    const res = await app.fetch(new Request("http://localhost/.well-known/capstan.json"));
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("my-service");
  });

  it("defaults appName to capstan-app", async () => {
    const { app } = await buildApp([], {});
    const res = await app.fetch(new Request("http://localhost/.well-known/capstan.json"));
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("capstan-app");
  });

  it("uses appDescription from config", async () => {
    const { app } = await buildApp([], {}, {
      appName: "svc",
      appDescription: "My service description",
    });
    const res = await app.fetch(new Request("http://localhost/.well-known/capstan.json"));
    const body = (await res.json()) as { description: string };
    expect(body.description).toBe("My service description");
  });

  it("includes authentication section", async () => {
    const { app } = await buildApp([], {});
    const res = await app.fetch(new Request("http://localhost/.well-known/capstan.json"));
    const body = (await res.json()) as { authentication: { schemes: Array<{ type: string }> } };
    expect(body.authentication.schemes).toBeInstanceOf(Array);
    expect(body.authentication.schemes[0]!.type).toBe("bearer");
  });

  it("lists capabilities from registered API routes", async () => {
    const mods = {
      "/tmp/app/routes/items.api.ts": {
        GET: {
          description: "List items",
          capability: "read",
          handler: async () => [],
        },
        POST: {
          description: "Create item",
          capability: "write",
          handler: async () => ({}),
        },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({ filePath: "app/routes/items.api.ts", urlPattern: "/items" })],
      mods,
    );
    const res = await app.fetch(new Request("http://localhost/.well-known/capstan.json"));
    const body = (await res.json()) as { capabilities: Array<{ key: string; mode: string }> };
    expect(body.capabilities.length).toBe(2);
    const modes = body.capabilities.map((c) => c.mode);
    expect(modes).toContain("read");
    expect(modes).toContain("write");
  });

  it("uses custom agentManifest when provided", async () => {
    const custom = { capstan: "2.0", name: "custom", capabilities: [] };
    const { app } = await buildApp([], {}, { agentManifest: custom });
    const res = await app.fetch(new Request("http://localhost/.well-known/capstan.json"));
    const body = await res.json();
    expect(body).toEqual(custom);
  });

  it("capability key combines method and path", async () => {
    const mods = {
      "/tmp/app/routes/hello.api.ts": {
        GET: { description: "Hello", handler: async () => ({}) },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({ filePath: "app/routes/hello.api.ts", urlPattern: "/hello" })],
      mods,
    );
    const res = await app.fetch(new Request("http://localhost/.well-known/capstan.json"));
    const body = (await res.json()) as { capabilities: Array<{ key: string }> };
    expect(body.capabilities[0]!.key).toBe("GET /hello");
  });

  it("falls back mode to read when capability is undefined", async () => {
    const mods = {
      "/tmp/app/routes/thing.api.ts": {
        GET: { description: "Thing", handler: async () => ({}) },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({ filePath: "app/routes/thing.api.ts", urlPattern: "/thing" })],
      mods,
    );
    const res = await app.fetch(new Request("http://localhost/.well-known/capstan.json"));
    const body = (await res.json()) as { capabilities: Array<{ mode: string }> };
    expect(body.capabilities[0]!.mode).toBe("read");
  });
});

// ===================================================================
// OpenAPI endpoint
// ===================================================================

describe("server.ts — OpenAPI spec", () => {
  it("returns valid 3.1.0 spec", async () => {
    const { app } = await buildApp([], {});
    const res = await app.fetch(new Request("http://localhost/openapi.json"));
    const body = (await res.json()) as { openapi: string };
    expect(body.openapi).toBe("3.1.0");
  });

  it("uses appName as info.title", async () => {
    const { app } = await buildApp([], {}, { appName: "test-api" });
    const res = await app.fetch(new Request("http://localhost/openapi.json"));
    const body = (await res.json()) as { info: { title: string } };
    expect(body.info.title).toBe("test-api");
  });

  it("uses appDescription as info.description", async () => {
    const { app } = await buildApp([], {}, {
      appName: "x",
      appDescription: "My API",
    });
    const res = await app.fetch(new Request("http://localhost/openapi.json"));
    const body = (await res.json()) as { info: { description: string } };
    expect(body.info.description).toBe("My API");
  });

  it("includes version 0.3.0", async () => {
    const { app } = await buildApp([], {});
    const res = await app.fetch(new Request("http://localhost/openapi.json"));
    const body = (await res.json()) as { info: { version: string } };
    expect(body.info.version).toBe("0.3.0");
  });

  it("maps route params to OpenAPI path params", async () => {
    const mods = {
      "/tmp/app/routes/users.api.ts": {
        GET: { description: "Get user", handler: async () => ({}) },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({ filePath: "app/routes/users.api.ts", urlPattern: "/users/:id" })],
      mods,
    );
    const res = await app.fetch(new Request("http://localhost/openapi.json"));
    const body = (await res.json()) as { paths: Record<string, unknown> };
    expect(body.paths["/users/{id}"]).toBeDefined();
  });

  it("generates operationId from method and path", async () => {
    const mods = {
      "/tmp/app/routes/items.api.ts": {
        POST: { description: "Create", handler: async () => ({}) },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({ filePath: "app/routes/items.api.ts", urlPattern: "/items" })],
      mods,
    );
    const res = await app.fetch(new Request("http://localhost/openapi.json"));
    const body = (await res.json()) as { paths: Record<string, Record<string, { operationId: string }>> };
    expect(body.paths["/items"]!.post!.operationId).toContain("post");
    expect(body.paths["/items"]!.post!.operationId).toContain("items");
  });

  it("uses custom openApiSpec when provided", async () => {
    const custom = { openapi: "3.1.0", info: { title: "custom" }, paths: {} };
    const { app } = await buildApp([], {}, { openApiSpec: custom });
    const res = await app.fetch(new Request("http://localhost/openapi.json"));
    expect(await res.json()).toEqual(custom);
  });

  it("groups multiple methods under same path", async () => {
    const mods = {
      "/tmp/app/routes/data.api.ts": {
        GET: { description: "Read", handler: async () => ({}) },
        PUT: { description: "Write", handler: async () => ({}) },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({ filePath: "app/routes/data.api.ts", urlPattern: "/data" })],
      mods,
    );
    const res = await app.fetch(new Request("http://localhost/openapi.json"));
    const body = (await res.json()) as { paths: Record<string, Record<string, unknown>> };
    expect(body.paths["/data"]!.get).toBeDefined();
    expect(body.paths["/data"]!.put).toBeDefined();
  });

  it("includes inputSchema in requestBody when available", async () => {
    const mods = {
      "/tmp/app/routes/echo.api.ts": {
        POST: {
          description: "Echo",
          handler: async ({ input }: { input: unknown }) => input,
        },
      },
    };
    // No Zod schema, so no inputSchema — just verifying path exists
    const { app } = await buildApp(
      [makeApiRoute({ filePath: "app/routes/echo.api.ts", urlPattern: "/echo" })],
      mods,
    );
    const res = await app.fetch(new Request("http://localhost/openapi.json"));
    const body = (await res.json()) as { paths: Record<string, Record<string, object>> };
    expect(body.paths["/echo"]!.post).toBeDefined();
  });
});

// ===================================================================
// MCP discovery endpoint
// ===================================================================

describe("server.ts — MCP discovery", () => {
  it("returns protocol mcp", async () => {
    const { app } = await buildApp([], {});
    const res = await app.fetch(
      new Request("http://localhost/.well-known/mcp", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { protocol: string };
    expect(body.protocol).toBe("mcp");
  });

  it("uses appName in response", async () => {
    const { app } = await buildApp([], {}, { appName: "mcp-svc" });
    const res = await app.fetch(
      new Request("http://localhost/.well-known/mcp", { method: "POST" }),
    );
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("mcp-svc");
  });

  it("returns tools array for registered routes", async () => {
    const mods = {
      "/tmp/app/routes/greet.api.ts": {
        GET: { description: "Greet", handler: async () => ({ hi: true }) },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({ filePath: "app/routes/greet.api.ts", urlPattern: "/greet" })],
      mods,
      { appName: "tools-test" },
    );
    const res = await app.fetch(
      new Request("http://localhost/.well-known/mcp", { method: "POST" }),
    );
    const body = (await res.json()) as { tools: Array<{ description: string }> };
    expect(body.tools.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty tools with error when no routes", async () => {
    const { app } = await buildApp([], {});
    const res = await app.fetch(
      new Request("http://localhost/.well-known/mcp", { method: "POST" }),
    );
    const body = (await res.json()) as { tools: unknown[] };
    expect(body.tools).toBeInstanceOf(Array);
  });
});

// ===================================================================
// API route registration
// ===================================================================

describe("server.ts — API route registration", () => {
  it("registers GET handler", async () => {
    const mods = {
      "/tmp/app/routes/get.api.ts": {
        GET: { handler: async () => ({ method: "GET" }) },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({ filePath: "app/routes/get.api.ts", urlPattern: "/get" })],
      mods,
    );
    const res = await app.fetch(new Request("http://localhost/get"));
    expect(res.status).toBe(200);
    expect((await res.json() as { method: string }).method).toBe("GET");
  });

  it("registers POST handler", async () => {
    const mods = {
      "/tmp/app/routes/post.api.ts": {
        POST: { handler: async ({ input }: { input: unknown }) => ({ received: input }) },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({ filePath: "app/routes/post.api.ts", urlPattern: "/post" })],
      mods,
    );
    const res = await app.fetch(
      new Request("http://localhost/post", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "val" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: { key: string } };
    expect(body.received.key).toBe("val");
  });

  it("registers PUT handler", async () => {
    const mods = {
      "/tmp/app/routes/put.api.ts": {
        PUT: { handler: async () => ({ updated: true }) },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({ filePath: "app/routes/put.api.ts", urlPattern: "/put" })],
      mods,
    );
    const res = await app.fetch(
      new Request("http://localhost/put", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("registers DELETE handler", async () => {
    const mods = {
      "/tmp/app/routes/del.api.ts": {
        DELETE: { handler: async () => ({ deleted: true }) },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({ filePath: "app/routes/del.api.ts", urlPattern: "/del" })],
      mods,
    );
    const res = await app.fetch(
      new Request("http://localhost/del", { method: "DELETE" }),
    );
    expect(res.status).toBe(200);
  });

  it("registers PATCH handler", async () => {
    const mods = {
      "/tmp/app/routes/patch.api.ts": {
        PATCH: { handler: async () => ({ patched: true }) },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({ filePath: "app/routes/patch.api.ts", urlPattern: "/patch" })],
      mods,
    );
    const res = await app.fetch(
      new Request("http://localhost/patch", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("counts registered API routes correctly", async () => {
    const mods = {
      "/tmp/app/routes/multi.api.ts": {
        GET: { handler: async () => ({}) },
        POST: { handler: async () => ({}) },
        DELETE: { handler: async () => ({}) },
      },
    };
    const result = await buildApp(
      [makeApiRoute({ filePath: "app/routes/multi.api.ts", urlPattern: "/multi" })],
      mods,
    );
    expect(result.apiRouteCount).toBe(3);
  });

  it("skips undefined methods", async () => {
    const mods = {
      "/tmp/app/routes/partial.api.ts": {
        GET: { handler: async () => ({}) },
        // POST, PUT, DELETE, PATCH all undefined
      },
    };
    const result = await buildApp(
      [makeApiRoute({ filePath: "app/routes/partial.api.ts", urlPattern: "/partial" })],
      mods,
    );
    expect(result.apiRouteCount).toBe(1);
  });

  it("skips routes when module not found", async () => {
    const result = await buildApp(
      [makeApiRoute({ filePath: "app/routes/ghost.api.ts", urlPattern: "/ghost" })],
      {},
    );
    expect(result.apiRouteCount).toBe(0);
  });

  it("populates route registry with description", async () => {
    const mods = {
      "/tmp/app/routes/desc.api.ts": {
        GET: {
          description: "Described endpoint",
          handler: async () => ({}),
        },
      },
    };
    const result = await buildApp(
      [makeApiRoute({ filePath: "app/routes/desc.api.ts", urlPattern: "/desc" })],
      mods,
    );
    expect(result.routeRegistry[0]!.description).toBe("Described endpoint");
  });

  it("populates route registry with capability", async () => {
    const mods = {
      "/tmp/app/routes/cap.api.ts": {
        POST: {
          capability: "write",
          handler: async () => ({}),
        },
      },
    };
    const result = await buildApp(
      [makeApiRoute({ filePath: "app/routes/cap.api.ts", urlPattern: "/cap" })],
      mods,
    );
    expect(result.routeRegistry[0]!.capability).toBe("write");
  });

  it("uses meta export for description when handler lacks it", async () => {
    const mods = {
      "/tmp/app/routes/meta.api.ts": {
        GET: { handler: async () => ({}) },
        meta: { description: "From meta" },
      },
    };
    const result = await buildApp(
      [makeApiRoute({ filePath: "app/routes/meta.api.ts", urlPattern: "/meta" })],
      mods,
    );
    expect(result.routeRegistry[0]!.description).toBe("From meta");
  });

  it("uses meta export for capability when handler lacks it", async () => {
    const mods = {
      "/tmp/app/routes/metacap.api.ts": {
        GET: { handler: async () => ({}) },
        meta: { capability: "external" },
      },
    };
    const result = await buildApp(
      [makeApiRoute({ filePath: "app/routes/metacap.api.ts", urlPattern: "/metacap" })],
      mods,
    );
    expect(result.routeRegistry[0]!.capability).toBe("external");
  });

  it("handler description takes precedence over meta description", async () => {
    const mods = {
      "/tmp/app/routes/prio.api.ts": {
        GET: {
          description: "Handler desc",
          handler: async () => ({}),
        },
        meta: { description: "Meta desc" },
      },
    };
    const result = await buildApp(
      [makeApiRoute({ filePath: "app/routes/prio.api.ts", urlPattern: "/prio" })],
      mods,
    );
    expect(result.routeRegistry[0]!.description).toBe("Handler desc");
  });
});

// ===================================================================
// GET query parameter parsing
// ===================================================================

describe("server.ts — GET query parameter input", () => {
  it("parses query string as input for GET", async () => {
    const mods = {
      "/tmp/app/routes/search.api.ts": {
        GET: {
          handler: async ({ input }: { input: Record<string, string> }) => ({ query: input }),
        },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({ filePath: "app/routes/search.api.ts", urlPattern: "/search" })],
      mods,
    );
    const res = await app.fetch(new Request("http://localhost/search?q=hello&page=2"));
    const body = (await res.json()) as { query: { q: string; page: string } };
    expect(body.query.q).toBe("hello");
    expect(body.query.page).toBe("2");
  });

  it("returns empty object for GET without query", async () => {
    const mods = {
      "/tmp/app/routes/empty.api.ts": {
        GET: {
          handler: async ({ input }: { input: unknown }) => ({ input }),
        },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({ filePath: "app/routes/empty.api.ts", urlPattern: "/empty" })],
      mods,
    );
    const res = await app.fetch(new Request("http://localhost/empty"));
    const body = (await res.json()) as { input: Record<string, unknown> };
    expect(Object.keys(body.input).length).toBe(0);
  });
});

// ===================================================================
// POST body parsing
// ===================================================================

describe("server.ts — POST body parsing", () => {
  it("parses JSON body for POST", async () => {
    const mods = {
      "/tmp/app/routes/json.api.ts": {
        POST: {
          handler: async ({ input }: { input: unknown }) => input,
        },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({ filePath: "app/routes/json.api.ts", urlPattern: "/json" })],
      mods,
    );
    const res = await app.fetch(
      new Request("http://localhost/json", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ foo: "bar" }),
      }),
    );
    const body = (await res.json()) as { foo: string };
    expect(body.foo).toBe("bar");
  });

  it("returns empty object when content-type is not json", async () => {
    const mods = {
      "/tmp/app/routes/noct.api.ts": {
        POST: {
          handler: async ({ input }: { input: unknown }) => ({ input }),
        },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({ filePath: "app/routes/noct.api.ts", urlPattern: "/noct" })],
      mods,
    );
    const res = await app.fetch(
      new Request("http://localhost/noct", {
        method: "POST",
        body: "plain text",
      }),
    );
    const body = (await res.json()) as { input: Record<string, unknown> };
    expect(body.input).toEqual({});
  });

  it("falls back to empty input on malformed JSON", async () => {
    const mods = {
      "/tmp/app/routes/bad.api.ts": {
        POST: {
          handler: async ({ input }: { input: unknown }) => ({ input }),
        },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({ filePath: "app/routes/bad.api.ts", urlPattern: "/bad" })],
      mods,
    );
    const res = await app.fetch(
      new Request("http://localhost/bad", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json{",
      }),
    );
    // Should not crash, falls back to {}
    const body = (await res.json()) as { input: unknown };
    expect(body.input).toEqual({});
  });
});

// ===================================================================
// Error handling
// ===================================================================

describe("server.ts — Error handling", () => {
  it("returns 400 for Zod-style validation errors", async () => {
    const mods = {
      "/tmp/app/routes/val.api.ts": {
        POST: {
          handler: async () => {
            const err = new Error("Zod");
            (err as any).issues = [{ path: ["name"], message: "required" }];
            throw err;
          },
        },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({ filePath: "app/routes/val.api.ts", urlPattern: "/val" })],
      mods,
    );
    const res = await app.fetch(
      new Request("http://localhost/val", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe("Validation Error");
    expect(body.issues).toHaveLength(1);
  });

  it("returns 500 for generic errors", async () => {
    const mods = {
      "/tmp/app/routes/boom.api.ts": {
        GET: {
          handler: async () => { throw new Error("boom"); },
        },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({ filePath: "app/routes/boom.api.ts", urlPattern: "/boom" })],
      mods,
    );
    const res = await app.fetch(new Request("http://localhost/boom"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("boom");
  });

  it("returns 500 for non-Error thrown objects", async () => {
    const mods = {
      "/tmp/app/routes/nonErr.api.ts": {
        GET: {
          handler: async () => { throw "string error"; },
        },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({ filePath: "app/routes/nonErr.api.ts", urlPattern: "/nonErr" })],
      mods,
    );
    const res = await app.fetch(new Request("http://localhost/nonErr"));
    expect(res.status).toBe(500);
  });

  it("returns 500 for invalid handler exports", async () => {
    const mods = {
      "/tmp/app/routes/invalid.api.ts": {
        GET: 42, // not a function or APIDefinition
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({ filePath: "app/routes/invalid.api.ts", urlPattern: "/invalid" })],
      mods,
    );
    const res = await app.fetch(new Request("http://localhost/invalid"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid handler export");
  });
});

// ===================================================================
// Function-style handlers (non-APIDefinition)
// ===================================================================

describe("server.ts — Function-style handlers", () => {
  it("invokes plain function export", async () => {
    const mods = {
      "/tmp/app/routes/fn.api.ts": {
        GET: async () => ({ source: "function" }),
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({ filePath: "app/routes/fn.api.ts", urlPattern: "/fn" })],
      mods,
    );
    const res = await app.fetch(new Request("http://localhost/fn"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string };
    expect(body.source).toBe("function");
  });

  it("passes input and params to function handler", async () => {
    const mods = {
      "/tmp/app/routes/fnparams.api.ts": {
        GET: async ({ input, params }: { input: unknown; params: Record<string, string> }) => ({
          input,
          params,
        }),
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({
        filePath: "app/routes/fnparams.api.ts",
        urlPattern: "/fnparams/:id",
        params: ["id"],
      })],
      mods,
    );
    const res = await app.fetch(new Request("http://localhost/fnparams/42?q=test"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { input: { q: string }; params: { id: string } };
    expect(body.input.q).toBe("test");
    expect(body.params.id).toBe("42");
  });
});

// ===================================================================
// Client bootstrap script
// ===================================================================

describe("server.ts — Client bootstrap", () => {
  it("serves /_capstan/client.js with correct content-type", async () => {
    const { app } = await buildApp([], {});
    const res = await app.fetch(new Request("http://localhost/_capstan/client.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("contains bootstrapClient import", async () => {
    const { app } = await buildApp([], {});
    const res = await app.fetch(new Request("http://localhost/_capstan/client.js"));
    const text = await res.text();
    expect(text).toContain("bootstrapClient");
  });

  it("sets revalidate cache header(dev 档;prod 由 STATIC_CACHE_CONTROL 切 SWR)", async () => {
    const { app } = await buildApp([], {});
    const res = await app.fetch(new Request("http://localhost/_capstan/client.js"));
    // 测试跑在非 production → dev 档(must-revalidate,保 HMR 即时)。prod 同一常量
    // 切 "public, max-age=300, stale-while-revalidate=86400",修「每资产每次加载吃一个
    // revalidation RTT」(高延迟链路首屏 15s+ 的元凶之一)。
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });
});

// ===================================================================
// Multiple API routes
// ===================================================================

describe("server.ts — Multiple routes", () => {
  it("registers multiple API routes from different files", async () => {
    const mods = {
      "/tmp/app/routes/a.api.ts": {
        GET: { handler: async () => ({ route: "a" }) },
      },
      "/tmp/app/routes/b.api.ts": {
        POST: { handler: async () => ({ route: "b" }) },
      },
    };
    const result = await buildApp(
      [
        makeApiRoute({ filePath: "app/routes/a.api.ts", urlPattern: "/a" }),
        makeApiRoute({ filePath: "app/routes/b.api.ts", urlPattern: "/b" }),
      ],
      mods,
    );
    expect(result.apiRouteCount).toBe(2);

    const resA = await result.app.fetch(new Request("http://localhost/a"));
    expect(resA.status).toBe(200);
    expect((await resA.json() as { route: string }).route).toBe("a");

    const resB = await result.app.fetch(
      new Request("http://localhost/b", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(resB.status).toBe(200);
  });

  it("handles mix of API and missing routes gracefully", async () => {
    const mods = {
      "/tmp/app/routes/ok.api.ts": {
        GET: { handler: async () => ({ ok: true }) },
      },
    };
    const result = await buildApp(
      [
        makeApiRoute({ filePath: "app/routes/ok.api.ts", urlPattern: "/ok" }),
        makeApiRoute({ filePath: "app/routes/missing.api.ts", urlPattern: "/missing" }),
      ],
      mods,
    );
    // Only the valid route should be counted
    expect(result.apiRouteCount).toBe(1);
  });
});

// ===================================================================
// Route registry structure
// ===================================================================

describe("server.ts — Route registry", () => {
  it("registry entries have method and path", async () => {
    const mods = {
      "/tmp/app/routes/reg.api.ts": {
        GET: { handler: async () => ({}) },
      },
    };
    const result = await buildApp(
      [makeApiRoute({ filePath: "app/routes/reg.api.ts", urlPattern: "/reg" })],
      mods,
    );
    const entry = result.routeRegistry[0]!;
    expect(entry.method).toBe("GET");
    expect(entry.path).toBe("/reg");
  });

  it("registry includes all methods from a multi-method route", async () => {
    const mods = {
      "/tmp/app/routes/all.api.ts": {
        GET: { handler: async () => ({}) },
        POST: { handler: async () => ({}) },
        PUT: { handler: async () => ({}) },
        DELETE: { handler: async () => ({}) },
        PATCH: { handler: async () => ({}) },
      },
    };
    const result = await buildApp(
      [makeApiRoute({ filePath: "app/routes/all.api.ts", urlPattern: "/all" })],
      mods,
    );
    expect(result.routeRegistry.length).toBe(5);
    const methods = result.routeRegistry.map((r) => r.method);
    expect(methods).toContain("GET");
    expect(methods).toContain("POST");
    expect(methods).toContain("PUT");
    expect(methods).toContain("DELETE");
    expect(methods).toContain("PATCH");
  });
});

// ===================================================================
// Portable runtime middleware
// ===================================================================

describe("server.ts — Route middleware in portable runtime", () => {
  it("executes middleware before handler", async () => {
    const callOrder: string[] = [];
    const middlewareMod = {
      default: {
        handler: async ({ request, ctx, next }: any) => {
          callOrder.push("middleware");
          return next();
        },
      },
    };
    const mods = {
      "/tmp/app/routes/mw.api.ts": {
        GET: {
          handler: async () => {
            callOrder.push("handler");
            return { ok: true };
          },
        },
      },
      "/tmp/app/routes/_middleware.ts": middlewareMod,
    };
    const { app } = await buildApp(
      [makeApiRoute({
        filePath: "app/routes/mw.api.ts",
        urlPattern: "/mw",
        middlewares: ["app/routes/_middleware.ts"],
      })],
      mods,
    );
    const res = await app.fetch(new Request("http://localhost/mw"));
    expect(res.status).toBe(200);
    expect(callOrder).toEqual(["middleware", "handler"]);
  });

  it("middleware can short-circuit response", async () => {
    const mods = {
      "/tmp/app/routes/blocked.api.ts": {
        GET: { handler: async () => ({ should: "not reach" }) },
      },
      "/tmp/app/routes/_middleware.ts": {
        default: {
          handler: async () => {
            return new Response(JSON.stringify({ blocked: true }), {
              status: 403,
              headers: { "content-type": "application/json" },
            });
          },
        },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({
        filePath: "app/routes/blocked.api.ts",
        urlPattern: "/blocked",
        middlewares: ["app/routes/_middleware.ts"],
      })],
      mods,
    );
    const res = await app.fetch(new Request("http://localhost/blocked"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { blocked: boolean };
    expect(body.blocked).toBe(true);
  });

  it("chained middleware executes in order", async () => {
    const order: number[] = [];
    const mods = {
      "/tmp/app/routes/chain.api.ts": {
        GET: {
          handler: async () => {
            order.push(3);
            return { order };
          },
        },
      },
      "/tmp/app/routes/_middleware1.ts": {
        default: {
          handler: async ({ next }: any) => {
            order.push(1);
            return next();
          },
        },
      },
      "/tmp/app/routes/_middleware2.ts": {
        default: {
          handler: async ({ next }: any) => {
            order.push(2);
            return next();
          },
        },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({
        filePath: "app/routes/chain.api.ts",
        urlPattern: "/chain",
        middlewares: ["app/routes/_middleware1.ts", "app/routes/_middleware2.ts"],
      })],
      mods,
    );
    await app.fetch(new Request("http://localhost/chain"));
    expect(order).toEqual([1, 2, 3]);
  });

  it("function-style middleware is normalized", async () => {
    const mods = {
      "/tmp/app/routes/fmw.api.ts": {
        GET: { handler: async () => ({ ok: true }) },
      },
      "/tmp/app/routes/_middleware.ts": {
        default: async ({ next }: any) => next(),
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({
        filePath: "app/routes/fmw.api.ts",
        urlPattern: "/fmw",
        middlewares: ["app/routes/_middleware.ts"],
      })],
      mods,
    );
    const res = await app.fetch(new Request("http://localhost/fmw"));
    expect(res.status).toBe(200);
  });
});

// ===================================================================
// Not-found fallback
// ===================================================================

describe("server.ts — Not found behavior", () => {
  it("returns 404 for unmatched routes", async () => {
    const { app } = await buildApp([], {});
    const res = await app.fetch(new Request("http://localhost/nonexistent"));
    expect(res.status).toBe(404);
  });

  it("returns 404 for unmatched routes with accept html", async () => {
    const { app } = await buildApp([], {});
    const res = await app.fetch(
      new Request("http://localhost/nonexistent", {
        headers: { accept: "text/html" },
      }),
    );
    expect(res.status).toBe(404);
  });
});

// ===================================================================
// CORS headers
// ===================================================================

describe("server.ts — CORS", () => {
  it("includes CORS headers by default", async () => {
    const { app } = await buildApp([], {});
    const res = await app.fetch(
      new Request("http://localhost/health", {
        headers: { origin: "http://example.com" },
      }),
    );
    // CORS middleware from Hono adds access-control-allow-origin
    expect(res.headers.get("access-control-allow-origin")).toBeDefined();
  });

  it("CORS can be disabled", async () => {
    const { app } = await buildApp([], {}, { corsOptions: false });
    const res = await app.fetch(
      new Request("http://localhost/health", {
        headers: { origin: "http://example.com" },
      }),
    );
    // When CORS is disabled, no ACAO header
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

// ===================================================================
// App build structure
// ===================================================================

describe("server.ts — App build result", () => {
  it("returns app, apiRouteCount, pageRouteCount, routeRegistry", async () => {
    const result = await buildApp([], {});
    expect(result.app).toBeDefined();
    expect(typeof result.apiRouteCount).toBe("number");
    expect(typeof result.pageRouteCount).toBe("number");
    expect(Array.isArray(result.routeRegistry)).toBe(true);
  });

  it("diagnostics array is present on portable runtime builds", async () => {
    const result = await buildPortableRuntimeApp({
      rootDir: "/tmp",
      manifest: { routes: [] },
      routeModules: {},
    });
    expect((result as any).diagnostics).toBeDefined();
    expect(Array.isArray((result as any).diagnostics)).toBe(true);
  });
});

// ===================================================================
// Route URL pattern matching
// ===================================================================

describe("server.ts — URL pattern parameters", () => {
  it("extracts single URL param", async () => {
    const mods = {
      "/tmp/app/routes/users.api.ts": {
        GET: {
          handler: async ({ params }: { params: Record<string, string> }) => ({
            id: params.id,
          }),
        },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({
        filePath: "app/routes/users.api.ts",
        urlPattern: "/users/:id",
        params: ["id"],
      })],
      mods,
    );
    const res = await app.fetch(new Request("http://localhost/users/123"));
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("123");
  });

  it("extracts multiple URL params", async () => {
    const mods = {
      "/tmp/app/routes/nested.api.ts": {
        GET: {
          handler: async ({ params }: { params: Record<string, string> }) => params,
        },
      },
    };
    const { app } = await buildApp(
      [makeApiRoute({
        filePath: "app/routes/nested.api.ts",
        urlPattern: "/org/:orgId/team/:teamId",
        params: ["orgId", "teamId"],
      })],
      mods,
    );
    const res = await app.fetch(new Request("http://localhost/org/acme/team/dev"));
    const body = (await res.json()) as { orgId: string; teamId: string };
    expect(body.orgId).toBe("acme");
    expect(body.teamId).toBe("dev");
  });
});

// ===================================================================
// A2A endpoints
// ===================================================================

describe("server.ts — A2A endpoints", () => {
  it("GET /.well-known/agent.json responds", async () => {
    const { app } = await buildApp([], {});
    const res = await app.fetch(new Request("http://localhost/.well-known/agent.json"));
    // Might be 200 or 501 depending on if capstan-agent is available
    expect([200, 501]).toContain(res.status);
  });

  it("POST /.well-known/a2a responds", async () => {
    const { app } = await buildApp([], {});
    const res = await app.fetch(
      new Request("http://localhost/.well-known/a2a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "agent/discover", id: 1 }),
      }),
    );
    // Might be 200 or 501 depending on if capstan-agent is available
    expect([200, 501]).toContain(res.status);
  });
});

// ===================================================================
// Zero-route baseline
// ===================================================================

describe("server.ts — Zero routes baseline", () => {
  it("app with zero routes has 0 API and 0 page counts", async () => {
    const result = await buildApp([], {});
    expect(result.apiRouteCount).toBe(0);
    expect(result.pageRouteCount).toBe(0);
  });

  it("route registry is empty for zero routes", async () => {
    const result = await buildApp([], {});
    expect(result.routeRegistry).toEqual([]);
  });

  it("framework endpoints still work with zero routes", async () => {
    const { app } = await buildApp([], {});
    const health = await app.fetch(new Request("http://localhost/health"));
    expect(health.status).toBe(200);

    const manifest = await app.fetch(new Request("http://localhost/.well-known/capstan.json"));
    expect(manifest.status).toBe(200);

    const openapi = await app.fetch(new Request("http://localhost/openapi.json"));
    expect(openapi.status).toBe(200);
  });
});

// ===================================================================
// Config defaults
// ===================================================================

describe("server.ts — Config defaults", () => {
  it("defaults appName to capstan-app in health-related responses", async () => {
    const { app } = await buildApp([], {});
    const res = await app.fetch(new Request("http://localhost/.well-known/capstan.json"));
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("capstan-app");
  });

  it("defaults appDescription to empty string", async () => {
    const { app } = await buildApp([], {});
    const res = await app.fetch(new Request("http://localhost/.well-known/capstan.json"));
    const body = (await res.json()) as { description: string };
    expect(body.description).toBe("");
  });
});

// ===================================================================
// Asset provider integration
// ===================================================================

describe("server.ts — Asset provider", () => {
  it("serves provided client assets", async () => {
    const assetProvider = {
      readClientAsset: async (assetPath: string) => {
        if (assetPath === "entry.js") {
          return {
            body: 'console.log("hello")',
            contentType: "application/javascript",
          };
        }
        return null;
      },
    };
    const { app } = await buildPortableRuntimeApp({
      rootDir: "/tmp",
      manifest: { routes: [] },
      routeModules: {},
      assetProvider,
    });
    const res = await app.fetch(new Request("http://localhost/_capstan/client/entry.js"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("hello");
  });

  it("returns 404 for missing client assets", async () => {
    const assetProvider = {
      readClientAsset: async () => null,
    };
    const { app } = await buildPortableRuntimeApp({
      rootDir: "/tmp",
      manifest: { routes: [] },
      routeModules: {},
      assetProvider,
    });
    const res = await app.fetch(new Request("http://localhost/_capstan/client/missing.js"));
    expect(res.status).toBe(404);
  });

  it("serves provided public assets", async () => {
    const assetProvider = {
      readPublicAsset: async (urlPath: string) => {
        if (urlPath === "/logo.png") {
          return {
            body: btoa("fake-png"),
            encoding: "base64" as const,
            contentType: "image/png",
          };
        }
        return null;
      },
    };
    const { app } = await buildPortableRuntimeApp({
      rootDir: "/tmp",
      manifest: { routes: [] },
      routeModules: {},
      assetProvider,
    });
    const res = await app.fetch(new Request("http://localhost/logo.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });
});
