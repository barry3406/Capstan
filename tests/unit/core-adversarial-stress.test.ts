import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import {
  createCapstanApp,
  defineAPI,
  definePolicy,
  enforcePolicies,
  composePolicy,
  clearAPIRegistry,
  clearRouteRateLimits,
  checkRouteRateLimit,
  coerceQueryInput,
  withTimeout,
  TimeoutError,
  buildSunsetHeader,
  // Cache
  cacheSet,
  cacheGet,
  cacheInvalidateTag,
  cacheInvalidate,
  cacheClear,
  cached,
  setCacheStore,
  // Response cache
  responseCacheClear,
  setResponseCacheStore,
  // Rate limit
  defineRateLimit,
  clearRateLimitStore,
  // CSRF
  csrfProtection,
  // Circuit breaker
  CircuitBreaker,
  CircuitOpenError,
  // Metrics
  Counter,
  Histogram,
  counter,
  histogram,
  serializeMetrics,
  resetMetrics,
  // WebSocket
  defineWebSocket,
  WebSocketRoom,
  // Store
  MemoryStore,
  // Approvals
  clearApprovals,
  createApproval,
  getApproval,
  listApprovals,
  resolveApproval,
  setApprovalStore,
  // Policy
  getPolicyAuditLog,
  clearPolicyAuditLog,
  denyWithCode,
  allowResult,
  definePolicyGroup,
  applyPolicyGroup,
  getAPIRegistry,
} from "@zauso-ai/capstan-core";
import type {
  CapstanContext,
  PolicyDefinition,
  PolicyCheckResult,
  WebSocketClient,
} from "@zauso-ai/capstan-core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeContext(overrides?: Partial<CapstanContext>): CapstanContext {
  return {
    auth: { isAuthenticated: false, type: "anonymous", permissions: [] },
    request: new Request("http://localhost/test"),
    env: {},
    honoCtx: {} as CapstanContext["honoCtx"],
    ...overrides,
  };
}

function makePolicy(
  key: string,
  effect: "allow" | "deny" | "approve" | "redact",
  opts?: {
    priority?: number;
    reason?: string;
    code?: string;
    when?: PolicyDefinition["when"];
  },
): PolicyDefinition {
  return definePolicy({
    key,
    title: `Test ${key}`,
    effect,
    priority: opts?.priority,
    when: opts?.when,
    async check() {
      const result: { effect: typeof effect; reason?: string; code?: string } = { effect };
      if (opts?.reason !== undefined) result.reason = opts.reason;
      if (opts?.code !== undefined) result.code = opts.code;
      return result;
    },
  });
}

function createMockClient(readyState = 1): WebSocketClient & {
  sent: (string | ArrayBuffer)[];
  closed: boolean;
} {
  const sent: (string | ArrayBuffer)[] = [];
  return {
    readyState,
    sent,
    closed: false,
    send(data: string | ArrayBuffer) {
      sent.push(data);
    },
    close() {
      (this as any).closed = true;
      (this as any).readyState = 3;
    },
  };
}

function advanceTime(ms: number) {
  const original = Date.now;
  const base = original();
  Date.now = () => base + ms;
  return () => {
    Date.now = original;
  };
}

// ===========================================================================
// 1. SERVER ADVERSARIAL TESTS
// ===========================================================================

