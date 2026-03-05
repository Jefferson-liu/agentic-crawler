import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import {
  query,
  type CanUseTool,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { v4 as uuidv4 } from "uuid";
import { indexRepositoryAst } from "./ast-indexer";
import {
  getContextSummaryPath,
  readContextSummary,
  writeContextSummary,
} from "./context-summary";
import {
  getFileSummariesPath,
  loadFileSummariesStore,
  prepareFileSummariesStore,
  summarizeStoreProgress,
} from "./file-summary-store";
import { load_prompt_sync } from "./prompt-loader";
import {
  listReferenceSubjects,
  readReferenceGraphContext,
} from "./reference-graph";
import { computeRepoFingerprint } from "./repo-fingerprint";
import {
  type RepoProgressEvent,
  type RepoPermissionDenial,
  type RepoProgressCostState,
  type RepoProgressQueueState,
  repoProgressBus,
} from "./repo-progress-bus";
import { normalizeRepoPathInput } from "./path-normalization";

const DEFAULT_FILE_SUMMARIZER_PROMPT =
  "You are a specialized file summarizer. Summarize one file and write results using the available tools.";
const DEFAULT_CONTEXT_GENERATOR_PROMPT =
  "You are a repository context generator. Read file summaries and write summary markdown.";
const SHOULD_LOG_REPO_PROGRESS = process.env.LOG_REPO_PROGRESS !== "0";

type AgentModel = "sonnet" | "haiku" | "opus" | "inherit";

interface RepoKnowledgeStatus {
  repo_address: string;
  force_refresh: boolean;
  cache_valid: boolean;
  cache_invalid_reasons: string[];
  current_fingerprint: string;
}

interface QueueSubject {
  subject: string;
  attempt: number;
}

interface WorkerRunResult {
  success: boolean;
  error: string | null;
  cost_usd: number;
  permission_denials: RepoPermissionDenial[];
}

interface QueueRunResult {
  queue: RepoProgressQueueState;
  queue_cost_usd: number;
  failed_subjects: string[];
}

interface AllowlistCanUseToolContext {
  allowedToolNames: string[];
  chatId: string | undefined;
  runId: string;
  repoAddress: string;
  stage: "queue" | "context";
  subagent: "file-summarizer" | "context-generator";
  sourceLabel: string;
  subject?: string;
  attempt?: number;
  denialToolUseIds?: Set<string>;
}

export interface RunRepoKnowledgeTeamPipelineInput {
  repo_address?: string;
  force_refresh?: boolean;
  chat_id?: string;
  max_workers?: number;
  mcp_server: unknown;
}

export interface RepoKnowledgeTeamPipelineReport {
  cache_used: boolean;
  repo_address: string;
  force_refresh: boolean;
  total_subjects: number;
  completed_subjects: number;
  missing_count: number;
  missing_subjects: string[];
  no_supported_files: boolean;
  message: string;
  fallback_used: boolean;
  cache_invalid_reasons: string[];
  run_id: string;
  queue_total: number;
  queue_completed: number;
  queue_failed: number;
  retry_count: number;
  queue_cost_usd: number;
  context_cost_usd: number;
  total_cost_usd: number;
  avg_cost_per_completed_file_usd: number;
  duration_ms: number;
}

type CanUseToolOptions = Parameters<CanUseTool>[2];
type CanUseToolSuggestions = CanUseToolOptions["suggestions"];

function normalizeCost(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "";
  }

  const normalizedInput = input as Record<string, unknown>;
  const compactPairs: string[] = [];

  for (const [key, value] of Object.entries(normalizedInput)) {
    if (typeof value === "string") {
      compactPairs.push(`${key}=${JSON.stringify(truncateText(value, 80))}`);
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      compactPairs.push(`${key}=${String(value)}`);
    }
  }

  if (compactPairs.length > 0) {
    return truncateText(compactPairs.join(" "), 180);
  }

  try {
    return truncateText(JSON.stringify(normalizedInput), 180);
  } catch {
    return "";
  }
}

function parsePermissionDenials(value: unknown): RepoPermissionDenial[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const denials: RepoPermissionDenial[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    const raw = item as Record<string, unknown>;
    const toolName =
      typeof raw.tool_name === "string" && raw.tool_name.trim().length > 0
        ? raw.tool_name.trim()
        : "unknown_tool";
    const toolUseId =
      typeof raw.tool_use_id === "string" && raw.tool_use_id.trim().length > 0
        ? raw.tool_use_id.trim()
        : undefined;
    const toolInputSummary = summarizeToolInput(raw.tool_input);

    denials.push({
      tool_name: toolName,
      ...(toolUseId ? { tool_use_id: toolUseId } : {}),
      ...(toolInputSummary ? { tool_input_summary: toolInputSummary } : {}),
    });
  }
  return denials;
}

function formatPermissionDenialsError(denials: RepoPermissionDenial[]): string {
  if (denials.length === 0) {
    return "permission_denials=0";
  }

  const compact = denials
    .slice(0, 5)
    .map((denial) => {
      const useId = denial.tool_use_id ? `#${denial.tool_use_id}` : "";
      const input = denial.tool_input_summary ? ` ${denial.tool_input_summary}` : "";
      return `${denial.tool_name}${useId}${input}`;
    })
    .join(" | ");
  const suffix = denials.length > 5 ? ` (+${denials.length - 5} more)` : "";
  return `permission_denials=${denials.length} [${truncateText(compact, 420)}]${suffix}`;
}

