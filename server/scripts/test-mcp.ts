import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { customServer } from "../custom-tools";
import { load_prompt_sync } from "../prompt-loader";
import {
  getFileSummariesPath,
  loadFileSummariesStore,
  summarizeStoreProgress,
} from "../file-summary-store";
import { getContextSummaryPath } from "../context-summary";
import { listReferenceNodes, readReferenceGraphContext } from "../reference-graph";
import { normalizeRepoPathInput } from "../path-normalization";

type HarnessMode = "tool" | "agent";

type ParsedArgs = {
  mode: HarnessMode;
  repo: string;
  tool?: string;
  args?: string;
  withWrites: boolean;
  output: string;
  forceRefresh: boolean;
  timeoutMs: number;
  includeDirectory: boolean;
  resetStore: boolean;
  rawArgv: string[];
};

type RegisteredTool = {
  inputSchema?: unknown;
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

type AgentModel = "sonnet" | "haiku" | "opus" | "inherit";

type TaskTarget = "repo-knowledge" | "file-summarizer" | "context-generator" | "unknown";

type ChainTracker = {
  task_calls_total: number;
  repo_knowledge_tasks: number;
  file_summarizer_tasks: number;
  context_generator_tasks: number;
  unknown_task_calls: number;
  team_pipeline_tool_calls: number;
};

type ValidationCheck = {
  name: string;
  pass: boolean;
  details: string;
};

type ArtifactValidationResult = {
  checks: ValidationCheck[];
  progress: {
    expected_count: number;
    completed_count: number;
    missing_subjects: string[];
  };
  summaryCount: number;
  summarizedFileNodeCount: number;
  summaryBytes: number;
  firstHeading: string | null;
};

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_TOOL_OUTPUT_PATH = path.resolve(process.cwd(), "data/mcp-test-output-tool.txt");
const DEFAULT_AGENT_OUTPUT_PATH = path.resolve(process.cwd(), "data/mcp-test-output-agent.txt");
const REF_GRAPH_PATH = path.resolve(process.cwd(), "data/ref-graph.json");

const DEFAULT_FILE_SUMMARIZER_PROMPT =
  "You are a specialized file summarizer. Summarize one file and write results using the available tools.";
const DEFAULT_CONTEXT_GENERATOR_PROMPT =
  "You are a repository context generator. Read file summaries and write summary markdown.";
const DEFAULT_REPO_KNOWLEDGE_PROMPT =
  "You are a cache-first repo knowledge orchestrator. Reuse cache when valid, rebuild when stale.";

function parseMode(value: string): HarnessMode {
  if (value === "tool" || value === "agent") {
    return value;
  }

  throw new Error(`Invalid --mode value: ${value}. Expected "tool" or "agent".`);
}

function parseTimeout(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --timeout-ms value: ${value}. Expected positive integer.`);
  }
  return parsed;
}

function resolveAgentModel(value: string | undefined, fallback: AgentModel): AgentModel {
  if (value === "sonnet" || value === "haiku" || value === "opus" || value === "inherit") {
    return value;
  }

  return fallback;
}

function safeLoadPrompt(promptName: string, fallback: string): string {
  try {
    return load_prompt_sync(promptName);
  } catch {
    return fallback;
  }
}

function parseCliArgs(argv: string[]): ParsedArgs {
  let forceRefreshOverride: boolean | undefined;
  let outputOverride: string | undefined;

  const parsed: ParsedArgs = {
    mode: "tool",
    repo: process.cwd(),
    withWrites: false,
    output: "",
    forceRefresh: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    includeDirectory: false,
    resetStore: false,
    rawArgv: argv,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];

    if (current === "--mode" && next) {
      parsed.mode = parseMode(next);
      i += 1;
      continue;
    }

    if (current === "--repo" && next) {
      parsed.repo = path.resolve(normalizeRepoPathInput(next) ?? next);
      i += 1;
      continue;
    }

    if (current === "--tool" && next) {
      parsed.tool = next;
      i += 1;
      continue;
    }

    if (current === "--args" && next) {
      parsed.args = next;
      i += 1;
      continue;
    }

    if (current === "--with-writes") {
      parsed.withWrites = true;
      continue;
    }

    if (current === "--output" && next) {
      outputOverride = path.resolve(next);
      i += 1;
      continue;
    }

    if (current === "--force-refresh") {
      forceRefreshOverride = true;
      continue;
    }

    if (current === "--no-force-refresh") {
      forceRefreshOverride = false;
      continue;
    }

    if (current === "--timeout-ms" && next) {
      parsed.timeoutMs = parseTimeout(next);
      i += 1;
      continue;
    }

    if (current === "--include-directory") {
      parsed.includeDirectory = true;
      continue;
    }

    if (current === "--reset-store") {
      parsed.resetStore = true;
      continue;
    }
  }

  parsed.forceRefresh =
    parsed.mode === "agent" ? forceRefreshOverride ?? true : forceRefreshOverride ?? false;
  parsed.output =
    outputOverride ??
    (parsed.mode === "agent" ? DEFAULT_AGENT_OUTPUT_PATH : DEFAULT_TOOL_OUTPUT_PATH);

  return parsed;
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  return { ...(input as Record<string, unknown>) };
}

function allowTool(input: unknown, suggestions?: unknown) {
  return {
    behavior: "allow" as const,
    updatedInput: normalizeToolInput(input),
    ...(Array.isArray(suggestions) && suggestions.length > 0
      ? { updatedPermissions: suggestions as any }
      : {}),
  };
}

function denyTool(message: string) {
  return {
    behavior: "deny" as const,
    message,
  };
}

function getRegisteredTools(): Record<string, RegisteredTool> {
  const raw = (customServer.instance as unknown as { _registeredTools?: unknown })
    ._registeredTools;
  if (!raw || typeof raw !== "object") {
    throw new Error("Unable to read registered MCP tools from custom server instance.");
  }

  return raw as Record<string, RegisteredTool>;
}

async function validateInputSchema(tool: RegisteredTool, args: unknown): Promise<unknown> {
  const inputSchema = tool.inputSchema as
    | {
        safeParseAsync?: (v: unknown) => Promise<{
          success: boolean;
          data?: unknown;
          error?: unknown;
        }>;
      }
    | undefined;

  if (!inputSchema || typeof inputSchema.safeParseAsync !== "function") {
    return args;
  }

  const parsed = await inputSchema.safeParseAsync(args);
  if (!parsed.success) {
    throw new Error(`Input validation failed: ${String(parsed.error)}`);
  }

  return parsed.data;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return `<<non-serializable value: ${error instanceof Error ? error.message : String(error)}>>`;
  }
}

function tryParseToolPayload(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return null;
  }

  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return null;
  }

  const first = content[0] as { text?: unknown };
  if (!first || typeof first.text !== "string") {
    return null;
  }

  try {
    return JSON.parse(first.text);
  } catch {
    return null;
  }
}

async function callTool(
  tools: Record<string, RegisteredTool>,
  toolName: string,
  args: Record<string, unknown>,
  log: (line: string) => void,
): Promise<unknown> {
  const tool = tools[toolName];
  if (!tool) {
    throw new Error(`Tool not found: ${toolName}`);
  }

  const validatedArgs = await validateInputSchema(tool, args);
  const result = await tool.handler(validatedArgs, {});
  const parsedPayload = tryParseToolPayload(result);

  log(`\n=== ${toolName} ===`);
  log("args:");
  log(safeJsonStringify(args));
  log("raw result:");
  log(safeJsonStringify(result));
  if (parsedPayload !== null) {
    log("parsed payload:");
    log(safeJsonStringify(parsedPayload));
  } else {
    log("parsed payload: <none>");
  }

  return result;
}

function extractPayload(result: unknown): Record<string, unknown> {
  const payload = tryParseToolPayload(result);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }

  return payload as Record<string, unknown>;
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

function extractTaskTarget(input: unknown): TaskTarget {
  if (!input || typeof input !== "object") {
    return "unknown";
  }

  const record = input as Record<string, unknown>;
  const explicitKeys = ["subagent_type", "subagent", "agent", "agent_name", "target_agent"];
  for (const key of explicitKeys) {
    const value = record[key];
    if (typeof value !== "string") {
      continue;
    }

    if (value === "repo-knowledge") {
      return "repo-knowledge";
    }
    if (value === "file-summarizer") {
      return "file-summarizer";
    }
    if (value === "context-generator") {
      return "context-generator";
    }
  }

  const textFields = [record.prompt, record.description, record.task]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();

  const matches: TaskTarget[] = [];
  if (textFields.includes("repo-knowledge")) {
    matches.push("repo-knowledge");
  }
  if (textFields.includes("file-summarizer")) {
    matches.push("file-summarizer");
  }
  if (textFields.includes("context-generator")) {
    matches.push("context-generator");
  }

  if (matches.length === 1) {
    return matches[0];
  }

  return "unknown";
}

function updateChainTrackerForToolUse(
  toolName: string | null,
  toolInput: unknown,
  tracker: ChainTracker,
): void {
  if (toolName === "mcp__file__run_repo_knowledge_team_pipeline") {
    tracker.team_pipeline_tool_calls += 1;
  }

  if (toolName !== "Task") {
    return;
  }

  tracker.task_calls_total += 1;
  const target = extractTaskTarget(toolInput);
  if (target === "repo-knowledge") {
    tracker.repo_knowledge_tasks += 1;
    return;
  }
  if (target === "file-summarizer") {
    tracker.file_summarizer_tasks += 1;
    return;
  }
  if (target === "context-generator") {
    tracker.context_generator_tasks += 1;
    return;
  }
  tracker.unknown_task_calls += 1;
}

function logContentBlocks(
  content: unknown,
  log: (line: string) => void,
  tracker?: ChainTracker,
): void {
  if (typeof content === "string") {
    log("text:");
    log(content);
    return;
  }

  if (!Array.isArray(content)) {
    log("content:");
    log(safeJsonStringify(content));
    return;
  }

  for (const block of content) {
    if (!block || typeof block !== "object") {
      log("block:");
      log(safeJsonStringify(block));
      continue;
    }

    const typedBlock = block as {
      type?: unknown;
      text?: unknown;
      id?: unknown;
      name?: unknown;
      input?: unknown;
      tool_use_id?: unknown;
      content?: unknown;
      is_error?: unknown;
    };

    if (typedBlock.type === "text") {
      log("text:");
      log(typeof typedBlock.text === "string" ? typedBlock.text : safeJsonStringify(typedBlock));
      continue;
    }

    if (typedBlock.type === "tool_use") {
      const toolName = typeof typedBlock.name === "string" ? typedBlock.name : null;
      const toolId = typeof typedBlock.id === "string" ? typedBlock.id : "no-id";
      log(`tool_use: ${toolName ?? "<unknown>"} (${toolId})`);
      log("tool_input:");
      log(safeJsonStringify(typedBlock.input));
      if (tracker) {
        updateChainTrackerForToolUse(toolName, typedBlock.input, tracker);
      }
      continue;
    }

    if (typedBlock.type === "tool_result") {
      const toolUseId =
        typeof typedBlock.tool_use_id === "string" ? typedBlock.tool_use_id : "unknown";
      log(`tool_result: ${toolUseId}`);
      log(`tool_result_is_error: ${String(Boolean(typedBlock.is_error))}`);
      log("tool_result_content:");
      log(safeJsonStringify(typedBlock.content));
      continue;
    }

    log("block:");
    log(safeJsonStringify(block));
  }
}

function logSdkEvent(
  message: unknown,
  log: (line: string) => void,
  tracker: ChainTracker,
): void {
  if (!message || typeof message !== "object") {
    log("\n=== event ===");
    log(safeJsonStringify(message));
    return;
  }

  const typedMessage = message as {
    type?: unknown;
    subtype?: unknown;
    duration_ms?: unknown;
    total_cost_usd?: unknown;
    message?: { content?: unknown } | undefined;
    [key: string]: unknown;
  };

  const type = typeof typedMessage.type === "string" ? typedMessage.type : "unknown";
  log(`\n=== ${type} ===`);

  if (typeof typedMessage.subtype === "string") {
    log(`subtype: ${typedMessage.subtype}`);
  }
  if (typeof typedMessage.duration_ms === "number") {
    log(`duration_ms: ${typedMessage.duration_ms}`);
  }
  if (typeof typedMessage.total_cost_usd === "number") {
    log(`total_cost_usd: ${typedMessage.total_cost_usd}`);
  }

  if (typedMessage.message && typeof typedMessage.message === "object") {
    logContentBlocks(typedMessage.message.content, log, tracker);
    return;
  }

  log(safeJsonStringify(message));
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

function createChainTracker(): ChainTracker {
  return {
    task_calls_total: 0,
    repo_knowledge_tasks: 0,
    file_summarizer_tasks: 0,
    context_generator_tasks: 0,
    unknown_task_calls: 0,
    team_pipeline_tool_calls: 0,
  };
}

function logChainVerification(
  tracker: ChainTracker,
  log: (line: string) => void,
): ValidationCheck[] {
  const checks: ValidationCheck[] = [
    {
      name: "repo-knowledge task seen",
      pass: tracker.repo_knowledge_tasks > 0,
      details: `repo_knowledge_tasks=${tracker.repo_knowledge_tasks}`,
    },
    {
      name: "team pipeline tool seen",
      pass: tracker.team_pipeline_tool_calls > 0,
      details: `team_pipeline_tool_calls=${tracker.team_pipeline_tool_calls}`,
    },
  ];

  log("\n=== SUBAGENT CHAIN VERIFICATION ===");
  log(
    `[INFO] Task calls: total=${tracker.task_calls_total}, repo-knowledge=${tracker.repo_knowledge_tasks}, file-summarizer=${tracker.file_summarizer_tasks}, context-generator=${tracker.context_generator_tasks}, unknown=${tracker.unknown_task_calls}`,
  );
  log(
    `[INFO] team-pipeline tool calls: ${tracker.team_pipeline_tool_calls}`,
  );
  for (const check of checks) {
    log(`[${check.pass ? "PASS" : "FAIL"}] ${check.name}: ${check.details}`);
  }

  return checks;
}

async function runAgentArtifactValidation(
  repoAddress: string,
  log: (line: string) => void,
): Promise<ArtifactValidationResult> {
  const checks: ValidationCheck[] = [];
  const normalizedRepoAddress = path.resolve(
    normalizeRepoPathInput(repoAddress) ?? repoAddress,
  );

  const fileSummariesPath = getFileSummariesPath();
  const fileSummariesExists = existsSync(fileSummariesPath);
  checks.push({
    name: "file-summaries exists",
    pass: fileSummariesExists,
    details: fileSummariesPath,
  });

  const store = await loadFileSummariesStore();
  checks.push({
    name: "file-summaries repo matches requested repo",
    pass: Boolean(store && store.repo_address === normalizedRepoAddress),
    details: store
      ? `store.repo_address=${store.repo_address}`
      : "store not found or unreadable",
  });

  const progress = summarizeStoreProgress(store);
  const summaryCount = store ? Object.keys(store.summaries).length : 0;

  const refGraphExists = existsSync(REF_GRAPH_PATH);
  checks.push({
    name: "ref-graph exists",
    pass: refGraphExists,
    details: REF_GRAPH_PATH,
  });

  const refGraphContext = await readReferenceGraphContext();
  checks.push({
    name: "ref-graph repo matches requested repo",
    pass: refGraphContext.repo_address === normalizedRepoAddress,
    details: `ref_graph.repo_address=${refGraphContext.repo_address ?? "null"}`,
  });

  const refNodes = await listReferenceNodes();
  const summarizedFileNodeCount = refNodes.filter(
    (node) =>
      node.type === "file" &&
      typeof node.summary === "string" &&
      node.summary.trim().length > 0,
  ).length;

  const summaryPath = getContextSummaryPath();
  const summaryExists = existsSync(summaryPath);
  checks.push({
    name: "summary.md exists",
    pass: summaryExists,
    details: summaryPath,
  });

  let summaryBytes = 0;
  let firstHeading: string | null = null;
  if (summaryExists) {
    const summaryContent = await readFile(summaryPath, "utf-8");
    summaryBytes = Buffer.byteLength(summaryContent, "utf-8");
    const headingLine = summaryContent
      .split(/\r?\n/)
      .find((line) => line.trim().startsWith("#"));
    firstHeading = headingLine ? headingLine.trim() : null;
  }

  log("\n=== AGENT ARTIFACT VALIDATION ===");
  for (const check of checks) {
    log(`[${check.pass ? "PASS" : "FAIL"}] ${check.name}: ${check.details}`);
  }
  log(
    `[INFO] file-summaries progress: completed=${progress.completed_count}, expected=${progress.expected_count}, missing=${progress.missing_subjects.length}`,
  );
  if (progress.missing_subjects.length > 0) {
    log(`[INFO] missing subjects: ${safeJsonStringify(progress.missing_subjects)}`);
  }
  log(`[INFO] file-summaries count: ${summaryCount}`);
  log(
    `[INFO] ref-graph: node_count=${refGraphContext.node_count}, file_node_count=${refGraphContext.file_node_count}, summarized_file_node_count=${summarizedFileNodeCount}`,
  );
  log(`[INFO] summary.md bytes: ${summaryBytes}`);
  log(`[INFO] summary.md first heading: ${firstHeading ?? "<none>"}`);

  return {
    checks,
    progress,
    summaryCount,
    summarizedFileNodeCount,
    summaryBytes,
    firstHeading,
  };
}

function buildAgentHarnessOptions() {
  const MAIN_AGENT_MODEL = resolveAgentModel(process.env.MAIN_AGENT_MODEL, "sonnet");
  const REPO_KNOWLEDGE_MODEL = resolveAgentModel(
    process.env.REPO_KNOWLEDGE_MODEL,
    "sonnet",
  );
  const REPO_KNOWLEDGE_PROMPT = safeLoadPrompt(
    "repo_knowledge_orchestrator",
    DEFAULT_REPO_KNOWLEDGE_PROMPT,
  );

  const REPO_KNOWLEDGE_ALLOWED_MCP_TOOLS = new Set([
    "mcp__file__run_repo_knowledge_team_pipeline",
    "mcp__file__read_context_summary",
  ]);
  const TOP_LEVEL_ALLOWED_TOOLS = new Set([
    "Task",
    ...REPO_KNOWLEDGE_ALLOWED_MCP_TOOLS,
  ]);

  return {
    maxTurns: 300,
    model: MAIN_AGENT_MODEL,
    allowedTools: Array.from(TOP_LEVEL_ALLOWED_TOOLS),
    permissionMode: "dontAsk",
    mcpServers: {
      file: customServer,
    },
    agents: {
      "repo-knowledge": {
        description:
          "Cache-first repository knowledge orchestrator. Reuses existing artifacts or rebuilds AST/file summaries/context.",
        prompt: REPO_KNOWLEDGE_PROMPT,
        model: REPO_KNOWLEDGE_MODEL,
        tools: [
          "mcp__file__run_repo_knowledge_team_pipeline",
          "mcp__file__read_context_summary",
        ],
        mcpServers: ["file"],
      },
    },
    canUseTool: async (toolName: string, input: unknown, options: any) => {
      const isTopLevelAgent = !options.agentID;

      if (toolName === "Task") {
        if (isTopLevelAgent) {
          return allowTool(input, options.suggestions);
        }
        return denyTool("Nested Task is disabled.");
      }

      if (isTopLevelAgent && !TOP_LEVEL_ALLOWED_TOOLS.has(toolName)) {
        return denyTool(`${toolName} is disabled at top level. Delegate through Task.`);
      }

      if (REPO_KNOWLEDGE_ALLOWED_MCP_TOOLS.has(toolName)) {
        return allowTool(input, options.suggestions);
      }

      return denyTool(`${toolName} is not allowed in this harness session.`);
    },
    systemPrompt:
      "You are the MCP subagent test runner. You must invoke the repo-knowledge subagent by using Task. Do not answer from your own analysis.",
  };
}

async function runAgentSubagentHarness(
  repoAddress: string,
  forceRefresh: boolean,
  timeoutMs: number,
  log: (line: string) => void,
): Promise<void> {
  const resolvedRepo = path.resolve(normalizeRepoPathInput(repoAddress) ?? repoAddress);
  const agentPrompt = [
    "Run an explicit repo-knowledge subagent test.",
    `Repo path: ${resolvedRepo}`,
    `force_refresh: ${String(forceRefresh)}`,
    'You MUST call Task with subagent_type "repo-knowledge".',
    `Pass these exact inputs to that subagent: {"repo_address": ${JSON.stringify(resolvedRepo)}, "force_refresh": ${String(forceRefresh)}}.`,
    "Require the repo-knowledge flow to run and report completion stats.",
  ].join("\n");

  log(`Running MCP agent harness with repo: ${resolvedRepo}`);
  log(`forceRefresh: ${forceRefresh}`);
  log(`timeoutMs: ${timeoutMs}`);
  log("topLevelAllowedTools: Task,mcp__file__run_repo_knowledge_team_pipeline,mcp__file__read_context_summary");
  log("agentPrompt:");
  log(agentPrompt);

  const chainTracker = createChainTracker();
  const stream = query({
    prompt: makeSingleMessagePrompt(agentPrompt),
    options: buildAgentHarnessOptions() as any,
  })[Symbol.asyncIterator]();

  const startedAt = Date.now();
  let sawTerminalResult = false;
  let permissionDenialsCount = 0;

  while (true) {
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = timeoutMs - elapsedMs;
    if (remainingMs <= 0) {
      throw new Error(`Agent mode timed out after ${timeoutMs} ms.`);
    }

    const { value, done } = await nextWithTimeout(stream, remainingMs);
    if (done) {
      break;
    }

    logSdkEvent(value, log, chainTracker);
    if (
      value &&
      typeof value === "object" &&
      (value as { type?: unknown }).type === "result"
    ) {
      const resultRecord = value as { permission_denials?: unknown };
      if (Array.isArray(resultRecord.permission_denials)) {
        permissionDenialsCount += resultRecord.permission_denials.length;
      }
      sawTerminalResult = true;
      break;
    }
  }

  if (!sawTerminalResult) {
    throw new Error("Agent output stream ended without a terminal result event.");
  }

  const chainChecks = logChainVerification(chainTracker, log);
  const artifactValidation = await runAgentArtifactValidation(resolvedRepo, log);

  const hardFailureChecks: ValidationCheck[] = [
    ...chainChecks,
    {
      name: "file summaries written",
      pass: artifactValidation.summaryCount > 0,
      details: `summaryCount=${artifactValidation.summaryCount}`,
    },
    {
      name: "summary.md has non-trivial content",
      pass: artifactValidation.summaryBytes > 120,
      details: `summaryBytes=${artifactValidation.summaryBytes}`,
    },
    {
      name: "no permission denials",
      pass: permissionDenialsCount === 0,
      details: `permissionDenialsCount=${permissionDenialsCount}`,
    },
    ...artifactValidation.checks,
  ];

  log("\n=== HARD FAILURE CHECKS ===");
  for (const check of hardFailureChecks) {
    log(`[${check.pass ? "PASS" : "FAIL"}] ${check.name}: ${check.details}`);
  }

  const allPassed = hardFailureChecks.every((check) => check.pass);
  log(`Final agent harness result: ${allPassed ? "PASS" : "FAIL"}`);
  if (!allPassed) {
    throw new Error("Agent subagent harness validation failed. See transcript diagnostics.");
  }
}

async function runToolDebugHarness(
  tools: Record<string, RegisteredTool>,
  repoAddress: string,
  withWrites: boolean,
  includeDirectory: boolean,
  resetStore: boolean,
  log: (line: string) => void,
): Promise<void> {
  log(`Running MCP tool-debug suite with repo: ${repoAddress}`);
  log(`withWrites: ${withWrites}`);
  log(`includeDirectory: ${includeDirectory}`);
  log(`resetStore: ${resetStore}`);

  if (includeDirectory) {
    await callTool(tools, "return_directory", { repo_address: repoAddress }, log);
  } else {
    log("Skipping return_directory by default. Use --include-directory to enable.");
  }

  const statusResult = await callTool(
    tools,
    "get_repo_knowledge_status",
    {
      repo_address: repoAddress,
      force_refresh: false,
    },
    log,
  );
  const statusPayload = extractPayload(statusResult);

  await callTool(tools, "index_repository_ast", { repo_address: repoAddress }, log);

  const listResult = await callTool(tools, "list_reference_subjects", { type: "file" }, log);
  const listPayload = extractPayload(listResult);
  const subjects = Array.isArray(listPayload.subjects)
    ? listPayload.subjects.filter((subject): subject is string => typeof subject === "string")
    : [];
  const sampleSubject = subjects[0];
  log(`list_reference_subjects returned count=${subjects.length}`);
  if (!sampleSubject) {
    log("No file subjects were returned. Write tests will be skipped.");
  } else {
    log(`Sample subject selected for write tests: ${sampleSubject}`);
  }

  if (resetStore || withWrites) {
    const fingerprint =
      typeof statusPayload.current_fingerprint === "string"
        ? statusPayload.current_fingerprint
        : "manual-test-fingerprint";

    await callTool(
      tools,
      "prepare_file_summaries_store",
      {
        repo_address: repoAddress,
        fingerprint,
        expected_subjects: subjects,
      },
      log,
    );
  } else {
    log("Skipping prepare_file_summaries_store to avoid clobbering existing summaries.");
  }

  if (sampleSubject) {
    await callTool(
      tools,
      "return_reference_graph",
      {
        input_subject: sampleSubject,
        type: "file",
      },
      log,
    );
  }

  if (withWrites && sampleSubject) {
    log("Running manual debug write fixture calls (not subagent-generated summaries).");
    await callTool(
      tools,
      "write_file_summary",
      {
        subject: sampleSubject,
        summary_json: {
          overall_summary: "Manual MCP harness write test summary.",
          file_cluster: ["manual-test"],
          important_relationships: [],
          group_function: "Manual MCP debug harness fixture write.",
        },
        raw_output: "manual mcp harness write fixture",
      },
      log,
    );

    await callTool(
      tools,
      "write_reference_summary",
      {
        input_subject: sampleSubject,
        type: "file",
        summary: "Manual MCP harness reference summary write fixture.",
      },
      log,
    );
  } else if (withWrites) {
    log("withWrites=true, but no sample subject available. No write calls were made.");
  }

  await callTool(tools, "read_file_summaries", { repo_address: repoAddress }, log);
  await callTool(tools, "read_context_summary", {}, log);
}

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const logs: string[] = [];
  const log = (line: string): void => {
    logs.push(line);
    console.log(line);
  };

  const startedAtIso = new Date().toISOString();
  let runError: unknown = null;

  try {
    log("=== MCP TEST HARNESS RUN HEADER ===");
    log(`StartedAt: ${startedAtIso}`);
    log(`Mode: ${cli.mode}`);
    log(`Repo: ${cli.repo}`);
    log(`Output: ${cli.output}`);
    log(`Argv: ${safeJsonStringify(cli.rawArgv)}`);

    if (cli.mode === "tool") {
      const tools = getRegisteredTools();
      if (cli.tool) {
        const parsedArgs = cli.args ? JSON.parse(cli.args) : {};
        if (!parsedArgs || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
          throw new Error("--args must parse to a JSON object.");
        }

        await callTool(tools, cli.tool, parsedArgs as Record<string, unknown>, log);
      } else {
        await runToolDebugHarness(
          tools,
          cli.repo,
          cli.withWrites,
          cli.includeDirectory,
          cli.resetStore,
          log,
        );
      }
    } else {
      if (cli.tool) {
        throw new Error("--tool is only supported in --mode tool.");
      }

      await runAgentSubagentHarness(cli.repo, cli.forceRefresh, cli.timeoutMs, log);
    }
  } catch (error) {
    runError = error;
    log("\nMCP harness failed:");
    log(error instanceof Error ? error.stack ?? error.message : String(error));
  } finally {
    await mkdir(path.dirname(cli.output), { recursive: true });
    await writeFile(cli.output, `${logs.join("\n")}\n`, "utf-8");
    console.log(`\nSaved MCP test output to: ${cli.output}`);
  }

  if (runError) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("MCP harness fatal error:");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
