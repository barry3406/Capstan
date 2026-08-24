// ---------------------------------------------------------------------------
// LLM provider adapter interface and built-in implementations
// ---------------------------------------------------------------------------

/**
 * Multimodal content part. Inline base64 is preferred for images so the
 * downstream provider has no separate fetch. A `tool_result` part carries the
 * textual result of a prior tool call, linked by `toolUseId`.
 *
 * NOTE: this is a structural mirror of `@zauso-ai/capstan-ai`'s
 * `LLMContentPart`. The agent package intentionally does NOT import from the
 * ai package; the mirror is kept one-directionally assignable (ai → agent for
 * inputs, agent → ai for outputs) so a provider built here satisfies
 * `ai.LLMProvider`.
 */
export type LLMContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }
  | { type: "tool_result"; toolUseId: string; content: string };

/**
 * A single conversation message. Content can be a plain string (legacy /
 * cheap path) or an array of multimodal parts (text + image + tool_result).
 *
 * The `role` union is intentionally WIDER than the ai package's: providers
 * accept a `tool`-role input message (mapped to a provider tool-result message)
 * even though the v1 loop never emits one. `toolCallId` links a `tool`-role
 * message to the assistant tool call it answers.
 */
export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | LLMContentPart[];
  toolCallId?: string | undefined;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage?:
    | {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      }
    | undefined;
  finishReason?: string | undefined;
  /** Native tool calls parsed from the provider response. Present (possibly
   * `[]`) ONLY when tools were advertised this turn; UNDEFINED otherwise. */
  toolCalls?:
    | { id: string; name: string; args: Record<string, unknown> }[]
    | undefined;
  /** Tool definitions loaded by a provider-native search during this turn. */
  disclosedTools?: string[] | undefined;
}

export interface LLMStreamChunk {
  content: string;
  done: boolean;
  finishReason?: string | undefined;
  /** Terminal-only: native tool calls accumulated across the stream. Present
   * (possibly `[]`) on the terminal chunk ONLY when tools were advertised;
   * UNDEFINED otherwise. Non-terminal chunks MUST omit this. */
  toolCalls?:
    | { id: string; name: string; args: Record<string, unknown> }[]
    | undefined;
  /** Terminal-only tool definitions loaded by a provider-native search. */
  disclosedTools?: string[] | undefined;
}

/** Tool spec passed to the LLM provider. The provider can use this to
 * advertise native function calling (OpenAI / Anthropic) so the model
 * picks tool names from the canonical list instead of hallucinating. */
export interface LLMToolSpec {
  name: string;
  description: string;
  parameters?: Record<string, unknown> | undefined;
  deferLoading?: boolean | undefined;
  namespace?: string | undefined;
}

export interface LLMOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  responseFormat?: Record<string, unknown>;
  signal?: AbortSignal | undefined;
  /** Tools available this turn. Native-function-call providers will present
   * them; text-only providers may ignore. */
  tools?: LLMToolSpec[] | undefined;
  /** Full definitions kept out of the initial model context when supported. */
  deferredTools?: LLMToolSpec[] | undefined;
}