function emitPermissionDenialProgress(input: {
  chatId: string | undefined;
  runId: string;
  repoAddress: string;
  stage: "queue" | "context";
  subagent: "file-summarizer" | "context-generator";
  sourceLabel: string;
  denials: RepoPermissionDenial[];
  subject?: string;
  attempt?: number;
  emittedToolUseIds?: Set<string>;
}): void {
  const {
    chatId,
    runId,
    repoAddress,
    stage,
    subagent,
    sourceLabel,
    denials,
    subject,
    attempt,
    emittedToolUseIds,
  } = input;

  for (const denial of denials) {
    if (denial.tool_use_id && emittedToolUseIds?.has(denial.tool_use_id)) {
      continue;
    }
    if (denial.tool_use_id) {
      emittedToolUseIds?.add(denial.tool_use_id);
    }

    const detail = denial.tool_input_summary ? ` ${denial.tool_input_summary}` : "";
    emitProgress(chatId, runId, repoAddress, {
      stage,
      event_kind: "tool_use",
      subagent,
      task_id: makeTaskId(subagent, subject, attempt),
      tool_name: denial.tool_name,
      ...(denial.tool_input_summary ? { tool_input_summary: denial.tool_input_summary } : {}),
      message: `[${sourceLabel}] permission denied for ${denial.tool_name}${detail}`,
      ...(subject ? { subject } : {}),
      ...(typeof attempt === "number" ? { attempt } : {}),
      success: false,
      error: `Permission denied for ${denial.tool_name}`,
      permission_denials: [denial],
    });
  }
}

function makeTaskId(
  subagent: "file-summarizer" | "context-generator",
  subject?: string,
  attempt?: number,
): string {
  if (subagent === "file-summarizer") {
    const normalizedSubject = subject?.trim() || "unknown-subject";
    const normalizedAttempt = typeof attempt === "number" ? attempt : 1;
    return `file-summarizer:${normalizedSubject}:attempt-${normalizedAttempt}`;
  }
  return "context-generator:single-run";
}

function emitToolUseProgress(
  chatId: string | undefined,
  runId: string,
  repoAddress: string,
  stage: "queue" | "context",
  subagent: "file-summarizer" | "context-generator",
  sourceLabel: string,
  toolName: string,
  toolInput: unknown,
  subject?: string,
  attempt?: number,
): void {
  const summarizedInput = summarizeToolInput(toolInput);
  const detail = summarizedInput ? ` ${summarizedInput}` : "";
  const taskId = makeTaskId(subagent, subject, attempt);

  emitProgress(chatId, runId, repoAddress, {
    stage,
    event_kind: "tool_use",
    subagent,
    task_id: taskId,
    tool_name: toolName,
    tool_input_summary: summarizedInput,
    message: `[${sourceLabel}] tool_use ${toolName}${detail}`,
    ...(subject ? { subject } : {}),
    ...(typeof attempt === "number" ? { attempt } : {}),
  });
}

function buildCostState(
  queueCostUsd: number,
  contextCostUsd: number,
  completedCount: number,
  lastJobCostUsd?: number,
): RepoProgressCostState {
  return {
    queue_cost_usd: queueCostUsd,
    context_cost_usd: contextCostUsd,
    total_cost_usd: queueCostUsd + contextCostUsd,
    avg_cost_per_completed_file_usd:
      completedCount > 0 ? queueCostUsd / completedCount : 0,
    ...(typeof lastJobCostUsd === "number" ? { last_job_cost_usd: lastJobCostUsd } : {}),
  };
}

function allowTool(input: Record<string, unknown>, suggestions?: CanUseToolSuggestions) {
  return {
    behavior: "allow" as const,
    updatedInput: input,
    ...(Array.isArray(suggestions) && suggestions.length > 0
      ? { updatedPermissions: suggestions }
      : {}),
  };
}

function denyTool(message: string) {
  return {
    behavior: "deny" as const,
    message,
  };
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  return { ...(input as Record<string, unknown>) };
}

function buildAllowlistCanUseTool(context: AllowlistCanUseToolContext): CanUseTool {
  const {
    allowedToolNames,
    chatId,
    runId,
    repoAddress,
    stage,
    subagent,
    sourceLabel,
    subject,
    attempt,
    denialToolUseIds,
  } = context;
  const allowedSet = new Set(allowedToolNames);
  return async (
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ) => {
    const normalizedInput = normalizeToolInput(input);

    if (!allowedSet.has(toolName)) {
      const toolInputSummary = summarizeToolInput(normalizedInput);
      const denial: RepoPermissionDenial = {
        tool_name: toolName,
        tool_use_id: options.toolUseID,
        ...(toolInputSummary ? { tool_input_summary: toolInputSummary } : {}),
      };
      emitPermissionDenialProgress({
        chatId,
        runId,
        repoAddress,
        stage,
        subagent,
        sourceLabel,
        denials: [denial],
        subject,
        attempt,
        emittedToolUseIds: denialToolUseIds,
      });

      return denyTool(`${toolName} is not allowed in this worker session.`);
    }
    return allowTool(normalizedInput, options.suggestions);
  };
}

function safeLoadPrompt(promptName: string, fallback: string): string {
  try {
    return load_prompt_sync(promptName);
  } catch (error) {
    console.error(`Failed to load prompt "${promptName}":`, error);
    return fallback;
  }
}

const FILE_SUMMARIZER_PROMPT = safeLoadPrompt(
  "file_summarizer",
  DEFAULT_FILE_SUMMARIZER_PROMPT,
);
const CONTEXT_GENERATOR_PROMPT = safeLoadPrompt(
  "context_generator",
  DEFAULT_CONTEXT_GENERATOR_PROMPT,
);

function resolveAgentModel(value: string | undefined, fallback: AgentModel): AgentModel {
  if (value === "sonnet" || value === "haiku" || value === "opus" || value === "inherit") {
    return value;
  }
  return fallback;
}

const FILE_SUMMARIZER_MODEL = resolveAgentModel(
  process.env.FILE_SUMMARIZER_MODEL,
  "haiku",
);
const CONTEXT_GENERATOR_MODEL = resolveAgentModel(
  process.env.CONTEXT_GENERATOR_MODEL,
  "haiku",
);

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

