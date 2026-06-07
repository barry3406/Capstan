import type {
  AgentCheckpoint,
  LLMMessage,
  MemoryScope,
} from "../../types.js";
import type {
  HarnessArtifactRecord,
  HarnessCompactionKind,
  HarnessConfig,
  HarnessContextArtifactRef,
  HarnessContextAssembleOptions,
  HarnessContextBlock,
  HarnessContextPackage,
  HarnessMemoryInput,
  HarnessMemoryMatch,
  HarnessMemoryQuery,
  HarnessMemoryRecord,
  HarnessRunRecord,
  HarnessRuntimeStore,
  HarnessSessionMemoryRecord,
  HarnessSummaryRecord,
} from "../types.js";
import {
  getCheckpointLastAssistantResponse,
  getCheckpointMessages,
  getCheckpointStage,
  getCheckpointToolCalls,
} from "../runtime/checkpoint.js";
import { summarizeHarnessResult } from "../runtime/utils.js";
import { messageText } from "../../loop/content-helpers.js";

type NormalizedContextConfig = {
  enabled: boolean;
  maxPromptTokens: number;
  reserveOutputTokens: number;
  maxMemories: number;
  maxArtifacts: number;
  maxRecentMessages: number;
  maxRecentToolResults: number;
  microcompactToolResultChars: number;
  sessionCompactThreshold: number;
  defaultScopes: MemoryScope[];
  autoPromoteObservations: boolean;
  autoPromoteSummaries: boolean;
};

export interface HarnessCheckpointUpdate {
  checkpoint: AgentCheckpoint;
  sessionMemory: HarnessSessionMemoryRecord;
  summary?: HarnessSummaryRecord;
  promotedMemories: HarnessMemoryRecord[];
  compaction?:
    | {
        kind: HarnessCompactionKind;
        previousTokens: number;
        nextTokens: number;
        compactedMessages: number;
      }
    | undefined;
}

export interface HarnessRunContextState {
  sessionMemory: HarnessSessionMemoryRecord;
  summary?: HarnessSummaryRecord;
  promotedMemories: HarnessMemoryRecord[];
}

export class HarnessContextKernel {
  private readonly config: NormalizedContextConfig;

  constructor(
    private readonly runtimeStore: HarnessRuntimeStore,
    config?: HarnessConfig["context"],
  ) {
    this.config = normalizeContextConfig(config);
  }

  async initialize(): Promise<void> {
    await this.runtimeStore.initialize();
  }

  async handleCheckpoint(input: {
    runId: string;
    checkpoint: AgentCheckpoint;
  }): Promise<HarnessCheckpointUpdate> {
    await this.initialize();

    const run = await this.runtimeStore.getRun(input.runId);
    const artifacts = await this.runtimeStore.getArtifacts(input.runId);
    const initialRunSnapshot = buildRunSnapshot(input.runId, run, input.checkpoint);
    const initialSessionMemory = buildSessionMemory(
      initialRunSnapshot,
      input.checkpoint,
      artifacts,
      0,
    );

    if (!this.config.enabled) {
      return {
        checkpoint: cloneCheckpoint(input.checkpoint),
        sessionMemory: initialSessionMemory,
        promotedMemories: [],
      };
    }

    let nextCheckpoint = cloneCheckpoint(input.checkpoint);
    const previousTokens = estimateCheckpointTokens(nextCheckpoint);

    const microcompact = microcompactCheckpoint(nextCheckpoint, {
      maxRecentToolResults: this.config.maxRecentToolResults,
      maxChars: this.config.microcompactToolResultChars,
    });
    nextCheckpoint = microcompact.checkpoint;

    let compactedMessages = microcompact.compactedMessages;
    let summary: HarnessSummaryRecord | undefined;
    const promotedMemories: HarnessMemoryRecord[] = [];

    if (shouldSessionCompact(nextCheckpoint, this.config)) {
      const runSnapshot = buildRunSnapshot(input.runId, run, nextCheckpoint);
      const provisionalSessionMemory = buildSessionMemory(
        runSnapshot,
        nextCheckpoint,
        artifacts,
        compactedMessages,
      );

      summary = await this.writeSummary(
        buildSummaryRecord(
          input.runId,
          runSnapshot,
          nextCheckpoint,
          provisionalSessionMemory,
          "session_compact",
        ),
      );

      nextCheckpoint = compactCheckpointTranscript(
        nextCheckpoint,
        summary,
        this.config.maxRecentMessages,
      );
      compactedMessages = Math.max(
        compactedMessages,
        Math.max(
          getCheckpointMessages(input.checkpoint).length -
            getCheckpointMessages(nextCheckpoint).length,
          0,
        ),
      );

      if (this.config.autoPromoteSummaries) {
        promotedMemories.push(
          await this.rememberMemory({
            scope: { type: "run", id: input.runId },
            runId: input.runId,
            kind: "summary",
            importance: "high",
            sourceSummaryId: summary.id,
            metadata: {
              kind: summary.kind,
              status: summary.status,
            },
            content: renderSummaryMemory(summary),
          }),
        );
      }
    }

    const runSnapshot = buildRunSnapshot(input.runId, run, nextCheckpoint);
    const sessionMemory = buildSessionMemory(
      runSnapshot,
      nextCheckpoint,
      artifacts,
      compactedMessages,
    );
    await this.writeSessionMemory(sessionMemory);

    return {
      checkpoint: nextCheckpoint,
      sessionMemory,
      ...(summary ? { summary } : {}),
      promotedMemories,
      ...(compactedMessages > 0
        ? {
            compaction: {
              kind: summary ? "session_compact" : "microcompact",
              previousTokens,
              nextTokens: estimateCheckpointTokens(nextCheckpoint),
              compactedMessages,
            },
          }
        : {}),
    };
  }