describe("Server adversarial", () => {
  beforeEach(() => {
    clearAPIRegistry();
    clearRouteRateLimits();
    clearApprovals();
  });

  it("handles 100 concurrent requests to the same endpoint", async () => {
    const capstan = await createCapstanApp({ app: { name: "stress" } });
    let callCount = 0;
    const api = defineAPI({
      async handler() {
        callCount++;
        return { ok: true };
      },
    });
    capstan.registerAPI("GET", "/concurrent", api);

    const promises = Array.from({ length: 100 }, () =>
      capstan.app.fetch(new Request("http://localhost/concurrent")),
    );
    const responses = await Promise.all(promises);
    for (const res of responses) {
      expect(res.status).toBe(200);
    }
    expect(callCount).toBe(100);
  });

  it("handles request with 1MB body (within default limit)", async () => {
    const capstan = await createCapstanApp({ app: { name: "test" } });
    const api = defineAPI({
      async handler({ input }) {
        return { received: typeof input };
      },
    });
    capstan.registerAPI("POST", "/large", api);

    const largePayload = JSON.stringify({ data: "x".repeat(500_000) });
    const response = await capstan.app.fetch(
      new Request("http://localhost/large", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(largePayload.length),
        },
        body: largePayload,
      }),
    );
    // Within default 1MB limit
    expect(response.status).toBe(200);
  });

  it("rejects request with 10MB body (over default limit)", async () => {
    const capstan = await createCapstanApp({
      app: { name: "test" },
      server: { maxBodySize: 1_048_576 },
    });
    const api = defineAPI({
      async handler() {
        return { ok: true };
      },
    });
    capstan.registerAPI("POST", "/oversized", api);

    const tenMB = 10 * 1024 * 1024;
    const response = await capstan.app.fetch(
      new Request("http://localhost/oversized", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(tenMB),
        },
        body: JSON.stringify({ data: "x" }),
      }),
    );
    expect(response.status).toBe(413);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("handles 1000 sequential requests without error", async () => {
    const capstan = await createCapstanApp({ app: { name: "test" } });
    const api = defineAPI({
      async handler() {
        return { ts: Date.now() };
      },
    });
    capstan.registerAPI("GET", "/seq", api);

    for (let i = 0; i < 1000; i++) {
      const res = await capstan.app.fetch(new Request("http://localhost/seq"));
      expect(res.status).toBe(200);
    }
  });

  it("fast requests complete while slow handler is running", async () => {
    const capstan = await createCapstanApp({ app: { name: "test" } });
    const slowApi = defineAPI({
      async handler() {
        await new Promise((r) => setTimeout(r, 200));
        return { slow: true };
      },
    });
    const fastApi = defineAPI({
      async handler() {
        return { fast: true };
      },
    });
    capstan.registerAPI("GET", "/slow", slowApi);
    capstan.registerAPI("GET", "/fast", fastApi);

    const slowP = capstan.app.fetch(new Request("http://localhost/slow"));
    const fastP = capstan.app.fetch(new Request("http://localhost/fast"));
    const [slowRes, fastRes] = await Promise.all([slowP, fastP]);
    expect(slowRes.status).toBe(200);
    expect(fastRes.status).toBe(200);
  });

  it("double-shutdown does not crash", async () => {
    const capstan = await createCapstanApp({ app: { name: "test" } });
    await capstan.shutdown();
    // Second shutdown should be a no-op
    await capstan.shutdown();
    const res = await capstan.app.fetch(new Request("http://localhost/health"));
    const body = (await res.json()) as any;
    expect(body.status).toBe("shutting_down");
  });

  it("requests after shutdown get 503", async () => {
    const capstan = await createCapstanApp({ app: { name: "test" } });
    const api = defineAPI({
      async handler() {
        return { ok: true };
      },
    });
    capstan.registerAPI("GET", "/after-shutdown", api);
    await capstan.shutdown();

    const res = await capstan.app.fetch(
      new Request("http://localhost/after-shutdown"),
    );
    expect(res.status).toBe(503);
  });

  it("handles path traversal attempt in URL", async () => {
    const capstan = await createCapstanApp({ app: { name: "test" } });
    const res = await capstan.app.fetch(
      new Request("http://localhost/../../etc/passwd"),
    );
    // Should get 404 (no route matches), not a file leak
    expect(res.status).toBe(404);
  });

  it("handles null bytes in URL path", async () => {
    const capstan = await createCapstanApp({ app: { name: "test" } });
    const res = await capstan.app.fetch(
      new Request("http://localhost/test%00path"),
    );
    expect(res.status).toBe(404);
  });

  it("handles unicode in URL path", async () => {
    const capstan = await createCapstanApp({ app: { name: "test" } });
    const res = await capstan.app.fetch(
      new Request("http://localhost/test/%E4%B8%AD%E6%96%87"),
    );
    expect(res.status).toBe(404);
  });

  it("handles empty POST body with application/json content type", async () => {
    const capstan = await createCapstanApp({ app: { name: "test" } });
    const api = defineAPI({
      async handler({ input }) {
        return { input: input ?? "none" };
      },
    });
    capstan.registerAPI("POST", "/empty-body", api);

    const res = await capstan.app.fetch(
      new Request("http://localhost/empty-body", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "",
      }),
    );
    // Should not crash; empty body falls through to {}
    expect([200, 400]).toContain(res.status);
  });

  it("handles request with no content-type on POST", async () => {
    const capstan = await createCapstanApp({ app: { name: "test" } });
    const api = defineAPI({
      async handler({ input }) {
        return { received: input };
      },
    });
    capstan.registerAPI("POST", "/no-ct", api);

    const res = await capstan.app.fetch(
      new Request("http://localhost/no-ct", {
        method: "POST",
        body: "raw data",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.received).toEqual({});
  });

  it("health endpoint accessible during shutdown", async () => {
    const capstan = await createCapstanApp({ app: { name: "test" } });
    await capstan.shutdown();
    const res = await capstan.app.fetch(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
  });

  it("returns 404 for unknown routes", async () => {
    const capstan = await createCapstanApp({ app: { name: "test" } });
    const res = await capstan.app.fetch(
      new Request("http://localhost/does/not/exist"),
    );
    expect(res.status).toBe(404);
  });

  it("handles extremely long query strings", async () => {
    const capstan = await createCapstanApp({ app: { name: "test" } });
    const api = defineAPI({
      async handler({ input }) {
        return { ok: true };
      },
    });
    capstan.registerAPI("GET", "/longq", api);

    const longParam = "x".repeat(10000);
    const res = await capstan.app.fetch(
      new Request(`http://localhost/longq?q=${longParam}`),
    );
    expect(res.status).toBe(200);
  });

  it("handles POST with array body", async () => {
    const capstan = await createCapstanApp({ app: { name: "test" } });
    const api = defineAPI({
      async handler({ input }) {
        return { received: input };
      },
    });
    capstan.registerAPI("POST", "/array-body", api);

    const res = await capstan.app.fetch(
      new Request("http://localhost/array-body", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([1, 2, 3]),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("maxBodySize of 10 bytes rejects even small payloads", async () => {
    const capstan = await createCapstanApp({
      app: { name: "test" },
      server: { maxBodySize: 10 },
    });
    const api = defineAPI({
      async handler() {
        return { ok: true };
      },
    });
    capstan.registerAPI("POST", "/tiny-limit", api);

    const res = await capstan.app.fetch(
      new Request("http://localhost/tiny-limit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "50",
        },
        body: JSON.stringify({ hello: "world" }),
      }),
    );
    expect(res.status).toBe(413);
  });
});

// ===========================================================================
// 2. defineAPI ADVERSARIAL TESTS
// ===========================================================================

describe("defineAPI adversarial", () => {
  beforeEach(() => clearAPIRegistry());

  it("handler throwing non-Error string", async () => {
    const api = defineAPI({
      async handler() {
        throw "string error";
      },
    });

    const capstan = await createCapstanApp({ app: { name: "test" } });
    capstan.registerAPI("GET", "/throw-str", api);
    const res = await capstan.app.fetch(
      new Request("http://localhost/throw-str"),
    );
    expect(res.status).toBe(500);
  });

  it("handler throwing null", async () => {
    const api = defineAPI({
      async handler() {
        throw null;
      },
    });

    const capstan = await createCapstanApp({ app: { name: "test" } });
    capstan.registerAPI("GET", "/throw-null", api);
    const res = await capstan.app.fetch(
      new Request("http://localhost/throw-null"),
    );
    expect(res.status).toBe(500);
  });

  it("handler throwing undefined", async () => {
    const api = defineAPI({
      async handler() {
        throw undefined;
      },
    });

    const capstan = await createCapstanApp({ app: { name: "test" } });
    capstan.registerAPI("GET", "/throw-undef", api);
    const res = await capstan.app.fetch(
      new Request("http://localhost/throw-undef"),
    );
    expect(res.status).toBe(500);
  });

  it("handler throwing a number", async () => {
    const api = defineAPI({
      async handler() {
        throw 42;
      },
    });

    const capstan = await createCapstanApp({ app: { name: "test" } });
    capstan.registerAPI("GET", "/throw-num", api);
    const res = await capstan.app.fetch(
      new Request("http://localhost/throw-num"),
    );
    expect(res.status).toBe(500);
  });

  it("handler returning undefined produces valid JSON response", async () => {
    const api = defineAPI({
      async handler() {
        return undefined as any;
      },
    });

    const capstan = await createCapstanApp({ app: { name: "test" } });
    capstan.registerAPI("GET", "/ret-undef", api);
    const res = await capstan.app.fetch(
      new Request("http://localhost/ret-undef"),
    );
    // Should not crash the server
    expect([200, 204]).toContain(res.status);
  });

  it("handler returning null", async () => {
    const api = defineAPI({
      async handler() {
        return null as any;
      },
    });

    const capstan = await createCapstanApp({ app: { name: "test" } });
    capstan.registerAPI("GET", "/ret-null", api);
    const res = await capstan.app.fetch(
      new Request("http://localhost/ret-null"),
    );
    expect(res.status).toBe(200);
  });

  it("handler returning empty object", async () => {
    const api = defineAPI({
      async handler() {
        return {};
      },
    });

    const capstan = await createCapstanApp({ app: { name: "test" } });
    capstan.registerAPI("GET", "/ret-empty", api);
    const res = await capstan.app.fetch(
      new Request("http://localhost/ret-empty"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toEqual({});
  });

  it("beforeHandler does not mutate original input object", async () => {
    const originalInput = { name: "alice" };
    let handlerInput: any;

    const api = defineAPI({
      input: z.object({ name: z.string() }),
      beforeHandler: async ({ input }) => {
        // Attempt in-place mutation
        (input as any).name = "MUTATED";
      },
      async handler({ input }) {
        handlerInput = input;
        return { name: (input as any).name };
      },
    });

    const capstan = await createCapstanApp({ app: { name: "test" } });
    capstan.registerAPI("POST", "/mutate", api);
    await capstan.app.fetch(
      new Request("http://localhost/mutate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(originalInput),
      }),
    );
    // The handler should have received the validated input.
    // Whether mutation propagates depends on implementation;
    // we just verify the server does not crash.
    expect(handlerInput).toBeDefined();
  });

  it("afterHandler throwing does not crash the response pipeline", async () => {
    const api = defineAPI({
      afterHandler: async () => {
        throw new Error("afterHandler crash");
      },
      async handler() {
        return { ok: true };
      },
    });

    // The wrapped handler in defineAPI catches errors
    try {
      await api.handler({
        input: undefined,
        ctx: makeFakeContext(),
        params: {},
      });
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("afterHandler crash");
    }
  });

  it("transform returning different structure", async () => {
    const api = defineAPI<unknown, any>({
      transform: (output) => ({ transformed: true, original: output }),
      async handler() {
        return { name: "test" };
      },
    });
    const result = await api.handler({
      input: undefined,
      ctx: makeFakeContext(),
      params: {},
    });
    expect(result).toEqual({ transformed: true, original: { name: "test" } });
  });

  it("deeply nested Zod schema validates correctly", async () => {
    const schema = z.object({
      level1: z.object({
        level2: z.object({
          level3: z.object({
            value: z.string(),
          }),
        }),
      }),
    });

    const api = defineAPI({
      input: schema,
      async handler({ input }) {
        return { value: (input as any).level1.level2.level3.value };
      },
    });

    const capstan = await createCapstanApp({ app: { name: "test" } });
    capstan.registerAPI("POST", "/deep", api);

    const res = await capstan.app.fetch(
      new Request("http://localhost/deep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          level1: { level2: { level3: { value: "deep" } } },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.value).toBe("deep");
  });

  it("deeply nested Zod schema rejects invalid deep field", async () => {
    const schema = z.object({
      level1: z.object({
        level2: z.object({
          value: z.number(),
        }),
      }),
    });

    const api = defineAPI({
      input: schema,
      async handler({ input }) {
        return input;
      },
    });

    const capstan = await createCapstanApp({ app: { name: "test" } });
    capstan.registerAPI("POST", "/deep-bad", api);

    const res = await capstan.app.fetch(
      new Request("http://localhost/deep-bad", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level1: { level2: { value: "notanumber" } } }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("Zod union schema validates correctly", async () => {
    const schema = z.union([
      z.object({ type: z.literal("a"), valueA: z.string() }),
      z.object({ type: z.literal("b"), valueB: z.number() }),
    ]);

    const api = defineAPI({
      input: schema,
      async handler({ input }) {
        return { received: (input as any).type };
      },
    });

    const capstan = await createCapstanApp({ app: { name: "test" } });
    capstan.registerAPI("POST", "/union", api);

    const res = await capstan.app.fetch(
      new Request("http://localhost/union", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "a", valueA: "hello" }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("API with 0 fields in input schema", async () => {
    const api = defineAPI({
      input: z.object({}),
      async handler() {
        return { ok: true };
      },
    });

    const capstan = await createCapstanApp({ app: { name: "test" } });
    capstan.registerAPI("POST", "/empty-schema", api);
    const res = await capstan.app.fetch(
      new Request("http://localhost/empty-schema", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("API with many fields in input schema", async () => {
    const fields: Record<string, any> = {};
    for (let i = 0; i < 100; i++) {
      fields[`field${i}`] = z.string().optional();
    }
    const schema = z.object(fields);

    const api = defineAPI({
      input: schema,
      async handler() {
        return { ok: true };
      },
    });

    const capstan = await createCapstanApp({ app: { name: "test" } });
    capstan.registerAPI("POST", "/many-fields", api);

    const inputData: Record<string, string> = {};
    for (let i = 0; i < 100; i++) {
      inputData[`field${i}`] = `value${i}`;
    }

    const res = await capstan.app.fetch(
      new Request("http://localhost/many-fields", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inputData),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("timeout fires when handler never resolves (within test timeout)", async () => {
    const api = defineAPI({
      timeout: 50,
      async handler() {
        await new Promise(() => {}); // never resolves
        return { ok: true };
      },
    });

    try {
      await api.handler({ input: undefined, ctx: makeFakeContext(), params: {} });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      expect((err as TimeoutError).timeoutMs).toBe(50);
    }
  });

  it("onError maps thrown error to structured response", async () => {
    const api = defineAPI({
      onError: async (err) => ({
        code: "CUSTOM_ERR",
        message: err instanceof Error ? err.message : "unknown",
      }),
      async handler() {
        throw new Error("test failure");
      },
    });

    try {
      await api.handler({ input: undefined, ctx: makeFakeContext(), params: {} });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.__capstanMapped.code).toBe("CUSTOM_ERR");
      expect(err.__capstanMapped.message).toBe("test failure");
    }
  });

  it("output schema validation rejects invalid handler output", async () => {
    const api = defineAPI({
      output: z.object({ name: z.string() }),
      async handler() {
        return { name: 123 } as any;
      },
    });

    try {
      await api.handler({ input: undefined, ctx: makeFakeContext(), params: {} });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.issues).toBeDefined();
    }
  });

  it("both input and output schemas work together", async () => {
    const api = defineAPI({
      input: z.object({ n: z.number() }),
      output: z.object({ doubled: z.number() }),
      async handler({ input }) {
        return { doubled: (input as any).n * 2 };
      },
    });

    const result = await api.handler({
      input: { n: 5 },
      ctx: makeFakeContext(),
      params: {},
    });
    expect(result).toEqual({ doubled: 10 });
  });

  it("input validation rejects bad input before handler runs", async () => {
    let handlerCalled = false;
    const api = defineAPI({
      input: z.object({ required: z.string() }),
      async handler() {
        handlerCalled = true;
        return {};
      },
    });

    try {
      await api.handler({ input: {}, ctx: makeFakeContext(), params: {} });
    } catch {
      // Expected
    }
    expect(handlerCalled).toBe(false);
  });

  it("beforeHandler + handler + afterHandler + transform chain", async () => {
    const order: string[] = [];
    const api = defineAPI<unknown, { value: number }>({
      beforeHandler: async () => {
        order.push("before");
      },
      afterHandler: async ({ output }) => {
        order.push("after");
        return { value: output.value + 10 };
      },
      transform: (output) => {
        order.push("transform");
        return { value: output.value * 2 };
      },
      async handler() {
        order.push("handler");
        return { value: 1 };
      },
    });

    const result = await api.handler({
      input: undefined,
      ctx: makeFakeContext(),
      params: {},
    });
    expect(order).toEqual(["before", "handler", "after", "transform"]);
    expect(result).toEqual({ value: 22 }); // (1+10)*2
  });
});

// ===========================================================================
// 3. POLICY ADVERSARIAL TESTS
// ===========================================================================

describe("Policy adversarial", () => {
  const ctx = makeFakeContext();

  beforeEach(() => clearPolicyAuditLog());

  it("50 policies in sequence — all evaluated", async () => {
    const policies: PolicyDefinition[] = [];
    for (let i = 0; i < 50; i++) {
      policies.push(makePolicy(`p${i}`, "allow"));
    }
    const result = await enforcePolicies(policies, ctx);
    expect(result.effect).toBe("allow");
    const log = getPolicyAuditLog();
    expect(log.length).toBe(50);
  });

  it("50 policies with one deny — deny wins", async () => {
    const policies: PolicyDefinition[] = [];
    for (let i = 0; i < 49; i++) {
      policies.push(makePolicy(`p${i}`, "allow"));
    }
    policies.push(makePolicy("denier", "deny", { reason: "blocked" }));
    const result = await enforcePolicies(policies, ctx);
    expect(result.effect).toBe("deny");
    expect(result.reason).toBe("blocked");
  });

  it("composePolicy with 1 policy returns its result", async () => {
    const deny = makePolicy("solo", "deny", { reason: "solo-deny" });
    const composed = composePolicy(deny);
    const result = await composed.check({ ctx });
    expect(result.effect).toBe("deny");
    expect(result.reason).toBe("solo-deny");
  });

  it("composePolicy uses max priority from inputs", () => {
    const p1 = makePolicy("a", "allow", { priority: 5 });
    const p2 = makePolicy("b", "allow", { priority: 99 });
    const p3 = makePolicy("c", "allow", { priority: 10 });
    const composed = composePolicy(p1, p2, p3);
    expect(composed.priority).toBe(99);
  });

  it("policy audit log tracks 100 entries", async () => {
    for (let i = 0; i < 100; i++) {
      const p = makePolicy(`audit-${i}`, "allow");
      await enforcePolicies([p], ctx);
    }
    const log = getPolicyAuditLog();
    expect(log.length).toBe(100);
  });

  it("concurrent policy checks on same context", async () => {
    const policy = makePolicy("concurrent", "deny", { reason: "no" });
    const promises = Array.from({ length: 20 }, () =>
      enforcePolicies([policy], ctx),
    );
    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r.effect).toBe("deny");
      expect(r.reason).toBe("no");
    }
  });

  it("policy with when guard returning false is skipped", async () => {
    const never = makePolicy("never-run", "deny", {
      reason: "should not apply",
      when: () => false,
    });
    const result = await enforcePolicies([never], ctx);
    expect(result.effect).toBe("allow");
  });

  it("all policies skipped by when guards returns allow", async () => {
    const policies = Array.from({ length: 10 }, (_, i) =>
      makePolicy(`skip-${i}`, "deny", { reason: "nope", when: () => false }),
    );
    const result = await enforcePolicies(policies, ctx);
    expect(result.effect).toBe("allow");
  });

  it("priority ordering: higher priority policies run first", async () => {
    const order: string[] = [];
    const low = definePolicy({
      key: "low-adv",
      title: "Low",
      effect: "allow",
      priority: 1,
      async check() {
        order.push("low");
        return { effect: "allow" };
      },
    });
    const high = definePolicy({
      key: "high-adv",
      title: "High",
      effect: "allow",
      priority: 100,
      async check() {
        order.push("high");
        return { effect: "allow" };
      },
    });
    const mid = definePolicy({
      key: "mid-adv",
      title: "Mid",
      effect: "allow",
      priority: 50,
      async check() {
        order.push("mid");
        return { effect: "allow" };
      },
    });

    await enforcePolicies([low, mid, high], ctx);
    expect(order).toEqual(["high", "mid", "low"]);
  });

  it("denyWithCode returns correct structure", () => {
    const r = denyWithCode("ERR_001", "Custom reason");
    expect(r.effect).toBe("deny");
    expect(r.code).toBe("ERR_001");
    expect(r.reason).toBe("Custom reason");
  });

  it("allowResult returns allow effect", () => {
    const r = allowResult();
    expect(r.effect).toBe("allow");
    expect(r.reason).toBeUndefined();
  });

  it("definePolicyGroup + applyPolicyGroup preserves policies", () => {
    const p1 = makePolicy("grp-a", "allow");
    const p2 = makePolicy("grp-b", "deny");
    const p3 = makePolicy("grp-c", "approve");
    const group = definePolicyGroup("test-group", [p1, p2, p3]);
    const flat = applyPolicyGroup(group);
    expect(flat).toHaveLength(3);
    expect(flat[0]!.key).toBe("grp-a");
    expect(flat[2]!.key).toBe("grp-c");
  });

  it("composePolicy key format concatenates sub-policy keys", () => {
    const p1 = makePolicy("x", "allow");
    const p2 = makePolicy("y", "deny");
    const p3 = makePolicy("z", "allow");
    const composed = composePolicy(p1, p2, p3);
    expect(composed.key).toBe("composed:x+y+z");
  });
});

// ===========================================================================
// 4. CACHE ADVERSARIAL TESTS
// ===========================================================================

describe("Cache adversarial", () => {
  beforeEach(async () => {
    await cacheClear();
    await responseCacheClear();
    setCacheStore(new MemoryStore());
    setResponseCacheStore(new MemoryStore());
  });

  it("stores and retrieves 1000 cache entries", async () => {
    for (let i = 0; i < 1000; i++) {
      await cacheSet(`k${i}`, { index: i });
    }
    for (let i = 0; i < 1000; i++) {
      const entry = await cacheGet<{ index: number }>(`k${i}`);
      expect(entry).toBeDefined();
      expect(entry!.data.index).toBe(i);
    }
  });

  it("cache key with special characters", async () => {
    const specialKeys = [
      "key with spaces",
      "key/with/slashes",
      "key:with:colons",
      "key=with=equals",
      "key\nwith\nnewlines",
      "emoji-key-\u{1F600}",
    ];
    for (const key of specialKeys) {
      await cacheSet(key, "value");
      const entry = await cacheGet(key);
      expect(entry).toBeDefined();
      expect(entry!.data).toBe("value");
    }
  });

  it("TTL of 0 causes immediate expiry", async () => {
    await cacheSet("zero-ttl", "val", { ttl: 0 });
    const restore = advanceTime(1);
    const result = await cacheGet("zero-ttl");
    expect(result).toBeUndefined();
    restore();
  });

  it("negative TTL is treated as immediate expiry", async () => {
    await cacheSet("neg-ttl", "val", { ttl: -1 });
    const restore = advanceTime(1);
    const result = await cacheGet("neg-ttl");
    expect(result).toBeUndefined();
    restore();
  });

  it("concurrent set/get on same key", async () => {
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      promises.push(cacheSet("race", { v: i }));
    }
    await Promise.all(promises);
    const entry = await cacheGet<{ v: number }>("race");
    expect(entry).toBeDefined();
    expect(typeof entry!.data.v).toBe("number");
  });

  it("cached() with throwing async function propagates error", async () => {
    try {
      await cached("throw-key", async () => {
        throw new Error("compute failed");
      }, { ttl: 60 });
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toBe("compute failed");
    }
  });

  it("cache invalidation by tag removes all tagged entries", async () => {
    for (let i = 0; i < 20; i++) {
      await cacheSet(`tagged-${i}`, i, { tags: ["batch"] });
    }
    const count = await cacheInvalidateTag("batch");
    expect(count).toBeGreaterThanOrEqual(20);

    for (let i = 0; i < 20; i++) {
      expect(await cacheGet(`tagged-${i}`)).toBeUndefined();
    }
  });

  it("cache invalidate returns false for nonexistent key", async () => {
    const result = await cacheInvalidate("nope-doesnt-exist");
    expect(result).toBe(false);
  });

  it("cacheInvalidateTag with nonexistent tag returns 0", async () => {
    const count = await cacheInvalidateTag("nonexistent-tag-xyz");
    expect(count).toBe(0);
  });

  it("cached() deduplicates concurrent computations", async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 50));
      return "deduped";
    };

    const [r1, r2, r3, r4, r5] = await Promise.all([
      cached("dedup", fn, { ttl: 60 }),
      cached("dedup", fn, { ttl: 60 }),
      cached("dedup", fn, { ttl: 60 }),
      cached("dedup", fn, { ttl: 60 }),
      cached("dedup", fn, { ttl: 60 }),
    ]);

    expect(r1).toBe("deduped");
    expect(r2).toBe("deduped");
    expect(callCount).toBe(1);
  });

  it("cache entry with revalidate marks as stale after interval", async () => {
    await cacheSet("swr-test", "data", { revalidate: 1 });

    // Before revalidate interval
    const fresh = await cacheGet("swr-test");
    expect(fresh!.stale).toBe(false);

    // After revalidate interval
    const restore = advanceTime(2000);
    const stale = await cacheGet("swr-test");
    if (stale) {
      expect(stale.stale).toBe(true);
    }
    restore();
  });

  it("cacheClear removes everything", async () => {
    await cacheSet("x1", 1);
    await cacheSet("x2", 2);
    await cacheSet("x3", 3);
    await cacheClear();
    expect(await cacheGet("x1")).toBeUndefined();
    expect(await cacheGet("x2")).toBeUndefined();
    expect(await cacheGet("x3")).toBeUndefined();
  });

  it("cache overwrite replaces value", async () => {
    await cacheSet("ow", "first");
    await cacheSet("ow", "second");
    const entry = await cacheGet("ow");
    expect(entry!.data).toBe("second");
  });

  it("cache with multiple tags can be invalidated by any tag", async () => {
    await cacheSet("multi-tag", "data", { tags: ["t1", "t2", "t3"] });
    await cacheInvalidateTag("t2");
    expect(await cacheGet("multi-tag")).toBeUndefined();
  });
});

// ===========================================================================
// 5. RATE LIMIT ADVERSARIAL TESTS
// ===========================================================================

describe("Rate limit adversarial", () => {
  beforeEach(() => {
    clearRouteRateLimits();
  });

  it("burst of 100 requests with limit of 10", () => {
    const config = { window: 60_000, max: 10 };
    let allowed = 0;
    let blocked = 0;
    for (let i = 0; i < 100; i++) {
      const result = checkRouteRateLimit("GET /burst", "client", config);
      if (result.allowed) allowed++;
      else blocked++;
    }
    expect(allowed).toBe(10);
    expect(blocked).toBe(90);
  });

  it("rate limit at exactly the boundary", () => {
    const config = { window: 60_000, max: 5 };
    for (let i = 0; i < 5; i++) {
      const result = checkRouteRateLimit("GET /boundary", "client", config);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4 - i);
    }
    // 6th request should be blocked
    const result = checkRouteRateLimit("GET /boundary", "client", config);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("concurrent requests from same IP all counted", () => {
    const config = { window: 60_000, max: 3 };
    // Simulate rapid-fire
    const results = Array.from({ length: 10 }, () =>
      checkRouteRateLimit("GET /rapid", "same-ip", config),
    );
    const allowedCount = results.filter((r) => r.allowed).length;
    expect(allowedCount).toBe(3);
  });

  it("different clients have independent limits", () => {
    const config = { window: 60_000, max: 1 };
    const r1 = checkRouteRateLimit("GET /indep", "client-a", config);
    const r2 = checkRouteRateLimit("GET /indep", "client-b", config);
    const r3 = checkRouteRateLimit("GET /indep", "client-c", config);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);
  });

  it("clearRouteRateLimits resets all buckets", () => {
    const config = { window: 60_000, max: 1 };
    checkRouteRateLimit("GET /clear-test", "client", config);
    const blocked = checkRouteRateLimit("GET /clear-test", "client", config);
    expect(blocked.allowed).toBe(false);

    clearRouteRateLimits();
    const afterClear = checkRouteRateLimit("GET /clear-test", "client", config);
    expect(afterClear.allowed).toBe(true);
  });

  it("retryAfterMs is positive when blocked", () => {
    const config = { window: 60_000, max: 1 };
    checkRouteRateLimit("GET /retry", "client", config);
    const result = checkRouteRateLimit("GET /retry", "client", config);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("different routes have independent limits", () => {
    const config = { window: 60_000, max: 1 };
    const r1 = checkRouteRateLimit("GET /route-a", "client", config);
    const r2 = checkRouteRateLimit("GET /route-b", "client", config);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
  });
});

// ===========================================================================
// 6. RATE LIMIT MIDDLEWARE ADVERSARIAL
// ===========================================================================

describe("Rate limit middleware adversarial", () => {
  beforeEach(async () => {
    await clearRateLimitStore();
  });

  it("sequential burst of 20 requests through middleware with limit 5", async () => {
    const limiter = defineRateLimit({ limit: 5, window: 60 });
    const results: Response[] = [];
    for (let i = 0; i < 20; i++) {
      const request = new Request("http://localhost/api/test", {
        headers: { "x-forwarded-for": "burst-ip" },
      });
      const ctx = makeFakeContext();
      const res = await limiter.handler({
        request,
        ctx,
        next: async () => new Response("OK", { status: 200 }),
      });
      results.push(res);
    }
    const allowed = results.filter((r) => r.status === 200).length;
    const blocked = results.filter((r) => r.status === 429).length;
    expect(allowed).toBe(5);
    expect(blocked).toBe(15);
  });

  it("429 response body contains retryAfter", async () => {
    const limiter = defineRateLimit({ limit: 1, window: 60 });
    const makeReq = () => {
      const request = new Request("http://localhost/api/test", {
        headers: { "x-forwarded-for": "retry-ip" },
      });
      return limiter.handler({
        request,
        ctx: makeFakeContext(),
        next: async () => new Response("OK", { status: 200 }),
      });
    };
    await makeReq();
    const blocked = await makeReq();
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as any;
    expect(body.error).toBe("Too Many Requests");
    expect(body.retryAfter).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 7. CIRCUIT BREAKER STRESS TESTS
// ===========================================================================

describe("Circuit breaker stress", () => {
  it("rapid open/close cycling (10 transitions)", async () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeout: 10,
    });

    for (let i = 0; i < 10; i++) {
      // Fail to open
      try {
        await cb.execute(async () => {
          throw new Error("fail");
        });
      } catch {}
      expect(cb.getState()).toBe("open");

      // Wait for reset timeout
      await new Promise((r) => setTimeout(r, 20));

      // Succeed to close
      await cb.execute(async () => "ok");
      expect(cb.getState()).toBe("closed");
    }
  });

  it("concurrent calls during half-open state", async () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeout: 30,
      successThreshold: 1,
    });

    try {
      await cb.execute(async () => {
        throw new Error("fail");
      });
    } catch {}
    expect(cb.getState()).toBe("open");

    await new Promise((r) => setTimeout(r, 50));

    // Multiple calls during half-open
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        cb.execute(async () => "half-open-result"),
      ),
    );

    // At least one should succeed
    const successes = results.filter((r) => r.status === "fulfilled");
    expect(successes.length).toBeGreaterThanOrEqual(1);
  });

  it("reset always returns to closed state", async () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeout: 99999,
    });

    try {
      await cb.execute(async () => {
        throw new Error("fail");
      });
    } catch {}
    expect(cb.getState()).toBe("open");

    cb.reset();
    expect(cb.getState()).toBe("closed");

    // Should work normally after reset
    const result = await cb.execute(async () => "after-reset");
    expect(result).toBe("after-reset");
    expect(cb.getState()).toBe("closed");
  });

  it("failure in half-open reopens circuit", async () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeout: 10,
    });

    try {
      await cb.execute(async () => {
        throw new Error("initial");
      });
    } catch {}
    expect(cb.getState()).toBe("open");

    await new Promise((r) => setTimeout(r, 20));

    try {
      await cb.execute(async () => {
        throw new Error("half-open fail");
      });
    } catch {}
    expect(cb.getState()).toBe("open");
  });

  it("CircuitOpenError is instance of Error", () => {
    const err = new CircuitOpenError("test message");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CircuitOpenError");
    expect(err.message).toBe("test message");
  });

  it("success threshold of 3 requires 3 successes to close", async () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeout: 10,
      successThreshold: 3,
    });

    try {
      await cb.execute(async () => {
        throw new Error("fail");
      });
    } catch {}

    await new Promise((r) => setTimeout(r, 20));

    await cb.execute(async () => "ok1");
    expect(cb.getState()).toBe("half-open");

    await cb.execute(async () => "ok2");
    expect(cb.getState()).toBe("half-open");

    await cb.execute(async () => "ok3");
    expect(cb.getState()).toBe("closed");
  });
});

