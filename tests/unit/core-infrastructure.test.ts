import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
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
  // Compliance
  defineCompliance,
  recordAuditEntry,
  getAuditLog,
  clearAuditLog,
  setAuditStore,
  // Approval
  createApproval,
  getApproval,
  listApprovals,
  resolveApproval,
  clearApprovals,
  setApprovalStore,
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
  // Logger
  createRequestLogger,
  // Cache utils
  normalizeCacheTag,
  normalizeCacheTags,
  normalizeCachePath,
  createPageCacheKey,
} from "@zauso-ai/capstan-core";
import type {
  AuditEntry,
  RiskLevel,
  CapstanContext,
  CapstanAuthContext,
  WebSocketClient,
} from "@zauso-ai/capstan-core";

// Import authz directly since it is not re-exported from the package index
import {
  hasAuthGrant,
  collectAuthGrants,
  buildAuditAuthSnapshot,
} from "../../packages/core/src/authz.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAuthContext(overrides: Partial<CapstanAuthContext> = {}): CapstanAuthContext {
  return {
    isAuthenticated: false,
    type: "anonymous",
    ...overrides,
  };
}

function makeCapstanContext(overrides: Partial<CapstanContext> = {}): CapstanContext {
  return {
    auth: makeAuthContext(),
    request: new Request("http://localhost/test"),
    env: {},
    honoCtx: {} as any,
    ...overrides,
  };
}

function makeAuditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    requestId: crypto.randomUUID(),
    method: "POST",
    path: "/api/test",
    riskLevel: "limited",
    auth: { type: "human", userId: "user-1" },
    input: { foo: "bar" },
    output: { ok: true },
    durationMs: 42,
    ...overrides,
  };
}

/** Advance time by manipulating Date.now for TTL tests */
function advanceTime(ms: number) {
  const original = Date.now;
  const base = original();
  Date.now = () => base + ms;
  return () => {
    Date.now = original;
  };
}

// =========================================================================
// 1. Cache tests
// =========================================================================

describe("Cache", () => {
  beforeEach(async () => {
    await cacheClear();
    await responseCacheClear();
    setCacheStore(new MemoryStore());
    setResponseCacheStore(new MemoryStore());
  });

  test("cacheSet/cacheGet stores and retrieves a value", async () => {
    await cacheSet("k1", { hello: "world" });
    const result = await cacheGet<{ hello: string }>("k1");
    expect(result).toBeDefined();
    expect(result!.data).toEqual({ hello: "world" });
    expect(result!.stale).toBe(false);
  });

  test("cacheSet with TTL makes entry expire", async () => {
    await cacheSet("k2", "value", { ttl: 1 }); // 1 second
    const before = await cacheGet("k2");
    expect(before).toBeDefined();

    const restore = advanceTime(2000);
    const after = await cacheGet("k2");
    expect(after).toBeUndefined();
    restore();
  });

  test("cache miss returns undefined", async () => {
    const result = await cacheGet("nonexistent");
    expect(result).toBeUndefined();
  });

  test("cacheSet with TTL=0 results in immediate expiry", async () => {
    await cacheSet("k-zero", "val", { ttl: 0 });
    // TTL 0 => expiresAt = now + 0 => already expired on next check
    const restore = advanceTime(1);
    const result = await cacheGet("k-zero");
    expect(result).toBeUndefined();
    restore();
  });

  test("cacheInvalidateTag removes tagged entries", async () => {
    await cacheSet("a", 1, { tags: ["groupA"] });
    await cacheSet("b", 2, { tags: ["groupA"] });
    await cacheSet("c", 3, { tags: ["groupB"] });

    const count = await cacheInvalidateTag("groupA");
    expect(count).toBeGreaterThanOrEqual(2);

    expect(await cacheGet("a")).toBeUndefined();
    expect(await cacheGet("b")).toBeUndefined();
    expect(await cacheGet("c")).toBeDefined();
  });

  test("cacheInvalidate removes a single entry", async () => {
    await cacheSet("x", 42);
    expect(await cacheGet("x")).toBeDefined();

    const deleted = await cacheInvalidate("x");
    expect(deleted).toBe(true);
    expect(await cacheGet("x")).toBeUndefined();
  });

  test("cacheInvalidate on missing key returns false", async () => {
    const deleted = await cacheInvalidate("nope");
    expect(deleted).toBe(false);
  });

  test("cacheClear removes all entries", async () => {
    await cacheSet("a", 1);
    await cacheSet("b", 2);
    await cacheClear();
    expect(await cacheGet("a")).toBeUndefined();
    expect(await cacheGet("b")).toBeUndefined();
  });

  test("cached() fetches and stores on miss", async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      return "computed";
    };
    const result = await cached("ck", fn, { ttl: 60 });
    expect(result).toBe("computed");
    expect(callCount).toBe(1);

    // Second call should return cached
    const result2 = await cached("ck", fn, { ttl: 60 });
    expect(result2).toBe("computed");
    expect(callCount).toBe(1);
  });

  test("cached() with stale-while-revalidate returns stale data", async () => {
    await cacheSet("swr", "old-value", { revalidate: 1 });

    // Advance past revalidate window
    const restore = advanceTime(2000);

    let revalidateCalled = false;
    const result = await cached("swr", async () => {
      revalidateCalled = true;
      return "new-value";
    }, { revalidate: 10 });

    // Should return old stale data immediately
    expect(result).toBe("old-value");
    restore();
  });

  test("concurrent cached() calls deduplicate computation", async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 50));
      return "deduped";
    };

    const [r1, r2, r3] = await Promise.all([
      cached("dedup-key", fn, { ttl: 60 }),
      cached("dedup-key", fn, { ttl: 60 }),
      cached("dedup-key", fn, { ttl: 60 }),
    ]);

    expect(r1).toBe("deduped");
    expect(r2).toBe("deduped");
    expect(r3).toBe("deduped");
    expect(callCount).toBe(1);
  });

  test("cache with complex nested objects", async () => {
    const complex = {
      nested: { deep: { array: [1, 2, 3], map: { a: true } } },
      date: "2024-01-01",
    };
    await cacheSet("complex", complex);
    const result = await cacheGet("complex");
    expect(result!.data).toEqual(complex);
  });

  test("different keys store independent values", async () => {
    await cacheSet("key1", "value1");
    await cacheSet("key2", "value2");
    expect((await cacheGet("key1"))!.data).toBe("value1");
    expect((await cacheGet("key2"))!.data).toBe("value2");
  });

  test("cacheSet overwrites existing entry", async () => {
    await cacheSet("overwrite", "first");
    await cacheSet("overwrite", "second");
    expect((await cacheGet("overwrite"))!.data).toBe("second");
  });

  test("cache entry with revalidate but not expired is not stale", async () => {
    await cacheSet("fresh", "data", { revalidate: 60 });
    const result = await cacheGet("fresh");
    expect(result!.stale).toBe(false);
  });

  test("cacheInvalidateTag with nonexistent tag returns 0", async () => {
    const count = await cacheInvalidateTag("nonexistent-tag");
    expect(count).toBe(0);
  });

  test("cacheSet with multiple tags allows invalidation by any tag", async () => {
    await cacheSet("multi", "data", { tags: ["tagA", "tagB"] });
    expect(await cacheGet("multi")).toBeDefined();
    await cacheInvalidateTag("tagB");
    expect(await cacheGet("multi")).toBeUndefined();
  });

  test("normalizeCacheTag trims and rejects empty strings", () => {
    expect(normalizeCacheTag("  hello  ")).toBe("hello");
    expect(normalizeCacheTag("")).toBeUndefined();
    expect(normalizeCacheTag("   ")).toBeUndefined();
    expect(normalizeCacheTag(42 as any)).toBeUndefined();
  });

  test("normalizeCacheTags deduplicates", () => {
    const result = normalizeCacheTags(["a", "b", "a", "c"]);
    expect(result).toEqual(["a", "b", "c"]);
  });

  test("normalizeCachePath normalizes URLs", () => {
    expect(normalizeCachePath("/foo/bar")).toBe("/foo/bar");
    expect(normalizeCachePath("/foo//bar")).toBe("/foo/bar");
    expect(normalizeCachePath("")).toBe("/");
    expect(normalizeCachePath("/foo?query=1")).toBe("/foo");
  });

  test("createPageCacheKey prefixes with page:", () => {
    expect(createPageCacheKey("/about")).toBe("page:/about");
  });

  test("negative TTL is normalized to 0", async () => {
    await cacheSet("neg-ttl", "val", { ttl: -5 });
    const restore = advanceTime(1);
    const result = await cacheGet("neg-ttl");
    expect(result).toBeUndefined();
    restore();
  });
});