  async captureRunState(runId: string): Promise<HarnessRunContextState> {
    await this.initialize();

    const run = await this.runtimeStore.requireRun(runId);
    const checkpoint = (await this.runtimeStore.getCheckpoint(runId))?.checkpoint;
    const artifacts = await this.runtimeStore.getArtifacts(runId);

    const sessionMemory = buildSessionMemory(
      run,
      checkpoint,
      artifacts,
      (await this.getSessionMemory(runId))?.compactedMessages ?? 0,
    );

    if (!this.config.enabled) {
      return {
        sessionMemory,
        promotedMemories: [],
      };
    }

    await this.writeSessionMemory(sessionMemory);

    let summary: HarnessSummaryRecord | undefined;
    const promotedMemories: HarnessMemoryRecord[] = [];

    if (run.status !== "running" && run.status !== "pause_requested" && checkpoint) {
      summary = await this.writeSummary(
        buildSummaryRecord(runId, run, checkpoint, sessionMemory, "run_compact"),
      );

      if (this.config.autoPromoteSummaries) {
        promotedMemories.push(
          await this.rememberMemory({
            scope: { type: "run", id: runId },
            runId,
            kind: "summary",
            importance: "high",
            sourceSummaryId: summary.id,
            metadata: {
              kind: summary.kind,
              status: summary.status,
            },
            content: renderSummaryMemory(summary),
          }),
        );
      }
    }

    return {
      sessionMemory,
      ...(summary ? { summary } : {}),
      promotedMemories,
    };
  }

  async recordObservation(input: {
    runId: string;
    tool: string;
    args: unknown;
    result: unknown;
  }): Promise<HarnessMemoryRecord | undefined> {
    if (!this.config.enabled || !this.config.autoPromoteObservations) {
      return undefined;
    }

    return this.rememberMemory({
      scope: { type: "run", id: input.runId },
      runId: input.runId,
      kind: "observation",
      importance: hasToolError(input.result) ? "high" : "medium",
      metadata: {
        tool: input.tool,
        ...(hasToolError(input.result) ? { error: true } : {}),
      },
      content:
        `Tool ${input.tool} called with ${JSON.stringify(sanitizeUnknown(input.args))} ` +
        `returned ${JSON.stringify(sanitizeUnknown(summarizeHarnessResult(input.result)))}`,
    });
  }

  async rememberMemory(input: HarnessMemoryInput): Promise<HarnessMemoryRecord> {
    await this.initialize();

    const normalizedContent = normalizeMemoryContent(input.content);
    if (!normalizedContent) {
      throw new Error("Harness memory content must be a non-empty string");
    }

    return this.runtimeStore.rememberMemory({
      ...input,
      content: input.content.trim(),
      scope: { ...input.scope },
      ...(input.metadata
        ? {
            metadata: sanitizeUnknown(input.metadata) as Record<string, unknown>,
          }
        : {}),
    });
  }

  async recallMemory(query: HarnessMemoryQuery): Promise<HarnessMemoryMatch[]> {
    await this.initialize();
    return this.runtimeStore.recallMemory(query);
  }

  async getSessionMemory(runId: string): Promise<HarnessSessionMemoryRecord | undefined> {
    await this.initialize();
    return this.runtimeStore.getSessionMemory(runId);
  }

  async getLatestSummary(runId: string): Promise<HarnessSummaryRecord | undefined> {
    await this.initialize();
    return this.runtimeStore.getLatestSummary(runId);
  }

  async listSummaries(runId?: string): Promise<HarnessSummaryRecord[]> {
    await this.initialize();
    return this.runtimeStore.listSummaries(runId);
  }

