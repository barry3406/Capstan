import type { AgentCheckpoint, AgentTool, ToolCatalogConfig } from "../types.js";

const DEFAULT_INLINE_SCHEMA_TOKEN_LIMIT = 4_096;
const DEFAULT_MAX_SEARCH_RESULTS = 5;
const MAX_SEARCH_RESULTS = 10;
const DEFAULT_MAX_DISCLOSED_SCHEMA_TOKENS = 8_192;
const DISCOVER_TOOL_NAME = "discover_tools";

export interface ToolCatalogMatch {
  name: string;
  description: string;
  namespace?: string | undefined;
}

export type ToolCatalogEvent =
  | { type: "tool_search"; query: string; matches: string[]; native: boolean }
  | { type: "tools_disclosed"; tools: string[]; schemaTokens: number }
  | { type: "catalog_changed"; previousVersion: string; version: string; retained: string[] };

export interface ToolCatalogResult {
  mode: "inline" | "progressive";
  promptSection: string;
  version: string;
  discoverTool?: AgentTool | undefined;
  getVisibleTools(): AgentTool[];
  getDeferredTools(): AgentTool[];
  getDisclosedNames(): string[];
  disclose(names: readonly string[]): string[];
  recordNativeSearch(query: string, names: readonly string[]): string[];
  snapshot(): NonNullable<AgentCheckpoint["toolCatalog"]>;
  estimateVisibleSchemaTokens(): number;
  takeEvents(): ToolCatalogEvent[];
}

export function createToolCatalog(
  tools: AgentTool[],
  config?: ToolCatalogConfig,
  restored?: AgentCheckpoint["toolCatalog"],
): ToolCatalogResult {
  assertUniqueToolNames(tools);

  const version = catalogVersion(tools);
  const mode = resolveMode(tools, config);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const events: ToolCatalogEvent[] = [];
  const disclosed = new Set<string>();

  if (mode === "inline") {
    for (const tool of tools) disclosed.add(tool.name);
  } else {
    for (const tool of tools) {
      if (tool.disclosure?.mode === "always") disclosed.add(tool.name);
    }
    for (const name of restored?.disclosed ?? []) {
      if (byName.has(name)) disclosed.add(name);
    }
    if (restored && restored.version !== version) {
      events.push({
        type: "catalog_changed",
        previousVersion: restored.version,
        version,
        retained: sorted(disclosed),
      });
    }
  }

  const maxResults = clampInteger(
    config?.maxSearchResults,
    DEFAULT_MAX_SEARCH_RESULTS,
    1,
    MAX_SEARCH_RESULTS,
  );
  const maxDisclosedTokens = positiveNumber(
    config?.maxDisclosedSchemaTokens,
    DEFAULT_MAX_DISCLOSED_SCHEMA_TOKENS,
  );

  function getVisibleTools(): AgentTool[] {
    return tools.filter((tool) => disclosed.has(tool.name));
  }

  function getDeferredTools(): AgentTool[] {
    return tools.filter((tool) => !disclosed.has(tool.name));
  }

  function disclose(names: readonly string[]): string[] {
    if (mode === "inline") return [];

    let currentTokens = estimateToolSchemaTokens(getVisibleTools());
    const newlyDisclosed: string[] = [];
    for (const name of names) {
      const tool = byName.get(name);
      if (!tool || disclosed.has(name)) continue;
      const toolTokens = estimateToolSchemaTokens([tool]);
      if (currentTokens + toolTokens > maxDisclosedTokens) continue;
      disclosed.add(name);
      currentTokens += toolTokens;
      newlyDisclosed.push(name);
    }

    if (newlyDisclosed.length > 0) {
      events.push({
        type: "tools_disclosed",
        tools: newlyDisclosed,
        schemaTokens: currentTokens,
      });
    }
    return newlyDisclosed;
  }

  function recordNativeSearch(query: string, names: readonly string[]): string[] {
    const existingNames = names.filter((name) => byName.has(name));
    events.push({ type: "tool_search", query, matches: existingNames, native: true });
    return disclose(existingNames);
  }

  let discoverTool: AgentTool | undefined;
  if (mode === "progressive") {
    if (byName.has(DISCOVER_TOOL_NAME)) {
      throw new Error(`Tool name "${DISCOVER_TOOL_NAME}" is reserved in progressive mode`);
    }
    discoverTool = {
      name: DISCOVER_TOOL_NAME,
      description:
        "Search the hidden tool catalog. Matching tool schemas become available on the next turn.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            minLength: 1,
            description: "Specific capability, action, or resource to find.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: maxResults,
            description: `Maximum matches to disclose (default ${maxResults}).`,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      disclosure: { mode: "always", namespace: "capstan" },
      isConcurrencySafe: false,
      validate(args) {
        if (typeof args.query !== "string" || args.query.trim().length === 0) {
          return { valid: false, error: "query must be a non-empty string" };
        }
        if (
          args.limit !== undefined &&
          (!Number.isInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > maxResults)
        ) {
          return { valid: false, error: `limit must be an integer from 1 to ${maxResults}` };
        }
        return { valid: true };
      },
      async execute(args) {
        const query = (args.query as string).trim();
        const requestedLimit = args.limit as number | undefined;
        const limit = clampInteger(requestedLimit, maxResults, 1, maxResults);
        const ranked = rankTools(query, getDeferredTools());
        const selected = ranked.slice(0, limit);
        const matches = selected.map(compactMatch);
        events.push({
          type: "tool_search",
          query,
          matches: matches.map((match) => match.name),
          native: false,
        });
        const newlyDisclosed = disclose(matches.map((match) => match.name));
        const disclosedSet = new Set(newlyDisclosed);
        return {
          query,
          matches,
          disclosed: newlyDisclosed,
          blockedByBudget: matches
            .map((match) => match.name)
            .filter((name) => !disclosedSet.has(name)),
          hasMore: ranked.length > selected.length,
          catalogVersion: version,
        };
      },
    };
  }

  return {
    mode,
    promptSection: formatPromptSection(tools, mode),
    version,
    discoverTool,
    getVisibleTools,
    getDeferredTools,
    getDisclosedNames: () => sorted(disclosed),
    disclose,
    recordNativeSearch,
    snapshot: () => ({ version, disclosed: sorted(disclosed) }),
    estimateVisibleSchemaTokens: () => estimateToolSchemaTokens(getVisibleTools()),
    takeEvents() {
      return events.splice(0, events.length);
    },
  };
}