const DEFAULT_MAX_WORKERS = parsePositiveInteger(process.env.REPO_TEAM_MAX_WORKERS, 4);
const DEFAULT_RETRY_LIMIT = parsePositiveInteger(process.env.REPO_TEAM_RETRY_LIMIT, 1);
const DEFAULT_RETRY_BACKOFF_MS = parsePositiveInteger(process.env.REPO_TEAM_RETRY_BACKOFF_MS, 750);
const DEFAULT_FILE_SUMMARIZER_TIMEOUT_MS = parsePositiveInteger(
  process.env.REPO_TEAM_FILE_TIMEOUT_MS,
  120_000,
);
const DEFAULT_CONTEXT_TIMEOUT_MS = parsePositiveInteger(
  process.env.REPO_TEAM_CONTEXT_TIMEOUT_MS,
  120_000,
);
const DEFAULT_CONTEXT_HEARTBEAT_INTERVAL_MS = parsePositiveInteger(
  process.env.REPO_TEAM_CONTEXT_HEARTBEAT_MS,
  5_000,
);

const REF_GRAPH_PATH = path.resolve(process.cwd(), "data/ref-graph.json");

function resolveRepoAddress(repoAddress?: string): string {
  const normalizedRepoAddress = normalizeRepoPathInput(repoAddress);
  const resolvedPath = path.resolve(normalizedRepoAddress ?? process.cwd());
  if (!existsSync(resolvedPath) || !lstatSync(resolvedPath).isDirectory()) {
    throw new Error(
      `The provided path "${resolvedPath}" does not exist or is not a directory.`,
    );
  }
  return resolvedPath;
}

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
): Promise<IteratorResult<T>> {
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for agent output after ${timeoutMs} ms.`));
    }, timeoutMs);

    iterator.next().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function nextWithSoftTimeout<T>(
  pendingNext: Promise<IteratorResult<T>>,
  timeoutMs: number,
): Promise<{ kind: "item"; value: IteratorResult<T> } | { kind: "timeout" }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve({ kind: "timeout" });
    }, timeoutMs);

    pendingNext.then(
      (value) => {
        clearTimeout(timer);
        resolve({ kind: "item", value });
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function makeSingleMessagePrompt(content: string): AsyncIterable<SDKUserMessage> {
  return (async function* (): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: {
        role: "user",
        content,
      },
      parent_tool_use_id: null,
      session_id: "",
    };
  })();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function computeRepoKnowledgeStatus(
  repoAddress: string,
  forceRefresh: boolean,
): Promise<RepoKnowledgeStatus> {
  const fingerprint = await computeRepoFingerprint(repoAddress);
  const store = await loadFileSummariesStore();
  const refGraphContext = await readReferenceGraphContext();

  const summaryExists = existsSync(getContextSummaryPath());
  const refGraphExists = existsSync(REF_GRAPH_PATH);
  const fileSummariesExists = existsSync(getFileSummariesPath());
  const hasAllArtifacts = summaryExists && refGraphExists && fileSummariesExists;

  const matchesRepo = store?.repo_address === repoAddress;
  const matchesFingerprint = store?.fingerprint === fingerprint.fingerprint;
  const refGraphRepoMatches = refGraphContext.repo_address === repoAddress;
  const progress = summarizeStoreProgress(store);
  const progressComplete =
    progress.expected_count === 0 || progress.completed_count >= progress.expected_count;

  const cacheInvalidReasons: string[] = [];
  if (forceRefresh) {
    cacheInvalidReasons.push("force_refresh_requested");
  }
  if (!hasAllArtifacts) {
    cacheInvalidReasons.push("missing_required_artifacts");
  }
  if (!store) {
    cacheInvalidReasons.push("file_summaries_store_missing");
  }
  if (!matchesRepo) {
    cacheInvalidReasons.push("store_repo_mismatch");
  }
  if (!matchesFingerprint) {
    cacheInvalidReasons.push("store_fingerprint_mismatch");
  }
  if (!refGraphRepoMatches) {
    cacheInvalidReasons.push("ref_graph_repo_mismatch");
  }
  if (!progressComplete) {
    cacheInvalidReasons.push("file_summaries_incomplete");
  }

  return {
    repo_address: repoAddress,
    force_refresh: forceRefresh,
    cache_valid: cacheInvalidReasons.length === 0,
    cache_invalid_reasons: cacheInvalidReasons,
    current_fingerprint: fingerprint.fingerprint,
  };
}

function emitProgress(
  chatId: string | undefined,
  runId: string,
  repoAddress: string,
  partial: Omit<RepoProgressEvent, "type" | "chat_id" | "run_id" | "repo_address" | "timestamp">,
): void {
  if (!chatId || !chatId.trim()) {
    return;
  }

  const event: RepoProgressEvent = {
    type: "repo_progress",
    chat_id: chatId,
    run_id: runId,
    repo_address: repoAddress,
    timestamp: new Date().toISOString(),
    ...partial,
  };
  if (!event.event_kind) {
    event.event_kind = "pipeline";
  }

  if (SHOULD_LOG_REPO_PROGRESS) {
    const queue = event.queue
      ? ` queue(total=${event.queue.total},pending=${event.queue.pending},running=${event.queue.running},completed=${event.queue.completed},failed=${event.queue.failed},retries=${event.queue.retry_count})`
      : "";
    const cost = event.cost
      ? ` cost(total=${event.cost.total_cost_usd.toFixed(6)},queue=${event.cost.queue_cost_usd.toFixed(6)},context=${event.cost.context_cost_usd.toFixed(6)})`
      : "";
    const kind = event.event_kind ? ` kind=${event.event_kind}` : "";
    const task = event.task_id ? ` task=${event.task_id}` : "";
    const tool =
      event.tool_name
        ? ` tool=${event.tool_name}${event.tool_input_summary ? ` input=${JSON.stringify(event.tool_input_summary)}` : ""}`
        : "";
    const taskCost =
      typeof event.task_cost_usd === "number" ? ` task_cost=${event.task_cost_usd.toFixed(6)}` : "";
    const permissionDenials =
      Array.isArray(event.permission_denials) && event.permission_denials.length > 0
        ? ` permission_denials=${event.permission_denials
            .map((denial) =>
              `${denial.tool_name}${denial.tool_use_id ? `#${denial.tool_use_id}` : ""}${
                denial.tool_input_summary ? `(${truncateText(denial.tool_input_summary, 80)})` : ""
              }`,
            )
            .join(",")}`
        : "";
    const heartbeat =
      event.heartbeat
        ? ` heartbeat(seq=${event.heartbeat.seq},elapsed_ms=${event.heartbeat.elapsed_ms},idle_ms=${event.heartbeat.idle_ms},last_event=${event.heartbeat.last_event_type ?? "none"},last_tool=${event.heartbeat.last_tool_name ?? "none"},tool_use_count=${event.heartbeat.tool_use_count},tool_progress_count=${event.heartbeat.tool_progress_count},permission_denials_count=${event.heartbeat.permission_denials_count})`
        : "";
    console.log(
      `[repo_progress][chat=${chatId}][run=${runId}][${event.stage}]${kind}${task}${tool}${taskCost}${permissionDenials}${heartbeat} ${event.message}${queue}${cost}`,
    );
  }

  repoProgressBus.emit(event);
}