  async assembleContext(
    runId: string,
    options?: HarnessContextAssembleOptions,
  ): Promise<HarnessContextPackage> {
    await this.initialize();

    const run = await this.runtimeStore.requireRun(runId);
    const checkpoint = (await this.runtimeStore.getCheckpoint(runId))?.checkpoint;
    const artifacts = await this.runtimeStore.getArtifacts(runId);
    const persistedSessionMemory = await this.getSessionMemory(runId);
    const sessionMemory =
      persistedSessionMemory ??
      buildSessionMemory(
        run,
        checkpoint,
        artifacts,
        0,
      );
    const summary = await this.getLatestSummary(runId);

    const query = options?.query ?? sessionMemory?.headline ?? run.goal;
    const scopes = uniqueScopes([
      { type: "project", id: this.runtimeStore.paths.rootDir },
      { type: "run", id: runId },
      ...(options?.scopes ?? this.config.defaultScopes),
    ]);
    const memories = await this.runtimeStore.recallMemory({
      query,
      scopes,
      limit: options?.maxMemories ?? this.config.maxMemories,
    });
    const artifactRefs = await buildArtifactRefs(
      this.runtimeStore,
      artifacts,
      options?.maxArtifacts ?? this.config.maxArtifacts,
    );

    const candidateBlocks = buildContextBlocks({
      memories,
      artifactRefs,
      ...(sessionMemory ? { sessionMemory } : {}),
      ...(summary ? { summary } : {}),
    });
    const maxContextTokens = Math.max(
      0,
      Math.min(
        options?.maxTokens ?? this.config.maxPromptTokens,
        this.config.maxPromptTokens - this.config.reserveOutputTokens,
      ),
    );
    const preparedTranscript = checkpoint
      ? fitPreparedTranscriptBudget(
          getCheckpointMessages(checkpoint),
          this.config.maxRecentMessages,
          maxContextTokens,
          reservePrimaryContextTokens(candidateBlocks),
        )
      : [];
    const transcriptTail = checkpoint
      ? selectTranscriptTail(preparedTranscript, this.config.maxRecentMessages)
      : [];
    const transcriptTokens = estimateMessagesTokens(preparedTranscript);
    const budget = Math.max(0, maxContextTokens - transcriptTokens);
    const { blocks, omitted, usedTokens } = packContextBlocks(candidateBlocks, budget);

    return {
      runId,
      generatedAt: new Date().toISOString(),
      query,
      maxTokens: budget,
      totalTokens: usedTokens + transcriptTokens,
      blocks,
      transcriptTail,
      artifactRefs,
      memories,
      ...(sessionMemory ? { sessionMemory } : {}),
      ...(summary ? { summary } : {}),
      omitted,
    };
  }

  async prepareMessages(input: {
    runId: string;
    checkpoint: AgentCheckpoint;
    query?: string;
    scopes?: MemoryScope[];
  }): Promise<LLMMessage[]> {
    if (!this.config.enabled) {
      return cloneMessages(getCheckpointMessages(input.checkpoint));
    }

    const preparedTranscript = buildPreparedTranscript(
      getCheckpointMessages(input.checkpoint),
      this.config.maxRecentMessages,
    );
    const contextPackage = await this.assembleContext(input.runId, {
      maxTokens: this.config.maxPromptTokens - this.config.reserveOutputTokens,
      ...(input.query ? { query: input.query } : {}),
      ...(input.scopes ? { scopes: input.scopes } : {}),
    });

    if (contextPackage.blocks.length === 0) {
      return preparedTranscript;
    }

    const injection: LLMMessage = {
      role: "system",
      content: renderContextPackage(contextPackage),
    };

    if (preparedTranscript[0]?.role === "system") {
      return [preparedTranscript[0], injection, ...preparedTranscript.slice(1)];
    }

    return [injection, ...preparedTranscript];
  }

  private async writeSessionMemory(record: HarnessSessionMemoryRecord): Promise<void> {
    const current = await this.runtimeStore.getSessionMemory(record.runId);
    if (current && stableStringify(current) === stableStringify(record)) {
      return;
    }
    await this.runtimeStore.persistSessionMemory(record);
  }

  private async writeSummary(record: HarnessSummaryRecord): Promise<HarnessSummaryRecord> {
    const current = await this.runtimeStore.getLatestSummary(record.runId);
    if (current && stableStringify(current) === stableStringify(record)) {
      return current;
    }
    await this.runtimeStore.persistSummary(record);
    return record;
  }
}

