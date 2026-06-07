// === Public API ===
export { createSmartAgent } from "./smart-agent.js";
export { think, generate, thinkStream, generateStream } from "./think.js";
export { defineSkill, createActivateSkillTool, formatSkillDescriptions } from "./skill.js";
export { loadSkill, loadSkillsFrom, createSkillTools, parseSkillMd } from "./skill-bundle.js";
export type { SkillToolsOptions } from "./skill-bundle.js";
export type { SkillFile } from "./types.js";
export { BuiltinMemoryBackend, createMemoryAccessor } from "./memory.js";
export { SqliteMemoryBackend, createSqliteMemoryStore } from "./memory-sqlite.js";
export type { SqliteConnection, SqliteStatement } from "./memory-sqlite.js";
export { setTokenizer, defaultTokenizer } from "./tokenize.js";
export type { Tokenizer } from "./tokenize.js";
export { LlmMemoryReconciler, reconcileAndStore, parseReconcileResponse } from "./memory-reconciler.js";

// === Types (export type only) ===
export type {
  SmartAgent, SmartAgentConfig, SmartAgentHooks, SmartAgentMemoryConfig,
  AgentRunResult, AgentRunStatus, AgentCheckpoint,
  LLMProvider, LLMMessage, LLMContentPart, LLMResponse, LLMStreamChunk, LLMOptions,
  AgentTool, AgentTask, AgentTaskKind, AgentTaskExecutionContext,
  AgentToolCallRecord, AgentTaskCallRecord, ToolRequest,
  MemoryEntry, MemoryScope, MemoryBackend, MemoryEmbedder, MemoryAccessor,
  MemoryReconciler, ReconcileResult, MemoryOperation, MemoryOperationAction,
  RememberOptions, RecallOptions, AssembleContextOptions,
  PromptComposerConfig, PromptLayer, PromptContext,
  SnipConfig, MicrocompactConfig, AutocompactConfig,
  StreamingExecutorConfig, ToolCatalogConfig, ToolResultBudgetConfig,
  StopHook, StopHookContext, StopHookResult,
  ThinkOptions, GenerateOptions,
  ModelFinishReason,
  AgentEvent,
  AgentSkill, TokenBudgetConfig, IterationSnapshot, LLMTimeoutConfig,
} from "./types.js";

// === Validation ===
export { validateArgs } from "./loop/validate-args.js";
export { normalizeMessages } from "./loop/normalize-messages.js";

// === Task runtime (for harness and advanced users) ===
export { InMemoryAgentTaskRuntime } from "./task/runtime.js";
export { createShellTask } from "./task/shell-task.js";
export { createWorkflowTask } from "./task/workflow-task.js";
export { createRemoteTask } from "./task/remote-task.js";
export { createSubagentTask } from "./task/subagent-task.js";
export type { AgentTaskStatus, AgentTaskRecord, AgentTaskNotification, AgentTaskRuntime, AgentTaskSubmitHooks, AgentTaskSubmitResult } from "./task/types.js";

// Harness mode — sandbox + verification + observability
export { createHarness } from "./harness/index.js";
export type { Harness, HarnessControlPlane, HarnessConfig, HarnessRuntimeConfig, HarnessRunHandle, HarnessRunResult, HarnessRunStatus, HarnessRunEventType, HarnessRunRecord, HarnessRunEventRecord, HarnessArtifactRecord, HarnessTaskRecord, HarnessTaskStatus, HarnessReplayReport, HarnessRuntimePaths, HarnessSandboxDriver, HarnessSandboxContext, HarnessResumeOptions, HarnessApprovalResolutionOptions, HarnessRunCheckpointRecord, HarnessRunStartOptions, HarnessRunTrigger, BrowserSandboxConfig, FsSandboxConfig, HarnessAction, VerifyResult, HarnessVerifierFn, HarnessEvent, HarnessLogger, BrowserSandbox, FsSandbox, BrowserSession, BrowserEngine, VisionAction, GuardFn, GuardContext, HarnessMemoryKind, HarnessApprovalKind, HarnessApprovalStatus, HarnessPendingApproval, HarnessApprovalRecord, HarnessContextBlockKind, HarnessCompactionKind, HarnessContextArtifactRef, HarnessMemoryRecord, HarnessMemoryInput, HarnessMemoryQuery, HarnessMemoryMatch, HarnessSessionMemoryRecord, HarnessSummaryRecord, HarnessContextBlock, HarnessContextPackage, HarnessContextAssembleOptions, HarnessAuthorizedAction, HarnessAccessContext, HarnessAuthorizationRequest, HarnessAuthorizationDecision, HarnessAuthorizationHook, HarnessControlPlaneOptions } from "./harness/types.js";
export { PlaywrightEngine } from "./harness/browser/engine.js";
export { analyzeScreenshot, runVisionLoop } from "./harness/browser/vision.js";
export { GuardRegistry, domainWhitelist, autoDelay, maxNavigations } from "./harness/browser/guard.js";
export { randomDelay, humanScroll, humanDelay } from "./harness/browser/stealth.js";
export { FsSandboxImpl } from "./harness/sandbox/filesystem.js";
export { LocalHarnessSandboxDriver } from "./harness/runtime/local-driver.js";
export { FileHarnessRuntimeStore, buildHarnessRuntimePaths } from "./harness/runtime/store.js";
export { openHarnessRuntime } from "./harness/runtime/control-plane.js";
export { HarnessContextKernel } from "./harness/context/kernel.js";
export { HarnessVerifier } from "./harness/verify/index.js";
export { HarnessObserver } from "./harness/observe/index.js";
export type { HarnessMetrics } from "./harness/observe/index.js";

// Evolution engine — self-evolving agent primitives
export { InMemoryEvolutionStore } from "./evolution/store-memory.js";
export { SqliteEvolutionStore, createSqliteEvolutionStore } from "./evolution/store-sqlite.js";
export { LlmDistiller } from "./evolution/distiller.js";
export { buildExperience, shouldCapture, runPostRunEvolution, buildStrategyLayer } from "./evolution/engine.js";
export type {
  Experience, Strategy, TrajectoryStep, Distiller,
  EvolutionStore, EvolutionConfig, ExperienceQuery,
  PruningConfig, SkillPromotionConfig, EvolutionStats,
} from "./evolution/types.js";