async function buildSummaryMarkdownFromStore(
  repoAddress: string,
  missingSubjects: string[],
): Promise<string> {
  const headingLines = [
    "# Repository Summary",
    "",
    `Repository: \`${repoAddress}\``,
    "",
  ];

  return loadFileSummariesStore()
    .then((store) => {
      const summaries = store?.summaries ?? {};
      const subjects = Object.keys(summaries).sort();

      if (subjects.length === 0) {
        return [
          ...headingLines,
          "## Project Overview",
          "",
          "No file summaries were available for this run.",
          "",
          "## Notable Gaps (Missing File Summaries)",
          "",
          missingSubjects.length > 0
            ? missingSubjects.map((subject) => `- \`${subject}\``).join("\n")
            : "- None",
          "",
        ].join("\n");
      }

      const moduleLines: string[] = [];
      for (const subject of subjects.slice(0, 40)) {
        const summary = summaries[subject];
        moduleLines.push(`- \`${subject}\`: ${summary.overall_summary}`);
      }

      const relationshipSet = new Set<string>();
      for (const summary of Object.values(summaries)) {
        for (const relationship of summary.important_relationships) {
          if (relationship.trim()) {
            relationshipSet.add(relationship.trim());
          }
        }
      }
      const relationshipLines = Array.from(relationshipSet)
        .sort()
        .slice(0, 60)
        .map((relationship) => `- \`${relationship}\``);

      return [
        ...headingLines,
        "## Project Overview",
        "",
        `Summarized ${subjects.length} file(s) from the configured source allowlist.`,
        "",
        "## Core Modules and Responsibilities",
        "",
        moduleLines.join("\n"),
        "",
        "## Important Cross-File Relationships",
        "",
        relationshipLines.length > 0 ? relationshipLines.join("\n") : "- None identified",
        "",
        "## Notable Gaps (Missing File Summaries)",
        "",
        missingSubjects.length > 0
          ? missingSubjects.map((subject) => `- \`${subject}\``).join("\n")
          : "- None",
        "",
      ].join("\n");
    })
    .catch((error) => {
      console.error("Failed to build fallback markdown from store:", error);
      return [
        ...headingLines,
        "## Project Overview",
        "",
        "A fallback summary was generated after context generation failed.",
        "",
        "## Notable Gaps (Missing File Summaries)",
        "",
        missingSubjects.length > 0
          ? missingSubjects.map((subject) => `- \`${subject}\``).join("\n")
          : "- None",
        "",
      ].join("\n");
    });
}

