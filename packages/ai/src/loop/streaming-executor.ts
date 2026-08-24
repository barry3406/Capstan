import type {
  AgentTool,
  AgentToolCallRecord,
  LLMProvider,
  LLMMessage,
  LLMOptions,
  ToolRequest,
  ModelFinishReason,
  SmartAgentHooks,
  StreamingExecutorConfig,
} from "../types.js";
import { validateArgs } from "./validate-args.js";

// ---------------------------------------------------------------------------
// Tool call parsing (migrated from sampler.ts)
// ---------------------------------------------------------------------------

/**
 * Map native provider tool calls (`{id,name,args}[]`, surfaced by
 * `LLMResponse.toolCalls` / the terminal `LLMStreamChunk.toolCalls`) to the
 * loop's `ToolRequest` shape, using array index as the deterministic `order`.
 *
 * Per D1 the caller decides the *source* of tool requests: a defined (even
 * empty) native list means the provider spoke natively and its result is used
 * verbatim — `[]` ⇒ no tools this turn and NO text-JSON parse. Only an
 * `undefined` native field falls back to {@link parseToolRequests}.
 */
export function toolRequestsFromNative(
  calls: { id: string; name: string; args: Record<string, unknown> }[],
): ToolRequest[] {
  return calls.map((call, index) => ({
    id: call.id,
    name: call.name,
    args: call.args,
    order: index,
  }));
}

export function parseToolRequests(content: string): ToolRequest[] {
  const candidates = [
    content,
    ...extractFencedJson(content),
    ...extractLeadingJson(content),
  ];
  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (parsed === undefined) {
      continue;
    }
    const requests = normalizeToolRequests(parsed);
    if (requests.length > 0) {
      return requests;
    }
  }
  return [];
}

function normalizeToolRequests(value: unknown): ToolRequest[] {
  if (Array.isArray(value)) {
    return value
      .map((entry, index) => normalizeSingleToolRequest(entry, index))
      .filter((entry): entry is ToolRequest => entry != null);
  }

  if (isPlainObject(value) && Array.isArray(value.tools)) {
    return value.tools
      .map((entry, index) => normalizeSingleToolRequest(entry, index))
      .filter((entry): entry is ToolRequest => entry != null);
  }

  const single = normalizeSingleToolRequest(value, 0);
  return single ? [single] : [];
}

function normalizeSingleToolRequest(
  value: unknown,
  index: number,
): ToolRequest | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const name = typeof value.tool === "string" ? value.tool.trim() : "";
  const argsCandidate = isPlainObject(value.arguments)
    ? value.arguments
    : isPlainObject(value.args)
      ? value.args
      : undefined;
  if (!name || !argsCandidate) {
    return undefined;
  }

  return {
    id: `toolreq_${index}_${crypto.randomUUID()}`,
    name,
    args: cloneArgs(argsCandidate),
    order: index,
  };
}