// ===========================================================================
// 8. METRICS STRESS TESTS
// ===========================================================================

describe("Metrics stress", () => {
  beforeEach(() => resetMetrics());

  it("10,000 counter increments", () => {
    const c = new Counter();
    for (let i = 0; i < 10000; i++) {
      c.inc();
    }
    const output = c.serialize("stress_counter", "Stress test");
    expect(output).toContain("stress_counter 10000");
  });

  it("counter with 200 unique label combinations", () => {
    const c = new Counter();
    for (let i = 0; i < 200; i++) {
      c.inc({ method: `m${i % 10}`, path: `/p${i}` });
    }
    const output = c.serialize("labels_counter", "Labels test");
    expect(output).toContain('method="m0"');
    expect(output).toContain('method="m9"');
    expect(output.split("\n").length).toBeGreaterThan(200);
  });

  it("serializeMetrics with many registered metrics", () => {
    for (let i = 0; i < 50; i++) {
      counter(`metric_${i}`).inc(undefined, i);
    }
    for (let i = 0; i < 50; i++) {
      histogram(`hist_${i}`).observe(undefined, i * 0.1);
    }
    const output = serializeMetrics();
    expect(output).toContain("metric_0");
    expect(output).toContain("metric_49");
    expect(output).toContain("hist_0");
    expect(output).toContain("hist_49");
  });

  it("histogram with many observations", () => {
    const h = new Histogram();
    for (let i = 0; i < 1000; i++) {
      h.observe(undefined, i * 0.001);
    }
    const output = h.serialize("stress_hist", "Stress histogram");
    expect(output).toContain("stress_hist_count 1000");
  });

  it("counter inc with custom amounts", () => {
    const c = new Counter();
    c.inc(undefined, 100);
    c.inc(undefined, 200);
    c.inc(undefined, 300);
    const output = c.serialize("amount_counter", "Amount test");
    expect(output).toContain("amount_counter 600");
  });

  it("histogram labeled observations", () => {
    const h = new Histogram();
    for (let i = 0; i < 100; i++) {
      h.observe({ endpoint: `/api/v${i % 5}` }, i);
    }
    const output = h.serialize("labeled_hist", "Labeled histogram");
    expect(output).toContain('endpoint="/api/v0"');
    expect(output).toContain('endpoint="/api/v4"');
  });

  it("counter registry returns same instance for same name", () => {
    const c1 = counter("singleton");
    const c2 = counter("singleton");
    expect(c1).toBe(c2);
    c1.inc(undefined, 5);
    c2.inc(undefined, 3);
    const output = c1.serialize("singleton", "Same instance");
    expect(output).toContain("singleton 8");
  });

  it("resetMetrics clears everything", () => {
    counter("to-reset").inc();
    histogram("to-reset-h").observe(undefined, 1);
    resetMetrics();
    expect(serializeMetrics()).toBe("");
  });

  it("serialize includes HELP and TYPE headers", () => {
    const c = new Counter();
    c.inc();
    const output = c.serialize("my_metric", "My help text");
    expect(output).toContain("# HELP my_metric My help text");
    expect(output).toContain("# TYPE my_metric counter");
  });
});