export interface LLMProvider {
  name: string;
  chat(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse>;
  stream?(
    messages: LLMMessage[],
    options?: LLMOptions,
  ): AsyncIterable<LLMStreamChunk>;
  /** See @zauso-ai/capstan-ai LLMProvider: `"terminal"` means native tool calls
   * are surfaced on the terminal stream chunk / chat LLMResponse, so the loop
   * defers dispatch to stream-end for this provider. */
  nativeToolCalls?: "terminal" | undefined;
  /** Provider-native just-in-time tool loading capability. */
  nativeToolSearch?: "openai" | "anthropic" | undefined;
}

// ---------------------------------------------------------------------------
// Shared accumulator for streamed native tool calls (per provider-local index)
// ---------------------------------------------------------------------------

interface ToolCallAccumulator {
  id: string;
  name: string;
  argsBuf: string;
}

type ParsedToolCall = { id: string; name: string; args: Record<string, unknown> };

/** Parse an accumulated JSON-arguments string into an object. Bad/empty JSON
 * yields `{}` (never throws) per locked decision A-OA-01. */
function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Materialize accumulated tool-call deltas into the terminal shape, ordered
 * by their numeric index, dropping any with empty/missing name. */
function finalizeAccumulatedToolCalls(
  acc: Map<number, ToolCallAccumulator>,
): ParsedToolCall[] {
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .filter((v) => v.name)
    .map((v) => ({ id: v.id, name: v.name, args: parseToolArgs(v.argsBuf) }));
}

// ---------------------------------------------------------------------------
// OpenAI-compatible provider
// ---------------------------------------------------------------------------

/** Serialize agent messages into OpenAI `/chat/completions` message objects.
 * - string content → unchanged (backward compat).
 * - `tool`-role message → `{role:"tool",tool_call_id,content}`.
 * - part[] → text parts unchanged; image parts → `image_url` data URLs;
 *   `tool_result` parts are hoisted into their OWN top-level `role:"tool"`
 *   messages (OpenAI tool results are messages, not content parts). */
function serializeOpenAIMessages(
  messages: LLMMessage[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      // A tool-role message: content is the (string) result for toolCallId.
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId,
        content: typeof m.content === "string" ? m.content : "",
      });
      continue;
    }

    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }

    // Multimodal array: image/text stay as parts; tool_result becomes its own
    // top-level tool message.
    const parts: Record<string, unknown>[] = [];
    for (const part of m.content) {
      if (part.type === "text") {
        parts.push({ type: "text", text: part.text });
      } else if (part.type === "image") {
        parts.push({
          type: "image_url",
          image_url: {
            url: `data:${part.mediaType};base64,${part.data}`,
          },
        });
      } else {
        // tool_result → top-level tool message
        out.push({
          role: "tool",
          tool_call_id: part.toolUseId,
          content: part.content,
        });
      }
    }
    if (parts.length > 0) out.push({ role: m.role, content: parts });
  }
  return out;
}

/** Map advertised tool specs into OpenAI request `tools[]`. */
function openAIToolsBody(tools: LLMToolSpec[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// ---------------------------------------------------------------------------
// Resilient fetch for LLM providers
// ---------------------------------------------------------------------------
//
// LLM 网关常是跨境/高 RTT 入口:冷连接 TCP 1-2s、TLS 偶发抖到 7s+,单次建连能
// 逼近 undici 默认 10s connect-timeout → `fetch failed` → agent run 直接 fatal。
// 这里给所有 provider 的出站调用统一加固:
//   1. keep-alive dispatcher —— 跨 agent iteration 复用连接,把 TCP+TLS 成本从
//      "每轮一次" 摊到 "整个 run 基本一次"(高 iteration 的 run 提速最明显);
//   2. connect timeout 抬到 20s —— 兜住境外网关 TLS 握手抖动,慢但能连上的不再被砍;
//   3. 瞬时网络错(connect timeout / socket reset / DNS 抖)+ 429/5xx 自动重试,
//      指数退避,尊重调用方 AbortSignal —— 把单点抖动对用户的可见失败抹平。
//
// 注:只在 fetch 抛错(连接没建起、还没拿到响应)或收到可重试状态码时重试;一旦
// 拿到成功响应(含 stream)就交回调用方,绝不重发,避免重复副作用 / 双流。
type FetchInitWithDispatcher = RequestInit & { dispatcher?: unknown };

let __llmDispatcher: unknown | undefined;
let __llmDispatcherResolved = false;
async function getLlmDispatcher(): Promise<unknown | undefined> {
  if (__llmDispatcherResolved) return __llmDispatcher;
  __llmDispatcherResolved = true;
  try {
    const { Agent } = (await import("undici")) as { Agent: new (opts: unknown) => unknown };
    __llmDispatcher = new Agent({
      keepAliveTimeout: 60_000, // 空闲连接保活 60s,跨 iteration 复用
      keepAliveMaxTimeout: 600_000,
      connect: { timeout: 20_000 }, // TCP+TLS 上限 20s(默认 10s 对境外网关太紧)
      headersTimeout: 600_000, // 慢推理模型上限交给调用方 signal,undici 不抢先砍
      bodyTimeout: 600_000,
      connections: 128,
    });
  } catch {
    __llmDispatcher = undefined; // undici 不可用 → 退回全局 fetch,仅靠重试兜底
  }
  return __llmDispatcher;
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
]);

function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string } };
  if (e.name === "AbortError") return false; // 调用方主动取消 → 不重试
  const code = e.cause?.code ?? e.code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  // fetch() 对底层网络错统一抛 TypeError("fetch failed"),cause 不一定带 code。
  return /fetch failed|network|socket|terminated/i.test(e.message ?? "");
}

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 4_000); // 0.5s,1s,2s…(上限 4s)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * fetch + keep-alive dispatcher + 指数退避重试。signal 从 init 读取(既驱动在途
 * fetch 的取消,也用于重试/退避的提前中止)。retries=2 → 最多 3 次尝试。
 */