async function runFileSummarizerJob(
  mcpServer: unknown,
  repoAddress: string,
  subject: string,
  chatId: string | undefined,
  runId: string,
  attempt: number,
): Promise<WorkerRunResult> {
  const allowedTools = [
    "mcp__file__read_file",
    "mcp__file__return_reference_graph",
    "mcp__file__write_file_summary",
    "mcp__file__write_reference_summary",
  ];
  const prompt = [
    "Summarize one repository file and persist outputs.",
    `repo_address: ${repoAddress}`,
    `subject: ${subject}`,
    "Required:",
    `1) Call mcp__file__read_file with file_path=${JSON.stringify(path.resolve(repoAddress, subject))}`,
    `2) Call mcp__file__return_reference_graph with input_subject=${JSON.stringify(subject)}, type="file"`,
    "3) Build summary_json with overall_summary, file_cluster, important_relationships, group_function",
    `4) Call mcp__file__write_file_summary with subject=${JSON.stringify(subject)}`,
    `5) Call mcp__file__write_reference_summary with input_subject=${JSON.stringify(subject)}, type="file"`,
    "Return a one-line completion status.",
  ].join("\n");
  const denialToolUseIds = new Set<string>();

  try {
    const stream = query({
      prompt: makeSingleMessagePrompt(prompt),
      options: {
        maxTurns: 80,
        model: FILE_SUMMARIZER_MODEL,
        allowedTools,
        permissionMode: "dontAsk",
        mcpServers: {
          file: mcpServer,
        },
        canUseTool: buildAllowlistCanUseTool({
          allowedToolNames: allowedTools,
          chatId,
          runId,
          repoAddress,
          stage: "queue",
          subagent: "file-summarizer",
          sourceLabel: `file-summarizer:${subject}`,
          subject,
          attempt,
          denialToolUseIds,
        }),
        systemPrompt: FILE_SUMMARIZER_PROMPT,
      } as any,
    })[Symbol.asyncIterator]();

    let sawResult = false;
    let success = false;
    let errorMessage: string | null = null;
    let runCostUsd = 0;
    let permissionDenials: RepoPermissionDenial[] = [];
    const startedAt = Date.now();

    while (true) {
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = DEFAULT_FILE_SUMMARIZER_TIMEOUT_MS - elapsedMs;
      if (remainingMs <= 0) {
        throw new Error(
          `file summarizer timed out after ${DEFAULT_FILE_SUMMARIZER_TIMEOUT_MS} ms for ${subject}`,
        );
      }

      const { value, done } = await nextWithTimeout(stream, remainingMs);
      if (done) {
        break;
      }

      if (
        value &&
        typeof value === "object" &&
        (value as { type?: unknown }).type === "tool_progress"
      ) {
        const progressMessage = value as {
          tool_name?: unknown;
        };
        const toolName =
          typeof progressMessage.tool_name === "string" && progressMessage.tool_name.trim().length > 0
            ? progressMessage.tool_name
            : "unknown_tool";
        emitToolUseProgress(
          chatId,
          runId,
          repoAddress,
          "queue",
          "file-summarizer",
          `file-summarizer:${subject}`,
          toolName,
          undefined,
          subject,
          attempt,
        );
      }

      if (value && typeof value === "object" && (value as { type?: unknown }).type === "assistant") {
        const assistantMessage = value as {
          message?: {
            content?: unknown;
          };
        };
        const contentBlocks = assistantMessage.message?.content;
        if (Array.isArray(contentBlocks)) {
          for (const block of contentBlocks) {
            if (!block || typeof block !== "object") {
              continue;
            }

            const typedBlock = block as {
              type?: unknown;
              name?: unknown;
              input?: unknown;
            };
            if (typedBlock.type !== "tool_use") {
              continue;
            }

            const toolName =
              typeof typedBlock.name === "string" && typedBlock.name.trim().length > 0
                ? typedBlock.name
                : "unknown_tool";
            emitToolUseProgress(
              chatId,
              runId,
              repoAddress,
              "queue",
              "file-summarizer",
              `file-summarizer:${subject}`,
              toolName,
              typedBlock.input,
              subject,
              attempt,
            );
          }
        }
      }

      if (value && typeof value === "object" && (value as { type?: unknown }).type === "result") {
        sawResult = true;
        const result = value as {
          subtype?: unknown;
          is_error?: unknown;
          result?: unknown;
          permission_denials?: unknown;
          total_cost_usd?: unknown;
        };
        runCostUsd = normalizeCost(result.total_cost_usd);
        success = result.subtype === "success" && result.is_error !== true;
        permissionDenials = parsePermissionDenials(result.permission_denials);
        if (permissionDenials.length > 0) {
          emitPermissionDenialProgress({
            chatId,
            runId,
            repoAddress,
            stage: "queue",
            subagent: "file-summarizer",
            sourceLabel: `file-summarizer:${subject}`,
            denials: permissionDenials,
            subject,
            attempt,
            emittedToolUseIds: denialToolUseIds,
          });
        }
        if (permissionDenials.length > 0) {
          success = false;
          errorMessage = formatPermissionDenialsError(permissionDenials);
        } else if (!success) {
          errorMessage =
            typeof result.result === "string" && result.result.trim()
              ? result.result
              : "file summarizer result was not successful";
        }
        break;
      }
    }

    if (!sawResult) {
      return {
        success: false,
        error: "file summarizer stream ended without terminal result",
        cost_usd: 0,
        permission_denials: [],
      };
    }

    return {
      success,
      error: success ? null : errorMessage ?? "file summarizer failed",
      cost_usd: runCostUsd,
      permission_denials: permissionDenials,
    };
  } catch (error) {
    return {
      success: false,
      error: toErrorMessage(error),
      cost_usd: 0,
      permission_denials: [],
    };
  }
}

