import React, { useState, useRef, useEffect, useMemo } from "react";

interface Message {
  id: string;
  role: "user" | "assistant" | "tool_use";
  content: string;
  timestamp: string;
  turnId?: number;
  costUsd?: number;
  toolName?: string;
  toolInput?: Record<string, any>;
}

interface RepoProgressEvent {
  type: "repo_progress";
  chat_id: string;
  run_id: string;
  repo_address: string;
  stage: "status" | "index" | "prepare" | "queue" | "context" | "complete";
  event_kind?: "pipeline" | "task_update" | "tool_use";
  subagent?: "file-summarizer" | "context-generator" | "repo-orchestrator";
  task_id?: string;
  task_status?: "running" | "completed" | "failed";
  task_cost_usd?: number;
  tool_name?: string;
  tool_input_summary?: string;
  message: string;
  queue?: {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    retry_count: number;
  };
  cost?: {
    queue_cost_usd: number;
    context_cost_usd: number;
    total_cost_usd: number;
    avg_cost_per_completed_file_usd: number;
    last_job_cost_usd?: number;
  };
  subject?: string;
  attempt?: number;
  success?: boolean;
  error?: string;
  permission_denials?: Array<{
    tool_name: string;
    tool_use_id?: string;
    tool_input_summary?: string;
  }>;
  heartbeat?: {
    seq: number;
    elapsed_ms: number;
    idle_ms: number;
    last_event_type?: string;
    last_tool_name?: string;
    tool_use_count: number;
    tool_progress_count: number;
    permission_denials_count: number;
  };
  timestamp: string;
}

interface ChatWindowProps {
  chatId: string | null;
  messages: Message[];
  isConnected: boolean;
  isLoading: boolean;
  repoProgress: RepoProgressEvent | null;
  repoProgressEvents: RepoProgressEvent[];
  onSendMessage: (content: string) => void;
  onStopCurrentTurn: () => void;
  canStop: boolean;
}

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLen - 3))}...`;
}

function getTaskTarget(input: Record<string, any> | undefined): string {
  if (!input) {
    return "repo-knowledge";
  }

  const candidateKeys = ["subagent_type", "subagent", "agent", "agent_name", "target_agent"];
  for (const key of candidateKeys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return "repo-knowledge";
}

function getTaskDescription(input: Record<string, any> | undefined): string {
  if (!input) {
    return "Delegated task";
  }

  const candidateKeys = ["description", "task", "prompt"];
  for (const key of candidateKeys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return "Delegated task";
}

function RepoProgressCard({ progress }: { progress: RepoProgressEvent }) {
  const formatUsd = (value: number) => `$${value.toFixed(6)}`;

  return (
    <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">Repo Pipeline: {progress.stage}</span>
        <span className="text-xs text-blue-700">{new Date(progress.timestamp).toLocaleTimeString()}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap">{progress.message}</p>
      {progress.queue && (
        <p className="mt-1 text-xs text-blue-800">
          total={progress.queue.total} pending={progress.queue.pending} running={progress.queue.running} completed={progress.queue.completed} failed={progress.queue.failed} retries={progress.queue.retry_count}
        </p>
      )}
      {progress.cost && (
        <p className="mt-1 text-xs text-blue-800">
          total_cost={formatUsd(progress.cost.total_cost_usd)} queue_cost=
          {formatUsd(progress.cost.queue_cost_usd)} context_cost=
          {formatUsd(progress.cost.context_cost_usd)} avg_per_file=
          {formatUsd(progress.cost.avg_cost_per_completed_file_usd)}
          {typeof progress.cost.last_job_cost_usd === "number"
            ? ` last_job=${formatUsd(progress.cost.last_job_cost_usd)}`
            : ""}
        </p>
      )}
      {progress.subject && (
        <p className="mt-1 text-xs text-blue-800">
          subject={progress.subject}
          {typeof progress.attempt === "number" ? ` attempt=${progress.attempt}` : ""}
        </p>
      )}
      {progress.heartbeat && (
        <p className="mt-1 text-xs text-blue-800">
          heartbeat: seq={progress.heartbeat.seq} elapsed_ms={progress.heartbeat.elapsed_ms} idle_ms=
          {progress.heartbeat.idle_ms} last_event={progress.heartbeat.last_event_type ?? "none"} last_tool=
          {progress.heartbeat.last_tool_name ?? "none"} tool_use_count={progress.heartbeat.tool_use_count} tool_progress_count=
          {progress.heartbeat.tool_progress_count} permission_denials_count={progress.heartbeat.permission_denials_count}
        </p>
      )}
      {progress.error && <p className="mt-1 text-xs text-red-700">error={progress.error}</p>}
      {Array.isArray(progress.permission_denials) && progress.permission_denials.length > 0 && (
        <div className="mt-1 text-xs text-red-700">
          <p>permission_denials={progress.permission_denials.length}</p>
          {progress.permission_denials.slice(0, 6).map((denial, index) => (
            <p key={`${denial.tool_name}-${denial.tool_use_id ?? "none"}-${index}`}>
              - {denial.tool_name}
              {denial.tool_use_id ? ` #${denial.tool_use_id}` : ""}
              {denial.tool_input_summary ? ` ${truncate(denial.tool_input_summary, 120)}` : ""}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function stageBadgeClass(stage: RepoProgressEvent["stage"]): string {
  switch (stage) {
    case "queue":
      return "bg-blue-100 text-blue-800";
    case "context":
      return "bg-indigo-100 text-indigo-800";
    case "complete":
      return "bg-green-100 text-green-800";
    case "prepare":
      return "bg-amber-100 text-amber-800";
    case "index":
      return "bg-teal-100 text-teal-800";
    case "status":
    default:
      return "bg-gray-100 text-gray-800";
  }
}