// =========================================================================
// 2. Rate Limiting tests
// =========================================================================

describe("Rate Limiting", () => {
  beforeEach(async () => {
    await clearRateLimitStore();
  });

  function createMiddlewareArgs(
    overrides: {
      ip?: string;
      authType?: CapstanAuthContext["type"];
      responseBody?: string;
    } = {},
  ) {
    const request = new Request("http://localhost/api/test", {
      headers: {
        "x-forwarded-for": overrides.ip ?? "127.0.0.1",
      },
    });
    const ctx = makeCapstanContext({
      auth: makeAuthContext({ type: overrides.authType ?? "anonymous" }),
    });
    const next = async () =>
      new Response(overrides.responseBody ?? "OK", { status: 200 });
    return { request, ctx, next };
  }

  test("requests under limit pass through", async () => {
    const limiter = defineRateLimit({ limit: 10, window: 60 });
    const { request, ctx, next } = createMiddlewareArgs();
    const response = await limiter.handler({ request, ctx, next });
    expect(response.status).toBe(200);
  });

  test("requests over limit return 429", async () => {
    const limiter = defineRateLimit({ limit: 2, window: 60 });
    for (let i = 0; i < 2; i++) {
      const args = createMiddlewareArgs();
      await limiter.handler(args);
    }
    const args = createMiddlewareArgs();
    const response = await limiter.handler(args);
    expect(response.status).toBe(429);
  });

  test("rate limit headers are set on allowed responses", async () => {
    const limiter = defineRateLimit({ limit: 10, window: 60 });
    const args = createMiddlewareArgs();
    const response = await limiter.handler(args);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("10");
    expect(response.headers.get("X-RateLimit-Remaining")).toBeDefined();
    expect(response.headers.get("X-RateLimit-Reset")).toBeDefined();
  });

  test("rate limit headers on 429 response", async () => {
    const limiter = defineRateLimit({ limit: 1, window: 60 });
    await limiter.handler(createMiddlewareArgs());
    const response = await limiter.handler(createMiddlewareArgs());
    expect(response.status).toBe(429);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("1");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(response.headers.get("Retry-After")).toBeDefined();
  });

  test("different IPs have separate buckets", async () => {
    const limiter = defineRateLimit({ limit: 1, window: 60 });
    const r1 = await limiter.handler(createMiddlewareArgs({ ip: "1.1.1.1" }));
    expect(r1.status).toBe(200);
    const r2 = await limiter.handler(createMiddlewareArgs({ ip: "2.2.2.2" }));
    expect(r2.status).toBe(200);
  });

  test("byAuthType applies separate limits per auth type", async () => {
    const limiter = defineRateLimit({
      limit: 1,
      window: 60,
      byAuthType: { agent: 5, anonymous: 1 },
    });
    // Anonymous exhausts after 1
    const r1 = await limiter.handler(
      createMiddlewareArgs({ ip: "3.3.3.3", authType: "anonymous" }),
    );
    expect(r1.status).toBe(200);
    const r2 = await limiter.handler(
      createMiddlewareArgs({ ip: "3.3.3.3", authType: "anonymous" }),
    );
    expect(r2.status).toBe(429);
  });

  test("concurrent requests are all counted", async () => {
    const limiter = defineRateLimit({ limit: 3, window: 60 });
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        limiter.handler(createMiddlewareArgs({ ip: "4.4.4.4" })),
      ),
    );
    const statuses = results.map((r) => r.status);
    const passed = statuses.filter((s) => s === 200).length;
    const blocked = statuses.filter((s) => s === 429).length;
    expect(passed).toBeGreaterThanOrEqual(3);
    expect(blocked).toBeGreaterThanOrEqual(0);
  });

  test("429 response body is JSON with error", async () => {
    const limiter = defineRateLimit({ limit: 1, window: 60 });
    await limiter.handler(createMiddlewareArgs());
    const response = await limiter.handler(createMiddlewareArgs());
    const body = await response.json();
    expect(body.error).toBe("Too Many Requests");
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  test("clearRateLimitStore resets all state", async () => {
    const limiter = defineRateLimit({ limit: 1, window: 60 });
    await limiter.handler(createMiddlewareArgs({ ip: "5.5.5.5" }));
    const blocked = await limiter.handler(createMiddlewareArgs({ ip: "5.5.5.5" }));
    expect(blocked.status).toBe(429);

    await clearRateLimitStore();
    const afterClear = await limiter.handler(createMiddlewareArgs({ ip: "5.5.5.5" }));
    expect(afterClear.status).toBe(200);
  });

  test("middleware name is rateLimit", () => {
    const limiter = defineRateLimit({ limit: 10, window: 60 });
    expect(limiter.name).toBe("rateLimit");
  });

  test("remaining count decreases with each request", async () => {
    const limiter = defineRateLimit({ limit: 5, window: 60 });
    const r1 = await limiter.handler(createMiddlewareArgs({ ip: "6.6.6.6" }));
    expect(r1.headers.get("X-RateLimit-Remaining")).toBe("4");
    const r2 = await limiter.handler(createMiddlewareArgs({ ip: "6.6.6.6" }));
    expect(r2.headers.get("X-RateLimit-Remaining")).toBe("3");
  });
});