function normalizeContextConfig(
  config: HarnessConfig["context"] | undefined,
): NormalizedContextConfig {
  return {
    enabled: config?.enabled !== false,
    maxPromptTokens: config?.maxPromptTokens ?? 12_000,
    reserveOutputTokens: config?.reserveOutputTokens ?? 2_000,
    maxMemories: config?.maxMemories ?? 6,
    maxArtifacts: config?.maxArtifacts ?? 4,
    maxRecentMessages: config?.maxRecentMessages ?? 8,
    maxRecentToolResults: config?.maxRecentToolResults ?? 3,
    microcompactToolResultChars: config?.microcompactToolResultChars ?? 700,
    sessionCompactThreshold: config?.sessionCompactThreshold ?? 0.68,
    defaultScopes: config?.defaultScopes?.map((scope) => ({ ...scope })) ?? [],
    autoPromoteObservations: config?.autoPromoteObservations !== false,
    autoPromoteSummaries: config?.autoPromoteSummaries !== false,
  };
}

function buildRunSnapshot(
  runId: string,
  run: HarnessRunRecord | undefined,
  checkpoint: AgentCheckpoint,
): HarnessRunRecord {
  if (run) {
    return {
      ...run,
      status: statusFromCheckpointStage(getCheckpointStage(checkpoint), run.status),
      iterations: checkpoint.iterations,
      toolCalls: getCheckpointToolCalls(checkpoint).length,
      taskCalls: checkpoint.taskCalls?.length ?? run.taskCalls,
    };
  }

  const now = new Date().toISOString();
  return {
    id: runId,
    goal: typeof checkpoint.goal === "string" ? checkpoint.goal : checkpoint.goal.map((p) => (p.type === "text" ? p.text : "[image]")).join(""),
    status: statusFromCheckpointStage(getCheckpointStage(checkpoint), "running"),
    createdAt: now,
    updatedAt: now,
    iterations: checkpoint.iterations,
    toolCalls: getCheckpointToolCalls(checkpoint).length,
    taskCalls: checkpoint.taskCalls?.length ?? 0,
    maxIterations: 10,
    toolNames: [],
    taskNames: [],
    artifactIds: [],
    taskIds: [],
    sandbox: {
      driver: "unknown",
      mode: "unknown",
      browser: false,
      fs: false,
      artifactDir: "",
    },
    lastEventSequence: 0,
  };
}

function statusFromCheckpointStage(
  stage: string,
  fallback: HarnessRunRecord["status"],
): HarnessRunRecord["status"] {
  switch (stage) {
    case "approval_required":
      return "approval_required";
    case "paused":
      return "paused";
    case "completed":
      return "completed";
    case "max_iterations":
      return "max_iterations";
    case "canceled":
      return "canceled";
    default:
      return fallback;
  }
}

function buildSessionMemory(
  run: HarnessRunRecord,
  checkpoint: AgentCheckpoint | undefined,
  artifacts: HarnessArtifactRecord[],
  compactedMessages: number,
): HarnessSessionMemoryRecord {
  const artifactRefs = artifactsToRefs(artifacts);
  const recentSteps = (checkpoint ? getCheckpointToolCalls(checkpoint) : [])
    .slice(-5)
    .map((call) => formatToolObservation(call.tool, call.args, call.result));
  const blockers = collectBlockers(run, checkpoint);
  const openQuestions = collectOpenQuestions(run, checkpoint);
  const lastAssistantResponse = checkpoint
    ? getCheckpointLastAssistantResponse(checkpoint)
    : undefined;
  const headline = lastAssistantResponse?.trim() || `${run.goal} [${run.status}]`;

  return {
    runId: run.id,
    goal: run.goal,
    status: run.status,
    updatedAt: new Date().toISOString(),
    sourceRunUpdatedAt: run.updatedAt,
    headline,
    currentPhase: describePhase(run.status, checkpoint),
    ...(lastAssistantResponse
      ? { lastAssistantResponse }
      : {}),
    recentSteps,
    blockers,
    openQuestions,
    ...(run.pendingApproval
      ? {
          pendingApproval: {
            tool: run.pendingApproval.tool,
            reason: run.pendingApproval.reason,
          },
        }
      : {}),
    artifactRefs,
    compactedMessages,
    tokenEstimate: estimateTokens(
      [headline, ...recentSteps, ...blockers, ...openQuestions].join("\n"),
    ),
  };
}