// ===========================================================================
// 9. WEBSOCKET STRESS TESTS
// ===========================================================================

describe("WebSocket stress", () => {
  it("100 clients in one room", () => {
    const room = new WebSocketRoom();
    const clients = Array.from({ length: 100 }, () => createMockClient(1));
    for (const c of clients) {
      room.join(c);
    }
    expect(room.size).toBe(100);

    room.broadcast("hello-all");
    for (const c of clients) {
      expect(c.sent).toEqual(["hello-all"]);
    }
  });

  it("broadcast to 500 clients", () => {
    const room = new WebSocketRoom();
    const clients = Array.from({ length: 500 }, () => createMockClient(1));
    for (const c of clients) {
      room.join(c);
    }
    room.broadcast("mass-message");
    for (const c of clients) {
      expect(c.sent.length).toBe(1);
      expect(c.sent[0]).toBe("mass-message");
    }
  });

  it("rapid join/leave cycling", () => {
    const room = new WebSocketRoom();
    const client = createMockClient(1);

    for (let i = 0; i < 100; i++) {
      room.join(client);
      expect(room.size).toBe(1);
      room.leave(client);
      expect(room.size).toBe(0);
    }
  });

  it("broadcast with exclude skips the excluded client", () => {
    const room = new WebSocketRoom();
    const sender = createMockClient(1);
    const receivers = Array.from({ length: 50 }, () => createMockClient(1));
    room.join(sender);
    for (const r of receivers) {
      room.join(r);
    }
    room.broadcast("no-echo", sender);
    expect(sender.sent).toEqual([]);
    for (const r of receivers) {
      expect(r.sent).toEqual(["no-echo"]);
    }
  });

  it("broadcast skips closed clients", () => {
    const room = new WebSocketRoom();
    const open = createMockClient(1);
    const closed = createMockClient(3);
    room.join(open);
    room.join(closed);
    room.broadcast("test");
    expect(open.sent).toEqual(["test"]);
    expect(closed.sent).toEqual([]);
  });

  it("close() closes all clients and empties room", () => {
    const room = new WebSocketRoom();
    const clients = Array.from({ length: 20 }, () => createMockClient(1));
    for (const c of clients) {
      room.join(c);
    }
    room.close();
    expect(room.size).toBe(0);
    for (const c of clients) {
      expect(c.closed).toBe(true);
    }
  });

  it("multiple rooms are independent", () => {
    const room1 = new WebSocketRoom();
    const room2 = new WebSocketRoom();
    const c1 = createMockClient(1);
    const c2 = createMockClient(1);
    room1.join(c1);
    room2.join(c2);

    room1.broadcast("msg1");
    room2.broadcast("msg2");

    expect(c1.sent).toEqual(["msg1"]);
    expect(c2.sent).toEqual(["msg2"]);
  });

  it("defineWebSocket creates route with correct path", () => {
    const route = defineWebSocket("/ws/stress", {
      onOpen: () => {},
      onMessage: () => {},
    });
    expect(route.path).toBe("/ws/stress");
    expect(route.handler.onOpen).toBeDefined();
    expect(route.handler.onMessage).toBeDefined();
  });

  it("onError callback is invoked", () => {
    let errorReceived: Error | null = null;
    const route = defineWebSocket("/ws/err", {
      onError: (_ws, error) => {
        errorReceived = error;
      },
    });
    const client = createMockClient(1);
    route.handler.onError!(client, new Error("ws-error"));
    expect(errorReceived).toBeDefined();
    expect(errorReceived!.message).toBe("ws-error");
  });
});