function LivePipelineFeed({ events }: { events: RepoProgressEvent[] }) {
  const latestEvents = useMemo(() => events.slice(-30).reverse(), [events]);

  if (latestEvents.length === 0) {
    return null;
  }

  return (
    <div className="rounded border border-gray-200 bg-white">
      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-700">
          Live Pipeline Events
        </p>
        <span className="text-[11px] text-gray-500">{events.length} total</span>
      </div>
      <div className="max-h-64 overflow-y-auto p-2 space-y-2">
        {latestEvents.map((event, index) => (
          <div
            key={`${event.run_id}-${event.timestamp}-${event.stage}-${index}`}
            className="rounded border border-gray-200 bg-gray-50 px-2 py-1.5"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <span
                  className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${stageBadgeClass(
                    event.stage,
                  )}`}
                >
                  {event.stage}
                </span>
                {event.event_kind && (
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-700">
                    {event.event_kind}
                  </span>
                )}
              </div>
              <span className="text-[11px] text-gray-500">
                {new Date(event.timestamp).toLocaleTimeString()}
              </span>
            </div>
            <p className="mt-1 text-xs text-gray-700 whitespace-pre-wrap">
              {truncate(event.message, 260)}
            </p>
            {event.tool_name && (
              <p className="mt-1 text-[11px] text-gray-600">
                tool={event.tool_name}
                {event.tool_input_summary ? ` input=${event.tool_input_summary}` : ""}
              </p>
            )}
            {event.heartbeat && (
              <p className="mt-1 text-[11px] text-gray-600">
                heartbeat seq={event.heartbeat.seq} elapsed_ms={event.heartbeat.elapsed_ms} idle_ms=
                {event.heartbeat.idle_ms} last_event={event.heartbeat.last_event_type ?? "none"} last_tool=
                {event.heartbeat.last_tool_name ?? "none"} tool_use_count={event.heartbeat.tool_use_count} tool_progress_count=
                {event.heartbeat.tool_progress_count} permission_denials_count={event.heartbeat.permission_denials_count}
              </p>
            )}
            {event.cost && (
              <p className="mt-1 text-[11px] text-gray-500">
                total=${event.cost.total_cost_usd.toFixed(6)} queue=${event.cost.queue_cost_usd.toFixed(6)} context=${event.cost.context_cost_usd.toFixed(6)}
              </p>
            )}
            {typeof event.task_cost_usd === "number" && (
              <p className="mt-1 text-[11px] text-gray-600">
                task_cost=${event.task_cost_usd.toFixed(6)}
              </p>
            )}
            {(event.subject || typeof event.attempt === "number") && (
              <p className="mt-1 text-[11px] text-gray-500">
                {event.subject ? `subject=${event.subject}` : ""}
                {event.subject && typeof event.attempt === "number" ? " " : ""}
                {typeof event.attempt === "number" ? `attempt=${event.attempt}` : ""}
              </p>
            )}
            {event.task_id && (
              <p className="mt-1 text-[11px] text-gray-500">task_id={event.task_id}</p>
            )}
            {event.error && <p className="mt-1 text-[11px] text-red-600">{event.error}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolUseBlock({ message }: { message: Message }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const getToolSummary = () => {
    const input = message.toolInput || {};
    if (input.source === "subagent_repo_progress") {
      const subagent =
        typeof input.subagent === "string" && input.subagent.trim().length > 0
          ? input.subagent
          : "subagent";
      const summary =
        typeof input.input_summary === "string" && input.input_summary.trim().length > 0
          ? input.input_summary.trim()
          : typeof input.subject === "string"
            ? `subject=${input.subject}`
            : "";
      return `${subagent}${summary ? `: ${summary}` : ""}`;
    }
    switch (message.toolName) {
      case "Task":
        return `${getTaskTarget(input)}: ${truncate(getTaskDescription(input), 80)}`;
      case "Read":
        return input.file_path;
      case "Write":
      case "Edit":
        return input.file_path;
      case "Bash":
        return input.command?.slice(0, 60) + (input.command?.length > 60 ? "..." : "");
      case "Grep":
        return `"${input.pattern}" in ${input.path || "."}`;
      case "Glob":
        return input.pattern;
      case "WebSearch":
        return input.query;
      case "WebFetch":
        return input.url;
      default:
        return JSON.stringify(input).slice(0, 50);
    }
  };

  return (
    <div className="my-2 border border-gray-200 bg-gray-50 rounded">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full p-2 flex items-center justify-between text-left hover:bg-gray-100"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-600 uppercase">
            {message.toolName}
          </span>
          <span className="text-xs text-gray-500 truncate max-w-md">
            {getToolSummary()}
          </span>
        </div>
        <span className="text-xs text-gray-400">{isExpanded ? "▼" : "▶"}</span>
      </button>
      {isExpanded && (
        <div className="p-2 border-t border-gray-200">
          <pre className="text-xs bg-white p-2 rounded overflow-x-auto">
            {JSON.stringify(message.toolInput, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const showCost = message.role === "assistant" && typeof message.costUsd === "number";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-2 ${
          isUser
            ? "bg-blue-600 text-white"
            : "bg-gray-100 text-gray-900"
        }`}
      >
        <p className="whitespace-pre-wrap">{message.content}</p>
        {showCost && (
          <p className="mt-1 text-xs text-gray-500">
            Cost: ${message.costUsd!.toFixed(6)}
          </p>
        )}
      </div>
    </div>
  );
}

type TaskStatus = "running" | "completed" | "failed";

interface DelegationTask {
  id: string;
  target: string;
  description: string;
  timestamp: string;
  status: TaskStatus;
}

interface SubagentToolCall {
  toolName: string;
  inputSummary?: string;
  timestamp: string;
}

interface SubagentTaskRun {
  id: string;
  runId: string;
  subagent: string;
  subject?: string;
  attempt?: number;
  status: TaskStatus;
  costUsd?: number;
  startedAt: string;
  updatedAt: string;
  toolCalls: SubagentToolCall[];
  lastMessage?: string;
  error?: string;
  permissionDenials?: RepoProgressEvent["permission_denials"];
}

interface SubagentPipelineToolCall {
  id: string;
  runId: string;
  timestamp: string;
  stage: RepoProgressEvent["stage"];
  subagent: string;
  taskId?: string;
  subject?: string;
  attempt?: number;
  toolName: string;
  inputSummary?: string;
  taskCostUsd?: number;
  totalCostUsd?: number;
}

function statusPillClass(status: TaskStatus): string {
  switch (status) {
    case "running":
      return "bg-amber-100 text-amber-800";
    case "failed":
      return "bg-red-100 text-red-800";
    case "completed":
    default:
      return "bg-green-100 text-green-800";
  }
}

function buildSubagentTaskRuns(events: RepoProgressEvent[]): SubagentTaskRun[] {
  const taskMap = new Map<string, SubagentTaskRun>();
  const sortedEvents = [...events].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  for (const event of sortedEvents) {
    if (!event.task_id && !event.subagent) {
      continue;
    }

    const rawTaskId =
      event.task_id ??
      `${event.subagent ?? "unknown-subagent"}:${event.subject ?? "unknown-subject"}:${
        typeof event.attempt === "number" ? event.attempt : 1
      }`;
    const taskId = `${event.run_id}:${rawTaskId}`;
    const existing = taskMap.get(taskId);
    const task =
      existing ??
      {
        id: taskId,
        runId: event.run_id,
        subagent: event.subagent ?? "unknown-subagent",
        subject: event.subject,
        attempt: event.attempt,
        status: event.task_status ?? "running",
        startedAt: event.timestamp,
        updatedAt: event.timestamp,
        toolCalls: [],
      };

    task.updatedAt = event.timestamp;
    if (event.subagent) task.subagent = event.subagent;
    if (event.subject) task.subject = event.subject;
    if (typeof event.attempt === "number") task.attempt = event.attempt;
    if (typeof event.task_cost_usd === "number") task.costUsd = event.task_cost_usd;
    if (event.task_status) task.status = event.task_status;
    if (event.error) {
      task.status = "failed";
      task.error = event.error;
    }
    if (Array.isArray(event.permission_denials) && event.permission_denials.length > 0) {
      task.permissionDenials = event.permission_denials;
    }
    if (event.message) {
      task.lastMessage = event.message;
    }

    if (event.event_kind === "tool_use" || event.tool_name) {
      task.toolCalls.push({
        toolName: event.tool_name ?? "unknown_tool",
        inputSummary: event.tool_input_summary,
        timestamp: event.timestamp,
      });
      if (task.toolCalls.length > 30) {
        task.toolCalls.splice(0, task.toolCalls.length - 30);
      }
    }

    taskMap.set(taskId, task);
  }

  const statusRank: Record<TaskStatus, number> = {
    running: 0,
    failed: 1,
    completed: 2,
  };

  return Array.from(taskMap.values()).sort((a, b) => {
    const statusDiff = statusRank[a.status] - statusRank[b.status];
    if (statusDiff !== 0) {
      return statusDiff;
    }
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

function buildSubagentToolCalls(events: RepoProgressEvent[]): SubagentPipelineToolCall[] {
  const sortedEvents = [...events]
    .filter((event) => event.event_kind === "tool_use" || !!event.tool_name)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return sortedEvents.map((event, index) => ({
    id: `${event.run_id}:${event.task_id ?? "no-task"}:${event.tool_name ?? "unknown-tool"}:${event.timestamp}:${index}`,
    runId: event.run_id,
    timestamp: event.timestamp,
    stage: event.stage,
    subagent: event.subagent ?? "unknown-subagent",
    taskId: event.task_id,
    subject: event.subject,
    attempt: event.attempt,
    toolName: event.tool_name ?? "unknown_tool",
    inputSummary: event.tool_input_summary,
    taskCostUsd: event.task_cost_usd,
    totalCostUsd: event.cost?.total_cost_usd,
  }));
}

function SubagentProgressSidebar({
  messages,
  repoProgressEvents,
  isLoading,
}: {
  messages: Message[];
  repoProgressEvents: RepoProgressEvent[];
  isLoading: boolean;
}) {
  const delegationTasks = useMemo<DelegationTask[]>(() => {
    const taskMessages = messages.filter(
      (message) => message.role === "tool_use" && message.toolName === "Task",
    );

    if (taskMessages.length === 0) {
      return [];
    }

    const latestProgress = repoProgressEvents[repoProgressEvents.length - 1];

    return taskMessages.map((message, index) => {
      let status: TaskStatus = "completed";

      if (index === taskMessages.length - 1) {
        if (isLoading) {
          status = "running";
        } else if (latestProgress?.error) {
          status = "failed";
        }
      }

      return {
        id: message.id,
        target: getTaskTarget(message.toolInput),
        description: truncate(getTaskDescription(message.toolInput), 100),
        timestamp: message.timestamp,
        status,
      };
    });
  }, [messages, repoProgressEvents, isLoading]);

  const subagentTasks = useMemo(
    () => buildSubagentTaskRuns(repoProgressEvents),
    [repoProgressEvents],
  );
  const subagentToolCalls = useMemo(
    () => buildSubagentToolCalls(repoProgressEvents),
    [repoProgressEvents],
  );

  const recentEvents = useMemo(() => {
    return repoProgressEvents.slice(-12).reverse();
  }, [repoProgressEvents]);

  return (
    <aside className="flex w-full shrink-0 flex-col border-t border-gray-200 bg-gray-50 max-h-[45vh] lg:w-80 lg:max-h-none lg:border-t-0 lg:border-l">
      <div className="border-b border-gray-200 px-4 py-3">
        <h3 className="text-sm font-semibold text-gray-800">Subagent Progress</h3>
        <p className="mt-1 text-xs text-gray-500">Live Task and pipeline tracker</p>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600">Delegations</h4>
          {delegationTasks.length === 0 ? (
            <p className="mt-2 text-xs text-gray-500">No delegated subagent tasks yet.</p>
          ) : (
            <div className="mt-2 space-y-2">
              {delegationTasks.map((task) => (
                <div key={task.id} className="rounded border border-gray-200 bg-white px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-gray-800 truncate">{task.target}</p>
                    <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${statusPillClass(task.status)}`}>
                      {task.status}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-600">{task.description}</p>
                  <p className="mt-1 text-[11px] text-gray-400">{new Date(task.timestamp).toLocaleTimeString()}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600">Subagent Tool Calls</h4>
          {subagentToolCalls.length === 0 ? (
            <p className="mt-2 text-xs text-gray-500">No subagent tool calls yet.</p>
          ) : (
            <div className="mt-2 space-y-2">
              {subagentToolCalls.slice(0, 40).map((toolCall) => (
                <div key={toolCall.id} className="rounded border border-gray-200 bg-white px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-gray-800 truncate">{toolCall.toolName}</p>
                    <span className="text-[11px] text-gray-400">
                      {new Date(toolCall.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-gray-600">
                    {toolCall.subagent} run={toolCall.runId.slice(0, 8)} stage={toolCall.stage}
                  </p>
                  {(toolCall.subject || typeof toolCall.attempt === "number") && (
                    <p className="mt-1 text-[11px] text-gray-500">
                      {toolCall.subject ? `subject=${toolCall.subject}` : ""}
                      {toolCall.subject && typeof toolCall.attempt === "number" ? " " : ""}
                      {typeof toolCall.attempt === "number" ? `attempt=${toolCall.attempt}` : ""}
                    </p>
                  )}
                  {toolCall.inputSummary && (
                    <p className="mt-1 text-[11px] text-gray-500">
                      {truncate(toolCall.inputSummary, 140)}
                    </p>
                  )}
                  {typeof toolCall.taskCostUsd === "number" && (
                    <p className="mt-1 text-[11px] text-gray-600">
                      task_cost=${toolCall.taskCostUsd.toFixed(6)}
                    </p>
                  )}
                  {typeof toolCall.totalCostUsd === "number" && (
                    <p className="mt-1 text-[11px] text-gray-500">
                      total_cost=${toolCall.totalCostUsd.toFixed(6)}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600">Subagent Task Runs</h4>
          {subagentTasks.length === 0 ? (
            <p className="mt-2 text-xs text-gray-500">No subagent task telemetry yet.</p>
          ) : (
            <div className="mt-2 space-y-2">
              {subagentTasks.map((task) => (
                <div key={task.id} className="rounded border border-gray-200 bg-white px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-gray-800 truncate">{task.subagent}</p>
                    <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${statusPillClass(task.status)}`}>
                      {task.status}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-gray-500">run={task.runId.slice(0, 8)}</p>
                  {(task.subject || typeof task.attempt === "number") && (
                    <p className="mt-1 text-[11px] text-gray-500">
                      {task.subject ? `subject=${task.subject}` : ""}
                      {task.subject && typeof task.attempt === "number" ? " " : ""}
                      {typeof task.attempt === "number" ? `attempt=${task.attempt}` : ""}
                    </p>
                  )}
                  {typeof task.costUsd === "number" && (
                    <p className="mt-1 text-[11px] text-gray-600">task_cost=${task.costUsd.toFixed(6)}</p>
                  )}
                  {task.toolCalls.length > 0 && (
                    <div className="mt-2 space-y-1 rounded border border-gray-100 bg-gray-50 p-2">
                      {task.toolCalls.slice(-8).map((toolCall, index) => (
                        <p key={`${task.id}-${toolCall.timestamp}-${toolCall.toolName}-${index}`} className="text-[11px] text-gray-600">
                          {new Date(toolCall.timestamp).toLocaleTimeString()} {toolCall.toolName}
                          {toolCall.inputSummary ? ` ${truncate(toolCall.inputSummary, 90)}` : ""}
                        </p>
                      ))}
                    </div>
                  )}
                  {task.error && <p className="mt-1 text-[11px] text-red-600">{task.error}</p>}
                  {Array.isArray(task.permissionDenials) && task.permissionDenials.length > 0 && (
                    <div className="mt-1 rounded border border-red-100 bg-red-50 p-2">
                      <p className="text-[11px] font-semibold text-red-700">
                        permission_denials={task.permissionDenials.length}
                      </p>
                      {task.permissionDenials.slice(0, 5).map((denial, index) => (
                        <p
                          key={`${task.id}-denial-${denial.tool_name}-${denial.tool_use_id ?? "none"}-${index}`}
                          className="text-[11px] text-red-700"
                        >
                          {denial.tool_name}
                          {denial.tool_use_id ? ` #${denial.tool_use_id}` : ""}
                          {denial.tool_input_summary
                            ? ` ${truncate(denial.tool_input_summary, 100)}`
                            : ""}
                        </p>
                      ))}
                    </div>
                  )}
                  {task.lastMessage && (
                    <p className="mt-1 text-[11px] text-gray-500">{truncate(task.lastMessage, 140)}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600">Pipeline Events</h4>
          {recentEvents.length === 0 ? (
            <p className="mt-2 text-xs text-gray-500">No repo pipeline events yet.</p>
          ) : (
            <div className="mt-2 space-y-2">
              {recentEvents.map((event) => (
                <div key={`${event.run_id}-${event.timestamp}-${event.stage}-${event.message}`} className="rounded border border-gray-200 bg-white px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase text-blue-700">{event.stage}</span>
                    <span className="text-[11px] text-gray-400">{new Date(event.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <p className="mt-1 text-xs text-gray-700">{truncate(event.message, 120)}</p>
                  {event.cost && (
                    <p className="mt-1 text-[11px] text-gray-500">
                      total=${event.cost.total_cost_usd.toFixed(6)} queue=${event.cost.queue_cost_usd.toFixed(6)} context=${event.cost.context_cost_usd.toFixed(6)}
                    </p>
                  )}
                  {event.heartbeat && (
                    <p className="mt-1 text-[11px] text-gray-600">
                      heartbeat seq={event.heartbeat.seq} elapsed_ms={event.heartbeat.elapsed_ms} idle_ms=
                      {event.heartbeat.idle_ms} last_event={event.heartbeat.last_event_type ?? "none"} last_tool=
                      {event.heartbeat.last_tool_name ?? "none"} tool_use_count={event.heartbeat.tool_use_count} tool_progress_count=
                      {event.heartbeat.tool_progress_count} permission_denials_count={event.heartbeat.permission_denials_count}
                    </p>
                  )}
                  {event.subject && (
                    <p className="mt-1 text-[11px] text-gray-500">subject={event.subject}</p>
                  )}
                  {event.error && <p className="mt-1 text-[11px] text-red-600">{event.error}</p>}
                  {Array.isArray(event.permission_denials) && event.permission_denials.length > 0 && (
                    <div className="mt-1 rounded border border-red-100 bg-red-50 p-2">
                      <p className="text-[11px] font-semibold text-red-700">
                        permission_denials={event.permission_denials.length}
                      </p>
                      {event.permission_denials.slice(0, 4).map((denial, index) => (
                        <p
                          key={`${event.run_id}-${event.timestamp}-${denial.tool_name}-${denial.tool_use_id ?? "none"}-${index}`}
                          className="text-[11px] text-red-700"
                        >
                          {denial.tool_name}
                          {denial.tool_use_id ? ` #${denial.tool_use_id}` : ""}
                          {denial.tool_input_summary
                            ? ` ${truncate(denial.tool_input_summary, 100)}`
                            : ""}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}

export function ChatWindow({
  chatId,
  messages,
  isConnected,
  isLoading,
  repoProgress,
  repoProgressEvents,
  onSendMessage,
  onStopCurrentTurn,
  canStop,
}: ChatWindowProps) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, repoProgressEvents]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !chatId || isLoading || !isConnected) return;
    onSendMessage(input.trim());
    setInput("");
  };

  if (!chatId) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-center text-gray-500">
          <p className="text-lg">Welcome to Simple Chat</p>
          <p className="text-sm mt-2">Select a chat or create a new one to get started</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col lg:flex-row bg-white min-h-0">
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-semibold text-gray-800">Chat</h2>
          <div className="flex items-center gap-2">
            {isConnected ? (
              <span className="text-xs text-green-600">● Connected</span>
            ) : (
              <span className="text-xs text-red-600">○ Disconnected</span>
            )}
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {repoProgress && <RepoProgressCard progress={repoProgress} />}
          <LivePipelineFeed events={repoProgressEvents} />
          {messages.length === 0 ? (
            <div className="text-center text-gray-400 mt-8">
              <p>Start a conversation</p>
            </div>
          ) : (
            <>
              {messages.map((msg) =>
                msg.role === "tool_use" ? (
                  <ToolUseBlock key={msg.id} message={msg} />
                ) : (
                  <MessageBubble key={msg.id} message={msg} />
                )
              )}
              {isLoading && (
                <div className="flex items-center gap-2 text-gray-500">
                  <span className="animate-pulse">●</span>
                  <span className="text-sm">Thinking...</span>
                </div>
              )}
            </>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="p-4 border-t border-gray-200">
          <form onSubmit={handleSubmit} className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={isConnected ? "Type a message..." : "Connecting..."}
              disabled={!isConnected || isLoading}
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100"
            />
            <button
              type="submit"
              disabled={!input.trim() || !isConnected || isLoading}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Send
            </button>
            <button
              type="button"
              onClick={onStopCurrentTurn}
              disabled={!canStop}
              className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Stop
            </button>
          </form>
        </div>
      </div>

      <SubagentProgressSidebar
        messages={messages}
        repoProgressEvents={repoProgressEvents}
        isLoading={isLoading}
      />
    </div>
  );
}