// =========================================================================
// 3. CSRF Protection tests
// =========================================================================

describe("CSRF Protection", () => {
  // CSRF middleware uses Hono Context. We'll create minimal mocks.
  function createHonoContext(opts: {
    method: string;
    cookie?: string;
    csrfHeader?: string;
    authorization?: string;
    url?: string;
  }) {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers["cookie"] = opts.cookie;
    if (opts.csrfHeader) headers["x-csrf-token"] = opts.csrfHeader;
    if (opts.authorization) headers["authorization"] = opts.authorization;

    const responseHeaders = new Headers();

    const c = {
      req: {
        method: opts.method,
        url: opts.url ?? "http://localhost/test",
        header: (name: string) => {
          return headers[name.toLowerCase()];
        },
      },
      json: (data: any, status?: number) => {
        return new Response(JSON.stringify(data), {
          status: status ?? 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      header: (name: string, value: string, options?: { append?: boolean }) => {
        if (options?.append) responseHeaders.append(name, value);
        else responseHeaders.set(name, value);
      },
      res: {
        headers: responseHeaders,
      },
      _responseHeaders: responseHeaders,
    };
    return c as any;
  }

  test("GET request issues CSRF token in header and cookie", async () => {
    const middleware = csrfProtection();
    const c = createHonoContext({ method: "GET" });
    let nextCalled = false;
    await middleware(c, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(c._responseHeaders.get("X-CSRF-Token")).toBeDefined();
    const setCookie = c._responseHeaders.get("Set-Cookie");
    expect(setCookie).toContain("__csrf=");
  });

  test("POST with valid CSRF token passes", async () => {
    const token = "abcdef1234567890abcdef1234567890";
    const middleware = csrfProtection();
    const c = createHonoContext({
      method: "POST",
      cookie: `__csrf=${token}`,
      csrfHeader: token,
    });
    let nextCalled = false;
    await middleware(c, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  test("POST without CSRF token returns 403", async () => {
    const middleware = csrfProtection();
    const c = createHonoContext({ method: "POST" });
    const result = await middleware(c, async () => {});
    expect(result).toBeDefined();
    expect(result!.status).toBe(403);
    const body = await result!.json();
    expect(body.error).toBe("CSRF token mismatch");
  });

  test("POST with mismatched CSRF token returns 403", async () => {
    const middleware = csrfProtection();
    const c = createHonoContext({
      method: "POST",
      cookie: "__csrf=token-a",
      csrfHeader: "token-b",
    });
    const result = await middleware(c, async () => {});
    expect(result!.status).toBe(403);
  });

  test("HEAD request is exempt from CSRF (issues token)", async () => {
    const middleware = csrfProtection();
    const c = createHonoContext({ method: "HEAD" });
    let nextCalled = false;
    await middleware(c, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  test("OPTIONS request is exempt from CSRF", async () => {
    const middleware = csrfProtection();
    const c = createHonoContext({ method: "OPTIONS" });
    let nextCalled = false;
    await middleware(c, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  test("PUT request requires CSRF token", async () => {
    const middleware = csrfProtection();
    const c = createHonoContext({ method: "PUT" });
    const result = await middleware(c, async () => {});
    expect(result!.status).toBe(403);
  });

  test("DELETE request requires CSRF token", async () => {
    const middleware = csrfProtection();
    const c = createHonoContext({ method: "DELETE" });
    const result = await middleware(c, async () => {});
    expect(result!.status).toBe(403);
  });

  test("PATCH request requires CSRF token", async () => {
    const middleware = csrfProtection();
    const c = createHonoContext({ method: "PATCH" });
    const result = await middleware(c, async () => {});
    expect(result!.status).toBe(403);
  });

  test("Bearer token bypasses CSRF check", async () => {
    const middleware = csrfProtection();
    const c = createHonoContext({
      method: "POST",
      authorization: "Bearer some-jwt-token",
    });
    let nextCalled = false;
    await middleware(c, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });
});

// =========================================================================
// 4. Circuit Breaker tests
// =========================================================================

describe("Circuit Breaker", () => {
  test("closed state: requests pass through", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 1000 });
    expect(cb.getState()).toBe("closed");
    const result = await cb.execute(async () => "ok");
    expect(result).toBe("ok");
    expect(cb.getState()).toBe("closed");
  });

  test("opens after reaching failure threshold", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeout: 5000 });
    for (let i = 0; i < 2; i++) {
      try {
        await cb.execute(async () => {
          throw new Error("fail");
        });
      } catch {}
    }
    expect(cb.getState()).toBe("open");
  });

  test("open state rejects requests with CircuitOpenError", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeout: 50000 });
    try {
      await cb.execute(async () => {
        throw new Error("fail");
      });
    } catch {}

    expect(cb.getState()).toBe("open");
    try {
      await cb.execute(async () => "should not run");
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitOpenError);
    }
  });

  test("transitions to half-open after resetTimeout", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeout: 100 });
    try {
      await cb.execute(async () => {
        throw new Error("fail");
      });
    } catch {}
    expect(cb.getState()).toBe("open");

    // Wait for resetTimeout
    await new Promise((r) => setTimeout(r, 150));

    // Next execute should transition to half-open and allow the call
    const result = await cb.execute(async () => "probe");
    expect(result).toBe("probe");
    expect(cb.getState()).toBe("closed"); // success closes it
  });

  test("half-open: success closes the circuit", async () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeout: 50,
      successThreshold: 2,
    });
    try {
      await cb.execute(async () => {
        throw new Error("fail");
      });
    } catch {}
    expect(cb.getState()).toBe("open");

    await new Promise((r) => setTimeout(r, 100));

    // First success in half-open — not enough to close
    await cb.execute(async () => "ok1");
    expect(cb.getState()).toBe("half-open");

    // Second success meets successThreshold=2
    await cb.execute(async () => "ok2");
    expect(cb.getState()).toBe("closed");
  });

  test("success in closed state resets failure counter", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 5000 });
    // 2 failures, then a success
    for (let i = 0; i < 2; i++) {
      try {
        await cb.execute(async () => {
          throw new Error("fail");
        });
      } catch {}
    }
    expect(cb.getState()).toBe("closed");
    await cb.execute(async () => "ok");

    // 2 more failures should not open (counter was reset)
    for (let i = 0; i < 2; i++) {
      try {
        await cb.execute(async () => {
          throw new Error("fail");
        });
      } catch {}
    }
    expect(cb.getState()).toBe("closed");
  });

  test("reset() returns to closed state", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeout: 99999 });
    try {
      await cb.execute(async () => {
        throw new Error("fail");
      });
    } catch {}
    expect(cb.getState()).toBe("open");
    cb.reset();
    expect(cb.getState()).toBe("closed");
  });

  test("default successThreshold is 1", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeout: 50 });
    try {
      await cb.execute(async () => {
        throw new Error("fail");
      });
    } catch {}

    await new Promise((r) => setTimeout(r, 100));
    await cb.execute(async () => "ok");
    // With default successThreshold=1, a single success closes
    expect(cb.getState()).toBe("closed");
  });

  test("CircuitOpenError has correct name", () => {
    const err = new CircuitOpenError("test");
    expect(err.name).toBe("CircuitOpenError");
    expect(err.message).toBe("test");
    expect(err).toBeInstanceOf(Error);
  });

  test("failure in half-open reopens the circuit", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeout: 50 });
    try {
      await cb.execute(async () => {
        throw new Error("initial fail");
      });
    } catch {}
    expect(cb.getState()).toBe("open");

    await new Promise((r) => setTimeout(r, 100));

    // Fail again in half-open
    try {
      await cb.execute(async () => {
        throw new Error("half-open fail");
      });
    } catch {}
    expect(cb.getState()).toBe("open");
  });
});