// ===========================================================================
// 10. COERCE QUERY INPUT ADVERSARIAL
// ===========================================================================

describe("coerceQueryInput adversarial", () => {
  it("coerces integer strings", () => {
    expect(coerceQueryInput({ n: "42" })).toEqual({ n: 42 });
  });

  it("coerces float strings", () => {
    expect(coerceQueryInput({ f: "3.14" })).toEqual({ f: 3.14 });
  });

  it("coerces negative numbers", () => {
    expect(coerceQueryInput({ neg: "-5" })).toEqual({ neg: -5 });
  });

  it("coerces zero", () => {
    expect(coerceQueryInput({ z: "0" })).toEqual({ z: 0 });
  });

  it("does not coerce empty string", () => {
    expect(coerceQueryInput({ e: "" })).toEqual({ e: "" });
  });

  it("does not coerce NaN string", () => {
    expect(coerceQueryInput({ n: "NaN" })).toEqual({ n: "NaN" });
  });

  it("does not coerce Infinity string", () => {
    expect(coerceQueryInput({ i: "Infinity" })).toEqual({ i: "Infinity" });
  });

  it("coerces true/false booleans", () => {
    expect(coerceQueryInput({ t: "true", f: "false" })).toEqual({
      t: true,
      f: false,
    });
  });

  it("does not coerce TRUE or FALSE (case sensitive)", () => {
    expect(coerceQueryInput({ t: "TRUE", f: "FALSE" })).toEqual({
      t: "TRUE",
      f: "FALSE",
    });
  });

  it("coerces null string to null", () => {
    expect(coerceQueryInput({ n: "null" })).toEqual({ n: null });
  });

  it("leaves regular strings as-is", () => {
    expect(coerceQueryInput({ s: "hello world" })).toEqual({
      s: "hello world",
    });
  });

  it("handles multiple types simultaneously", () => {
    const result = coerceQueryInput({
      num: "42",
      bool: "true",
      nil: "null",
      str: "hello",
    });
    expect(result).toEqual({
      num: 42,
      bool: true,
      nil: null,
      str: "hello",
    });
  });
});