export function estimateToolSchemaTokens(tools: readonly AgentTool[]): number {
  if (tools.length === 0) return 0;
  const specs = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? { type: "object", properties: {} },
  }));
  return Math.ceil(JSON.stringify(specs).length / 4);
}

function resolveMode(
  tools: AgentTool[],
  config?: ToolCatalogConfig,
): "inline" | "progressive" {
  if (config?.mode === "inline") return "inline";
  if (config?.mode === "progressive") return "progressive";
  if (config?.deferThreshold !== undefined) {
    return tools.length > config.deferThreshold ? "progressive" : "inline";
  }
  const limit = positiveNumber(
    config?.inlineSchemaTokenLimit,
    DEFAULT_INLINE_SCHEMA_TOKEN_LIMIT,
  );
  return estimateToolSchemaTokens(tools) > limit ? "progressive" : "inline";
}

function rankTools(query: string, tools: AgentTool[]): AgentTool[] {
  const normalizedQuery = query.toLowerCase();
  const queryTokens = tokenize(normalizedQuery);
  return tools
    .map((tool) => ({ tool, score: scoreTool(tool, normalizedQuery, queryTokens) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .map(({ tool }) => tool);
}

function scoreTool(tool: AgentTool, query: string, queryTokens: string[]): number {
  const name = tool.name.toLowerCase();
  const nameTokens = tokenize(name);
  const descriptionTokens = new Set(tokenize(tool.description));
  const keywordTokens = new Set(tokenize((tool.disclosure?.keywords ?? []).join(" ")));
  const parameterTokens = new Set(tokenize(schemaSearchText(tool.parameters)));
  let score = name === query ? 100 : name.includes(query) ? 50 : 0;

  for (const token of queryTokens) {
    if (nameTokens.includes(token)) score += 20;
    else if (nameTokens.some((candidate) => candidate.startsWith(token))) score += 12;
    if (descriptionTokens.has(token)) score += 8;
    if (keywordTokens.has(token)) score += 8;
    if (parameterTokens.has(token)) score += 4;
  }
  return score;
}

function schemaSearchText(schema: unknown): string {
  if (!schema || typeof schema !== "object") return "";
  if (Array.isArray(schema)) return schema.map(schemaSearchText).join(" ");
  const record = schema as Record<string, unknown>;
  return Object.entries(record)
    .flatMap(([key, value]) => [key, typeof value === "string" ? value : schemaSearchText(value)])
    .join(" ");
}

function compactMatch(tool: AgentTool): ToolCatalogMatch {
  const namespace = tool.disclosure?.namespace;
  return namespace
    ? { name: tool.name, description: tool.description, namespace }
    : { name: tool.name, description: tool.description };
}

function formatPromptSection(tools: AgentTool[], mode: "inline" | "progressive"): string {
  if (tools.length === 0) return "No tools available.";
  if (mode === "inline") {
    return "Available tools:\n" + tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
  }
  const namespaces = sorted(
    new Set(tools.map((tool) => tool.disclosure?.namespace ?? "default")),
  );
  return `A catalog contains ${tools.length} tools across: ${namespaces.join(", ")}. Search with "${DISCOVER_TOOL_NAME}" using a specific capability or resource; matching schemas become callable on the next turn.`;
}

function catalogVersion(tools: AgentTool[]): string {
  const canonical = tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? null,
      mode: tool.disclosure?.mode ?? null,
      namespace: tool.disclosure?.namespace ?? null,
      keywords: [...(tool.disclosure?.keywords ?? [])].sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return `v1-${fnv1a(stableStringify(canonical))}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function assertUniqueToolNames(tools: AgentTool[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    names.add(tool.name);
  }
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}