function buildSummaryRecord(
  runId: string,
  run: HarnessRunRecord,
  checkpoint: AgentCheckpoint,
  sessionMemory: HarnessSessionMemoryRecord,
  kind: HarnessCompactionKind,
): HarnessSummaryRecord {
  const now = new Date().toISOString();
  const completedSteps = getCheckpointToolCalls(checkpoint)
    .slice(-8)
    .map((call) => formatToolObservation(call.tool, call.args, call.result));

  return {
    id: `summary_${runId}`,
    runId,
    createdAt: now,
    updatedAt: now,
    sourceRunUpdatedAt: run.updatedAt,
    kind,
    status: run.status,
    headline: sessionMemory.headline,
    completedSteps,
    blockers: sessionMemory.blockers,
    openQuestions: sessionMemory.openQuestions,
    artifactRefs: sessionMemory.artifactRefs,
    iterations: checkpoint.iterations,
    toolCalls: getCheckpointToolCalls(checkpoint).length,
    messageCount: getCheckpointMessages(checkpoint).length,
    compactedMessages: sessionMemory.compactedMessages,
  };
}

function shouldSessionCompact(
  checkpoint: AgentCheckpoint,
  config: NormalizedContextConfig,
): boolean {
  const transcriptTokens = estimateCheckpointTokens(checkpoint);
  return (
    transcriptTokens >=
      Math.floor((config.maxPromptTokens - config.reserveOutputTokens) * config.sessionCompactThreshold) ||
    getCheckpointMessages(checkpoint).length > config.maxRecentMessages * 3
  );
}

function microcompactCheckpoint(
  checkpoint: AgentCheckpoint,
  options: {
    maxRecentToolResults: number;
    maxChars: number;
  },
): { checkpoint: AgentCheckpoint; compactedMessages: number } {
  const messages = getCheckpointMessages(checkpoint);
  const toolResultIndices = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => isToolResultTranscriptMessage(messageText(message.content)))
    .map(({ index }) => index);

  const keep = new Set(
    options.maxRecentToolResults > 0
      ? toolResultIndices.slice(-options.maxRecentToolResults)
      : [],
  );
  let compactedMessages = 0;
  const nextMessages = messages.map((message, index) => {
    if (!toolResultIndices.includes(index) || keep.has(index)) {
      return { ...message };
    }

    // Multimodal content (image parts) — pass through untouched, never
    // collapse to text or truncate.
    if (typeof message.content !== "string") {
      return { ...message };
    }

    if (message.content.length <= options.maxChars) {
      return { ...message };
    }

    compactedMessages++;
    return {
      role: message.role,
      content:
        `${message.content.slice(0, options.maxChars)}\n... [microcompacted tool result]`,
    };
  });

  return {
    checkpoint: {
      ...cloneCheckpoint(checkpoint),
      messages: nextMessages,
    },
    compactedMessages,
  };
}

function compactCheckpointTranscript(
  checkpoint: AgentCheckpoint,
  summary: HarnessSummaryRecord,
  maxRecentMessages: number,
): AgentCheckpoint {
  const messages = cloneMessages(getCheckpointMessages(checkpoint)).filter(
    (message) => !isHarnessSummaryMessage(messageText(message.content)),
  );
  const { prefix, bodyStart } = splitTranscriptPrefix(messages);
  const tail = selectTranscriptTail(messages.slice(bodyStart), maxRecentMessages);
  const summaryMessage: LLMMessage = {
    role: "system",
    content: renderSummaryForTranscript(summary),
  };

  return {
    ...cloneCheckpoint(checkpoint),
    messages: [
      ...prefix,
      summaryMessage,
      ...tail,
    ],
  };
}

async function buildArtifactRefs(
  runtimeStore: HarnessRuntimeStore,
  artifacts: HarnessArtifactRecord[],
  limit: number,
): Promise<HarnessContextArtifactRef[]> {
  const refs = await Promise.all(
    artifacts
      .slice(-limit)
      .map(async (artifact) => {
        const preview = await runtimeStore
          .readArtifactPreview(artifact, 240)
          .catch(() => undefined);
        return {
          artifactId: artifact.id,
          kind: artifact.kind,
          path: artifact.path,
          mimeType: artifact.mimeType,
          size: artifact.size,
          ...(preview ? { preview } : {}),
          ...(artifact.metadata ? { metadata: artifact.metadata } : {}),
        } satisfies HarnessContextArtifactRef;
      }),
  );
  return refs;
}

function artifactsToRefs(artifacts: HarnessArtifactRecord[]): HarnessContextArtifactRef[] {
  return artifacts.slice(-6).map((artifact) => ({
    artifactId: artifact.id,
    kind: artifact.kind,
    path: artifact.path,
    mimeType: artifact.mimeType,
    size: artifact.size,
    ...(artifact.metadata ? { metadata: artifact.metadata } : {}),
  }));
}