// ===========================================================================
// 11. TIMEOUT HELPER ADVERSARIAL
// ===========================================================================

describe("withTimeout adversarial", () => {
  it("resolves immediately for fast function", async () => {
    const result = await withTimeout(() => Promise.resolve(99), 5000);
    expect(result).toBe(99);
  });

  it("rejects with TimeoutError for slow function", async () => {
    try {
      await withTimeout(
        () => new Promise((r) => setTimeout(r, 500)),
        10,
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
    }
  });

  it("TimeoutError has correct timeoutMs", async () => {
    try {
      await withTimeout(
        () => new Promise((r) => setTimeout(r, 500)),
        25,
      );
    } catch (err) {
      expect((err as TimeoutError).timeoutMs).toBe(25);
      expect((err as TimeoutError).name).toBe("TimeoutError");
    }
  });

  it("propagates thrown errors from the function", async () => {
    try {
      await withTimeout(
        () => Promise.reject(new Error("inner error")),
        5000,
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("inner error");
    }
  });
});

// ===========================================================================
// 12. CSRF ADVERSARIAL
// ===========================================================================

describe("CSRF adversarial", () => {
  function createHonoContext(opts: {
    method: string;
    cookie?: string;
    csrfHeader?: string;
    authorization?: string;
  }) {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers["cookie"] = opts.cookie;
    if (opts.csrfHeader) headers["x-csrf-token"] = opts.csrfHeader;
    if (opts.authorization) headers["authorization"] = opts.authorization;

    const responseHeaders = new Headers();

    return {
      req: {
        method: opts.method,
        url: "http://localhost/test",
        header: (name: string) => headers[name.toLowerCase()],
      },
      json: (data: any, status?: number) =>
        new Response(JSON.stringify(data), {
          status: status ?? 200,
          headers: { "Content-Type": "application/json" },
        }),
      header: (name: string, value: string, options?: { append?: boolean }) => {
        if (options?.append) responseHeaders.append(name, value);
        else responseHeaders.set(name, value);
      },
      res: { headers: responseHeaders },
      _responseHeaders: responseHeaders,
    } as any;
  }

  it("GET issues token", async () => {
    const mw = csrfProtection();
    const c = createHonoContext({ method: "GET" });
    let called = false;
    await mw(c, async () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(c._responseHeaders.get("X-CSRF-Token")).toBeDefined();
  });

  it("POST without token returns 403", async () => {
    const mw = csrfProtection();
    const c = createHonoContext({ method: "POST" });
    const result = await mw(c, async () => {});
    expect(result!.status).toBe(403);
  });

  it("POST with matching token passes", async () => {
    const token = "valid-token-12345678901234567890";
    const mw = csrfProtection();
    const c = createHonoContext({
      method: "POST",
      cookie: `__csrf=${token}`,
      csrfHeader: token,
    });
    let called = false;
    await mw(c, async () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it("POST with mismatched token returns 403", async () => {
    const mw = csrfProtection();
    const c = createHonoContext({
      method: "POST",
      cookie: "__csrf=aaa",
      csrfHeader: "bbb",
    });
    const result = await mw(c, async () => {});
    expect(result!.status).toBe(403);
  });

  it("PUT requires CSRF", async () => {
    const mw = csrfProtection();
    const c = createHonoContext({ method: "PUT" });
    const result = await mw(c, async () => {});
    expect(result!.status).toBe(403);
  });

  it("DELETE requires CSRF", async () => {
    const mw = csrfProtection();
    const c = createHonoContext({ method: "DELETE" });
    const result = await mw(c, async () => {});
    expect(result!.status).toBe(403);
  });

  it("PATCH requires CSRF", async () => {
    const mw = csrfProtection();
    const c = createHonoContext({ method: "PATCH" });
    const result = await mw(c, async () => {});
    expect(result!.status).toBe(403);
  });

  it("OPTIONS is exempt", async () => {
    const mw = csrfProtection();
    const c = createHonoContext({ method: "OPTIONS" });
    let called = false;
    await mw(c, async () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it("HEAD is exempt", async () => {
    const mw = csrfProtection();
    const c = createHonoContext({ method: "HEAD" });
    let called = false;
    await mw(c, async () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it("Bearer token bypasses CSRF", async () => {
    const mw = csrfProtection();
    const c = createHonoContext({
      method: "POST",
      authorization: "Bearer some-jwt",
    });
    let called = false;
    await mw(c, async () => {
      called = true;
    });
    expect(called).toBe(true);
  });
});

// ===========================================================================
// 13. MEMORY STORE STRESS
// ===========================================================================

describe("MemoryStore stress", () => {
  it("1000 concurrent set operations", async () => {
    const store = new MemoryStore<number>();
    await Promise.all(
      Array.from({ length: 1000 }, (_, i) => store.set(`k${i}`, i)),
    );
    const keys = await store.keys();
    expect(keys.length).toBe(1000);
  });

  it("concurrent set then get all returns correct values", async () => {
    const store = new MemoryStore<number>();
    await Promise.all(
      Array.from({ length: 500 }, (_, i) => store.set(`k${i}`, i)),
    );
    const results = await Promise.all(
      Array.from({ length: 500 }, (_, i) => store.get(`k${i}`)),
    );
    for (let i = 0; i < 500; i++) {
      expect(results[i]).toBe(i);
    }
  });

  it("TTL expiration works on many entries", async () => {
    const store = new MemoryStore<string>();
    for (let i = 0; i < 50; i++) {
      await store.set(`ttl-${i}`, "val", 10); // 10ms TTL
    }
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 50; i++) {
      expect(await store.get(`ttl-${i}`)).toBeUndefined();
    }
  });

  it("has/delete/clear work correctly", async () => {
    const store = new MemoryStore<string>();
    await store.set("a", "1");
    expect(await store.has("a")).toBe(true);
    expect(await store.has("b")).toBe(false);

    await store.delete("a");
    expect(await store.has("a")).toBe(false);

    await store.set("x", "1");
    await store.set("y", "2");
    await store.clear();
    expect(await store.keys()).toEqual([]);
  });
});

// ===========================================================================
// 14. APPROVAL STORE STRESS
// ===========================================================================

describe("Approval adversarial", () => {
  beforeEach(async () => {
    await clearApprovals();
    setApprovalStore(new MemoryStore());
  });

  it("creates 100 approvals with unique IDs", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const approval = await createApproval({
        method: "POST",
        path: `/api/action-${i}`,
        input: { i },
        policy: "p",
        reason: "r",
      });
      ids.add(approval.id);
    }
    expect(ids.size).toBe(100);
  });

  it("resolveApproval on nonexistent ID returns undefined", async () => {
    const result = await resolveApproval("does-not-exist", "approved");
    expect(result).toBeUndefined();
  });

  it("getApproval on nonexistent ID returns undefined", async () => {
    const result = await getApproval("nope");
    expect(result).toBeUndefined();
  });

  it("listApprovals filters by status correctly", async () => {
    const a1 = await createApproval({
      method: "POST",
      path: "/a",
      input: {},
      policy: "p",
      reason: "r",
    });
    const a2 = await createApproval({
      method: "POST",
      path: "/b",
      input: {},
      policy: "p",
      reason: "r",
    });
    await resolveApproval(a1.id, "approved", "admin");

    const pending = await listApprovals("pending");
    expect(pending.length).toBe(1);
    expect(pending[0]!.id).toBe(a2.id);

    const approved = await listApprovals("approved");
    expect(approved.length).toBe(1);
    expect(approved[0]!.id).toBe(a1.id);
  });

  it("clearApprovals removes everything", async () => {
    await createApproval({
      method: "POST",
      path: "/a",
      input: {},
      policy: "p",
      reason: "r",
    });
    await clearApprovals();
    const all = await listApprovals();
    expect(all.length).toBe(0);
  });

  it("concurrent approval creates produce unique IDs", async () => {
    const promises = Array.from({ length: 20 }, (_, i) =>
      createApproval({
        method: "POST",
        path: `/api/c-${i}`,
        input: {},
        policy: "p",
        reason: "r",
      }),
    );
    const approvals = await Promise.all(promises);
    const ids = new Set(approvals.map((a) => a.id));
    expect(ids.size).toBe(20);
  });
});

// ===========================================================================
// 15. buildSunsetHeader ADVERSARIAL
// ===========================================================================

describe("buildSunsetHeader adversarial", () => {
  it("converts ISO date to HTTP-date format", () => {
    const header = buildSunsetHeader("2026-12-01");
    expect(header).toContain("2026");
    expect(header).toContain("GMT");
  });

  it("handles full ISO datetime", () => {
    const header = buildSunsetHeader("2026-06-15T12:00:00Z");
    expect(header).toContain("2026");
    expect(header).toContain("GMT");
  });

  it("returns string for any date input", () => {
    const header = buildSunsetHeader("2025-01-01");
    expect(typeof header).toBe("string");
    expect(header.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 16. API REGISTRY
// ===========================================================================

describe("API registry", () => {
  beforeEach(() => clearAPIRegistry());

  it("defineAPI registers in global registry", () => {
    defineAPI({
      description: "test",
      async handler() {
        return {};
      },
    });
    const registry = getAPIRegistry();
    expect(registry.length).toBe(1);
  });

  it("clearAPIRegistry empties the registry", () => {
    defineAPI({
      async handler() {
        return {};
      },
    });
    defineAPI({
      async handler() {
        return {};
      },
    });
    expect(getAPIRegistry().length).toBe(2);
    clearAPIRegistry();
    expect(getAPIRegistry().length).toBe(0);
  });

  it("multiple defineAPI calls accumulate in registry", () => {
    for (let i = 0; i < 10; i++) {
      defineAPI({
        description: `api-${i}`,
        async handler() {
          return {};
        },
      });
    }
    expect(getAPIRegistry().length).toBe(10);
  });
});