async function resilientFetch(
  url: string,
  init: FetchInitWithDispatcher,
  retries = 2,
): Promise<Response> {
  const signal = init.signal ?? undefined;
  const dispatcher = await getLlmDispatcher();
  const finalInit: FetchInitWithDispatcher = dispatcher ? { ...init, dispatcher } : init;
  let lastErr: unknown;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    try {
      const res = await fetch(url, finalInit as RequestInit);
      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        await res.text().catch(() => {}); // 释放连接以便 keep-alive 复用
        await sleep(backoffMs(attempt), signal);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries && !signal?.aborted && isRetryableError(err)) {
        await sleep(backoffMs(attempt), signal);
        continue;
      }
      throw err;
    }
  }
  // 不可达:循环要么 return res 要么 throw;留作类型收尾。
  throw lastErr;
}

export function openaiProvider(config: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}): LLMProvider {
  const baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
  const defaultModel = config.model ?? "gpt-4o";

  /** Build the shared request body for chat() and stream(). */
  function buildBody(
    messages: LLMMessage[],
    options: LLMOptions | undefined,
    streaming: boolean,
  ): Record<string, unknown> {
    const baseMessages: LLMMessage[] = options?.systemPrompt
      ? [{ role: "system", content: options.systemPrompt }, ...messages]
      : messages;

    const body: Record<string, unknown> = {
      model: options?.model ?? defaultModel,
      messages: serializeOpenAIMessages(baseMessages),
    };
    if (streaming) body["stream"] = true;
    if (options?.temperature !== undefined)
      body["temperature"] = options.temperature;
    if (options?.maxTokens !== undefined)
      body["max_tokens"] = options.maxTokens;
    if (options?.responseFormat)
      body["response_format"] = {
        type: "json_schema",
        json_schema: {
          schema: options.responseFormat,
          name: "response",
          strict: true,
        },
      };
    if (options?.tools?.length) {
      body["tools"] = openAIToolsBody(options.tools);
      body["tool_choice"] = "auto";
    }
    return body;
  }

  return {
    name: "openai",
    nativeToolCalls: "terminal",

    async chat(messages, options) {
      const body = buildBody(messages, options, false);

      const res = await resilientFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        ...(options?.signal ? { signal: options.signal } : {}),
      });

      if (!res.ok)
        throw new Error(`LLM error ${res.status}: ${await res.text()}`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (await res.json()) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const message = data.choices?.[0]?.message;

      const toolsAdvertised = !!options?.tools?.length;
      let toolCalls: ParsedToolCall[] | undefined;
      if (toolsAdvertised) {
        const rawCalls: any[] = Array.isArray(message?.tool_calls)
          ? message.tool_calls
          : [];
        toolCalls = rawCalls
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((c: any) => ({
            id: c?.id ?? "",
            name: c?.function?.name ?? "",
            args: parseToolArgs(c?.function?.arguments ?? ""),
          }))
          .filter((c) => c.name);
      }

      return {
        content: message?.content ?? "",
        model: data.model ?? defaultModel,
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
              totalTokens: data.usage.total_tokens,
            }
          : undefined,
        finishReason: data.choices?.[0]?.finish_reason,
        ...(toolCalls !== undefined ? { toolCalls } : {}),
      };
    },

    async *stream(messages, options) {
      const body = buildBody(messages, options, true);

      const res = await resilientFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        ...(options?.signal ? { signal: options.signal } : {}),
      });

      if (!res.ok) throw new Error(`LLM error ${res.status}`);
      if (!res.body) throw new Error("No body");

      const toolsAdvertised = !!options?.tools?.length;
      const acc = new Map<number, ToolCallAccumulator>();
      let finishReason: string | undefined;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let terminated = false;

      const finalChunk = (): LLMStreamChunk => ({
        content: "",
        done: true,
        ...(finishReason !== undefined ? { finishReason } : {}),
        ...(toolsAdvertised
          ? { toolCalls: finalizeAccumulatedToolCalls(acc) }
          : {}),
      });

      // Process one SSE line: yield content chunks, accumulate tool-call
      // deltas by index, set `terminated` on [DONE]. Shared by the streaming
      // loop and the EOF residual flush so a final newline-less frame is not
      // dropped (real servers may close right after the last `data:` frame).
      const handleLine = function* (line: string): Generator<LLMStreamChunk> {
        if (!line.startsWith("data:")) return;
        const d = line.slice(line.indexOf(":") + 1).trim();
        if (!d) return;
        if (d === "[DONE]") {
          terminated = true;
          return;
        }
        try {
          const p = JSON.parse(d);
          const choice = p.choices?.[0];
          const delta = choice?.delta;
          const c = delta?.content ?? "";
          if (c) yield { content: c, done: false };

          // Accumulate streamed tool-call deltas by index.
          const deltaToolCalls = delta?.tool_calls;
          if (Array.isArray(deltaToolCalls)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const tc of deltaToolCalls as any[]) {
              const idx = typeof tc?.index === "number" ? tc.index : 0;
              let entry = acc.get(idx);
              if (!entry) {
                entry = { id: "", name: "", argsBuf: "" };
                acc.set(idx, entry);
              }
              // id + name come from the first delta that carries them.
              if (tc?.id && !entry.id) entry.id = tc.id;
              if (tc?.function?.name && !entry.name)
                entry.name = tc.function.name;
              if (typeof tc?.function?.arguments === "string")
                entry.argsBuf += tc.function.arguments;
            }
          }

          if (choice?.finish_reason) finishReason = choice.finish_reason;
        } catch {
          // skip malformed chunks
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          for (const ch of handleLine(line)) yield ch;
          if (terminated) {
            yield finalChunk();
            return;
          }
        }
      }
      // Flush any residual line that arrived without a trailing newline.
      buf += decoder.decode();
      const tail = buf.replace(/\r$/, "").trim();
      if (tail) {
        for (const ch of handleLine(tail)) yield ch;
      }
      yield finalChunk();
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic provider
// ---------------------------------------------------------------------------

