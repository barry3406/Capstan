[English](README.md) | [简体中文](README.zh-CN.md) | **繁體中文**

<div align="center">

<h1>
Capstan
</h1>

**一個框架。人類應用。智慧 Agent。零壁壘。**

定義一次應用契約。人類透過瀏覽器使用它。
AI Agent 透過工具操作它。Agent 在每次執行中持續進化。
無膠水程式碼。無轉接層。無隔閡。

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/tests-full%20suite%20passing-brightgreen?logo=bun&logoColor=white)](https://bun.sh)
[![Version](https://img.shields.io/badge/version-0.3.0-orange)](https://github.com/barry3406/capstan)
[![ESM](https://img.shields.io/badge/ESM-only-blue)](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules)

[展示](#-30-秒體驗) · [為什麼零壁壘？](#-為什麼零壁壘) · [面向人類](#-面向人類--全端-web) · [面向 Agent](#-面向-agent--智慧執行環境) · [進化橋梁](#-橋梁--自我進化) · [文件](#-文件)

</div>

---

## 問題在哪裡

今天，建構 Web 應用程式和建構 AI Agent 是兩個完全割裂的世界：

- **Web 開發者**寫 API、路由、驗證、策略 — Agent 用不了其中任何一項
- **Agent 開發者**寫工具鏈、提示詞、記憶 — 人類無法互動
- **連接二者**需要大量膠水程式碼、轉接器和重複邏輯

結果就是：兩套程式碼庫、兩套驗證系統、兩組校驗規則，再加一層一改就碎的轉接層。

**Capstan 徹底消除了這道牆。**

---

## 30 秒體驗

```typescript
// 這一個 API 定義同時服務人類和 Agent：
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
// 結果：HTTP 端點 + MCP 工具 + A2A 技能 + OpenAPI 規範 — 全部自動產生
```

```typescript
// 而這個 Agent 可以操作它、從中學習、並變得更聰明：
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
// 第 1 次執行：完成任務，記錄經驗
// 第 10 次執行：已學會策略，修復 bug 更快
// 第 50 次執行：已從自身經驗中結晶出可複用的技能
```

同一個框架。同一套驗證。同一組策略。Agent 操作的就是人類使用的那個應用 — 而且每次執行都變得更聰明。

---

## 為什麼零壁壘？

沒有任何其他框架能同時跨越 Web 開發和 Agent 開發。它們都逼你選一邊站：

| | Next.js / Remix | LangChain / CrewAI | **Capstan** |
|---|---|---|---|
| 建構 Web 應用 | 是 | 否 | **是** |
| 建構 AI Agent | 否 | 是 | **是** |
| Agent 使用你的 API | 需要膠水 | 獨立體系 | **自動** |
| 共享驗證和策略 | 否 | 否 | **同一套規則** |
| Agent 自我進化 | 否 | 否 | **從執行中學習** |
| 一套程式碼搞定兩者 | 否 | 否 | **是** |
| **Web 與 Agent 之間的牆** | **完全隔斷** | **完全隔斷** | **不存在** |

**Next.js** 給你一個出色的 Web 框架 — 但當你需要 Agent 操作你的應用時，只能自己想辦法。**LangChain** 給你一個 Agent 工具箱 — 但它對你的 Web 應用、路由和策略一無所知。

**Capstan** 是唯一一個框架，同一個 `defineAPI()` 呼叫既建立了 React 前端呼叫的 HTTP 端點，也建立了 Agent 使用的 MCP 工具。同樣的輸入校驗，同樣的驗證檢查，同樣的策略執行。零重複。

---

## 面向人類 — 全端 Web

現代 Web 框架該有的一切，這裡都有。區別在於：你在這裡定義的一切，Agent 也能自動使用。

### `defineAPI` — 定義一次，處處可用

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

單一檔案自動產生：

| 協定 | 你得到的 |
|------|---------|
| REST API | `GET /tickets` JSON 回應 |
| MCP 工具 | `get_tickets` 帶型別參數，可供 Claude Desktop 使用 |
| A2A 技能 | `get_tickets` 帶 SSE 串流傳輸，用於 Google Agent-to-Agent |
| OpenAPI | 記錄在 `/openapi.json` 中 |

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

執行 `capstan dev` 後，自動產生以下端點：

| 端點 | 協定 | 用途 |
|------|------|------|
| `GET /.well-known/capstan.json` | Capstan | Agent 清單，包含全部能力 |
| `GET /.well-known/agent.json` | A2A | Google Agent-to-Agent agent card |
| `POST /.well-known/a2a` | A2A | JSON-RPC 處理器，SSE 串流傳輸 |
| `GET /openapi.json` | OpenAPI 3.1 | 完整 API 規範 |
| `POST /.well-known/mcp` | MCP | 遠端 MCP 工具存取 |
| `bunx capstan mcp` | MCP (stdio) | 供 Claude Desktop / Cursor 使用 |

### `defineModel` — 宣告式資料模型

```typescript
import { defineModel, field } from "@zauso-ai/capstan-db";

export const Ticket = defineModel("ticket", {
  fields: {
    id:          field.id(),
    title:       field.string({ required: true, min: 1, max: 200 }),
    description: field.text(),
    status:      field.enum(["open", "in_progress", "closed"], { default: "open" }),
    priority:    field.enum(["low", "medium", "high"], { default: "medium" }),
    embedding:   field.vector(1536),  // 內建向量搜尋
    createdAt:   field.datetime({ default: "now" }),
  },
});
```

執行 `capstan add api tickets`，Capstan 會產生帶有 Zod 校驗、策略執行和 Agent 中繼資料的完整型別化 CRUD 路由。

### `definePolicy` — 權限策略

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

策略效果：**`allow`** | **`deny`** | **`approve`**（人工審批）| **`redact`**（過濾敏感欄位）。無論是人類還是 Agent 發出的請求，都使用同一套策略。

### AI TDD 自迴圈

`capstan verify --json` 執行 8 步驗證級聯，專為 AI 編碼 Agent 設計：

1. **structure** — 必要檔案是否存在
2. **config** — `capstan.config.ts` 是否正確載入
3. **routes** — API 檔案是否匯出處理器，寫入端點是否有策略
4. **models** — 模型定義是否合法
5. **typecheck** — `tsc --noEmit`
6. **contracts** — 模型/路由一致性，策略引用是否有效
7. **manifest** — Agent 清單是否匹配線上路由
8. **protocols** — HTTP/MCP/A2A/OpenAPI 模式一致性

輸出包含 `repairChecklist`，帶有 `fixCategory` 和 `autoFixable`，供 AI 消費。

### 更多 Web 特性

- **React SSR** — 串流渲染、選擇性水合（`full` / `visible` / `none`）、React Server Components 基礎
- **向量欄位 & RAG** — `field.vector()`、`defineEmbedding`、ORM 內建混合搜尋
- **OAuth 提供者** — 內建 `googleProvider()`、`githubProvider()`、`createOAuthHandlers()`
- **DPoP (RFC 9449) & SPIFFE/mTLS** — 持有證明權杖與工作負載身分
- **感知 Token 的限流** — 人類工作階段與 Agent API Key 分桶
- **OpenTelemetry** — 跨 HTTP、MCP、A2A 的分散式追蹤
- **快取層 + ISR** — `cached()` 裝飾器、stale-while-revalidate、按標籤失效
- **客戶端 SPA 路由** — `<Link>` 預取、View Transitions、捲動恢復
- **WebSocket 支援** — `defineWebSocket()` 即時通訊、`WebSocketRoom` 發布/訂閱
- **圖片 & 字型最佳化** — 響應式 srcset、模糊佔位符、`defineFont()`
- **CSS 管線** — 內建 Lightning CSS、Tailwind v4 自動偵測
- **EU AI Act 合規** — `defineCompliance()` 風險等級、稽核日誌、透明度
- **語意化維運** — 事件、incidents、健康快照持久化到 SQLite，CLI 檢視
- **外掛系統** — `definePlugin()` 新增路由、策略和中介軟體
- **部署轉接器** — Cloudflare Workers、Vercel（Edge + Node.js）、Fly.io、Docker

---

## 面向 Agent — 智慧執行環境

`@zauso-ai/capstan-ai` 中的 `createSmartAgent()` 提供了生產級自主 Agent 執行環境。不是 LLM 的簡單封裝 — 而是一個完整的執行環境，具備 13 項工程特性，將玩具展示和真實世界的 Agent 區分開來。

與其他 Agent 框架的關鍵區別：這些 Agent 可以操作人類使用的同一個 Capstan Web 應用。同一套 API，同一套驗證，同一組策略 — 無需轉接層。

### 1. 響應式 4 層上下文壓縮

長時間執行的 Agent 會累積超出模型視窗的上下文。Capstan 逐級壓縮：

```
上下文增長 -> snip（丟棄舊工具結果，保留尾部）
           -> microcompact（截斷大型工具輸出，結果快取）
           -> autocompact（LLM 驅動的摘要）
           -> reactive compact（context_limit 時緊急壓縮）
```

每一層都比上一層更激進。microcompact 結果會被快取，重複壓縮瞬間完成。系統永遠不會遺失當前目標和最近的輸出。

### 2. 模型降級與 Thinking 剝離

當主模型失敗（限流、伺服器錯誤）時，執行環境自動用 `fallbackLlm` 重試。降級到不支援延伸思考的模型時，Thinking 區塊會被自動剝離。無需人工介入 — Agent 持續運作。

### 3. 工具輸入校驗

每次工具呼叫在執行前都會被校驗：

```
LLM 呼叫工具 -> JSON Schema 檢查 -> 自訂 validate() -> 執行
                     | 失敗              | 失敗
                結構化錯誤           結構化錯誤
                回傳給 LLM          回傳給 LLM
               （自我修正）         （自我修正）
```

校驗失敗以回饋形式回傳，而非崩潰。LLM 有機會修正自己的參數。

### 4. 單工具逾時

每個工具可指定 `timeout`（毫秒）。逾時透過 `Promise.race` 取消執行。一個卡住的 `git log` 或失控的 shell 指令不會讓 Agent 永遠掛起。

### 5. LLM 看門狗

- **對話逾時**（預設 120 秒）— LLM 呼叫時間過長時中斷
- **串流閒置逾時**（預設 90 秒）— 無 token 到達時斷開連線
- **停滯告警**（預設 30 秒）— 偵測 LLM 疑似卡住

### 6. Token 預算管理

| 閾值 | 動作 |
|------|------|
| **預算 80%** | 注入提醒訊息：「接近 token 上限，請收尾」 |
| **預算 100%** | 強制完成 Agent，回傳部分結果 |

透過 `tokenBudget: number | TokenBudgetConfig` 設定。

### 7. 工具結果預算

大型工具輸出（檔案內容、搜尋結果、日誌）自動管理：

- **單結果截斷**，限制在 `maxChars`
- **每次迭代聚合上限**（預設 200K 字元）
- **磁碟持久化** — 超大結果寫入 `persistDir`，替換為參考
- **`read_persisted_result` 工具** — LLM 按需擷取持久化結果

### 8. 錯誤隱匿與恢復

暫態工具錯誤會靜默重試一次。如果重試成功，LLM 永遠不會看到錯誤。只有持續性故障才會暴露 — 讓 Agent 保持專注。

### 9. 動態上下文與記憶

- **記憶重新整理** — 每 5 次迭代防止上下文漂移
- **陳舊度標註** — 標記較老的記憶
- **訊息正規化** — API 呼叫前合併相鄰同角色訊息
- **作用域記憶** — 透過 `MemoryBackend` 實作（記憶體或 SQLite）
- **LLM 驅動記憶協調器** — 新事實與所有活躍記憶比對，由模型決定保留、替代、修訂或移除（`reconciler: "llm"`）

### 10. 生命週期掛鉤

```typescript
createSmartAgent({
  hooks: {
    beforeToolCall: async (tool, args) => ({ allowed: true }),
    afterToolCall: async (tool, args, result, status) => { /* 記錄 */ },
    afterIteration: async (snapshot) => { /* 檢查點 */ },
    onRunComplete: async (result) => { /* 通知 */ },
    getControlState: async (phase, checkpoint) => ({ action: "continue" }),
  },
});
```

### 11. 並行工具執行

標記了 `isConcurrencySafe: true` 的工具在 LLM 發起多個工具呼叫時並行執行。非安全工具按順序執行。透過 `streaming.maxConcurrency` 設定。

### 12. 提示詞組合

分層提示詞系統，支援 `prepend`、`append` 和 `replace_base` 位置。動態層可以根據迭代次數、可用工具和記憶狀態注入上下文。

### 13. 漸進式工具揭露

大型工具目錄會按 schema token 預算從全量內嵌自動切換為按需探索。
`discover_tools` 只回傳精簡配對，隱藏工具在成功揭露前不能執行。OpenAI
和 Anthropic 的原生工具搜尋共用同一套預算與執行閘門；checkpoint 保存只增
不減的可見工具集合。MCP 用戶端會拉取完整分頁目錄，並在工具變更通知後發布
完整快照。詳見[漸進式工具揭露](docs/progressive-tool-disclosure.md)。

### 技能層

技能是**高階策略** — 不是像工具那樣的單個操作，而是解決某一類問題的多步驟方法。

```typescript
import { defineSkill } from "@zauso-ai/capstan-ai";

const debugSkill = defineSkill({
  name: "tdd-debug",
  trigger: "when tests fail or a bug needs fixing",
  prompt: `
    1. 閱讀失敗的測試以理解預期行為
    2. 閱讀被測原始碼
    3. 找出根因
    4. 修復程式碼
    5. 執行測試驗證
  `,
  tools: ["read_file", "write_file", "run_tests"],
});

const refactorSkill = defineSkill({
  name: "safe-refactor",
  trigger: "when refactoring or restructuring code",
  prompt: `
    1. 先執行全部測試建立基線
    2. 每次只做一個結構性修改
    3. 每次修改後執行測試
    4. 測試失敗則回退，嘗試其他方案
  `,
});
```

**運作原理：**

1. 技能在系統提示詞中描述，讓模型知道可用的策略
2. 執行環境注入一個合成的 `activate_skill` 工具
3. 當模型呼叫 `activate_skill({ name: "tdd-debug" })` 時，技能的指引作為工具結果回傳
4. 模型按照策略使用建議的工具執行

技能彌合了底層工具使用與高層問題解決之間的鴻溝。它們可以來自開發者（`source: "developer"`），也可以從 Agent 自身經驗中自動進化而來（`source: "evolved"`）。

**帶程式碼的技能。** 技能還可以是一個*目錄* —— 一個 `SKILL.md`（指引文字）加上隨附的腳本/資源 —— 用 `loadSkillsFrom("./skills")` 載入。啟用時 Agent 會收到這些隨附檔案的清單，以及 `read_skill_file` 和 `run_skill_script` 兩個工具，用來檢視並執行隨附程式碼（`.py`/`.sh`/`.js`/`.ts`），並被沙箱限制在該技能目錄內（須先啟用、路徑鎖定、逾時 + 輸出截斷）。這就是 "Agent Skills" 模式 —— 技能攜帶可執行程式碼，而不只是指引文字。

> LLM provider 來自 `@zauso-ai/capstan-agent`：`openaiProvider`（Chat Completions）、`anthropicProvider`（Messages）、`responsesProvider`（OpenAI **Responses API** —— 用於 gpt-5.x 等推理模型及 Responses 相容代理）。

### 持久化 Harness 執行環境

需要沙箱、持久化和維運監督的 Agent，可以使用 `createHarness()` 取得完整的持久化執行環境：

- **持久化執行** — 帶檢查點和事件串流
- **瀏覽器沙箱**（基於 Playwright）— 視覺操作與守衛註冊
- **檔案系統沙箱** — 隔離檔案操作
- **產物記錄** — 持久化中間輸出
- **任務編排** — shell、workflow、remote 和 subagent 任務，帶狀態追蹤
- **驗證掛鉤** — Agent 執行後的結構化驗證
- **可觀測性** — 指標、事件與 OpenTelemetry 整合

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

## 橋梁 — 自我進化

這是 Capstan 獨一無二的部分。Agent 不僅執行任務 — 它從操作應用中**學習**。每一次執行都成為下一次的訓練資料。

```
執行完成 -> 記錄經驗（目標、軌跡、結果、token 消耗）
                    |
                    v
          策略蒸餾（LLM 分析什麼有效）
                    |
                    v
          效用評分（+0.1 成功，-0.05 失敗）
                    |
                    v
          高效用策略自動晉升為 AgentSkill
                    |
                    v
          Agent 從字面意義上進化出新能力
```

### 經驗記錄

每次執行產生一筆結構化的 `Experience` 記錄：呼叫了哪些工具、什麼順序、什麼成功了、什麼失敗了、token 成本和最終結果。這是學習的原材料。

### 策略蒸餾

執行結束後，`Distiller`（預設透過 `LlmDistiller` 由 LLM 驅動）分析經驗並萃取可複用的規則 — 比如「修改原始碼前一定先讀測試檔案」或「寫新程式碼前先搜尋已有實作」。這些成為帶有效用分數的 `Strategy` 物件。

### 效用回饋迴圈

策略根據結果累積效用：
- **成功**：效用分數 +0.1
- **失敗**：效用分數 -0.05
- 分數限制在 `[0, 1]` 範圍

隨著時間推移，有效策略浮到頂部，無效策略逐漸淡出。

### 技能結晶

當策略的效用超過晉升閾值時，它會被自動提升為完整的 `AgentSkill` — 成為一等公民技能，出現在系統提示詞中，可被模型啟動。Agent 從字面意義上從自身經驗中進化出新能力。

### 持久化儲存

```typescript
import { SqliteEvolutionStore, InMemoryEvolutionStore } from "@zauso-ai/capstan-ai";

// 正式環境：跨工作階段持久化進化
const store = new SqliteEvolutionStore("./agent-evolution.db");

// 開發/測試：記憶體儲存，不持久化
const store = new InMemoryEvolutionStore();
```

進化設定：

```typescript
createSmartAgent({
  evolution: {
    store: new SqliteEvolutionStore("./agent-brain.db"),
    capture: "every-run",        // 或 "on-failure" | "on-success"
    distillation: "post-run",    // 每次執行後進行蒸餾
  },
});
```

---

## 架構

```
                    你的應用契約
                    (defineAPI + defineModel + definePolicy)
                              |
              +---------------------------------+------------------+
              |               |                 |                  |
          面向人類        面向 Agent         自我進化             驗證
         +--------+     +----------+      +------------+     +-----------+
         | HTTP   |     | Smart    |      | Experience |     | 8 步      |
         | React  |     | Agent    |      | Strategy   |     | 級聯      |
         | SSR    |     | Runtime  |      | Skill      |     | AI TDD    |
         +--------+     +----------+      +------------+     +-----------+
```

### 專案結構

```
capstan.config.ts           <- 應用設定（資料庫、驗證、Agent 設定）
app/
  routes/
    index.page.tsx          <- React 頁面（帶 loader 的 SSR）
    index.api.ts            <- API 處理器（匯出 GET、POST、PUT、DELETE）
    tickets/
      index.api.ts          <- 檔案式路由：/tickets
      [id].api.ts           <- 動態區段：/tickets/:id
    _layout.tsx             <- 佈局包裝器
    _middleware.ts          <- 中介軟體
  models/
    ticket.model.ts         <- Drizzle ORM + defineModel()
  policies/
    index.ts                <- definePolicy() 權限規則
  public/
    favicon.ico             <- 靜態資源（自動服務）
```

**技術棧：** [Hono](https://hono.dev)（HTTP）. [Drizzle](https://orm.drizzle.team)（ORM）. [React](https://react.dev)（SSR）. [Zod](https://zod.dev)（校驗）. [OpenTelemetry](https://opentelemetry.io)（追蹤）. [Bun](https://bun.sh) 或 Node.js（執行環境）

---

## 工程成熟度

`createSmartAgent` 執行環境包含 13 項生產特性，這些特性決定了展示與可部署系統之間的差距：

1. **響應式 4 層上下文壓縮** — snip、microcompact、autocompact、reactive compact
2. **模型降級與 Thinking 剝離** — 失敗時自動切換，對非思考模型剝離 thinking 區塊
3. **工具輸入校驗** — JSON Schema + 自訂 `validate()`，錯誤作為回饋回傳以供自我修正
4. **單工具逾時** — 毫秒級 `Promise.race` 取消
5. **LLM 看門狗** — 對話逾時（120 秒）、串流閒置逾時（90 秒）、停滯告警（30 秒）
6. **Token 預算管理** — 80% 提醒、100% 強制完成
7. **工具結果預算** — 單結果截斷、聚合上限、磁碟持久化與按需擷取
8. **錯誤隱匿** — 暴露給 LLM 之前靜默重試暫態錯誤
9. **動態上下文與記憶** — 作用域記憶、陳舊度標註、週期性重新整理、LLM 驅動協調器
10. **生命週期掛鉤** — `beforeToolCall`、`afterToolCall`、`afterIteration`、`onRunComplete`、`getControlState`
11. **並行工具執行** — `isConcurrencySafe` 旗標，可設定 `maxConcurrency`
12. **分層提示詞組合** — `prepend`、`append`、`replace_base` 與動態層
13. **漸進式工具揭露** — schema token 預算、確定性探索、執行隔離、Provider 原生搜尋與可恢復目錄狀態

---

## 套件

Capstan 發布 12 個工作空間套件：

| 套件名 | 描述 |
|--------|------|
| `@zauso-ai/capstan-ai` | **智慧 Agent 執行環境**：`createSmartAgent` 帶漸進式工具揭露、4 層壓縮、模型降級、工具校驗/逾時、LLM 看門狗、Token 預算、工具結果預算、錯誤隱匿、生命週期掛鉤。`defineSkill` 技能層。自我進化引擎含 `SqliteEvolutionStore`。持久化 `createHarness` 含瀏覽器/檔案系統沙箱。另有：`think`/`generate`、作用域記憶、任務編排。 |
| `@zauso-ai/capstan-core` | Hono 伺服器、`defineAPI`、`defineMiddleware`、`definePolicy`、審批工作流、8 步驗證器 |
| `@zauso-ai/capstan-agent` | `CapabilityRegistry`、MCP 伺服器（stdio + Streamable HTTP）、MCP 客戶端、A2A 轉接器（SSE）、OpenAPI 產生器、LangChain 整合 |
| `@zauso-ai/capstan-db` | Drizzle ORM、`defineModel`、欄位/關聯輔助函式、遷移、自動 CRUD、向量欄位、`defineEmbedding`、混合搜尋 |
| `@zauso-ai/capstan-auth` | JWT 工作階段、API Key 驗證、OAuth 提供者（Google、GitHub）、DPoP（RFC 9449）、SPIFFE/mTLS、感知 Token 的限流 |
| `@zauso-ai/capstan-router` | 檔案式路由（`.page.tsx`、`.api.ts`、`_layout.tsx`、`_middleware.ts`、路由群組） |
| `@zauso-ai/capstan-react` | SSR 含 loader、佈局、選擇性水合、ISR、`<Link>` SPA 路由、`Image`、`defineFont`、`defineMetadata`、`ErrorBoundary` |
| `@zauso-ai/capstan-cron` | 排程任務排程器：`defineCron`、`createCronRunner`、`createAgentCron` |
| `@zauso-ai/capstan-ops` | 語意化維運：事件、incidents、快照、查詢、SQLite 持久化 |
| `@zauso-ai/capstan-dev` | 開發伺服器含檔案監聽、熱路由重新載入、MCP/A2A 端點 |
| `@zauso-ai/capstan-cli` | CLI：`dev`、`build`、`start`、`deploy:init`、`verify`、`ops:*`、`add`、`mcp`、`db:*` |
| `create-capstan-app` | 專案鷹架（`--template blank`、`--template tickets`） |

---

## 快速開始

### 「我想建構一個 Web 應用」

```bash
bunx create-capstan-app my-app
cd my-app
bun run dev
```

```bash
# 鷹架產生功能
bunx capstan add model ticket
bunx capstan add api tickets
bunx capstan add page tickets
bunx capstan add policy requireAuth

# 驗證一切是否正確連接
bunx capstan verify --json
```

應用已上線，所有協定介面就緒：
- `http://localhost:3000` — Web 應用
- `http://localhost:3000/openapi.json` — OpenAPI 規範
- `http://localhost:3000/.well-known/capstan.json` — Agent 清單
- `http://localhost:3000/.well-known/agent.json` — A2A agent card

### 「我想建構一個 AI Agent」

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

### 「我兩個都要」

建構一個操作你的 Capstan Web 應用的 Agent — 框架同時驅動 Agent 大腦和它所操作的應用。一套程式碼，零壁壘。

> **Node.js 同樣支援：** 將 `bunx` 替換為 `npx`，`bun run` 替換為 `npx`。

---

## 正式環境部署

```bash
# 正式環境建置
bunx capstan build

# 針對特定目標建置
bunx capstan build --target node-standalone
bunx capstan build --target docker
bunx capstan build --target vercel-node
bunx capstan build --target vercel-edge
bunx capstan build --target cloudflare
bunx capstan build --target fly

# 啟動正式環境伺服器
bunx capstan start
```

---

## 文件

### 線上文件

造訪 **[Capstan 文件站](https://capstan.dev)** 取得完整的互動式文件，支援搜尋、多語言和 AI Agent 可查詢的 MCP 工具。

### 面向編碼 Agent 的 MCP 文件服務

文件站暴露 MCP 工具，編碼 Agent（Claude Code、Cursor 等）可以用來查詢文件：

- **搜尋文件** — `GET /api/search?q=createSmartAgent`
- **查詢文件** — `GET /api/docs?slug=core-concepts&section=defineAPI`
- **程式碼範例** — `GET /api/examples?topic=defineSkill`

### Markdown 文件

- [快速開始](docs/getting-started.md) — 安裝、首個專案、開發工作流
- [核心概念](docs/core-concepts.md) — `defineAPI`、`defineModel`、`definePolicy`、能力
- [架構](docs/architecture/) — 系統設計、多協定註冊、路由掃描
- [驗證](docs/authentication.md) — JWT 工作階段、API Key、驗證類型
- [資料庫](docs/database.md) — SQLite、PostgreSQL、MySQL 設定與遷移
- [部署](docs/deployment.md) — `capstan build`、平台目標、`deploy:init`
- [測試策略](docs/testing-strategy.md) — 單元測試、整合測試和驗證器測試
- [API 參考](docs/api-reference.md) — 完整 API 介面文件
- [比較](docs/comparison.md) — Capstan vs Next.js、FastAPI 等

---

## 參與貢獻

Capstan 處於活躍開發階段（`v0.3.0`）。歡迎參與貢獻！

```bash
git clone https://github.com/barry3406/capstan.git
cd capstan
npm install
npm run build        # 建置所有工作空間套件
npm test             # 執行完整測試套件
```

### 約定

- 僅 ESM，匯入使用 `.js` 副檔名
- 嚴格 TypeScript（`exactOptionalPropertyTypes`、`verbatimModuleSyntax`）
- 所有 API 處理器使用 `defineAPI()` 和 Zod schema
- 寫入端點必須參考 `policy`

### 需要幫助

- 更多 Agent 工具實作（瀏覽器自動化、API 客戶端）
- 更多進化儲存後端（PostgreSQL、Redis）
- 更多鷹架範本（除 `blank` 和 `tickets` 外）
- 更多 OAuth 提供者（除 Google 和 GitHub 外）
- 更多嵌入轉接器（Cohere、本地模型）
- 更多部署轉接器（AWS Lambda、Deno Deploy）

---

## 授權條款

[MIT](LICENSE)

---

**Capstan — Web 開發與 Agent 智慧的交會之處。**
