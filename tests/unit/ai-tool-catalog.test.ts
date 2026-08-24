import { describe, expect, it } from "bun:test";

import type { AgentTool, ToolCatalogConfig } from "../../packages/ai/src/types.ts";
import {
  createToolCatalog,
  estimateToolSchemaTokens,
} from "../../packages/ai/src/loop/tool-catalog.ts";

interface SearchResult {
  query: string;
  matches: Array<{ name: string; description: string; namespace?: string }>;
  disclosed: string[];
  blockedByBudget: string[];
  hasMore: boolean;
  catalogVersion: string;
}

function makeTool(
  name: string,
  description = `Tool ${name}`,
  overrides: Partial<AgentTool> = {},
): AgentTool {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: { input: { type: "string", description: `Input for ${name}` } },
    },
    async execute() {
      return { ok: true };
    },
    ...overrides,
  };
}

function makeTools(count: number, description = "shared capability"): AgentTool[] {
  return Array.from({ length: count }, (_, i) => makeTool(`tool_${i + 1}`, description));
}

async function search(
  catalog: ReturnType<typeof createToolCatalog>,
  query: string,
  limit?: number,
): Promise<SearchResult> {
  return await catalog.discoverTool!.execute({
    query,
    ...(limit !== undefined ? { limit } : {}),
  }) as SearchResult;
}