/** Serialize a single message's content into Anthropic content parts. String
 * content stays a string (backward compat); arrays map text/image/tool_result
 * into Anthropic's content-part shapes. A `tool`-role message becomes a
 * `user`-role message carrying a single `tool_result` part. */
function serializeAnthropicContent(
  content: string | LLMContentPart[],
): string | Record<string, unknown>[] {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    if (part.type === "image") {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: part.mediaType,
          data: part.data,
        },
      };
    }
    // tool_result
    return {
      type: "tool_result",
      tool_use_id: part.toolUseId,
      content: part.content,
    };
  });
}

/** Map non-system messages into Anthropic request `messages[]`, translating a
 * `tool`-role message into a `user` message with a `tool_result` part. */
function serializeAnthropicMessages(
  messages: LLMMessage[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId,
            content: typeof m.content === "string" ? m.content : "",
          },
        ],
      });
      continue;
    }
    out.push({ role: m.role, content: serializeAnthropicContent(m.content) });
  }
  return out;
}

/** Map advertised tool specs into Anthropic request `tools[]`, defaulting an
 * empty object schema when `parameters` is absent. */
function anthropicToolsBody(
  tools: LLMToolSpec[],
  deferLoading = false,
): Record<string, unknown>[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters ?? { type: "object", properties: {} },
    ...(deferLoading || t.deferLoading ? { defer_loading: true } : {}),
  }));
}

