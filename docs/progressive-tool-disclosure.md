# Progressive Tool Disclosure

Large tool catalogs consume context before the agent has done any work. Capstan
keeps execution deterministic by separating three concerns:

1. The **catalog** knows every configured tool.
2. The **visible set** contains only schemas the model may currently inspect.
3. The **execution gate** permits only visible tools, even if the model guesses a
   hidden tool name.

Disclosure is append-only for a run. Once a tool becomes visible, it remains
visible until the run ends or the agent resumes from a different checkpoint.

## Configuration

```typescript
const agent = createSmartAgent({
  llm,
  tools,
  toolCatalog: {
    mode: "auto",
    inlineSchemaTokenLimit: 4096,
    maxSearchResults: 5,
    maxDisclosedSchemaTokens: 8192,
  },
});
```

| Option | Default | Contract |
| --- | --- | --- |
| `mode` | `"auto"` | `"inline"` advertises every tool, `"progressive"` always enables discovery, and `"auto"` switches by estimated serialized schema tokens. |
| `inlineSchemaTokenLimit` | `4096` | Initial schema-token limit used by `"auto"`. The estimate is `ceil(JSON.stringify(toolSpecs).length / 4)`. |
| `maxSearchResults` | `5` | Maximum matches returned and considered by one generic discovery call. Clamped to `1..10`. |
| `maxDisclosedSchemaTokens` | `8192` | Maximum visible schema tokens accumulated during a progressive run. |
| `deferThreshold` | none | Deprecated count-based compatibility option. Use `mode` and `inlineSchemaTokenLimit` for new code. |

Individual tools can override their initial placement and supply discovery
metadata:

```typescript
const deployTool: AgentTool = {
  name: "deploy_service",
  description: "Deploy a service to an environment",
  parameters: deploySchema,
  disclosure: {
    mode: "deferred",
    namespace: "deployments",
    keywords: ["release", "rollout", "production"],
  },
  execute: deploy,
};
```

- `mode: "always"` makes the tool initially visible in progressive mode.
- `mode: "deferred"` documents that the tool should be discovered first.
- `namespace` and `keywords` improve deterministic catalog search without
  changing the execution name.

In `inline` mode every tool remains visible, including tools marked deferred.

## Generic Discovery

Progressive mode reserves the name `discover_tools`. The synthetic tool accepts:

```typescript
{ query: string; limit?: number }
```

`query` must be non-empty. `limit` defaults to `maxSearchResults` and cannot
exceed it. Search considers the tool name, description, namespace, keywords, and
parameter schema, then uses the tool name as the stable tie-breaker.

The result is intentionally compact:

```typescript
{
  query: string;
  matches: Array<{
    name: string;
    description: string;
    namespace?: string;
  }>;
  disclosed: string[];
  blockedByBudget: string[];
  hasMore: boolean;
  catalogVersion: string;
}
```

Tools listed in `disclosed` are advertised on the next model turn. A match can be
listed in `blockedByBudget` when adding its schema would exceed
`maxDisclosedSchemaTokens`.

## Native Provider Search

Capstan uses provider-native search when the selected model supports it:

- OpenAI Responses models `gpt-5.4` and newer receive a `tool_search` tool and
  deferred function definitions.
- Supported Anthropic Claude models receive the BM25 tool-search definition and
  deferred client-tool definitions.

Provider search references are still passed through Capstan's disclosure budget
and execution gate. This permits a native search result and its function call in
the same model response, but it does not allow a provider to bypass catalog
policy.

Unsupported models automatically keep `discover_tools` visible and omit native
search metadata. The application does not need separate provider-specific tool
catalog configuration.

See the provider contracts for the wire formats:

- [OpenAI tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)
- [Anthropic tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)

## Execution Isolation

The runtime keeps a full internal tool map for dispatch, but constructs each LLM
request from the current visible set. Before execution, every requested tool is
checked against that set.

A guessed hidden tool never runs. The model receives a structured tool result:

```json
{
  "error": "Tool is not disclosed",
  "code": "TOOL_NOT_DISCLOSED"
}
```

The model can recover by calling `discover_tools` or the provider-native search
tool, then retrying the operation.

## Events And Supervision

Streaming runs expose catalog decisions as `AgentEvent` values:

| Event | Meaning |
| --- | --- |
| `tool_search` | A generic or native catalog search completed. Includes the query, matched names, and `native`. |
| `tools_disclosed` | New schemas passed the budget and became executable. Includes the append-only names and current schema-token total. |
| `catalog_changed` | A resumed checkpoint used a different catalog version. Includes both versions and retained tool names. |

Humans can force predictable behavior with `mode: "inline"`, require progressive
behavior with `mode: "progressive"`, inspect events, and cap schema growth with
`maxDisclosedSchemaTokens`.

## Checkpoints

Each checkpoint records:

```typescript
toolCatalog?: {
  version: string;
  disclosed: string[];
}
```

The version is derived from canonical tool definitions and disclosure metadata.
On resume, Capstan restores disclosed names that still exist. If the version has
changed, it emits `catalog_changed`; removed tools are ignored and new tools
remain deferred. This makes catalog drift observable without making an otherwise
recoverable resume fail.

## MCP Catalog Synchronization

The MCP client exposes a stable source identifier, follows `tools/list` cursors,
and publishes complete catalog snapshots after a server change notification:

```typescript
const client = createMcpClient({
  url: "https://tools.example.com/mcp",
  serverId: "production-tools",
});

const unsubscribe = client.onToolsChanged((tools) => {
  replaceToolsFromSource(client.serverId, tools);
});

const tools = await client.listTools();
```

`listTools()` follows every `nextCursor`. Both SDK and raw HTTP transports listen
for `notifications/tools/list_changed`, refetch all pages, and send listeners a
complete replacement snapshot. `serverId` defaults to a normalized endpoint
identity and can be set explicitly when URLs are not stable.

Consumers should replace all tools for that `serverId` atomically rather than
merging notification payloads. Call the function returned by `onToolsChanged()`
when the catalog is no longer needed, and call `close()` to release transport
resources.