function renderSessionMemory(record: HarnessSessionMemoryRecord): string {
  const parts = [
    `Goal: ${record.goal}`,
    `Status: ${record.status}`,
    `Phase: ${record.currentPhase}`,
    `Headline: ${record.headline}`,
  ];
  if (record.recentSteps.length > 0) {
    parts.push("Recent steps:");
    parts.push(...record.recentSteps.map((step) => `- ${step}`));
  }
  if (record.blockers.length > 0) {
    parts.push("Blockers:");
    parts.push(...record.blockers.map((item) => `- ${item}`));
  }
  if (record.openQuestions.length > 0) {
    parts.push("Open questions:");
    parts.push(...record.openQuestions.map((item) => `- ${item}`));
  }
  if (record.pendingApproval) {
    parts.push(
      `Pending approval: ${record.pendingApproval.tool} (${record.pendingApproval.reason})`,
    );
  }
  return parts.join("\n");
}

function renderSummaryBlock(record: HarnessSummaryRecord): string {
  const parts = [
    `Headline: ${record.headline}`,
    `Status: ${record.status}`,
    `Iterations: ${record.iterations}`,
    `Tool calls: ${record.toolCalls}`,
  ];
  if (record.completedSteps.length > 0) {
    parts.push("Completed steps:");
    parts.push(...record.completedSteps.map((step) => `- ${step}`));
  }
  if (record.blockers.length > 0) {
    parts.push("Blockers:");
    parts.push(...record.blockers.map((item) => `- ${item}`));
  }
  if (record.openQuestions.length > 0) {
    parts.push("Open questions:");
    parts.push(...record.openQuestions.map((item) => `- ${item}`));
  }
  return parts.join("\n");
}

function renderSummaryMemory(record: HarnessSummaryRecord): string {
  return `Run ${record.runId} summary: ${record.headline}\n${renderSummaryBlock(record)}`;
}