function extractToolReferences(value: unknown): string[] {
  const names = new Set<string>();
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (!entry || typeof entry !== "object") return;
    const record = entry as Record<string, unknown>;
    if (record["type"] === "tool_reference") {
      const name = record["tool_name"] ?? record["name"];
      if (typeof name === "string" && name) names.add(name);
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return [...names];
}

function supportsAnthropicToolSearch(model: string): boolean {
  const family = model.match(
    /^claude-(?:opus|sonnet|haiku)-(\d+)-(\d{1,2})(?:-|$)/,
  );
  if (family) {
    const major = Number(family[1]);
    const minor = Number(family[2]);
    return major > 4 || (major === 4 && minor >= 5);
  }
  return /^claude-(?:fable|mythos)-5(?:-|$)/.test(model);
}

export function anthropicProvider(config: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}): LLMProvider {
  const baseUrl = config.baseUrl ?? "https://api.anthropic.com/v1";
  const defaultModel = config.model ?? "claude-sonnet-4-20250514";

  function buildBody(
    messages: LLMMessage[],
    options: LLMOptions | undefined,
    streaming: boolean,
  ): Record<string, unknown> {
    const sys =
      options?.systemPrompt ??
      (() => {
        const sysMsg = messages.find((m) => m.role === "system");
        return typeof sysMsg?.content === "string"
          ? sysMsg.content
          : undefined;
      })();

    const body: Record<string, unknown> = {
      model: options?.model ?? defaultModel,
      messages: serializeAnthropicMessages(messages),
      max_tokens: options?.maxTokens ?? 4096,
    };
    if (streaming) body["stream"] = true;
    if (sys) body["system"] = sys;
    if (options?.temperature !== undefined)
      body["temperature"] = options.temperature;
    const model = options?.model ?? defaultModel;
    const nativeSearch =
      !!options?.deferredTools?.length && supportsAnthropicToolSearch(model);
    const tools = [
      ...(nativeSearch
        ? [
            {
              type: "tool_search_tool_bm25_20251119",
              name: "tool_search_tool_bm25",
            },
          ]
        : []),
      ...anthropicToolsBody(options?.tools ?? []),
      ...(nativeSearch
        ? anthropicToolsBody(options?.deferredTools ?? [], true)
        : []),
    ];
    if (tools.length) body["tools"] = tools;
    return body;
  }

  const headers = {
    "x-api-key": config.apiKey,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };

  return {
    name: "anthropic",
    nativeToolCalls: "terminal",
    nativeToolSearch: "anthropic",

    async chat(messages, options) {
      const body = buildBody(messages, options, false);

      const res = await resilientFetch(`${baseUrl}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(options?.signal ? { signal: options.signal } : {}),
      });

      if (!res.ok)
        throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (await res.json()) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const blocks: any[] = Array.isArray(data.content) ? data.content : [];
      const text =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        blocks.find((b: any) => b.type === "text")?.text ?? "";

      const toolsAdvertised =
        !!options?.tools?.length || !!options?.deferredTools?.length;
      const disclosedTools = extractToolReferences(blocks);
      let toolCalls: ParsedToolCall[] | undefined;
      if (toolsAdvertised) {
        toolCalls = blocks
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((b: any) => b.type === "tool_use")
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((b: any) => ({
            id: b?.id ?? "",
            name: b?.name ?? "",
            args:
              b?.input && typeof b.input === "object" && !Array.isArray(b.input)
                ? (b.input as Record<string, unknown>)
                : {},
          }))
          .filter((b) => b.name);
      }

      return {
        content: text,
        model: data.model ?? defaultModel,
        usage: data.usage
          ? {
              promptTokens: data.usage.input_tokens,
              completionTokens: data.usage.output_tokens,
              totalTokens:
                (data.usage.input_tokens ?? 0) +
                (data.usage.output_tokens ?? 0),
            }
          : undefined,
        finishReason: data.stop_reason,
        ...(toolCalls !== undefined ? { toolCalls } : {}),
        ...(disclosedTools.length ? { disclosedTools } : {}),
      };
    },

    async *stream(messages, options) {
      const body = buildBody(messages, options, true);

      const res = await resilientFetch(`${baseUrl}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(options?.signal ? { signal: options.signal } : {}),
      });

      if (!res.ok) throw new Error(`Anthropic error ${res.status}`);
      if (!res.body) throw new Error("No body");

      const toolsAdvertised =
        !!options?.tools?.length || !!options?.deferredTools?.length;
      const acc = new Map<number, ToolCallAccumulator>();
      const disclosedTools = new Set<string>();
      let finishReason: string | undefined;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let terminated = false;

      const finalChunk = (): LLMStreamChunk => ({
        content: "",
        done: true,
        ...(finishReason !== undefined ? { finishReason } : {}),
        ...(toolsAdvertised
          ? { toolCalls: finalizeAccumulatedToolCalls(acc) }
          : {}),
        ...(disclosedTools.size
          ? { disclosedTools: [...disclosedTools] }
          : {}),
      });

      // SSE frames are blank-line-separated `event:`/`data:` line groups. We
      // only need the JSON `data:` payload; its top-level `type` field tells
      // us how to interpret it, so the `event:` line is informational.
      const handleData = function* (
        raw: string,
      ): Generator<LLMStreamChunk, void, undefined> {
        let evt: any;
        try {
          evt = JSON.parse(raw);
        } catch {
          return;
        }
        const type = evt?.type;
        switch (type) {
          case "content_block_start": {
            const block = evt.content_block;
            for (const name of extractToolReferences(block))
              disclosedTools.add(name);
            if (block?.type === "tool_use") {
              const idx = typeof evt.index === "number" ? evt.index : 0;
              acc.set(idx, {
                id: block.id ?? "",
                name: block.name ?? "",
                argsBuf: "",
              });
            }
            return;
          }
          case "content_block_delta": {
            const delta = evt.delta;
            if (delta?.type === "text_delta") {
              const text = delta.text ?? "";
              if (text) yield { content: text, done: false };
            } else if (delta?.type === "input_json_delta") {
              const idx = typeof evt.index === "number" ? evt.index : 0;
              const entry = acc.get(idx);
              if (entry && typeof delta.partial_json === "string")
                entry.argsBuf += delta.partial_json;
            }
            return;
          }
          case "message_delta": {
            if (evt.delta?.stop_reason) finishReason = evt.delta.stop_reason;
            return;
          }
          case "message_stop": {
            terminated = true;
            yield finalChunk();
            return;
          }
          // message_start / content_block_stop / ping / unknown → ignore
          default:
            return;
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // Split off complete frames (blank-line delimited). Keep the trailing
        // partial in `buf` so frames split across reads are reassembled.
        // Match either \n\n or \r\n\r\n at the earliest position.
        for (
          let sep = nextFrameBoundary(buf);
          sep !== -1;
          sep = nextFrameBoundary(buf)
        ) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + frameBoundaryLen(buf, sep));
          for (const dataLine of extractDataPayloads(frame)) {
            yield* handleData(dataLine);
            if (terminated) return;
          }
        }
      }

      // Flush any final buffered frame without a trailing blank line.
      if (!terminated && buf.length > 0) {
        for (const dataLine of extractDataPayloads(buf)) {
          yield* handleData(dataLine);
          if (terminated) return;
        }
      }

      if (!terminated) yield finalChunk();
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic SSE frame helpers
// ---------------------------------------------------------------------------

/** Index of the earliest frame boundary (`\n\n` or `\r\n\r\n`) in `buf`, or
 * -1 if none is fully present yet. */
function nextFrameBoundary(buf: string): number {
  const lf = buf.indexOf("\n\n");
  const crlf = buf.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

/** Length of the boundary delimiter found at position `at`. */
function frameBoundaryLen(buf: string, at: number): number {
  return buf.startsWith("\r\n\r\n", at) ? 4 : 2;
}

/** Concatenate the `data:` lines of an SSE frame into their JSON payloads.
 * Each frame yields at most one logical payload, but multi-line `data:` fields
 * are concatenated per the SSE spec. */
function extractDataPayloads(frame: string): string[] {
  const dataParts: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("data:")) {
      // Strip the single optional leading space after the colon.
      dataParts.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (dataParts.length === 0) return [];
  return [dataParts.join("\n")];
}

// ---------------------------------------------------------------------------
// OpenAI Responses-API provider
// ---------------------------------------------------------------------------
// Talks the OpenAI Responses API (POST /v1/responses with `input` +
// `instructions`), so it works with OpenAI and Responses-compatible proxies
// (e.g. cocode for gpt-5.x). Text-based tool calling (the loop parses tool
// JSON from the model text), so it deliberately does NOT set nativeToolCalls.
// Handles both plain-JSON and SSE responses (reasoning models often stream).

/** Plain-text view of message content for the Responses `input_text` block. */
function responsesContentText(content: string | LLMContentPart[]): string {
  if (typeof content === "string") return content;
  return content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** Responses-API 输入内容部件:text → input_text,image → input_image(data URL)。
 *  assistant 历史只回放 output_text(它不发图)。其余角色按 parts 逐个映射。 */
function responsesContentParts(
  role: string,
  content: string | LLMContentPart[],
): Array<Record<string, unknown>> {
  if (role === "assistant") return [{ type: "output_text", text: responsesContentText(content) }];
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  const parts: Array<Record<string, unknown>> = [];
  for (const p of content) {
    if (p.type === "text") parts.push({ type: "input_text", text: p.text });
    else if (p.type === "image") parts.push({ type: "input_image", image_url: `data:${p.mediaType};base64,${p.data}` });
  }
  return parts.length ? parts : [{ type: "input_text", text: "" }];
}

/** Extract assistant text from a Responses payload (plain JSON or SSE). */
/** 从 Responses 输出数组里提取原生 function_call(工具调用)。 */
function extractResponsesToolCalls(
  d: unknown,
): { id: string; name: string; args: Record<string, unknown> }[] | undefined {
  const out = (d as { output?: unknown })?.output;
  if (!Array.isArray(out)) return undefined;
  const calls = out
    .filter(
      (o): o is Record<string, unknown> =>
        !!o && typeof o === "object" && (o as Record<string, unknown>).type === "function_call",
    )
    .map((o) => {
      let args: Record<string, unknown> = {};
      try {
        args = o.arguments ? (JSON.parse(String(o.arguments)) as Record<string, unknown>) : {};
      } catch {
        args = {};
      }
      return { id: String(o.call_id ?? o.id ?? o.name), name: String(o.name), args };
    });
  return calls.length ? calls : undefined;
}

export function parseResponsesPayload(raw: string, fallbackModel: string): {
  content: string;
  model: string;
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[] | undefined;
  disclosedTools?: string[] | undefined;
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fromOutput = (d: any): string =>
    d?.output_text ??
    (Array.isArray(d?.output)
      ? d.output
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((o: any) => o?.type === "message")
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .flatMap((o: any) => o?.content ?? [])
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((c: any) => c?.type === "output_text")
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((c: any) => c.text)
          .join("")
      : "");
  if (raw.startsWith("event:")) {
    let want = false;
    for (const line of raw.split("\n")) {
      if (line.startsWith("event: response.completed")) { want = true; continue; }
      if (want && line.startsWith("data: ")) {
        try {
          const d = JSON.parse(line.slice(6));
          const rr = d.response ?? d;
          const disclosedTools = extractToolReferences(rr);
          return {
            content: fromOutput(rr),
            model: rr?.model ?? fallbackModel,
            toolCalls: extractResponsesToolCalls(rr),
            ...(disclosedTools.length ? { disclosedTools } : {}),
          };
        } catch { break; }
      }
    }
    // Fallback: accumulate output_text deltas if no completed event was seen.
    const acc = raw
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => { try { return JSON.parse(l.slice(6)).delta ?? ""; } catch { return ""; } })
      .join("");
    return { content: acc, model: fallbackModel };
  }
  try {
    const d = JSON.parse(raw);
    const disclosedTools = extractToolReferences(d);
    return {
      content: fromOutput(d),
      model: d.model ?? fallbackModel,
      toolCalls: extractResponsesToolCalls(d),
      ...(disclosedTools.length ? { disclosedTools } : {}),
    };
  } catch {
    return { content: "", model: fallbackModel };
  }
}

function supportsOpenAIToolSearch(model: string): boolean {
  const match = /^gpt-5\.(\d+)(?:\b|[-_])/.exec(model.toLowerCase());
  return match?.[1] !== undefined && Number(match[1]) >= 4;
}

export function responsesProvider(config: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** Reasoning effort for reasoning models (e.g. gpt-5.x). Only sent when set. */
  reasoningEffort?: string;
}): LLMProvider {
  const root = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = root.endsWith("/v1") ? `${root}/responses` : `${root}/v1/responses`;
  const defaultModel = config.model ?? "gpt-5.5";

  return {
    name: "openai-responses",
    // Responses API 原生支持 function tools;工具调用在终态响应里返回,
    // 交给 smart-agent loop 在 stream-end 统一派发。
    nativeToolCalls: "terminal",
    nativeToolSearch: "openai",
    async chat(messages, options) {
      const sys = messages
        .filter((m) => m.role === "system")
        .map((m) => responsesContentText(m.content))
        .join("\n\n");
      const input = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role,
          content: responsesContentParts(m.role, m.content),
        }));
      const model = options?.model ?? defaultModel;
      const body: Record<string, unknown> = {
        model,
        input: input.length ? input : [{ role: "user", content: [{ type: "input_text", text: "(continue)" }] }],
        instructions: sys || "You are a helpful assistant.",
        store: false,
        stream: false,
      };
      if (config.reasoningEffort) body["reasoning"] = { effort: config.reasoningEffort };
      // Responses reasoning models reject `temperature`; only forward token cap.
      if (options?.maxTokens !== undefined) body["max_output_tokens"] = options.maxTokens;
      // 原生 function tools(Responses API 的扁平 function 形态)。
      const visibleTools = (options?.tools ?? []).map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.parameters ?? { type: "object", properties: {} },
      }));
      const useNativeToolSearch =
        !!options?.deferredTools?.length && supportsOpenAIToolSearch(model);
      const deferredTools = (useNativeToolSearch ? options?.deferredTools ?? [] : []).map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters ?? { type: "object", properties: {} },
        defer_loading: true,
      }));
      if (visibleTools.length || deferredTools.length) {
        body["tools"] = [
          ...(deferredTools.length ? [{ type: "tool_search" }] : []),
          ...visibleTools,
          ...deferredTools,
        ];
      }

      const res = await resilientFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(`Responses API error ${res.status}: ${raw.slice(0, 500)}`);
      const parsed = parseResponsesPayload(raw, model);
      // Honour the toolCalls contract: present (possibly []) only when tools
      // were advertised this turn, undefined otherwise — this drives the smart
      // loop's defer-gating (undefined => text-parse fallback, [] => no call).
      const toolsAdvertised = visibleTools.length > 0 || deferredTools.length > 0;
      const toolCalls = toolsAdvertised ? (parsed.toolCalls ?? []) : undefined;
      return {
        content: parsed.content,
        model: parsed.model,
        ...(toolCalls !== undefined ? { toolCalls } : {}),
        ...(parsed.disclosedTools?.length
          ? { disclosedTools: parsed.disclosedTools }
          : {}),
      };
    },
  };
}