describe("createToolCatalog", () => {
  it("keeps a small schema set inline by default", () => {
    const tools = makeTools(3);
    const result = createToolCatalog(tools);

    expect(result.mode).toBe("inline");
    expect(result.discoverTool).toBeUndefined();
    expect(result.getVisibleTools().map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name));
  });

  it("switches automatically from inline to progressive by estimated schema tokens", () => {
    const tools = makeTools(2);
    const result = createToolCatalog(tools, { inlineSchemaTokenLimit: 1 });

    expect(estimateToolSchemaTokens(tools)).toBeGreaterThan(1);
    expect(result.mode).toBe("progressive");
    expect(result.discoverTool?.name).toBe("discover_tools");
    expect(result.getVisibleTools()).toEqual([]);
    expect(result.getDeferredTools()).toHaveLength(2);
  });

  it("supports explicit inline and progressive modes", () => {
    expect(createToolCatalog(makeTools(20), { mode: "inline" }).mode).toBe("inline");
    expect(createToolCatalog(makeTools(1), { mode: "progressive" }).mode).toBe("progressive");
  });

  it("keeps explicitly always-visible tools visible in progressive mode", () => {
    const tools = [
      makeTool("health", "Check service health", { disclosure: { mode: "always" } }),
      makeTool("deploy", "Deploy a service"),
    ];
    const result = createToolCatalog(tools, { mode: "progressive" });

    expect(result.getVisibleTools().map((tool) => tool.name)).toEqual(["health"]);
    expect(result.getDeferredTools().map((tool) => tool.name)).toEqual(["deploy"]);
  });

  it("describes only count and namespaces in a progressive prompt", () => {
    const result = createToolCatalog([
      makeTool("query_db", "Query customer records", { disclosure: { namespace: "database" } }),
      makeTool("send_mail", "Send email", { disclosure: { namespace: "messaging" } }),
    ], { mode: "progressive" });

    expect(result.promptSection).toContain("2 tools");
    expect(result.promptSection).toContain("database");
    expect(result.promptSection).toContain("messaging");
    expect(result.promptSection).toContain("discover_tools");
    expect(result.promptSection).not.toContain("query_db");
  });

  it("searches name, description, keywords, and parameter metadata", async () => {
    const result = createToolCatalog([
      makeTool("read_file", "Read a file"),
      makeTool("tool_a", "Manage database connections"),
      makeTool("tool_b", "Send HTTP requests", {
        disclosure: { keywords: ["networking"] },
      }),
      makeTool("tool_c", "Parse data", {
        parameters: {
          type: "object",
          properties: { customerId: { type: "string", description: "Customer identifier" } },
        },
      }),
    ], { mode: "progressive" });

    expect((await search(result, "READ")).matches.map((match) => match.name)).toEqual(["read_file"]);
    expect((await search(result, "database")).matches.map((match) => match.name)).toEqual(["tool_a"]);
    expect((await search(result, "networking")).matches.map((match) => match.name)).toEqual(["tool_b"]);
    expect((await search(result, "customerId")).matches.map((match) => match.name)).toEqual(["tool_c"]);
  });

  it("returns compact metadata and exposes matched schemas on the next turn", async () => {
    const result = createToolCatalog([
      makeTool("read_file", "Read a file", { disclosure: { namespace: "filesystem" } }),
      makeTool("write_file", "Write a file"),
    ], { mode: "progressive" });

    const response = await search(result, "read");
    expect(response.matches).toEqual([
      { name: "read_file", description: "Read a file", namespace: "filesystem" },
    ]);
    expect(response.matches[0]).not.toHaveProperty("parameters");
    expect(response.disclosed).toEqual(["read_file"]);
    expect(response.blockedByBudget).toEqual([]);
    expect(result.getVisibleTools().map((tool) => tool.name)).toEqual(["read_file"]);
    expect(result.getDeferredTools().map((tool) => tool.name)).toEqual(["write_file"]);
  });

  it("validates non-empty queries and bounds result counts to ten", async () => {
    const result = createToolCatalog(makeTools(20), {
      mode: "progressive",
      maxSearchResults: 100,
    });

    expect(result.discoverTool!.validate!({ query: "" })).toEqual({
      valid: false,
      error: "query must be a non-empty string",
    });
    expect(result.discoverTool!.validate!({ query: "shared", limit: 11 })).toEqual({
      valid: false,
      error: "limit must be an integer from 1 to 10",
    });

    const response = await search(result, "shared", 10);
    expect(response.matches).toHaveLength(10);
    expect(response.hasMore).toBe(true);
  });

  it("reports matches that cannot fit the disclosed-schema budget", async () => {
    const result = createToolCatalog([
      makeTool("large_tool", "Large reporting capability"),
    ], {
      mode: "progressive",
      maxDisclosedSchemaTokens: 1,
    });

    const response = await search(result, "reporting");
    expect(response.matches.map((match) => match.name)).toEqual(["large_tool"]);
    expect(response.disclosed).toEqual([]);
    expect(response.blockedByBudget).toEqual(["large_tool"]);
    expect(result.getVisibleTools()).toEqual([]);
  });

  it("records native search before disclosure and rejects unknown names", () => {
    const result = createToolCatalog(makeTools(2), { mode: "progressive" });

    expect(result.recordNativeSearch("shared", ["tool_2", "missing"])).toEqual(["tool_2"]);
    expect(result.takeEvents()).toEqual([
      { type: "tool_search", query: "shared", matches: ["tool_2"], native: true },
      expect.objectContaining({ type: "tools_disclosed", tools: ["tool_2"] }),
    ]);
  });

  it("restores disclosed tools from a checkpoint", () => {
    const tools = makeTools(3);
    const first = createToolCatalog(tools, { mode: "progressive" });
    first.disclose(["tool_2"]);

    const restored = createToolCatalog(tools, { mode: "progressive" }, first.snapshot());
    expect(restored.getDisclosedNames()).toEqual(["tool_2"]);
    expect(restored.takeEvents()).toEqual([]);
  });

  it("retains matching disclosures and emits a catalog change on version drift", () => {
    const first = createToolCatalog(makeTools(2), { mode: "progressive" });
    first.disclose(["tool_2"]);
    const restored = createToolCatalog([
      makeTool("tool_2", "changed description"),
      makeTool("tool_3"),
    ], { mode: "progressive" }, first.snapshot());

    expect(restored.getDisclosedNames()).toEqual(["tool_2"]);
    expect(restored.takeEvents()).toEqual([
      {
        type: "catalog_changed",
        previousVersion: first.version,
        version: restored.version,
        retained: ["tool_2"],
      },
    ]);
  });

  it("uses a deterministic version independent of tool and schema key order", () => {
    const a = makeTool("lookup", "Lookup", {
      parameters: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } },
    });
    const b = makeTool("send", "Send");
    const reorderedA = makeTool("lookup", "Lookup", {
      parameters: { properties: { b: { type: "number" }, a: { type: "string" } }, type: "object" },
    });

    expect(createToolCatalog([a, b]).version).toBe(createToolCatalog([b, reorderedA]).version);
  });

  it("keeps deferThreshold as a compatibility override", () => {
    const config: ToolCatalogConfig = { deferThreshold: 2 };
    expect(createToolCatalog(makeTools(2), config).mode).toBe("inline");
    expect(createToolCatalog(makeTools(3), config).mode).toBe("progressive");
  });

  it("reserves discover_tools and rejects duplicate names", () => {
    expect(() => createToolCatalog([
      makeTool("discover_tools"),
    ], { mode: "progressive" })).toThrow('Tool name "discover_tools" is reserved');
    expect(() => createToolCatalog([
      makeTool("duplicate"),
      makeTool("duplicate"),
    ])).toThrow("Duplicate tool name: duplicate");
  });

  it("does not mutate the caller's tool array", () => {
    const tools = makeTools(3);
    const names = tools.map((tool) => tool.name);
    createToolCatalog(tools, { mode: "progressive" });
    expect(tools.map((tool) => tool.name)).toEqual(names);
    expect(tools).toHaveLength(3);
  });
});