function renderSummaryForTranscript(record: HarnessSummaryRecord): string {
  return [
    "[HARNESS_SUMMARY]",
    `Status: ${record.status}`,
    `Headline: ${record.headline}`,
    record.completedSteps.length > 0 ? "Completed steps:" : undefined,
    ...record.completedSteps.map((step) => `- ${step}`),
    record.blockers.length > 0 ? "Blockers:" : undefined,
    ...record.blockers.map((step) => `- ${step}`),
    record.openQuestions.length > 0 ? "Open questions:" : undefined,
    ...record.openQuestions.map((step) => `- ${step}`),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderContextPackage(contextPackage: HarnessContextPackage): string {
  return [
    "Runtime context below is authoritative and may contain fresher state than older transcript messages.",
    ...contextPackage.blocks.flatMap((block) => [
      `## ${block.title}`,
      block.content,
    ]),
  ].join("\n\n");
}

function selectTranscriptTail(
  messages: LLMMessage[],
  maxRecentMessages: number,
): LLMMessage[] {
  return cloneMessages(messages.slice(-maxRecentMessages));
}

function fitPreparedTranscriptBudget(
  messages: LLMMessage[],
  maxRecentMessages: number,
  maxTokens: number,
  reservedContextTokens: number,
): LLMMessage[] {
  const prepared = buildPreparedTranscript(messages, maxRecentMessages);
  const transcriptTokenBudget = Math.max(0, maxTokens - reservedContextTokens);
  if (estimateMessagesTokens(prepared) <= transcriptTokenBudget) {
    return prepared;
  }

  const { prefix, bodyStart: cursor } = splitTranscriptPrefix(prepared);

  const tail = prepared.slice(cursor).map((message) => ({ ...message }));
  while (
    tail.length > 0 &&
    estimateMessagesTokens([...prefix, ...tail]) > transcriptTokenBudget
  ) {
    tail.shift();
  }

  return [...prefix, ...tail];
}

function buildPreparedTranscript(
  messages: LLMMessage[],
  maxRecentMessages: number,
): LLMMessage[] {
  const filteredMessages = messages.filter(
    (message) =>
      !isHarnessSummaryMessage(messageText(message.content)) &&
      !isRuntimeContextMessage(messageText(message.content)),
  );

  if (filteredMessages.length <= maxRecentMessages + 2) {
    return cloneMessages(filteredMessages);
  }

  const preserved = new Set<number>();
  const { preservedIndices } = splitTranscriptPrefix(filteredMessages);
  for (const index of preservedIndices) {
    preserved.add(index);
  }

  const tailStart = Math.max(filteredMessages.length - maxRecentMessages, 0);
  for (let index = tailStart; index < filteredMessages.length; index++) {
    preserved.add(index);
  }

  return Array.from(preserved)
    .sort((left, right) => left - right)
    .map((index) => ({ ...filteredMessages[index]! }));
}

function estimateCheckpointTokens(checkpoint: AgentCheckpoint): number {
  return estimateMessagesTokens(getCheckpointMessages(checkpoint));
}

function estimateMessagesTokens(messages: LLMMessage[]): number {
  return messages.reduce(
    (total, message) => total + estimateTokens(messageText(message.content)) + 8,
    0,
  );
}

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

function fitContentToTokenBudget(content: string, budget: number): string {
  if (budget <= 0) {
    return "";
  }

  const maxChars = budget * 4;
  if (content.length <= maxChars) {
    return content;
  }

  const suffix = "\n... [truncated]";
  if (maxChars <= suffix.length) {
    return content.slice(0, maxChars);
  }

  const body = content.slice(0, maxChars - suffix.length).trimEnd();
  return body ? `${body}${suffix}` : content.slice(0, maxChars);
}

function cloneCheckpoint(checkpoint: AgentCheckpoint): AgentCheckpoint {
  return {
    stage: checkpoint.stage,
    goal: checkpoint.goal,
    messages: cloneMessages(getCheckpointMessages(checkpoint)),
    iterations: checkpoint.iterations,
    toolCalls: getCheckpointToolCalls(checkpoint).map((call) => ({
      tool: call.tool,
      args: sanitizeUnknown(call.args),
      result: sanitizeUnknown(call.result),
    })),
    taskCalls: (checkpoint.taskCalls ?? []).map((call) => ({
      task: call.task,
      args: sanitizeUnknown(call.args),
      result: sanitizeUnknown(call.result),
    })),
    maxOutputTokens: checkpoint.maxOutputTokens,
    compaction: { ...checkpoint.compaction },
    ...(checkpoint.pendingApproval ? { pendingApproval: { ...checkpoint.pendingApproval } } : {}),
  };
}

function cloneMessages(messages: LLMMessage[]): LLMMessage[] {
  return messages.map((message) => ({ ...message }));
}

function describePhase(
  status: HarnessRunRecord["status"],
  checkpoint: AgentCheckpoint | undefined,
): string {
  if (status === "approval_required") {
    return "awaiting_approval";
  }
  if (status === "paused") {
    return "paused";
  }
  if (status === "cancel_requested") {
    return "canceling";
  }
  if (status === "canceled") {
    return "canceled";
  }
  if (status === "completed") {
    return "completed";
  }
  if (status === "max_iterations") {
    return "iteration_limit_reached";
  }
  if (status === "failed") {
    return "failed";
  }
  if (checkpoint && checkpoint.stage === "tool_result") {
    const lastTool = checkpoint.toolCalls[checkpoint.toolCalls.length - 1];
    if (lastTool) {
      return `executing_${lastTool.tool}`;
    }
  }
  return "reasoning";
}

function collectBlockers(
  run: HarnessRunRecord,
  checkpoint: AgentCheckpoint | undefined,
): string[] {
  const blockers: string[] = [];
  if (run.error) {
    blockers.push(run.error);
  }
  if (run.pendingApproval) {
    blockers.push(`Approval required for ${run.pendingApproval.tool}: ${run.pendingApproval.reason}`);
  }
  const toolCalls = checkpoint ? getCheckpointToolCalls(checkpoint) : [];
  const lastCall = toolCalls[toolCalls.length - 1];
  if (lastCall && hasToolError(lastCall.result)) {
    blockers.push(formatToolError(lastCall.tool, lastCall.result));
  }
  return uniqueStrings(blockers);
}

function collectOpenQuestions(
  run: HarnessRunRecord,
  checkpoint: AgentCheckpoint | undefined,
): string[] {
  const questions: string[] = [];
  if (run.pendingApproval) {
    questions.push(`Should ${run.pendingApproval.tool} be approved?`);
  }
  if (checkpoint && checkpoint.stage === "tool_result") {
    const lastTool = checkpoint.toolCalls[checkpoint.toolCalls.length - 1];
    if (lastTool) {
      questions.push(`What should happen after ${lastTool.tool}?`);
    }
  }
  return uniqueStrings(questions);
}

function splitTranscriptPrefix(messages: LLMMessage[]): {
  prefix: LLMMessage[];
  preservedIndices: number[];
  bodyStart: number;
} {
  const preservedIndices: number[] = [];
  let cursor = 0;

  while (cursor < messages.length && messages[cursor]?.role === "system") {
    preservedIndices.push(cursor);
    cursor++;
  }

  if (cursor < messages.length && messages[cursor]?.role === "user") {
    preservedIndices.push(cursor);
    cursor++;
  }

  return {
    prefix: preservedIndices.map((index) => ({ ...messages[index]! })),
    preservedIndices,
    bodyStart: cursor,
  };
}

function isToolResultTranscriptMessage(content: string): boolean {
  return content.startsWith("Tool \"");
}

function formatToolObservation(tool: string, args: unknown, result: unknown): string {
  return `${tool}(${JSON.stringify(sanitizeUnknown(args))}) => ${JSON.stringify(
    sanitizeUnknown(summarizeHarnessResult(result)),
  )}`;
}

function formatToolError(tool: string, result: unknown): string {
  if (isPlainObject(result) && typeof result.error === "string") {
    return `${tool} failed: ${result.error}`;
  }
  return `${tool} failed`;
}

function hasToolError(result: unknown): boolean {
  return isPlainObject(result) && typeof result.error === "string";
}

function scopeKey(scope: MemoryScope): string {
  return `${scope.type}:${scope.id}`;
}

function uniqueScopes(scopes: MemoryScope[]): MemoryScope[] {
  const seen = new Set<string>();
  const out: MemoryScope[] = [];
  for (const scope of scopes) {
    const key = scopeKey(scope);
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ ...scope });
    }
  }
  return out;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizeMemoryContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ");
}