async function runContextGenerator(
  mcpServer: unknown,
  repoAddress: string,
  chatId: string | undefined,
  runId: string,
): Promise<WorkerRunResult> {
  const allowedTools = [
    "mcp__file__read_file_summaries",
    "mcp__file__write_context_summary",
    "Bash",
    "Write",
  ];
  const prompt = [
    "Generate repository context summary markdown from file summaries.",
    `repo_address: ${repoAddress}`,
    "Required:",
    "1) Call mcp__file__read_file_summaries",
    "2) Build markdown summary",
    "3) Call mcp__file__write_context_summary",
    "Return one-line completion status.",
  ].join("\n");
  const denialToolUseIds = new Set<string>();

  try {
    const stream = query({
      prompt: makeSingleMessagePrompt(prompt),
      options: {
        maxTurns: 60,
        model: CONTEXT_GENERATOR_MODEL,
        allowedTools,
        permissionMode: "dontAsk",
        mcpServers: {
          file: mcpServer,
        },
        canUseTool: buildAllowlistCanUseTool({
          allowedToolNames: allowedTools,
          chatId,
          runId,
          repoAddress,
          stage: "context",
          subagent: "context-generator",
          sourceLabel: "context-generator",
          denialToolUseIds,
        }),
        systemPrompt: CONTEXT_GENERATOR_PROMPT,
      } as any,
    })[Symbol.asyncIterator]();

    let sawResult = false;
    let success = false;
    let errorMessage: string | null = null;
    let runCostUsd = 0;
    let permissionDenials: RepoPermissionDenial[] = [];
    const startedAt = Date.now();
    const contextTaskId = makeTaskId("context-generator");
    let heartbeatSeq = 0;
    let toolUseCount = 0;
    let toolProgressCount = 0;
    let permissionDenialsCount = 0;
    let lastEventType: string | undefined;
    let lastToolName: string | undefined;
    let lastActivityAt = startedAt;
    let pendingNext: Promise<IteratorResult<unknown>> | null = null;

    while (true) {
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = DEFAULT_CONTEXT_TIMEOUT_MS - elapsedMs;
      if (remainingMs <= 0) {
        throw new Error(`context generator timed out after ${DEFAULT_CONTEXT_TIMEOUT_MS} ms`);
      }

      const pollMs = Math.min(remainingMs, DEFAULT_CONTEXT_HEARTBEAT_INTERVAL_MS);
      if (!pendingNext) {
        pendingNext = stream.next();
      }
      const polled = await nextWithSoftTimeout(pendingNext, pollMs);
      if (polled.kind === "timeout") {
        heartbeatSeq += 1;
        const now = Date.now();
        const knownDenials = Math.max(permissionDenialsCount, denialToolUseIds.size);
        emitProgress(chatId, runId, repoAddress, {
          stage: "context",
          event_kind: "task_update",
          subagent: "context-generator",
          task_id: contextTaskId,
          task_status: "running",
          message: `Context heartbeat #${heartbeatSeq}: elapsed=${now - startedAt}ms idle=${
            now - lastActivityAt
          }ms last_event=${lastEventType ?? "none"} last_tool=${lastToolName ?? "none"} tool_uses=${toolUseCount} tool_progress=${toolProgressCount} permission_denials=${knownDenials}`,
          heartbeat: {
            seq: heartbeatSeq,
            elapsed_ms: now - startedAt,
            idle_ms: now - lastActivityAt,
            ...(lastEventType ? { last_event_type: lastEventType } : {}),
            ...(lastToolName ? { last_tool_name: lastToolName } : {}),
            tool_use_count: toolUseCount,
            tool_progress_count: toolProgressCount,
            permission_denials_count: knownDenials,
          },
        });
        continue;
      }

      const { value, done } = polled.value;
      pendingNext = null;
      if (done) {
        break;
      }
      lastActivityAt = Date.now();
      if (
        value &&
        typeof value === "object" &&
        typeof (value as { type?: unknown }).type === "string"
      ) {
        lastEventType = (value as { type: string }).type;
      }

      if (
        value &&
        typeof value === "object" &&
        (value as { type?: unknown }).type === "tool_progress"
      ) {
        const progressMessage = value as {
          tool_name?: unknown;
        };
        const toolName =
          typeof progressMessage.tool_name === "string" && progressMessage.tool_name.trim().length > 0
            ? progressMessage.tool_name
            : "unknown_tool";
        toolProgressCount += 1;
        lastEventType = "tool_progress";
        lastToolName = toolName;
        emitToolUseProgress(
          chatId,
          runId,
          repoAddress,
          "context",
          "context-generator",
          "context-generator",
          toolName,
          undefined,
        );
      }

      if (value && typeof value === "object" && (value as { type?: unknown }).type === "assistant") {
        const assistantMessage = value as {
          message?: {
            content?: unknown;
          };
        };
        const contentBlocks = assistantMessage.message?.content;
        if (Array.isArray(contentBlocks)) {
          for (const block of contentBlocks) {
            if (!block || typeof block !== "object") {
              continue;
            }

            const typedBlock = block as {
              type?: unknown;
              name?: unknown;
              input?: unknown;
            };
            if (typedBlock.type !== "tool_use") {
              continue;
            }

            const toolName =
              typeof typedBlock.name === "string" && typedBlock.name.trim().length > 0
                ? typedBlock.name
                : "unknown_tool";
            toolUseCount += 1;
            lastEventType = "assistant.tool_use";
            lastToolName = toolName;
            emitToolUseProgress(
              chatId,
              runId,
              repoAddress,
              "context",
              "context-generator",
              "context-generator",
              toolName,
              typedBlock.input,
            );
          }
        }
      }

      if (value && typeof value === "object" && (value as { type?: unknown }).type === "result") {
        sawResult = true;
        lastEventType = "result";
        const result = value as {
          subtype?: unknown;
          is_error?: unknown;
          result?: unknown;
          permission_denials?: unknown;
          total_cost_usd?: unknown;
        };
        runCostUsd = normalizeCost(result.total_cost_usd);
        success = result.subtype === "success" && result.is_error !== true;
        permissionDenials = parsePermissionDenials(result.permission_denials);
        permissionDenialsCount += permissionDenials.length;
        if (permissionDenials.length > 0) {
          emitPermissionDenialProgress({
            chatId,
            runId,
            repoAddress,
            stage: "context",
            subagent: "context-generator",
            sourceLabel: "context-generator",
            denials: permissionDenials,
            emittedToolUseIds: denialToolUseIds,
          });
        }
        if (permissionDenials.length > 0) {
          success = false;
          errorMessage = formatPermissionDenialsError(permissionDenials);
        } else if (!success) {
          errorMessage =
            typeof result.result === "string" && result.result.trim()
              ? result.result
              : "context generator result was not successful";
        }
        break;
      }
    }

    if (!sawResult) {
      return {
        success: false,
        error: "context generator stream ended without terminal result",
        cost_usd: 0,
        permission_denials: [],
      };
    }

    return {
      success,
      error: success ? null : errorMessage ?? "context generator failed",
      cost_usd: runCostUsd,
      permission_denials: permissionDenials,
    };
  } catch (error) {
    return {
      success: false,
      error: toErrorMessage(error),
      cost_usd: 0,
      permission_denials: [],
    };
  }
}