function tryParseJson(content: string): unknown | undefined {
  const trimmed = content.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function extractFencedJson(content: string): string[] {
  const blocks = content.match(/```json\s*([\s\S]*?)```/gi) ?? [];
  return blocks
    .map((block) => block.replace(/^```json\s*/i, "").replace(/```$/i, "").trim())
    .filter(Boolean);
}

/**
 * Extract well-formed JSON objects/arrays that are EDGE-ANCHORED in the content:
 * the balanced JSON either STARTS at the first non-whitespace character (model
 * emits the tool-call JSON then trailing commentary, e.g.
 * `{...tool call...}已发起人工审批：...`) or ENDS at the last non-whitespace
 * character (model emits leading prose then the tool call).
 *
 * JSON buried in the MIDDLE of prose — e.g. an inline `{"tool":...}` example
 * inside a final answer — is deliberately NOT extracted, so it cannot be
 * mis-executed as a real tool call. Returns substrings that look like balanced
 * JSON; callers still run them through {@link tryParseJson} to confirm validity.
 */
function extractLeadingJson(content: string): string[] {
  const firstNonWs = content.search(/\S/);
  if (firstNonWs < 0) return [];
  // Exclusive index just past the last non-whitespace character.
  const endTrimmed = content.replace(/\s+$/, "").length;
  const results: string[] = [];
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === "{" || ch === "[") {
      const open = ch;
      const close = ch === "{" ? "}" : "]";
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let j = i; j < content.length; j++) {
        const c = content[j];
        if (escape) {
          escape = false;
          continue;
        }
        if (c === "\\") {
          escape = true;
          continue;
        }
        if (c === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (c === open) depth++;
        else if (c === close) {
          depth--;
          if (depth === 0) {
            // Keep ONLY edge-anchored candidates: start at content start, or
            // end at content end. Mid-prose JSON examples are skipped.
            if (i === firstNonWs || j + 1 === endTrimmed) {
              results.push(content.slice(i, j + 1));
            }
            i = j;
            break;
          }
        }
      }
    }
    i++;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Finish reason normalization
// ---------------------------------------------------------------------------

export function normalizeFinishReason(
  reason: string | undefined,
  hasTools: boolean,
): ModelFinishReason {
  const normalized = reason?.trim().toLowerCase();
  if (hasTools || normalized === "tool_use" || normalized === "tool") {
    return "tool_use";
  }
  if (
    normalized === "max_output_tokens" ||
    normalized === "max_tokens" ||
    normalized === "length"
  ) {
    return "max_output_tokens";
  }
  if (
    normalized === "context_limit" ||
    normalized === "prompt_too_long" ||
    normalized === "context_window_exceeded"
  ) {
    return "context_limit";
  }
  if (normalized === "error") {
    return "error";
  }
  return "stop";
}

// ---------------------------------------------------------------------------
// Model outcome
// ---------------------------------------------------------------------------

export interface ModelOutcome {
  content: string;
  toolRequests: ToolRequest[];
  finishReason: ModelFinishReason;
  disclosedTools?: string[] | undefined;
  hasToolErrors?: boolean | undefined;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

// ---------------------------------------------------------------------------
// Single-tool execution helper (shared by concurrent & serial paths)
// ---------------------------------------------------------------------------

type SingleToolResult =
  | { kind: "executed"; record: AgentToolCallRecord; hardFailure: boolean }
  | { kind: "blocked"; approval: { kind: "tool"; tool: string; args: unknown; reason: string } };

async function executeSingleTool(
  request: ToolRequest,
  tool: AgentTool,
  hooks: SmartAgentHooks | undefined,
): Promise<SingleToolResult> {
  // Policy check via hook
  if (hooks?.beforeToolCall) {
    const policy = await hooks.beforeToolCall(request.name, request.args);
    if (!policy.allowed) {
      return {
        kind: "blocked",
        approval: {
          kind: "tool",
          tool: request.name,
          args: request.args,
          reason: policy.reason ?? "Blocked by policy",
        },
      };
    }
  }

  // Input validation
  if (tool.validate) {
    const validation = tool.validate(cloneArgs(request.args));
    if (!validation.valid) {
      return {
        kind: "executed",
        record: { tool: request.name, args: request.args, result: { error: `Input validation failed:\n${validation.error}` }, requestId: request.id, order: request.order, status: "error" },
        hardFailure: false,
      };
    }
  } else if (tool.parameters) {
    const validation = validateArgs(request.args, tool.parameters);
    if (!validation.valid) {
      return {
        kind: "executed",
        record: { tool: request.name, args: request.args, result: { error: `Tool "${request.name}" input validation failed:\n${validation.error}` }, requestId: request.id, order: request.order, status: "error" },
        hardFailure: false,
      };
    }
  }

  // Execute tool (with optional timeout)
  let result: unknown;
  let status: "success" | "error" = "success";
  let hardFailure = false;
  let timerId: ReturnType<typeof setTimeout> | undefined;
  try {
    if (tool.timeout) {
      try {
        result = await Promise.race([
          tool.execute(cloneArgs(request.args)),
          new Promise<never>((_, reject) => {
            timerId = setTimeout(() => reject(new Error(
              `Tool "${request.name}" timed out after ${tool.timeout}ms`
            )), tool.timeout!);
          }),
        ]);
      } finally {
        if (timerId) clearTimeout(timerId);
      }
    } else {
      result = await tool.execute(cloneArgs(request.args));
    }
  } catch (error) {
    status = "error";
    result = {
      error: error instanceof Error ? error.message : String(error),
    };
    if (tool.failureMode === "hard") {
      hardFailure = true;
    }
  }

  const record: AgentToolCallRecord = {
    tool: request.name,
    args: request.args,
    result,
    requestId: request.id,
    order: request.order,
    status,
  };

  // After-tool hook
  if (hooks?.afterToolCall) {
    await hooks.afterToolCall(request.name, request.args, result, status);
  }

  return { kind: "executed", record, hardFailure };
}

/** Execute a tool without running beforeToolCall or afterToolCall (caller handles hooks) */
async function executeToolCore(
  request: ToolRequest,
  tool: AgentTool,
): Promise<SingleToolResult> {
  // Input validation
  if (tool.validate) {
    const validation = tool.validate(cloneArgs(request.args));
    if (!validation.valid) {
      return {
        kind: "executed",
        record: { tool: request.name, args: request.args, result: { error: `Input validation failed:\n${validation.error}` }, requestId: request.id, order: request.order, status: "error" },
        hardFailure: false,
      };
    }
  } else if (tool.parameters) {
    const validation = validateArgs(request.args, tool.parameters);
    if (!validation.valid) {
      return {
        kind: "executed",
        record: { tool: request.name, args: request.args, result: { error: `Tool "${request.name}" input validation failed:\n${validation.error}` }, requestId: request.id, order: request.order, status: "error" },
        hardFailure: false,
      };
    }
  }

  let result: unknown;
  let status: "success" | "error" = "success";
  let hardFailure = false;
  let timerId: ReturnType<typeof setTimeout> | undefined;
  try {
    if (tool.timeout) {
      try {
        result = await Promise.race([
          tool.execute(cloneArgs(request.args)),
          new Promise<never>((_, reject) => {
            timerId = setTimeout(() => reject(new Error(
              `Tool "${request.name}" timed out after ${tool.timeout}ms`
            )), tool.timeout!);
          }),
        ]);
      } finally {
        if (timerId) clearTimeout(timerId);
      }
    } else {
      result = await tool.execute(cloneArgs(request.args));
    }
  } catch (error) {
    status = "error";
    result = {
      error: error instanceof Error ? error.message : String(error),
    };
    if (tool.failureMode === "hard") {
      hardFailure = true;
    }
  }

  const record: AgentToolCallRecord = {
    tool: request.name,
    args: request.args,
    result,
    requestId: request.id,
    order: request.order,
    status,
  };

  return { kind: "executed", record, hardFailure };
}

// ---------------------------------------------------------------------------
// Concurrency-limited dispatcher
// ---------------------------------------------------------------------------

interface ConcurrentDispatcher {
  dispatch(fn: () => Promise<void>): Promise<void>;
  waitAll(): Promise<void>;
}

function createConcurrentDispatcher(maxConcurrency: number): ConcurrentDispatcher {
  const inFlight = new Set<Promise<void>>();
  let firstError: unknown;

  async function dispatch(fn: () => Promise<void>): Promise<void> {
    // Wait until we have a slot
    while (inFlight.size >= maxConcurrency) {
      await Promise.race(inFlight).catch(() => {});
    }

    const p = fn().catch((err) => {
      if (firstError === undefined) firstError = err;
    }).finally(() => {
      inFlight.delete(p);
    });
    inFlight.add(p);
  }

  async function waitAll(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
    if (firstError !== undefined) {
      const err = firstError;
      firstError = undefined;
      throw err;
    }
  }

  return { dispatch, waitAll };
}

// ---------------------------------------------------------------------------
// Main function — model sampling + tool execution
// ---------------------------------------------------------------------------

export async function executeModelAndTools(
  llm: LLMProvider,
  messages: LLMMessage[],
  tools: AgentTool[],
  hooks: SmartAgentHooks | undefined,
  _config: StreamingExecutorConfig | undefined,
  llmOptions?: LLMOptions,
  llmTimeout?: import("../types.js").LLMTimeoutConfig,
  visibleTools?: AgentTool[],
  authorizeToolDisclosure?: (names: readonly string[]) => string[],
): Promise<{
  outcome: ModelOutcome;
  toolRecords: AgentToolCallRecord[];
  blockedApproval?: { kind: "tool"; tool: string; args: unknown; reason: string };
  haltedByHardFailure: boolean;
}> {
  const maxConcurrency = Math.max(1, _config?.maxConcurrency ?? 10);
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const advertisedTools = visibleTools ?? tools;
  const allowedToolNames = new Set(advertisedTools.map((tool) => tool.name));
  const authorizeDisclosures = (names: readonly string[]): string[] => {
    const authorized = authorizeToolDisclosure
      ? authorizeToolDisclosure(names)
      : [...names];
    for (const name of authorized) allowedToolNames.add(name);
    return authorized;
  };

  // Forward the actual tool catalogue to the LLM provider so native function-
  // calling adapters (OpenAI / Anthropic) can present them. Text-only
  // providers ignore `options.tools` and fall back to text-JSON parsing.
  // Only attach `tools` when there is at least one — an empty catalogue leaves
  // the forwarded options untouched (providers omit tools/tool_choice for an
  // absent OR empty list anyway), so a no-tool turn forwards `llmOptions` as-is.
  const toolSpecs = advertisedTools.map((t) => ({
    name: t.name,
    description: t.description,
    ...(t.parameters ? { parameters: t.parameters } : {}),
    ...(t.disclosure?.namespace ? { namespace: t.disclosure.namespace } : {}),
  }));
  const deferredToolSpecs =
    llm.nativeToolSearch !== undefined
      ? tools
          .filter((tool) => !allowedToolNames.has(tool.name))
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            ...(tool.parameters ? { parameters: tool.parameters } : {}),
            ...(tool.disclosure?.namespace ? { namespace: tool.disclosure.namespace } : {}),
            deferLoading: true,
          }))
      : [];
  const optionsWithTools: LLMOptions = {
    ...(llmOptions ?? {}),
    ...(toolSpecs.length > 0 ? { tools: toolSpecs } : {}),
    ...(deferredToolSpecs.length > 0 ? { deferredTools: deferredToolSpecs } : {}),
  };

  // =========================================================================
  // Streaming path — detect and dispatch concurrent-safe tools during stream
  // =========================================================================
  if (llm.stream) {
    let content = "";
    let finishReason: string | undefined;

    // Whether native tools are advertised this turn. When true (the norm for
    // agent turns) ALL tool dispatch is DEFERRED to stream-end: native tool
    // calls only fully materialize on the terminal chunk, and per D1 a terminal
    // `[]` must suppress text-JSON parsing. Eager mid-stream dispatch is kept
    // for text-only providers (no native-tool capability). Gate on an EXPLICIT
    // provider capability (`nativeToolCalls === "terminal"`), not merely on
    // "tools advertised", so custom text-streaming providers keep mid-stream
    // dispatch. See exit-notes "STREAMING DISPATCH GATING".
    const deferDispatch =
      llm.nativeToolCalls === "terminal" &&
      (optionsWithTools.tools?.length ?? 0) > 0;

    // Native tool calls captured from the terminal (`done:true`) chunk, if the
    // provider surfaced any. `undefined` ⇒ provider gave no native signal.
    let terminalToolCalls:
      | { id: string; name: string; args: Record<string, unknown> }[]
      | undefined;
    let terminalDisclosedTools: string[] | undefined;

    // Track dispatched tool request ids so we only dispatch each once
    const dispatchedIds = new Set<string>();

    // Concurrent results collector: order -> record
    const concurrentResults: Map<number, AgentToolCallRecord> = new Map();
    let hardFailureDetected = false;
    let blockedApproval:
      | { kind: "tool"; tool: string; args: unknown; reason: string }
      | undefined;

    // Queued write (non-concurrent-safe) requests for post-stream execution
    const writeQueue: { request: ToolRequest; tool: AgentTool }[] = [];

    // All tool requests accumulated during the stream (for final outcome)
    let allToolRequests: ToolRequest[] = [];

    const dispatcher = createConcurrentDispatcher(maxConcurrency);

    const idleTimeout = llmTimeout?.streamIdleTimeoutMs ?? 90_000;
    let lastChunkTime = Date.now();

    for await (const chunk of llm.stream(messages, optionsWithTools)) {
      const gap = Date.now() - lastChunkTime;
      if (gap > idleTimeout) {
        throw new Error(`LLM stream idle timeout: no data for ${gap}ms`);
      }
      lastChunkTime = Date.now();

      content += chunk.content;

      if (chunk.done) {
        finishReason = chunk.finishReason;
        // Native tool calls are carried ONLY on the terminal chunk.
        terminalToolCalls = chunk.toolCalls;
        terminalDisclosedTools = chunk.disclosedTools;
      }

      // Eager mid-stream dispatch is the LEGACY text path only. When native
      // tools are advertised we defer everything to stream-end (avoids
      // double-dispatch with terminal-native calls and honors D1's empty-`[]`
      // suppression).
      if (deferDispatch) {
        continue;
      }

      // Try to detect complete tool calls from accumulated content
      const detected = parseToolRequests(content);
      if (detected.length > 0) {
        for (const req of detected) {
          const stableKey = `pos_${req.order}`;
          if (dispatchedIds.has(stableKey)) {
            continue;
          }
          // Use the parsed request as-is; dedup is by position key, not by id
          dispatchedIds.add(stableKey);

          const stableReq: ToolRequest = { ...req };

          // Update the master list
          allToolRequests.push(stableReq);

          const tool = toolMap.get(stableReq.name);
          if (!tool) {
            concurrentResults.set(stableReq.order, {
              tool: stableReq.name,
              args: stableReq.args,
              result: { error: `Tool "${stableReq.name}" not found` },
              requestId: stableReq.id,
              order: stableReq.order,
              status: "error",
            });
            continue;
          }
          if (!allowedToolNames.has(stableReq.name)) {
            concurrentResults.set(stableReq.order, undisclosedToolRecord(stableReq));
            continue;
          }

          if (tool.isConcurrencySafe) {
            // Dispatch immediately during streaming
            dispatcher.dispatch(async () => {
              if (blockedApproval || hardFailureDetected) return;
              const result = await executeSingleTool(
                stableReq,
                tool,
                hooks,
              );
              if (result.kind === "blocked") {
                blockedApproval = result.approval;
                return;
              }
              concurrentResults.set(stableReq.order, result.record);
              if (result.hardFailure) {
                hardFailureDetected = true;
              }
            });
          } else {
            // Queue for serial execution after stream ends
            writeQueue.push({ request: stableReq, tool });
          }
        }
      }
    }

    // Resolve the final tool requests for this turn.
    // - deferDispatch (native tools advertised): D1 — terminal native calls
    //   defined (even `[]`) win verbatim and suppress text-parse; `undefined`
    //   ⇒ fall back to parsing the accumulated content.
    // - legacy text path: re-parse the accumulated content (single canonical
    //   parse), same as before.
    const finalToolRequests = deferDispatch
      ? terminalToolCalls !== undefined
        ? toolRequestsFromNative(terminalToolCalls)
        : parseToolRequests(content)
      : parseToolRequests(content);
    const authorizedDisclosures = terminalDisclosedTools
      ? authorizeDisclosures(terminalDisclosedTools)
      : undefined;

    // Route the resolved requests through the SAME post-stream execution
    // machinery (concurrent dispatcher + write queue + unknown-tool errors).
    // For the deferred path this is the FIRST and ONLY dispatch — nothing ran
    // mid-stream, so concurrency-safe tools still run concurrently here. For
    // the legacy path this catches calls that only became parseable on the
    // final chunk; the `dispatchedIds` dedup guarantees exactly-once (nothing
    // already dispatched mid-stream is re-run).
    for (const req of finalToolRequests) {
      const stableKey = `pos_${req.order}`;
      if (dispatchedIds.has(stableKey)) {
        continue;
      }
      dispatchedIds.add(stableKey);
      allToolRequests.push(req);

      const tool = toolMap.get(req.name);
      if (!tool) {
        concurrentResults.set(req.order, {
          tool: req.name,
          args: req.args,
          result: { error: `Tool "${req.name}" not found` },
          requestId: req.id,
          order: req.order,
          status: "error",
        });
        continue;
      }
      if (!allowedToolNames.has(req.name)) {
        concurrentResults.set(req.order, undisclosedToolRecord(req));
        continue;
      }

      if (tool.isConcurrencySafe) {
        const concurrentReq = req;
        const concurrentTool = tool;
        dispatcher.dispatch(async () => {
          if (blockedApproval || hardFailureDetected) return;
          const result = await executeSingleTool(concurrentReq, concurrentTool, hooks);
          if (result.kind === "blocked") {
            blockedApproval = result.approval;
            return;
          }
          concurrentResults.set(concurrentReq.order, result.record);
          if (result.hardFailure) hardFailureDetected = true;
        });
      } else {
        writeQueue.push({ request: req, tool });
      }
    }

    // Wait for all in-flight concurrent tools to finish (legacy mid-stream
    // dispatch + the post-resolution dispatch above).
    await dispatcher.waitAll();

    // Build outcome using the final parse
    const normalizedFinish = normalizeFinishReason(
      finishReason,
      allToolRequests.length > 0,
    );
    const outcome: ModelOutcome = {
      content,
      toolRequests: allToolRequests,
      finishReason: normalizedFinish,
      ...(authorizedDisclosures ? { disclosedTools: authorizedDisclosures } : {}),
    };

    // If blocked by approval, return immediately with collected records
    if (blockedApproval) {
      const records = [...concurrentResults.values()].sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0),
      );
      return { outcome, toolRecords: records, blockedApproval, haltedByHardFailure: hardFailureDetected };
    }

    // Execute queued write tools serially (only if no hard failure yet)
    if (!hardFailureDetected) {
      for (const { request, tool } of writeQueue) {
        if (hardFailureDetected) break;

        const result = await executeSingleTool(
          request,
          tool,
          hooks,
        );
        if (result.kind === "blocked") {
          blockedApproval = result.approval;
          const records = [...concurrentResults.values()].sort(
            (a, b) => (a.order ?? 0) - (b.order ?? 0),
          );
          return { outcome, toolRecords: records, blockedApproval, haltedByHardFailure: hardFailureDetected };
        }
        concurrentResults.set(request.order, result.record);
        if (result.hardFailure) {
          hardFailureDetected = true;
        }
      }
    }

    // Sort all records by order
    const sortedRecords = [...concurrentResults.values()].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0),
    );

    // Synthetic tool_result for interrupted tools (only when NOT halted by hard failure —
    // hard failure intentionally stops remaining tools, they should NOT get records)
    if (!hardFailureDetected) {
      for (const req of allToolRequests) {
        const hasRecord = sortedRecords.some(r => r.requestId === req.id);
        if (!hasRecord) {
          sortedRecords.push({
            tool: req.name,
            args: req.args,
            result: { error: "Tool execution was interrupted" },
            requestId: req.id,
            order: req.order,
            status: "error",
          });
        }
      }
    }

    return {
      outcome,
      toolRecords: sortedRecords,
      ...(blockedApproval !== undefined ? { blockedApproval } : {}),
      haltedByHardFailure: hardFailureDetected,
    };
  }

  // =========================================================================
  // Non-streaming path — call chat(), parse, execute serially
  // =========================================================================
  const chatTimeout = llmTimeout?.chatTimeoutMs ?? 120_000;
  let chatTimer: ReturnType<typeof setTimeout> | undefined;
  const response = await Promise.race([
    llm.chat(messages, optionsWithTools),
    new Promise<never>((_, reject) => {
      chatTimer = setTimeout(() => reject(new Error(`LLM chat timeout after ${chatTimeout}ms`)), chatTimeout);
    }),
  ]);
  if (chatTimer) clearTimeout(chatTimer);
  const content = response.content;
  const finishReason = response.finishReason;
  const usage = response.usage;
  const authorizedDisclosures = response.disclosedTools
    ? authorizeDisclosures(response.disclosedTools)
    : undefined;

  // D1: a defined native `toolCalls` field (even `[]`) means the provider
  // spoke natively — use it verbatim and DO NOT text-parse. Only `undefined`
  // (a text-only provider that never advertised tools) falls back to text.
  const toolRequests =
    response.toolCalls !== undefined
      ? toolRequestsFromNative(response.toolCalls)
      : parseToolRequests(content);
  const normalizedFinish = normalizeFinishReason(finishReason, toolRequests.length > 0);

  const outcome: ModelOutcome = {
    content,
    toolRequests,
    finishReason: normalizedFinish,
    ...(usage ? { usage } : {}),
    ...(authorizedDisclosures ? { disclosedTools: authorizedDisclosures } : {}),
  };

  if (toolRequests.length === 0) {
    return { outcome, toolRecords: [], haltedByHardFailure: false };
  }

  const records: AgentToolCallRecord[] = [];
  let blockedApproval:
    | { kind: "tool"; tool: string; args: unknown; reason: string }
    | undefined;
  let haltedByHardFailure = false;

  // Separate concurrent-safe and serial tool requests
  const concurrentBatch: Array<{ request: ToolRequest; tool: AgentTool }> = [];
  const serialBatch: Array<{ request: ToolRequest; tool: AgentTool }> = [];

  for (const request of toolRequests) {
    const tool = toolMap.get(request.name);
    if (!tool) {
      records.push({
        tool: request.name,
        args: request.args,
        result: { error: `Tool "${request.name}" not found` },
        requestId: request.id,
        order: request.order,
        status: "error",
      });
      continue;
    }
    if (!allowedToolNames.has(request.name)) {
      records.push(undisclosedToolRecord(request));
      continue;
    }

    if (tool.isConcurrencySafe && toolRequests.length > 1) {
      concurrentBatch.push({ request, tool });
    } else {
      serialBatch.push({ request, tool });
    }
  }

  // Execute concurrent-safe tools in parallel (two-phase: hooks serial, execute parallel)
  if (concurrentBatch.length > 0) {
    // Phase 1: Run beforeToolCall hooks serially to ensure deterministic ordering
    const approved: Array<{ request: ToolRequest; tool: AgentTool }> = [];
    let hookError: unknown;
    for (const { request, tool } of concurrentBatch) {
      if (blockedApproval) break;
      if (hooks?.beforeToolCall) {
        try {
          const policy = await hooks.beforeToolCall(request.name, request.args);
          if (!policy.allowed) {
            blockedApproval = {
              kind: "tool",
              tool: request.name,
              args: request.args,
              reason: policy.reason ?? "Blocked by policy",
            };
            break;
          }
        } catch (err) {
          // A hook threw (e.g. task persistence failed). Still run Phase 2
          // so already-approved tools can see the abort and settle properly.
          hookError = err;
          break;
        }
      }
      approved.push({ request, tool });
    }

    if (blockedApproval) {
      return { outcome, toolRecords: records, blockedApproval, haltedByHardFailure };
    }

    // Phase 2: Dispatch approved tools concurrently (hooks already called).
    // Even with hookError, we still run Phase 2 so aborted tools can settle
    // (harness propagates cancellation via AbortController, not executor).
    if (approved.length > 0) {
      const concurrentDispatcher = createConcurrentDispatcher(maxConcurrency);
      const concurrentResults: Map<number, SingleToolResult> = new Map();

      for (const { request, tool } of approved) {
        concurrentDispatcher.dispatch(async () => {
          if (haltedByHardFailure) return;
          const result = await executeToolCore(request, tool);
          concurrentResults.set(request.order, result);
          if (result.kind === "executed" && result.hardFailure) {
            haltedByHardFailure = true;
          }
        });
      }

      await concurrentDispatcher.waitAll();

      // Run afterToolCall hooks serially to avoid concurrent patchRun races
      for (const { request } of approved) {
        const result = concurrentResults.get(request.order);
        if (!result) continue;
        if (result.kind === "blocked") {
          blockedApproval = result.approval;
          return { outcome, toolRecords: records, blockedApproval, haltedByHardFailure };
        }
        records.push(result.record);
        if (hooks?.afterToolCall) {
          await hooks.afterToolCall(request.name, request.args, result.record.result, result.record.status ?? "success");
        }
      }
    }

    // Re-throw the hook error after approved tools have settled
    if (hookError !== undefined) {
      throw hookError;
    }
  }

  // Execute serial tools sequentially
  for (const { request, tool } of serialBatch) {
    if (haltedByHardFailure) break;

    const result = await executeSingleTool(
      request,
      tool,
      hooks,
    );

    if (result.kind === "blocked") {
      blockedApproval = result.approval;
      return { outcome, toolRecords: records, blockedApproval, haltedByHardFailure };
    }

    records.push(result.record);

    if (result.hardFailure) {
      haltedByHardFailure = true;
      break;
    }
  }

  // Synthetic tool_result for interrupted tools (skip on hard failure — intentional halt)
  if (!haltedByHardFailure) {
    for (const req of toolRequests) {
      const hasRecord = records.some(r => r.requestId === req.id);
      if (!hasRecord) {
        records.push({
          tool: req.name,
          args: req.args,
          result: { error: "Tool execution was interrupted" },
          requestId: req.id,
          order: req.order,
          status: "error",
        });
      }
    }
  }

  return { outcome, toolRecords: records, ...(blockedApproval !== undefined ? { blockedApproval } : {}), haltedByHardFailure };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function cloneArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, cloneUnknown(value)]),
  );
}

function undisclosedToolRecord(request: ToolRequest): AgentToolCallRecord {
  return {
    tool: request.name,
    args: request.args,
    result: {
      error: `Tool "${request.name}" has not been disclosed. Search the tool catalog first.`,
      code: "TOOL_NOT_DISCLOSED",
    },
    requestId: request.id,
    order: request.order,
    status: "error",
  };
}

function cloneUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneUnknown);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, cloneUnknown(nested)]),
    );
  }
  return value;
}

function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
