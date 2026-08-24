[English](README.md) | **简体中文** | [繁體中文](README.zh-TW.md)

<div align="center">

<h1>
Capstan
</h1>

**一个框架。人类应用。智能 Agent。零壁垒。**

定义一次应用契约。人类通过浏览器使用它。
AI Agent 通过工具操作它。Agent 在每次运行中持续进化。
无胶水代码。无适配层。无隔阂。

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/tests-full%20suite%20passing-brightgreen?logo=bun&logoColor=white)](https://bun.sh)
[![Version](https://img.shields.io/badge/version-0.3.0-orange)](https://github.com/barry3406/capstan)
[![ESM](https://img.shields.io/badge/ESM-only-blue)](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules)

[演示](#-30-秒体验) · [为什么零壁垒？](#-为什么零壁垒) · [面向人类](#-面向人类--全栈-web) · [面向 Agent](#-面向-agent--智能运行时) · [进化桥梁](#-桥梁--自我进化) · [文档](#-文档)

</div>

---

## 问题在哪里

今天，构建 Web 应用和构建 AI Agent 是两个完全割裂的世界：

- **Web 开发者**写 API、路由、鉴权、策略 — Agent 用不了其中任何一项
- **Agent 开发者**写工具链、提示词、记忆 — 人类无法交互
- **连接二者**需要大量胶水代码、适配器和重复逻辑

结果就是：两套代码库、两套鉴权系统、两组校验规则，再加一层一改就碎的适配层。

**Capstan 彻底消除了这道墙。**

---

## 30 秒体验

```typescript
// 这一个 API 定义同时服务人类和 Agent：
import { defineAPI } from "@zauso-ai/capstan-core";
import { z } from "zod";

export const POST = defineAPI({
  input: z.object({ title: z.string(), priority: z.enum(["low", "medium", "high"]) }),
  output: z.object({ id: z.string(), title: z.string() }),
  description: "Create a ticket",
  capability: "write",
  policy: "requireAuth",
  async handler({ input }) {
    const ticket = await db.insert(tickets).values(input).returning();
    return ticket;
  },
});
// 结果：HTTP 端点 + MCP 工具 + A2A 技能 + OpenAPI 规范 — 全部自动生成
```

```typescript
// 而这个 Agent 可以操作它、从中学习、并变得更聪明：
import { createSmartAgent, defineSkill, SqliteEvolutionStore } from "@zauso-ai/capstan-ai";
import { openaiProvider } from "@zauso-ai/capstan-agent";

const agent = createSmartAgent({
  llm: openaiProvider({ apiKey, baseUrl, model: "gpt-4o" }),
  tools: [readFile, writeFile, runTests, searchCode],
  skills: [
    defineSkill({
      name: "tdd-debug",
      trigger: "when tests fail",
      prompt: "Read failing test -> Read source -> Fix -> Run tests -> Verify",
    }),
  ],
  evolution: {
    store: new SqliteEvolutionStore("./brain.db"),
    capture: "every-run",
    distillation: "post-run",
  },
  tokenBudget: 80_000,
  llmTimeout: { chatTimeoutMs: 120_000 },
});

await agent.run("Fix the login bug and create a ticket for the fix");
// 第 1 次运行：完成任务，记录经验
// 第 10 次运行：已学会策略，修复 bug 更快
// 第 50 次运行：已从自身经验中结晶出可复用的技能
```

同一个框架。同一套鉴权。同一组策略。Agent 操作的就是人类使用的那个应用 — 而且每次运行都变得更聪明。

---

## 为什么零壁垒？

没有任何其他框架能同时跨越 Web 开发和 Agent 开发。它们都逼你选一边站：

| | Next.js / Remix | LangChain / CrewAI | **Capstan** |
|---|---|---|---|
| 构建 Web 应用 | 是 | 否 | **是** |
| 构建 AI Agent | 否 | 是 | **是** |
| Agent 使用你的 API | 需要胶水 | 独立体系 | **自动** |
| 共享鉴权和策略 | 否 | 否 | **同一套规则** |
| Agent 自我进化 | 否 | 否 | **从运行中学习** |
| 一套代码搞定两者 | 否 | 否 | **是** |
| **Web 与 Agent 之间的墙** | **完全隔断** | **完全隔断** | **不存在** |

**Next.js** 给你一个出色的 Web 框架 — 但当你需要 Agent 操作你的应用时，只能自己想办法。**LangChain** 给你一个 Agent 工具箱 — 但它对你的 Web 应用、路由和策略一无所知。

**Capstan** 是唯一一个框架，同一个 `defineAPI()` 调用既创建了 React 前端调用的 HTTP 端点，也创建了 Agent 使用的 MCP 工具。同样的输入校验，同样的鉴权检查，同样的策略执行。零重复。

---

## 面向人类 — 全栈 Web

现代 Web 框架该有的一切，这里都有。区别在于：你在这里定义的一切，Agent 也能自动使用。

### `defineAPI` — 定义一次，处处可用

```typescript
// app/routes/tickets/index.api.ts
import { defineAPI } from "@zauso-ai/capstan-core";
import { z } from "zod";

export const GET = defineAPI({
  input: z.object({
    status: z.enum(["open", "in_progress", "closed", "all"]).optional(),
  }),
  output: z.object({
    tickets: z.array(z.object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
    })),
  }),
  description: "List all tickets",
  capability: "read",
  resource: "ticket",
  async handler({ input, ctx }) {
    const tickets = await db.query.tickets.findMany();
    return { tickets };
  },
});
```

单个文件自动生成：

| 协议 | 你得到的 |
|------|---------|
| REST API | `GET /tickets` JSON 响应 |
| MCP 工具 | `get_tickets` 带类型参数，可供 Claude Desktop 使用 |
| A2A 技能 | `get_tickets` 带 SSE 流式传输，用于 Google Agent-to-Agent |
| OpenAPI | 记录在 `/openapi.json` 中 |

```
                        defineAPI({ ... })
                               |
                      CapabilityRegistry
                               |
                +---------+---------+---------+---------+
                |         |         |         |         |
            HTTP/JSON    MCP      A2A     OpenAPI   Capstan
              API       Tools   Skills     3.1     Manifest
             (Hono)   (stdio/  (Google)   Spec      .json
                       HTTP)
```

运行 `capstan dev` 后，自动生成以下端点：

| 端点 | 协议 | 用途 |
|------|------|------|
| `GET /.well-known/capstan.json` | Capstan | Agent 清单，包含全部能力 |
| `GET /.well-known/agent.json` | A2A | Google Agent-to-Agent agent card |
| `POST /.well-known/a2a` | A2A | JSON-RPC 处理器，SSE 流式传输 |
| `GET /openapi.json` | OpenAPI 3.1 | 完整 API 规范 |
| `POST /.well-known/mcp` | MCP | 远程 MCP 工具访问 |
| `bunx capstan mcp` | MCP (stdio) | 供 Claude Desktop / Cursor 使用 |

### `defineModel` — 声明式数据模型

```typescript
import { defineModel, field } from "@zauso-ai/capstan-db";

export const Ticket = defineModel("ticket", {
  fields: {
    id:          field.id(),
    title:       field.string({ required: true, min: 1, max: 200 }),
    description: field.text(),
    status:      field.enum(["open", "in_progress", "closed"], { default: "open" }),
    priority:    field.enum(["low", "medium", "high"], { default: "medium" }),
    embedding:   field.vector(1536),  // 内置向量搜索
    createdAt:   field.datetime({ default: "now" }),
  },
});
```

执行 `capstan add api tickets`，Capstan 会生成带有 Zod 校验、策略执行和 Agent 元数据的完整类型化 CRUD 路由。

### `definePolicy` — 权限策略

```typescript
import { definePolicy } from "@zauso-ai/capstan-core";

export const requireAuth = definePolicy({
  key: "requireAuth",
  title: "Require Authentication",
  effect: "deny",
  async check({ ctx }) {
    if (!ctx.auth.isAuthenticated) {
      return { effect: "deny", reason: "Authentication required" };
    }
    return { effect: "allow" };
  },
});
```

策略效果：**`allow`** | **`deny`** | **`approve`**（人工审批）| **`redact`**（过滤敏感字段）。无论是人类还是 Agent 发出的请求，都使用同一套策略。

### AI TDD 自循环

`capstan verify --json` 运行 8 步验证级联，专为 AI 编码 Agent 设计：

1. **structure** — 必需文件是否存在
2. **config** — `capstan.config.ts` 是否正确加载
3. **routes** — API 文件是否导出处理器，写入端点是否有策略
4. **models** — 模型定义是否合法
5. **typecheck** — `tsc --noEmit`
6. **contracts** — 模型/路由一致性，策略引用是否有效
7. **manifest** — Agent 清单是否匹配在线路由
8. **protocols** — HTTP/MCP/A2A/OpenAPI 模式一致性

输出包含 `repairChecklist`，带有 `fixCategory` 和 `autoFixable`，供 AI 消费。

### 更多 Web 特性

- **React SSR** — 流式渲染、选择性水合（`full` / `visible` / `none`）、React Server Components 基础
- **向量字段 & RAG** — `field.vector()`、`defineEmbedding`、ORM 内置混合搜索
- **OAuth 提供商** — 内置 `googleProvider()`、`githubProvider()`、`createOAuthHandlers()`
- **DPoP (RFC 9449) & SPIFFE/mTLS** — 持有证明令牌与工作负载身份
- **感知 Token 的限流** — 人类会话与 Agent API Key 分桶
- **OpenTelemetry** — 跨 HTTP、MCP、A2A 的分布式追踪
- **缓存层 + ISR** — `cached()` 装饰器、stale-while-revalidate、按标签失效
- **客户端 SPA 路由** — `<Link>` 预取、View Transitions、滚动恢复
- **WebSocket 支持** — `defineWebSocket()` 实时通信、`WebSocketRoom` 发布/订阅
- **图片 & 字体优化** — 响应式 srcset、模糊占位符、`defineFont()`
- **CSS 管道** — 内置 Lightning CSS、Tailwind v4 自动检测
- **EU AI Act 合规** — `defineCompliance()` 风险等级、审计日志、透明度
- **语义化运维** — 事件、incidents、健康快照持久化到 SQLite，CLI 查看
- **插件系统** — `definePlugin()` 添加路由、策略和中间件
- **部署适配器** — Cloudflare Workers、Vercel（Edge + Node.js）、Fly.io、Docker

---

## 面向 Agent — 智能运行时

`@zauso-ai/capstan-ai` 中的 `createSmartAgent()` 提供了生产级自主 Agent 运行时。不是 LLM 的简单封装 — 而是一个完整的执行环境，具备 13 项工程特性，将玩具演示和真实世界的 Agent 区分开来。

与其他 Agent 框架的关键区别：这些 Agent 可以操作人类使用的同一个 Capstan Web 应用。同一套 API，同一套鉴权，同一组策略 — 无需适配层。

### 1. 响应式 4 层上下文压缩

长时间运行的 Agent 会积累超出模型窗口的上下文。Capstan 逐级压缩：

```
上下文增长 -> snip（丢弃旧工具结果，保留尾部）
           -> microcompact（截断大型工具输出，结果缓存）
           -> autocompact（LLM 驱动的摘要）
           -> reactive compact（context_limit 时紧急压缩）
```

每一层都比上一层更激进。microcompact 结果会被缓存，重复压缩瞬间完成。系统永远不会丢失当前目标和最近的输出。

### 2. 模型降级与 Thinking 剥离

当主模型失败（限流、服务器错误）时，运行时自动用 `fallbackLlm` 重试。降级到不支持扩展思考的模型时，Thinking 块会被自动剥离。无需人工干预 — Agent 持续工作。

### 3. 工具输入校验

每次工具调用在执行前都会被校验：

```
LLM 调用工具 -> JSON Schema 检查 -> 自定义 validate() -> 执行
                     | 失败              | 失败
                结构化错误           结构化错误
                返回给 LLM          返回给 LLM
               （自我修正）         （自我修正）
```

校验失败以反馈形式返回，而非崩溃。LLM 有机会修正自己的参数。

### 4. 单工具超时

每个工具可指定 `timeout`（毫秒）。超时通过 `Promise.race` 取消执行。一个卡住的 `git log` 或失控的 shell 命令不会让 Agent 永远挂起。

### 5. LLM 看门狗

- **会话超时**（默认 120 秒）— LLM 调用时间过长时中断
- **流式空闲超时**（默认 90 秒）— 无 token 到达时断开连接
- **停滞告警**（默认 30 秒）— 检测 LLM 疑似卡住

### 6. Token 预算管理

| 阈值 | 动作 |
|------|------|
| **预算 80%** | 注入提醒消息："接近 token 上限，请收尾" |
| **预算 100%** | 强制完成 Agent，返回部分结果 |

通过 `tokenBudget: number | TokenBudgetConfig` 配置。

### 7. 工具结果预算

大型工具输出（文件内容、搜索结果、日志）自动管理：

- **单结果截断**，限制在 `maxChars`
- **每次迭代聚合上限**（默认 200K 字符）
- **磁盘持久化** — 超大结果写入 `persistDir`，替换为引用
- **`read_persisted_result` 工具** — LLM 按需检索持久化结果

### 8. 错误隐匿与恢复

瞬时工具错误会静默重试一次。如果重试成功，LLM 永远不会看到错误。只有持续性故障才会暴露 — 让 Agent 保持专注。

### 9. 动态上下文与记忆

- **记忆刷新** — 每 5 次迭代防止上下文漂移
- **陈旧度标注** — 标记较老的记忆
- **消息规范化** — API 调用前合并相邻同角色消息
- **作用域记忆** — 通过 `MemoryBackend` 实现（内存或 SQLite）
- **LLM 驱动记忆协调器** — 新事实与所有活跃记忆对比，由模型决定保留、替代、修订或移除（`reconciler: "llm"`）

### 10. 生命周期钩子

```typescript
createSmartAgent({
  hooks: {
    beforeToolCall: async (tool, args) => ({ allowed: true }),
    afterToolCall: async (tool, args, result, status) => { /* 日志 */ },
    afterIteration: async (snapshot) => { /* 检查点 */ },
    onRunComplete: async (result) => { /* 通知 */ },
    getControlState: async (phase, checkpoint) => ({ action: "continue" }),
  },
});
```

### 11. 并发工具执行

标记了 `isConcurrencySafe: true` 的工具在 LLM 发起多个工具调用时并行执行。非安全工具按顺序执行。通过 `streaming.maxConcurrency` 配置。

### 12. 提示词组合

分层提示词系统，支持 `prepend`、`append` 和 `replace_base` 位置。动态层可以根据迭代次数、可用工具和记忆状态注入上下文。

### 13. 渐进式工具披露

大型工具目录会按 schema token 预算从全量内联自动切换为按需发现。
`discover_tools` 只返回紧凑匹配，隐藏工具在成功披露前不能执行。OpenAI
和 Anthropic 的原生工具搜索复用同一套预算与执行门禁；checkpoint 保存只增
不减的可见工具集合。MCP 客户端会拉取完整分页目录，并在工具变更通知后发布
完整快照。详见[渐进式工具披露](docs/progressive-tool-disclosure.md)。

### 技能层

技能是**高级策略** — 不是像工具那样的单个操作，而是解决某一类问题的多步方法。

```typescript
import { defineSkill } from "@zauso-ai/capstan-ai";

const debugSkill = defineSkill({
  name: "tdd-debug",
  trigger: "when tests fail or a bug needs fixing",
  prompt: `
    1. 阅读失败的测试以理解期望行为
    2. 阅读被测源代码
    3. 找出根因
    4. 修复代码
    5. 运行测试验证
  `,
  tools: ["read_file", "write_file", "run_tests"],
});

const refactorSkill = defineSkill({
  name: "safe-refactor",
  trigger: "when refactoring or restructuring code",
  prompt: `
    1. 先运行全部测试建立基线
    2. 每次只做一个结构性修改
    3. 每次修改后运行测试
    4. 测试失败则回退，尝试其他方案
  `,
});
```

**工作原理：**

1. 技能在系统提示词中描述，让模型知道可用的策略
2. 运行时注入一个合成的 `activate_skill` 工具
3. 当模型调用 `activate_skill({ name: "tdd-debug" })` 时，技能的指导作为工具结果返回
4. 模型按照策略使用推荐的工具执行

技能弥合了底层工具使用与高层问题解决之间的鸿沟。它们可以来自开发者（`source: "developer"`），也可以从 Agent 自身经验中自动进化而来（`source: "evolved"`）。

**带代码的技能。** 技能还可以是一个*目录* —— 一个 `SKILL.md`（指导文本）加上随附的脚本/资源 —— 用 `loadSkillsFrom("./skills")` 加载。激活时 Agent 会收到这些随附文件的清单，以及 `read_skill_file` 和 `run_skill_script` 两个工具，用来查看并执行随附代码（`.py`/`.sh`/`.js`/`.ts`），并被沙箱限制在该技能目录内（须先激活、路径锁定、超时 + 输出截断）。这就是 "Agent Skills" 模式 —— 技能携带可执行代码，而不只是指导文本。

> LLM provider 来自 `@zauso-ai/capstan-agent`：`openaiProvider`（Chat Completions）、`anthropicProvider`（Messages）、`responsesProvider`（OpenAI **Responses API** —— 用于 gpt-5.x 等推理模型及 Responses 兼容代理）。

### 持久化 Harness 运行时

需要沙箱、持久化和运维监督的 Agent，可以使用 `createHarness()` 获得完整的持久化执行环境：

- **持久化运行** — 带检查点和事件流
- **浏览器沙箱**（基于 Playwright）— 视觉操作与守卫注册
- **文件系统沙箱** — 隔离文件操作
- **产物记录** — 持久化中间输出
- **任务编排** — shell、workflow、remote 和 subagent 任务，带状态追踪
- **验证钩子** — Agent 运行后的结构化验证
- **可观测性** — 指标、事件与 OpenTelemetry 集成

```typescript
import { createHarness } from "@zauso-ai/capstan-ai";

const harness = createHarness({
  agent: mySmartAgent,
  sandbox: { fs: { root: "./workspace" } },
  verify: [myVerifier],
});

const handle = await harness.start({ goal: "Build the feature" });
const result = await handle.wait();
```

---

## 桥梁 — 自我进化

这是 Capstan 独一无二的部分。Agent 不仅执行任务 — 它从操作应用中**学习**。每一次运行都成为下一次的训练数据。

```
运行完成 -> 记录经验（目标、轨迹、结果、token 消耗）
                    |
                    v
          策略蒸馏（LLM 分析什么有效）
                    |
                    v
          效用评分（+0.1 成功，-0.05 失败）
                    |
                    v
          高效用策略自动晋升为 AgentSkill
                    |
                    v
          Agent 从字面意义上进化出新能力
```

### 经验记录

每次运行产生一条结构化的 `Experience` 记录：调用了哪些工具、什么顺序、什么成功了、什么失败了、token 成本和最终结果。这是学习的原材料。

### 策略蒸馏

运行结束后，`Distiller`（默认通过 `LlmDistiller` 由 LLM 驱动）分析经验并提取可复用的规则 — 比如"修改源码前一定先读测试文件"或"写新代码前先搜索已有实现"。这些成为带有效用分数的 `Strategy` 对象。

### 效用反馈环

策略根据结果积累效用：
- **成功**：效用分数 +0.1
- **失败**：效用分数 -0.05
- 分数限制在 `[0, 1]` 范围

随着时间推移，有效策略浮到顶部，无效策略逐渐淡出。

### 技能结晶

当策略的效用超过晋升阈值时，它会被自动提升为完整的 `AgentSkill` — 成为一等公民技能，出现在系统提示词中，可被模型激活。Agent 从字面意义上从自身经验中进化出新能力。

### 持久化存储

```typescript
import { SqliteEvolutionStore, InMemoryEvolutionStore } from "@zauso-ai/capstan-ai";

// 生产环境：跨会话持久化进化
const store = new SqliteEvolutionStore("./agent-evolution.db");

// 开发/测试：内存存储，不持久化
const store = new InMemoryEvolutionStore();
```

进化配置：

```typescript
createSmartAgent({
  evolution: {
    store: new SqliteEvolutionStore("./agent-brain.db"),
    capture: "every-run",        // 或 "on-failure" | "on-success"
    distillation: "post-run",    // 每次运行后执行蒸馏
  },
});
```

---

## 架构

```
                    你的应用契约
                    (defineAPI + defineModel + definePolicy)
                              |
              +---------------------------------+------------------+
              |               |                 |                  |
          面向人类        面向 Agent         自我进化             验证
         +--------+     +----------+      +------------+     +-----------+
         | HTTP   |     | Smart    |      | Experience |     | 8 步      |
         | React  |     | Agent    |      | Strategy   |     | 级联      |
         | SSR    |     | Runtime  |      | Skill      |     | AI TDD    |
         +--------+     +----------+      +------------+     +-----------+
```

### 项目结构

```
capstan.config.ts           <- 应用配置（数据库、鉴权、Agent 设置）
app/
  routes/
    index.page.tsx          <- React 页面（带 loader 的 SSR）
    index.api.ts            <- API 处理器（导出 GET、POST、PUT、DELETE）
    tickets/
      index.api.ts          <- 文件式路由：/tickets
      [id].api.ts           <- 动态段：/tickets/:id
    _layout.tsx             <- 布局包装器
    _middleware.ts          <- 中间件
  models/
    ticket.model.ts         <- Drizzle ORM + defineModel()
  policies/
    index.ts                <- definePolicy() 权限规则
  public/
    favicon.ico             <- 静态资源（自动服务）
```

**技术栈：** [Hono](https://hono.dev)（HTTP）. [Drizzle](https://orm.drizzle.team)（ORM）. [React](https://react.dev)（SSR）. [Zod](https://zod.dev)（校验）. [OpenTelemetry](https://opentelemetry.io)（追踪）. [Bun](https://bun.sh) 或 Node.js（运行时）

---

## 工程成熟度

`createSmartAgent` 运行时包含 13 项生产特性，这些特性决定了演示与可部署系统之间的差距：

1. **响应式 4 层上下文压缩** — snip、microcompact、autocompact、reactive compact
2. **模型降级与 Thinking 剥离** — 失败时自动切换，对非思考模型剥离 thinking 块
3. **工具输入校验** — JSON Schema + 自定义 `validate()`，错误作为反馈返回以供自我修正
4. **单工具超时** — 毫秒级 `Promise.race` 取消
5. **LLM 看门狗** — 会话超时（120 秒）、流式空闲超时（90 秒）、停滞告警（30 秒）
6. **Token 预算管理** — 80% 提醒、100% 强制完成
7. **工具结果预算** — 单结果截断、聚合上限、磁盘持久化与按需检索
8. **错误隐匿** — 暴露给 LLM 之前静默重试瞬时错误
9. **动态上下文与记忆** — 作用域记忆、陈旧度标注、周期性刷新、LLM 驱动协调器
10. **生命周期钩子** — `beforeToolCall`、`afterToolCall`、`afterIteration`、`onRunComplete`、`getControlState`
11. **并发工具执行** — `isConcurrencySafe` 标志，可配置 `maxConcurrency`
12. **分层提示词组合** — `prepend`、`append`、`replace_base` 与动态层
13. **渐进式工具披露** — schema token 预算、确定性发现、执行隔离、Provider 原生搜索与可恢复目录状态

---

## 包

Capstan 发布 12 个工作空间包：

| 包名 | 描述 |
|------|------|
| `@zauso-ai/capstan-ai` | **智能 Agent 运行时**：`createSmartAgent` 带渐进式工具披露、4 层压缩、模型降级、工具校验/超时、LLM 看门狗、Token 预算、工具结果预算、错误隐匿、生命周期钩子。`defineSkill` 技能层。自我进化引擎含 `SqliteEvolutionStore`。持久化 `createHarness` 含浏览器/文件系统沙箱。另有：`think`/`generate`、作用域记忆、任务编排。 |
| `@zauso-ai/capstan-core` | Hono 服务器、`defineAPI`、`defineMiddleware`、`definePolicy`、审批工作流、8 步验证器 |
| `@zauso-ai/capstan-agent` | `CapabilityRegistry`、MCP 服务器（stdio + Streamable HTTP）、MCP 客户端、A2A 适配器（SSE）、OpenAPI 生成器、LangChain 集成 |
| `@zauso-ai/capstan-db` | Drizzle ORM、`defineModel`、字段/关系辅助函数、迁移、自动 CRUD、向量字段、`defineEmbedding`、混合搜索 |
| `@zauso-ai/capstan-auth` | JWT 会话、API Key 鉴权、OAuth 提供商（Google、GitHub）、DPoP（RFC 9449）、SPIFFE/mTLS、感知 Token 的限流 |
| `@zauso-ai/capstan-router` | 文件式路由（`.page.tsx`、`.api.ts`、`_layout.tsx`、`_middleware.ts`、路由分组） |
| `@zauso-ai/capstan-react` | SSR 含 loader、布局、选择性水合、ISR、`<Link>` SPA 路由、`Image`、`defineFont`、`defineMetadata`、`ErrorBoundary` |
| `@zauso-ai/capstan-cron` | 定时任务调度器：`defineCron`、`createCronRunner`、`createAgentCron` |
| `@zauso-ai/capstan-ops` | 语义化运维：事件、incidents、快照、查询、SQLite 持久化 |
| `@zauso-ai/capstan-dev` | 开发服务器含文件监听、热路由重载、MCP/A2A 端点 |
| `@zauso-ai/capstan-cli` | CLI：`dev`、`build`、`start`、`deploy:init`、`verify`、`ops:*`、`add`、`mcp`、`db:*` |
| `create-capstan-app` | 项目脚手架（`--template blank`、`--template tickets`） |

---

## 快速开始

### "我想构建一个 Web 应用"

```bash
bunx create-capstan-app my-app
cd my-app
bun run dev
```

```bash
# 脚手架生成功能
bunx capstan add model ticket
bunx capstan add api tickets
bunx capstan add page tickets
bunx capstan add policy requireAuth

# 验证一切是否正确连接
bunx capstan verify --json
```

应用已上线，所有协议接口就绪：
- `http://localhost:3000` — Web 应用
- `http://localhost:3000/openapi.json` — OpenAPI 规范
- `http://localhost:3000/.well-known/capstan.json` — Agent 清单
- `http://localhost:3000/.well-known/agent.json` — A2A agent card

### "我想构建一个 AI Agent"

```bash
npm install @zauso-ai/capstan-ai @zauso-ai/capstan-agent
```

```typescript
import { createSmartAgent, defineSkill, SqliteEvolutionStore } from "@zauso-ai/capstan-ai";
import { openaiProvider } from "@zauso-ai/capstan-agent";

const agent = createSmartAgent({
  llm: openaiProvider({ apiKey: process.env.OPENAI_API_KEY!, model: "gpt-4o" }),
  tools: [/* 你的工具 */],
  skills: [
    defineSkill({
      name: "my-strategy",
      trigger: "when the task requires...",
      prompt: "Step 1...\nStep 2...\nStep 3...",
    }),
  ],
  evolution: {
    store: new SqliteEvolutionStore("./agent-brain.db"),
    capture: "every-run",
    distillation: "post-run",
  },
  tokenBudget: 80_000,
});

const result = await agent.run("Your goal here");
console.log(result.status, result.iterations, result.toolCalls.length);
```

### "我两个都要"

构建一个操作你的 Capstan Web 应用的 Agent — 框架同时驱动 Agent 大脑和它所操作的应用。一套代码，零壁垒。

> **Node.js 同样支持：** 将 `bunx` 替换为 `npx`，`bun run` 替换为 `npx`。

---

## 生产部署

```bash
# 生产构建
bunx capstan build

# 针对特定目标构建
bunx capstan build --target node-standalone
bunx capstan build --target docker
bunx capstan build --target vercel-node
bunx capstan build --target vercel-edge
bunx capstan build --target cloudflare
bunx capstan build --target fly

# 启动生产服务器
bunx capstan start
```

---

## 文档

### 在线文档

访问 **[Capstan 文档站](https://capstan.dev)** 获取完整的交互式文档，支持搜索、多语言和 AI Agent 可查询的 MCP 工具。

### 面向编码 Agent 的 MCP 文档服务

文档站暴露 MCP 工具，编码 Agent（Claude Code、Cursor 等）可以用来查询文档：

- **搜索文档** — `GET /api/search?q=createSmartAgent`
- **查询文档** — `GET /api/docs?slug=core-concepts&section=defineAPI`
- **代码示例** — `GET /api/examples?topic=defineSkill`

### Markdown 文档

- [快速开始](docs/getting-started.md) — 安装、首个项目、开发工作流
- [核心概念](docs/core-concepts.md) — `defineAPI`、`defineModel`、`definePolicy`、能力
- [架构](docs/architecture/) — 系统设计、多协议注册、路由扫描
- [鉴权](docs/authentication.md) — JWT 会话、API Key、鉴权类型
- [数据库](docs/database.md) — SQLite、PostgreSQL、MySQL 配置与迁移
- [部署](docs/deployment.md) — `capstan build`、平台目标、`deploy:init`
- [测试策略](docs/testing-strategy.md) — 单元测试、集成测试和验证器测试
- [API 参考](docs/api-reference.md) — 完整 API 接口文档
- [对比](docs/comparison.md) — Capstan vs Next.js、FastAPI 等

---

## 参与贡献

Capstan 处于活跃开发阶段（`v0.3.0`）。欢迎参与贡献！

```bash
git clone https://github.com/barry3406/capstan.git
cd capstan
npm install
npm run build        # 构建所有工作空间包
npm test             # 运行完整测试套件
```

### 约定

- 仅 ESM，导入使用 `.js` 扩展名
- 严格 TypeScript（`exactOptionalPropertyTypes`、`verbatimModuleSyntax`）
- 所有 API 处理器使用 `defineAPI()` 和 Zod schema
- 写入端点必须引用 `policy`

### 需要帮助

- 更多 Agent 工具实现（浏览器自动化、API 客户端）
- 更多进化存储后端（PostgreSQL、Redis）
- 更多脚手架模板（除 `blank` 和 `tickets` 外）
- 更多 OAuth 提供商（除 Google 和 GitHub 外）
- 更多嵌入适配器（Cohere、本地模型）
- 更多部署适配器（AWS Lambda、Deno Deploy）

---

## 许可证

[MIT](LICENSE)

---

**Capstan — Web 开发与 Agent 智能的交汇之处。**