async function runQueue(
  mcpServer: unknown,
  repoAddress: string,
  chatId: string | undefined,
  runId: string,
  subjects: string[],
  maxWorkers: number,
): Promise<QueueRunResult> {
  const queueState: RepoProgressQueueState = {
    total: subjects.length,
    pending: subjects.length,
    running: 0,
    completed: 0,
    failed: 0,
    retry_count: 0,
  };

  const pending: QueueSubject[] = subjects.map((subject) => ({ subject, attempt: 1 }));
  const inFlight = new Map<
    number,
    Promise<{ token: number; subject: string; attempt: number; result: WorkerRunResult }>
  >();
  const failedSubjects = new Set<string>();
  let queueCostUsd = 0;

  let tokenCounter = 0;
  const workerCount = Math.max(1, Math.min(maxWorkers, subjects.length || 1));

  emitProgress(chatId, runId, repoAddress, {
    stage: "queue",
    message: `Queue started with ${subjects.length} file(s) and ${workerCount} worker(s).`,
    queue: { ...queueState },
    cost: buildCostState(queueCostUsd, 0, queueState.completed),
  });

  const startWorker = (subject: string, attempt: number): void => {
    const token = ++tokenCounter;
    const taskId = makeTaskId("file-summarizer", subject, attempt);
    queueState.pending -= 1;
    queueState.running += 1;

    emitProgress(chatId, runId, repoAddress, {
      stage: "queue",
      message: `Starting file summarizer for ${subject} (attempt ${attempt}).`,
      event_kind: "task_update",
      subagent: "file-summarizer",
      task_id: taskId,
      task_status: "running",
      subject,
      attempt,
      queue: { ...queueState },
      cost: buildCostState(queueCostUsd, 0, queueState.completed),
    });

    const promise = runFileSummarizerJob(
      mcpServer,
      repoAddress,
      subject,
      chatId,
      runId,
      attempt,
    ).then((result) => ({
      token,
      subject,
      attempt,
      result,
    }));
    inFlight.set(token, promise);
  };

  while (pending.length > 0 || inFlight.size > 0) {
    while (pending.length > 0 && inFlight.size < workerCount) {
      const next = pending.shift();
      if (!next) {
        break;
      }
      startWorker(next.subject, next.attempt);
    }

    if (inFlight.size === 0) {
      continue;
    }

    const finished = await Promise.race(inFlight.values());
    inFlight.delete(finished.token);
    queueState.running -= 1;
    queueCostUsd += finished.result.cost_usd;
    const finishedTaskId = makeTaskId("file-summarizer", finished.subject, finished.attempt);

    if (finished.result.success) {
      queueState.completed += 1;
      emitProgress(chatId, runId, repoAddress, {
        stage: "queue",
        message: `Completed summary for ${finished.subject} (job_cost_usd=${finished.result.cost_usd.toFixed(6)}, total_queue_cost_usd=${queueCostUsd.toFixed(6)}).`,
        event_kind: "task_update",
        subagent: "file-summarizer",
        task_id: finishedTaskId,
        task_status: "completed",
        task_cost_usd: finished.result.cost_usd,
        subject: finished.subject,
        attempt: finished.attempt,
        success: true,
        queue: { ...queueState },
        cost: buildCostState(
          queueCostUsd,
          0,
          queueState.completed,
          finished.result.cost_usd,
        ),
      });
      continue;
    }

    console.error(
      `[repo-team][run=${runId}] file summarizer failed for ${finished.subject} (attempt ${finished.attempt}): ${
        finished.result.error ?? "unknown failure"
      }`,
    );
    if (finished.result.permission_denials.length > 0) {
      console.error(
        `[repo-team][run=${runId}] permission denials for ${finished.subject} (attempt ${finished.attempt}):`,
        finished.result.permission_denials,
      );
    }

    if (finished.attempt <= DEFAULT_RETRY_LIMIT) {
      queueState.retry_count += 1;
      queueState.pending += 1;
      pending.push({
        subject: finished.subject,
        attempt: finished.attempt + 1,
      });
      await new Promise((resolve) => setTimeout(resolve, DEFAULT_RETRY_BACKOFF_MS));
      emitProgress(chatId, runId, repoAddress, {
        stage: "queue",
        message: `Retrying ${finished.subject} after failure (job_cost_usd=${finished.result.cost_usd.toFixed(6)}, total_queue_cost_usd=${queueCostUsd.toFixed(6)}).`,
        event_kind: "task_update",
        subagent: "file-summarizer",
        task_id: finishedTaskId,
        task_status: "failed",
        task_cost_usd: finished.result.cost_usd,
        subject: finished.subject,
        attempt: finished.attempt,
        success: false,
        error: finished.result.error ?? "unknown failure",
        ...(finished.result.permission_denials.length > 0
          ? { permission_denials: finished.result.permission_denials }
          : {}),
        queue: { ...queueState },
        cost: buildCostState(
          queueCostUsd,
          0,
          queueState.completed,
          finished.result.cost_usd,
        ),
      });
      continue;
    }

    queueState.failed += 1;
    failedSubjects.add(finished.subject);
    emitProgress(chatId, runId, repoAddress, {
      stage: "queue",
      message: `Failed summary for ${finished.subject} after retries (job_cost_usd=${finished.result.cost_usd.toFixed(6)}, total_queue_cost_usd=${queueCostUsd.toFixed(6)}).`,
      event_kind: "task_update",
      subagent: "file-summarizer",
      task_id: finishedTaskId,
      task_status: "failed",
      task_cost_usd: finished.result.cost_usd,
      subject: finished.subject,
      attempt: finished.attempt,
      success: false,
      error: finished.result.error ?? "unknown failure",
      ...(finished.result.permission_denials.length > 0
        ? { permission_denials: finished.result.permission_denials }
        : {}),
      queue: { ...queueState },
      cost: buildCostState(
        queueCostUsd,
        0,
        queueState.completed,
        finished.result.cost_usd,
      ),
    });
  }

  emitProgress(chatId, runId, repoAddress, {
    stage: "queue",
    message: `Queue finished: completed=${queueState.completed}, failed=${queueState.failed}, queue_cost_usd=${queueCostUsd.toFixed(6)}.`,
    queue: { ...queueState },
    cost: buildCostState(queueCostUsd, 0, queueState.completed),
  });

  return {
    queue: queueState,
    queue_cost_usd: queueCostUsd,
    failed_subjects: Array.from(failedSubjects).sort(),
  };
}