function isHarnessSummaryMessage(content: string): boolean {
  return content.startsWith("[HARNESS_SUMMARY]");
}

function isRuntimeContextMessage(content: string): boolean {
  return content.startsWith(
    "Runtime context below is authoritative and may contain fresher state than older transcript messages.",
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function buildContextBlocks(input: {
  sessionMemory?: HarnessSessionMemoryRecord;
  summary?: HarnessSummaryRecord;
  memories: HarnessMemoryMatch[];
  artifactRefs: HarnessContextArtifactRef[];
}): HarnessContextBlock[] {
  const blocks: HarnessContextBlock[] = [];

  if (input.sessionMemory) {
    const content = renderSessionMemory(input.sessionMemory);
    blocks.push({
      kind: "session_memory",
      title: "Session Memory",
      content,
      tokens: estimateTokens(content),
    });
  }

  if (input.summary) {
    const content = renderSummaryBlock(input.summary);
    blocks.push({
      kind: "summary",
      title: "Run Summary",
      content,
      tokens: estimateTokens(content),
    });
  }

  if (input.memories.length > 0) {
    const memoryContent = input.memories
      .map((memory) => `- [${memory.scope.type}:${memory.scope.id}] ${memory.content}`)
      .join("\n");
    blocks.push({
      kind: "memory",
      title: "Relevant Memory",
      content: memoryContent,
      tokens: estimateTokens(memoryContent),
    });
  }

  if (input.artifactRefs.length > 0) {
    const artifactContent = input.artifactRefs
      .map((artifact) => {
        const base =
          `- ${artifact.kind} (${artifact.mimeType}, ${artifact.size} bytes) at ${artifact.path}`;
        return artifact.preview ? `${base}\n  Preview: ${artifact.preview}` : base;
      })
      .join("\n");
    blocks.push({
      kind: "artifact",
      title: "Artifacts",
      content: artifactContent,
      tokens: estimateTokens(artifactContent),
    });
  }

  return blocks;
}

function reservePrimaryContextTokens(blocks: HarnessContextBlock[]): number {
  const primary = blocks.find(
    (block) => block.kind === "session_memory" || block.kind === "summary",
  );
  return primary?.tokens ?? 0;
}

function packContextBlocks(
  blocks: HarnessContextBlock[],
  budget: number,
): {
  blocks: HarnessContextBlock[];
  omitted: HarnessContextPackage["omitted"];
  usedTokens: number;
} {
  const included: HarnessContextBlock[] = [];
  const omitted: HarnessContextPackage["omitted"] = [];
  let usedTokens = 0;

  for (const block of blocks) {
    const remainingBudget = Math.max(0, budget - usedTokens);
    const nextBlock =
      block.kind === "session_memory" &&
      included.length === 0 &&
      block.tokens > remainingBudget &&
      remainingBudget > 0
        ? {
            ...block,
            content: fitContentToTokenBudget(block.content, remainingBudget),
          }
        : block;
    const nextTokens = estimateTokens(nextBlock.content);

    if (usedTokens + nextTokens > budget) {
      omitted.push({ kind: block.kind, reason: "token_budget_exceeded" });
      continue;
    }
    included.push({
      ...nextBlock,
      tokens: nextTokens,
    });
    usedTokens += nextTokens;
  }

  return {
    blocks: included,
    omitted,
    usedTokens,
  };
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function sanitizeUnknown(value: unknown): unknown {
  if (value == null) {
    return value;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Buffer.isBuffer(value)) {
    return {
      type: "buffer",
      size: value.byteLength,
    };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeUnknown(entry));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = sanitizeUnknown(entry);
    }
    return out;
  }
  return String(value);
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