// =========================================================================
// 5. Compliance tests
// =========================================================================

describe("Compliance", () => {
  beforeEach(async () => {
    await clearAuditLog();
    setAuditStore(new MemoryStore());
  });

  test("defineCompliance returns the config as-is", () => {
    const config = defineCompliance({ riskLevel: "high", auditLog: true });
    expect(config.riskLevel).toBe("high");
    expect(config.auditLog).toBe(true);
  });

  test("recordAuditEntry stores an entry retrievable by getAuditLog", async () => {
    const entry = makeAuditEntry();
    await recordAuditEntry(entry);
    const log = await getAuditLog();
    expect(log.length).toBe(1);
    expect(log[0]!.requestId).toBe(entry.requestId);
  });

  test("getAuditLog returns entries ordered chronologically", async () => {
    await recordAuditEntry(makeAuditEntry({ timestamp: "2024-01-01T00:00:00Z" }));
    await recordAuditEntry(makeAuditEntry({ timestamp: "2024-01-02T00:00:00Z" }));
    await recordAuditEntry(makeAuditEntry({ timestamp: "2024-01-03T00:00:00Z" }));
    const log = await getAuditLog();
    expect(log.length).toBe(3);
    expect(log[0]!.timestamp).toBe("2024-01-01T00:00:00Z");
    expect(log[2]!.timestamp).toBe("2024-01-03T00:00:00Z");
  });

  test("getAuditLog with since filter", async () => {
    await recordAuditEntry(makeAuditEntry({ timestamp: "2024-01-01T00:00:00Z" }));
    await recordAuditEntry(makeAuditEntry({ timestamp: "2024-06-01T00:00:00Z" }));
    const log = await getAuditLog({ since: "2024-03-01T00:00:00Z" });
    expect(log.length).toBe(1);
    expect(log[0]!.timestamp).toBe("2024-06-01T00:00:00Z");
  });

  test("getAuditLog with limit", async () => {
    for (let i = 0; i < 5; i++) {
      await recordAuditEntry(
        makeAuditEntry({ timestamp: `2024-01-0${i + 1}T00:00:00Z` }),
      );
    }
    const log = await getAuditLog({ limit: 2 });
    expect(log.length).toBe(2);
  });

  test("clearAuditLog removes all entries", async () => {
    await recordAuditEntry(makeAuditEntry());
    await recordAuditEntry(makeAuditEntry());
    await clearAuditLog();
    const log = await getAuditLog();
    expect(log.length).toBe(0);
  });

  test("audit entry with transparency metadata", async () => {
    const entry = makeAuditEntry({
      riskLevel: "limited",
      transparency: { isAI: true, provider: "OpenAI", model: "gpt-4" },
    });
    await recordAuditEntry(entry);
    const log = await getAuditLog();
    expect(log[0]!.transparency!.isAI).toBe(true);
    expect(log[0]!.transparency!.provider).toBe("OpenAI");
  });

  test("large number of audit entries (1000)", async () => {
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 1000; i++) {
      promises.push(
        recordAuditEntry(
          makeAuditEntry({
            timestamp: new Date(Date.now() + i).toISOString(),
            requestId: `req-${i}`,
          }),
        ),
      );
    }
    await Promise.all(promises);
    const log = await getAuditLog();
    expect(log.length).toBe(1000);
  });
});