export async function runRepoKnowledgeTeamPipeline(
  input: RunRepoKnowledgeTeamPipelineInput,
): Promise<RepoKnowledgeTeamPipelineReport> {
  const startedAt = Date.now();
  const runId = uuidv4();
  const forceRefresh = input.force_refresh ?? false;
  const repoAddress = resolveRepoAddress(input.repo_address);
  const chatId = input.chat_id?.trim() ? input.chat_id.trim() : undefined;
  const maxWorkers = Math.max(1, input.max_workers ?? DEFAULT_MAX_WORKERS);

  if (!input.mcp_server) {
    throw new Error("mcp_server is required for team pipeline execution.");
  }

  emitProgress(chatId, runId, repoAddress, {
    stage: "status",
    message: "Computing repository knowledge status.",
  });

  const status = await computeRepoKnowledgeStatus(repoAddress, forceRefresh);

  if (status.cache_valid && !status.force_refresh) {
    await readContextSummary();
    const cachedProgress = summarizeStoreProgress(await loadFileSummariesStore());
    const report: RepoKnowledgeTeamPipelineReport = {
      cache_used: true,
      repo_address: repoAddress,
      force_refresh: forceRefresh,
      total_subjects: cachedProgress.expected_count,
      completed_subjects: cachedProgress.completed_count,
      missing_count: cachedProgress.missing_subjects.length,
      missing_subjects: cachedProgress.missing_subjects,
      no_supported_files: cachedProgress.expected_count === 0,
      message: "Cache is valid. Reused existing repository knowledge artifacts.",
      fallback_used: false,
      cache_invalid_reasons: status.cache_invalid_reasons,
      run_id: runId,
      queue_total: 0,
      queue_completed: 0,
      queue_failed: 0,
      retry_count: 0,
      queue_cost_usd: 0,
      context_cost_usd: 0,
      total_cost_usd: 0,
      avg_cost_per_completed_file_usd: 0,
      duration_ms: Date.now() - startedAt,
    };

    emitProgress(chatId, runId, repoAddress, {
      stage: "complete",
      message: report.message,
      queue: {
        total: 0,
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        retry_count: 0,
      },
      cost: buildCostState(0, 0, 0),
    });

    return report;
  }

  emitProgress(chatId, runId, repoAddress, {
    stage: "index",
    message: "Indexing repository sources and reference graph.",
  });
  const indexResult = await indexRepositoryAst(repoAddress);

  const subjects = await listReferenceSubjects("file");

  emitProgress(chatId, runId, repoAddress, {
    stage: "prepare",
    message: `Preparing file summary store for ${subjects.length} subject(s).`,
  });
  await prepareFileSummariesStore(repoAddress, status.current_fingerprint, subjects);

  const queueResult = await runQueue(
    input.mcp_server,
    repoAddress,
    chatId,
    runId,
    subjects,
    maxWorkers,
  );

  const refreshedStore = await loadFileSummariesStore();
  let progress = summarizeStoreProgress(refreshedStore);
  const contextTaskId = makeTaskId("context-generator");

  emitProgress(chatId, runId, repoAddress, {
    stage: "context",
    message: "Generating repository context summary.",
    event_kind: "task_update",
    subagent: "context-generator",
    task_id: contextTaskId,
    task_status: "running",
    queue: { ...queueResult.queue },
    cost: buildCostState(
      queueResult.queue_cost_usd,
      0,
      queueResult.queue.completed,
    ),
  });

  let fallbackUsed = false;
  const contextRun = await runContextGenerator(input.mcp_server, repoAddress, chatId, runId);
  if (!contextRun.success) {
    console.error(
      `[repo-team][run=${runId}] context generator failed: ${contextRun.error ?? "unknown failure"}`,
    );
    if (contextRun.permission_denials.length > 0) {
      console.error(
        `[repo-team][run=${runId}] context generator permission denials:`,
        contextRun.permission_denials,
      );
    }
    const fallbackMarkdown = await buildSummaryMarkdownFromStore(
      repoAddress,
      progress.missing_subjects,
    );
    await writeContextSummary(fallbackMarkdown);
    fallbackUsed = true;
    emitProgress(chatId, runId, repoAddress, {
      stage: "context",
      message: `Context generator failed; wrote direct fallback summary markdown (context_cost_usd=${contextRun.cost_usd.toFixed(6)}).`,
      event_kind: "task_update",
      subagent: "context-generator",
      task_id: contextTaskId,
      task_status: "failed",
      task_cost_usd: contextRun.cost_usd,
      success: false,
      error: contextRun.error ?? "context generator failed",
      ...(contextRun.permission_denials.length > 0
        ? { permission_denials: contextRun.permission_denials }
        : {}),
      queue: { ...queueResult.queue },
      cost: buildCostState(
        queueResult.queue_cost_usd,
        contextRun.cost_usd,
        queueResult.queue.completed,
      ),
    });
  } else {
    emitProgress(chatId, runId, repoAddress, {
      stage: "context",
      message: `Context summary generated (context_cost_usd=${contextRun.cost_usd.toFixed(6)}).`,
      event_kind: "task_update",
      subagent: "context-generator",
      task_id: contextTaskId,
      task_status: "completed",
      task_cost_usd: contextRun.cost_usd,
      success: true,
      queue: { ...queueResult.queue },
      cost: buildCostState(
        queueResult.queue_cost_usd,
        contextRun.cost_usd,
        queueResult.queue.completed,
      ),
    });
  }

  // Re-read after context generation/fallback to ensure final counts reflect persisted state.
  progress = summarizeStoreProgress(await loadFileSummariesStore());
  const noSupportedFiles = subjects.length === 0;

  const message = noSupportedFiles
    ? indexResult.status_message ??
      "No supported source files found for configured extension allowlist."
    : progress.missing_subjects.length === 0
      ? "Repository knowledge team pipeline completed."
      : "Repository knowledge team pipeline completed with partial file summary coverage.";

  const report: RepoKnowledgeTeamPipelineReport = {
    cache_used: false,
    repo_address: repoAddress,
    force_refresh: forceRefresh,
    total_subjects: subjects.length,
    completed_subjects: progress.completed_count,
    missing_count: progress.missing_subjects.length,
    missing_subjects: progress.missing_subjects,
    no_supported_files: noSupportedFiles,
    message,
    fallback_used: fallbackUsed,
    cache_invalid_reasons: status.cache_invalid_reasons,
    run_id: runId,
    queue_total: queueResult.queue.total,
    queue_completed: queueResult.queue.completed,
    queue_failed: queueResult.queue.failed,
    retry_count: queueResult.queue.retry_count,
    queue_cost_usd: queueResult.queue_cost_usd,
    context_cost_usd: contextRun.cost_usd,
    total_cost_usd: queueResult.queue_cost_usd + contextRun.cost_usd,
    avg_cost_per_completed_file_usd:
      queueResult.queue.completed > 0
        ? queueResult.queue_cost_usd / queueResult.queue.completed
        : 0,
    duration_ms: Date.now() - startedAt,
  };

  emitProgress(chatId, runId, repoAddress, {
    stage: "complete",
    message: report.message,
    queue: { ...queueResult.queue },
    cost: buildCostState(
      report.queue_cost_usd,
      report.context_cost_usd,
      report.queue_completed,
    ),
  });

  return report;
}