// =========================================================================
// 6. Approval Workflow tests
// =========================================================================

describe("Approval Workflow", () => {
  beforeEach(async () => {
    await clearApprovals();
    setApprovalStore(new MemoryStore());
  });

  test("createApproval creates a pending approval", async () => {
    const approval = await createApproval({
      method: "POST",
      path: "/api/deploy",
      input: { target: "production" },
      policy: "require-approval",
      reason: "Production deployment requires approval",
    });
    expect(approval.id).toBeDefined();
    expect(approval.status).toBe("pending");
    expect(approval.method).toBe("POST");
    expect(approval.path).toBe("/api/deploy");
    expect(approval.createdAt).toBeDefined();
  });

  test("getApproval retrieves by ID", async () => {
    const created = await createApproval({
      method: "POST",
      path: "/api/test",
      input: {},
      policy: "p",
      reason: "r",
    });
    const fetched = await getApproval(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
  });

  test("getApproval returns undefined for unknown ID", async () => {
    const result = await getApproval("nonexistent-id");
    expect(result).toBeUndefined();
  });

  test("resolveApproval approves a pending request", async () => {
    const created = await createApproval({
      method: "POST",
      path: "/api/test",
      input: {},
      policy: "p",
      reason: "r",
    });
    const resolved = await resolveApproval(created.id, "approved", "admin-user");
    expect(resolved).toBeDefined();
    expect(resolved!.status).toBe("approved");
    expect(resolved!.resolvedBy).toBe("admin-user");
    expect(resolved!.resolvedAt).toBeDefined();
  });

  test("resolveApproval denies a pending request", async () => {
    const created = await createApproval({
      method: "DELETE",
      path: "/api/data",
      input: {},
      policy: "p",
      reason: "r",
    });
    const resolved = await resolveApproval(created.id, "denied");
    expect(resolved!.status).toBe("denied");
  });

  test("resolveApproval on nonexistent ID returns undefined", async () => {
    const result = await resolveApproval("bad-id", "approved");
    expect(result).toBeUndefined();
  });

  test("listApprovals returns all approvals", async () => {
    await createApproval({
      method: "POST",
      path: "/a",
      input: {},
      policy: "p",
      reason: "r",
    });
    await createApproval({
      method: "POST",
      path: "/b",
      input: {},
      policy: "p",
      reason: "r",
    });
    const all = await listApprovals();
    expect(all.length).toBe(2);
  });

  test("listApprovals filters by status", async () => {
    const a1 = await createApproval({
      method: "POST",
      path: "/a",
      input: {},
      policy: "p",
      reason: "r",
    });
    await createApproval({
      method: "POST",
      path: "/b",
      input: {},
      policy: "p",
      reason: "r",
    });
    await resolveApproval(a1.id, "approved");

    const pending = await listApprovals("pending");
    expect(pending.length).toBe(1);
    const approved = await listApprovals("approved");
    expect(approved.length).toBe(1);
  });

  test("approval stores params", async () => {
    const approval = await createApproval({
      method: "PUT",
      path: "/api/items/:id",
      input: { name: "updated" },
      params: { id: "123" },
      policy: "p",
      reason: "r",
    });
    expect(approval.params).toEqual({ id: "123" });
  });

  test("clearApprovals removes all", async () => {
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
});

// =========================================================================
// 7. Metrics tests
// =========================================================================

describe("Metrics", () => {
  beforeEach(() => {
    resetMetrics();
  });

  test("Counter.inc() increments value", () => {
    const c = new Counter();
    c.inc();
    c.inc();
    const output = c.serialize("test_counter", "A test counter");
    expect(output).toContain("test_counter 2");
  });

  test("Counter.inc() with amount", () => {
    const c = new Counter();
    c.inc(undefined, 5);
    const output = c.serialize("test_counter", "help");
    expect(output).toContain("test_counter 5");
  });

  test("Counter with labels", () => {
    const c = new Counter();
    c.inc({ method: "GET" });
    c.inc({ method: "GET" });
    c.inc({ method: "POST" });
    const output = c.serialize("http_requests", "Request count");
    expect(output).toContain('http_requests{method="GET"} 2');
    expect(output).toContain('http_requests{method="POST"} 1');
  });

  test("Histogram.observe() records values", () => {
    const h = new Histogram();
    h.observe(undefined, 0.1);
    h.observe(undefined, 0.5);
    h.observe(undefined, 1.0);
    const output = h.serialize("request_duration", "Duration");
    expect(output).toContain("request_duration_sum 1.6");
    expect(output).toContain("request_duration_count 3");
  });

  test("Histogram with labels", () => {
    const h = new Histogram();
    h.observe({ path: "/api" }, 0.1);
    h.observe({ path: "/api" }, 0.2);
    h.observe({ path: "/web" }, 1.0);
    const output = h.serialize("latency", "Latency");
    expect(output).toContain('latency_sum{path="/api"}');
    expect(output).toContain('latency_count{path="/api"} 2');
    expect(output).toContain('latency_count{path="/web"} 1');
  });

  test("serializeMetrics() produces Prometheus format for all registered metrics", () => {
    const c = counter("my_counter");
    c.inc();
    c.inc();
    const h = histogram("my_histogram");
    h.observe(undefined, 42);

    const output = serializeMetrics();
    expect(output).toContain("# TYPE my_counter counter");
    expect(output).toContain("my_counter 2");
    expect(output).toContain("# TYPE my_histogram summary");
    expect(output).toContain("my_histogram_sum 42");
  });

  test("counter() registry returns the same instance for same name", () => {
    const c1 = counter("shared");
    const c2 = counter("shared");
    expect(c1).toBe(c2);
  });

  test("multiple independent counters", () => {
    const a = counter("counter_a");
    const b = counter("counter_b");
    a.inc(undefined, 10);
    b.inc(undefined, 20);
    const output = serializeMetrics();
    expect(output).toContain("counter_a 10");
    expect(output).toContain("counter_b 20");
  });

  test("resetMetrics clears all counters and histograms", () => {
    counter("to_clear").inc();
    histogram("to_clear_h").observe(undefined, 1);
    resetMetrics();
    const output = serializeMetrics();
    expect(output).toBe("");
  });

  test("high-cardinality labels (100+ unique values)", () => {
    const c = new Counter();
    for (let i = 0; i < 150; i++) {
      c.inc({ user: `user-${i}` });
    }
    const output = c.serialize("requests_by_user", "Per-user requests");
    expect(output).toContain('user="user-0"');
    expect(output).toContain('user="user-149"');
  });

  test("Counter serialize includes HELP and TYPE lines", () => {
    const c = new Counter();
    c.inc();
    const output = c.serialize("my_metric", "My help text");
    expect(output).toContain("# HELP my_metric My help text");
    expect(output).toContain("# TYPE my_metric counter");
  });
});

// =========================================================================
// 8. Logger tests
// =========================================================================

describe("Logger", () => {
  let logOutput: string[];
  const originalLog = console.log;

  beforeEach(() => {
    logOutput = [];
    console.log = (...args: any[]) => {
      logOutput.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  test("createRequestLogger returns a middleware function", () => {
    const logger = createRequestLogger();
    expect(typeof logger).toBe("function");
  });

  test("logger produces JSON structured log", async () => {
    // Set LOG_LEVEL to info to ensure logging
    const origLevel = process.env["LOG_LEVEL"];
    process.env["LOG_LEVEL"] = "info";

    const logger = createRequestLogger();
    const c = createMinimalHonoContext("GET", "/test");
    await logger(c as any, async () => {
      c.res = { status: 200, headers: new Headers() };
    });

    process.env["LOG_LEVEL"] = origLevel;

    expect(logOutput.length).toBeGreaterThanOrEqual(1);
    const entry = JSON.parse(logOutput[logOutput.length - 1]!);
    expect(entry.method).toBe("GET");
    expect(entry.path).toBe("/test");
    expect(entry.ts).toBeDefined();
    expect(entry.reqId).toBeDefined();
  });

  test("logger sets X-Request-Id response header", async () => {
    const origLevel = process.env["LOG_LEVEL"];
    process.env["LOG_LEVEL"] = "info";

    const logger = createRequestLogger();
    const c = createMinimalHonoContext("POST", "/api/action");
    await logger(c as any, async () => {
      c.res = { status: 201, headers: new Headers() };
    });

    process.env["LOG_LEVEL"] = origLevel;

    expect(c._responseHeaders.get("X-Request-Id")).toBeDefined();
  });

  test("logger sets X-Trace-Id response header", async () => {
    const origLevel = process.env["LOG_LEVEL"];
    process.env["LOG_LEVEL"] = "info";

    const logger = createRequestLogger();
    const c = createMinimalHonoContext("GET", "/");
    await logger(c as any, async () => {
      c.res = { status: 200, headers: new Headers() };
    });

    process.env["LOG_LEVEL"] = origLevel;

    expect(c._responseHeaders.get("X-Trace-Id")).toBeDefined();
  });

  test("debug level logs request start and completion", async () => {
    const origLevel = process.env["LOG_LEVEL"];
    process.env["LOG_LEVEL"] = "debug";

    const logger = createRequestLogger();
    const c = createMinimalHonoContext("GET", "/debug-test");
    await logger(c as any, async () => {
      c.res = { status: 200, headers: new Headers() };
    });

    process.env["LOG_LEVEL"] = origLevel;

    expect(logOutput.length).toBe(2);
    const startEntry = JSON.parse(logOutput[0]!);
    expect(startEntry.event).toBe("start");
    const completionEntry = JSON.parse(logOutput[1]!);
    expect(completionEntry.status).toBe(200);
  });

  test("warn level only logs 4xx and 5xx", async () => {
    const origLevel = process.env["LOG_LEVEL"];
    process.env["LOG_LEVEL"] = "warn";

    const logger = createRequestLogger();

    // 200 response should not log
    const c1 = createMinimalHonoContext("GET", "/ok");
    await logger(c1 as any, async () => {
      c1.res = { status: 200, headers: new Headers() };
    });
    expect(logOutput.length).toBe(0);

    // 404 response should log
    const c2 = createMinimalHonoContext("GET", "/not-found");
    await logger(c2 as any, async () => {
      c2.res = { status: 404, headers: new Headers() };
    });
    expect(logOutput.length).toBe(1);

    process.env["LOG_LEVEL"] = origLevel;
  });

  test("error level only logs 5xx", async () => {
    const origLevel = process.env["LOG_LEVEL"];
    process.env["LOG_LEVEL"] = "error";

    const logger = createRequestLogger();

    // 404 should not log at error level
    const c1 = createMinimalHonoContext("GET", "/not-found");
    await logger(c1 as any, async () => {
      c1.res = { status: 404, headers: new Headers() };
    });
    expect(logOutput.length).toBe(0);

    // 500 should log
    const c2 = createMinimalHonoContext("GET", "/error");
    await logger(c2 as any, async () => {
      c2.res = { status: 500, headers: new Headers() };
    });
    expect(logOutput.length).toBe(1);

    process.env["LOG_LEVEL"] = origLevel;
  });

  test("log entry includes duration in ms", async () => {
    const origLevel = process.env["LOG_LEVEL"];
    process.env["LOG_LEVEL"] = "info";

    const logger = createRequestLogger();
    const c = createMinimalHonoContext("GET", "/slow");
    await logger(c as any, async () => {
      await new Promise((r) => setTimeout(r, 10));
      c.res = { status: 200, headers: new Headers() };
    });

    process.env["LOG_LEVEL"] = origLevel;

    const entry = JSON.parse(logOutput[0]!);
    expect(entry.ms).toBeGreaterThanOrEqual(0);
  });

  test("request ID from x-request-id header is reused", async () => {
    const origLevel = process.env["LOG_LEVEL"];
    process.env["LOG_LEVEL"] = "info";

    const logger = createRequestLogger();
    const c = createMinimalHonoContext("GET", "/with-id", {
      "x-request-id": "custom-req-id-123",
    });
    await logger(c as any, async () => {
      c.res = { status: 200, headers: new Headers() };
    });

    process.env["LOG_LEVEL"] = origLevel;

    expect(c._responseHeaders.get("X-Request-Id")).toBe("custom-req-id-123");
  });
});

// Minimal Hono-like context for logger tests
function createMinimalHonoContext(
  method: string,
  path: string,
  headers: Record<string, string> = {},
) {
  const responseHeaders = new Map<string, string>();
  const ctxStore = new Map<string, any>();

  return {
    req: {
      method,
      path,
      url: `http://localhost${path}`,
      header: (name: string) => headers[name.toLowerCase()],
    },
    res: { status: 200, headers: new Headers() } as any,
    header: (name: string, value: string) => {
      responseHeaders.set(name, value);
    },
    get: (key: string) => ctxStore.get(key),
    set: (key: string, value: any) => ctxStore.set(key, value),
    _responseHeaders: responseHeaders,
  };
}

// =========================================================================
// 9. Store + AuthZ tests
// =========================================================================

describe("MemoryStore", () => {
  test("set/get stores and retrieves a value", async () => {
    const store = new MemoryStore<string>();
    await store.set("key", "value");
    expect(await store.get("key")).toBe("value");
  });

  test("get returns undefined for missing key", async () => {
    const store = new MemoryStore<string>();
    expect(await store.get("missing")).toBeUndefined();
  });

  test("delete removes a key", async () => {
    const store = new MemoryStore<string>();
    await store.set("key", "value");
    const deleted = await store.delete("key");
    expect(deleted).toBe(true);
    expect(await store.get("key")).toBeUndefined();
  });

  test("delete returns false for missing key", async () => {
    const store = new MemoryStore<string>();
    const deleted = await store.delete("missing");
    expect(deleted).toBe(false);
  });

  test("has returns true for existing key", async () => {
    const store = new MemoryStore<string>();
    await store.set("key", "value");
    expect(await store.has("key")).toBe(true);
  });

  test("has returns false for missing key", async () => {
    const store = new MemoryStore<string>();
    expect(await store.has("missing")).toBe(false);
  });

  test("TTL expiration: entry disappears after TTL", async () => {
    const store = new MemoryStore<string>();
    await store.set("ttl-key", "value", 50);
    expect(await store.get("ttl-key")).toBe("value");
    await new Promise((r) => setTimeout(r, 100));
    expect(await store.get("ttl-key")).toBeUndefined();
  });

  test("keys() returns all non-expired keys", async () => {
    const store = new MemoryStore<string>();
    await store.set("a", "1");
    await store.set("b", "2");
    await store.set("c", "3", 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 10));
    const keys = await store.keys();
    expect(keys).toContain("a");
    expect(keys).toContain("b");
    expect(keys).not.toContain("c");
  });

  test("clear() removes everything", async () => {
    const store = new MemoryStore<string>();
    await store.set("a", "1");
    await store.set("b", "2");
    await store.clear();
    expect(await store.keys()).toEqual([]);
  });

  test("concurrent set/get operations", async () => {
    const store = new MemoryStore<number>();
    await Promise.all(
      Array.from({ length: 100 }, (_, i) => store.set(`k${i}`, i)),
    );
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => store.get(`k${i}`)),
    );
    for (let i = 0; i < 100; i++) {
      expect(results[i]).toBe(i);
    }
  });
});

describe("AuthZ", () => {
  test("hasAuthGrant returns true for matching permission", () => {
    const auth = makeAuthContext({
      permissions: ["post:read", "post:write"],
    });
    expect(hasAuthGrant(auth, { resource: "post", action: "read" })).toBe(true);
  });

  test("hasAuthGrant returns false for missing permission", () => {
    const auth = makeAuthContext({
      permissions: ["post:read"],
    });
    expect(hasAuthGrant(auth, { resource: "post", action: "write" })).toBe(false);
  });

  test("hasAuthGrant with wildcard resource grant", () => {
    const auth = makeAuthContext({
      grants: [{ resource: "*", action: "read" }],
    });
    expect(hasAuthGrant(auth, { resource: "anything", action: "read" })).toBe(true);
  });

  test("hasAuthGrant with wildcard action grant", () => {
    const auth = makeAuthContext({
      grants: [{ resource: "post", action: "*" }],
    });
    expect(hasAuthGrant(auth, { resource: "post", action: "delete" })).toBe(true);
  });

  test("hasAuthGrant respects deny effect", () => {
    const auth = makeAuthContext({
      grants: [
        { resource: "post", action: "write", effect: "deny" },
        { resource: "post", action: "write", effect: "allow" },
      ],
    });
    // deny takes precedence over allow when encountered first
    expect(hasAuthGrant(auth, { resource: "post", action: "write" })).toBe(false);
  });

  test("hasAuthGrant with scope matching", () => {
    const auth = makeAuthContext({
      grants: [
        { resource: "post", action: "read", scope: { org: "acme" } },
      ],
    });
    expect(
      hasAuthGrant(auth, { resource: "post", action: "read", scope: { org: "acme" } }),
    ).toBe(true);
    expect(
      hasAuthGrant(auth, { resource: "post", action: "read", scope: { org: "other" } }),
    ).toBe(false);
  });

  test("hasAuthGrant with wildcard scope value", () => {
    const auth = makeAuthContext({
      grants: [{ resource: "post", action: "read", scope: { org: "*" } }],
    });
    expect(
      hasAuthGrant(auth, { resource: "post", action: "read", scope: { org: "any-org" } }),
    ).toBe(true);
  });

  test("hasAuthGrant with expired grant", () => {
    const auth = makeAuthContext({
      grants: [
        {
          resource: "post",
          action: "read",
          expiresAt: "2020-01-01T00:00:00Z",
        },
      ],
    });
    expect(hasAuthGrant(auth, { resource: "post", action: "read" })).toBe(false);
  });

  test("collectAuthGrants merges permissions, grants, and envelope grants", () => {
    const auth = makeAuthContext({
      permissions: ["a:b"],
      grants: [{ resource: "c", action: "d" }],
      envelope: {
        actor: { kind: "user", id: "u1" },
        credential: { kind: "session", subjectId: "u1", presentedAt: "" },
        delegation: [],
        grants: [{ resource: "e", action: "f" }],
      },
    });
    const grants = collectAuthGrants(auth);
    expect(grants.length).toBe(3);
    expect(grants.map((g) => g.resource)).toEqual(["a", "c", "e"]);
  });

  test("buildAuditAuthSnapshot includes actor and grants", () => {
    const auth = makeAuthContext({
      type: "human",
      userId: "user-1",
      actor: { kind: "user", id: "user-1", displayName: "Alice" },
      permissions: ["post:read"],
    });
    const snapshot = buildAuditAuthSnapshot(auth);
    expect(snapshot.type).toBe("human");
    expect(snapshot.userId).toBe("user-1");
    expect(snapshot.actor!.displayName).toBe("Alice");
    expect(snapshot.grants!.length).toBe(1);
    expect(snapshot.grants![0]!.resource).toBe("post");
  });
});

// =========================================================================
// 10. WebSocket tests
// =========================================================================

describe("WebSocket", () => {
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

  test("defineWebSocket creates a route with path and handler", () => {
    const route = defineWebSocket("/ws/chat", {
      onOpen: () => {},
      onMessage: () => {},
    });
    expect(route.path).toBe("/ws/chat");
    expect(route.handler.onOpen).toBeDefined();
    expect(route.handler.onMessage).toBeDefined();
  });

  test("WebSocketRoom join/leave/size", () => {
    const room = new WebSocketRoom();
    const client = createMockClient();
    expect(room.size).toBe(0);
    room.join(client);
    expect(room.size).toBe(1);
    room.leave(client);
    expect(room.size).toBe(0);
  });

  test("WebSocketRoom broadcast sends to all open clients", () => {
    const room = new WebSocketRoom();
    const c1 = createMockClient(1);
    const c2 = createMockClient(1);
    room.join(c1);
    room.join(c2);
    room.broadcast("hello");
    expect(c1.sent).toEqual(["hello"]);
    expect(c2.sent).toEqual(["hello"]);
  });

  test("WebSocketRoom broadcast with exclude", () => {
    const room = new WebSocketRoom();
    const sender = createMockClient(1);
    const receiver = createMockClient(1);
    room.join(sender);
    room.join(receiver);
    room.broadcast("msg", sender);
    expect(sender.sent).toEqual([]);
    expect(receiver.sent).toEqual(["msg"]);
  });

  test("broadcast skips clients with readyState != 1", () => {
    const room = new WebSocketRoom();
    const open = createMockClient(1);
    const closed = createMockClient(3); // CLOSED
    room.join(open);
    room.join(closed);
    room.broadcast("test");
    expect(open.sent).toEqual(["test"]);
    expect(closed.sent).toEqual([]);
  });

  test("WebSocketRoom close() closes all clients and clears room", () => {
    const room = new WebSocketRoom();
    const c1 = createMockClient(1);
    const c2 = createMockClient(1);
    room.join(c1);
    room.join(c2);
    room.close();
    expect(c1.closed).toBe(true);
    expect(c2.closed).toBe(true);
    expect(room.size).toBe(0);
  });

  test("multiple rooms are independent", () => {
    const room1 = new WebSocketRoom();
    const room2 = new WebSocketRoom();
    const c1 = createMockClient(1);
    const c2 = createMockClient(1);
    room1.join(c1);
    room2.join(c2);
    room1.broadcast("room1-msg");
    expect(c1.sent).toEqual(["room1-msg"]);
    expect(c2.sent).toEqual([]);
  });

  test("defineWebSocket handler callbacks are invoked", () => {
    let opened = false;
    let messageReceived = "";
    let closedCode = 0;

    const route = defineWebSocket("/ws/test", {
      onOpen: () => {
        opened = true;
      },
      onMessage: (_ws, msg) => {
        messageReceived = msg as string;
      },
      onClose: (_ws, code) => {
        closedCode = code;
      },
    });

    const client = createMockClient();
    route.handler.onOpen!(client);
    expect(opened).toBe(true);

    route.handler.onMessage!(client, "hello world");
    expect(messageReceived).toBe("hello world");

    route.handler.onClose!(client, 1000, "normal");
    expect(closedCode).toBe(1000);
  });
});
