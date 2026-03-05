import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  RepoPermissionDenial,
  RepoProgressEvent,
  RepoProgressCostState,
  RepoProgressQueueState,
} from "./repo-progress-bus";

const REPO_COST_LEDGER_PATH = path.resolve(process.cwd(), "data/repo-costs-live.json");
const MAX_RECENT_RUNS = 25;
const MAX_TURN_RESULTS = 200;
const MAX_TOOL_CALLS_PER_RUN = 2000;
const MAX_COST_HISTORY_PER_RUN = 2000;
const MAX_PERMISSION_DENIALS_PER_RUN = 500;

interface ToolCallLedgerEntry {
  id: string;
  timestamp: string;
  stage: RepoProgressEvent["stage"];
  subagent?: RepoProgressEvent["subagent"];
  task_id?: string;
  task_status?: RepoProgressEvent["task_status"];
  subject?: string;
  attempt?: number;
  tool_name: string;
  tool_input_summary?: string;
  cost_snapshot_total_usd: number;
  estimated_incremental_cost_usd: number;
  estimated_task_split_cost_usd?: number;
}

interface CostHistoryEntry {
  timestamp: string;
  stage: RepoProgressEvent["stage"];
  event_kind?: RepoProgressEvent["event_kind"];
  task_id?: string;
  total_cost_usd: number;
  delta_cost_usd: number;
}

interface TaskCostLedgerEntry {
  task_id: string;
  subagent?: RepoProgressEvent["subagent"];
  task_status?: RepoProgressEvent["task_status"];
  subject?: string;
  attempt?: number;
  task_cost_usd?: number;
  updated_at: string;
}

interface PermissionDenialHistoryEntry {
  timestamp: string;
  stage: RepoProgressEvent["stage"];
  task_id?: string;
  subagent?: RepoProgressEvent["subagent"];
  subject?: string;
  attempt?: number;
  denials: RepoPermissionDenial[];
}

interface RunCostLedgerEntry {
  run_id: string;
  chat_id: string;
  repo_address: string;
  started_at: string;
  updated_at: string;
  completed_at?: string;
  stage: RepoProgressEvent["stage"];
  message: string;
  queue?: RepoProgressQueueState;
  cost?: RepoProgressCostState;
  last_known_total_cost_usd: number;
  totals: {
    tool_calls: number;
    task_updates: number;
    pipeline_events: number;
  };
  task_costs: Record<string, TaskCostLedgerEntry>;
  tool_calls: ToolCallLedgerEntry[];
  cost_history: CostHistoryEntry[];
  permission_denials_history: PermissionDenialHistoryEntry[];
}

interface TurnResultLedgerEntry {
  chat_id: string;
  turn_id: number;
  timestamp: string;
  success: boolean;
  subtype?: string;
  error?: string;
  cost_usd?: number;
  duration_ms?: number;
}

interface RepoCostLedgerFile {
  version: 1;
  updated_at: string;
  active_runs: Record<string, RunCostLedgerEntry>;
  recent_runs: RunCostLedgerEntry[];
  turn_results: TurnResultLedgerEntry[];
}

export interface RepoCostRunSnapshot {
  run_id: string;
  chat_id: string;
  repo_address: string;
  stage: RepoProgressEvent["stage"];
  started_at: string;
  updated_at: string;
  completed_at?: string;
  total_cost_usd: number;
  queue_cost_usd: number;
  context_cost_usd: number;
  tool_call_count: number;
  permission_denial_count: number;
}

function toNonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class RepoCostLedger {
  private runs = new Map<string, RunCostLedgerEntry>();
  private recentRuns: RunCostLedgerEntry[] = [];
  private turnResults: TurnResultLedgerEntry[] = [];

  constructor() {
    this.load();
  }

  recordRepoProgressEvent(event: RepoProgressEvent): void {
    const run = this.getOrCreateRun(event);
    run.updated_at = event.timestamp;
    run.stage = event.stage;
    run.message = event.message;
    run.chat_id = event.chat_id;
    run.repo_address = event.repo_address;

    if (event.queue) {
      run.queue = { ...event.queue };
    }

    if (event.event_kind === "tool_use") {
      run.totals.tool_calls += 1;
      run.tool_calls.push({
        id: `${event.run_id}:tool:${run.totals.tool_calls}`,
        timestamp: event.timestamp,
        stage: event.stage,
        subagent: event.subagent,
        task_id: event.task_id,
        task_status: event.task_status,
        subject: event.subject,
        attempt: event.attempt,
        tool_name: event.tool_name ?? "unknown_tool",
        ...(event.tool_input_summary ? { tool_input_summary: event.tool_input_summary } : {}),
        cost_snapshot_total_usd: run.last_known_total_cost_usd,
        estimated_incremental_cost_usd: 0,
      });
      if (run.tool_calls.length > MAX_TOOL_CALLS_PER_RUN) {
        run.tool_calls.splice(0, run.tool_calls.length - MAX_TOOL_CALLS_PER_RUN);
      }
    } else if (event.event_kind === "task_update") {
      run.totals.task_updates += 1;
    } else {
      run.totals.pipeline_events += 1;
    }

    if (event.task_id) {
      const existingTask = run.task_costs[event.task_id];
      run.task_costs[event.task_id] = {
        task_id: event.task_id,
        subagent: event.subagent,
        task_status: event.task_status,
        subject: event.subject,
        attempt: event.attempt,
        task_cost_usd:
          typeof event.task_cost_usd === "number" ? toNonNegativeNumber(event.task_cost_usd) : existingTask?.task_cost_usd,
        updated_at: event.timestamp,
      };
    }

    if (event.cost) {
      const nextTotal = toNonNegativeNumber(event.cost.total_cost_usd);
      const delta = Math.max(0, nextTotal - run.last_known_total_cost_usd);
      run.cost = { ...event.cost };
      run.last_known_total_cost_usd = nextTotal;

      run.cost_history.push({
        timestamp: event.timestamp,
        stage: event.stage,
        event_kind: event.event_kind,
        task_id: event.task_id,
        total_cost_usd: nextTotal,
        delta_cost_usd: delta,
      });
      if (run.cost_history.length > MAX_COST_HISTORY_PER_RUN) {
        run.cost_history.splice(0, run.cost_history.length - MAX_COST_HISTORY_PER_RUN);
      }

      if (delta > 0) {
        const lastToolCall = run.tool_calls[run.tool_calls.length - 1];
        if (lastToolCall) {
          lastToolCall.estimated_incremental_cost_usd += delta;
        }
      }
    }

    if (event.task_id && typeof event.task_cost_usd === "number") {
      const normalizedTaskCost = toNonNegativeNumber(event.task_cost_usd);
      const relatedCalls = run.tool_calls.filter((entry) => entry.task_id === event.task_id);
      if (relatedCalls.length > 0) {
        const perCall = normalizedTaskCost / relatedCalls.length;
        for (const call of relatedCalls) {
          call.estimated_task_split_cost_usd = perCall;
        }
      }
    }

    if (Array.isArray(event.permission_denials) && event.permission_denials.length > 0) {
      run.permission_denials_history.push({
        timestamp: event.timestamp,
        stage: event.stage,
        task_id: event.task_id,
        subagent: event.subagent,
        subject: event.subject,
        attempt: event.attempt,
        denials: event.permission_denials.map((denial) => ({ ...denial })),
      });
      if (run.permission_denials_history.length > MAX_PERMISSION_DENIALS_PER_RUN) {
        run.permission_denials_history.splice(
          0,
          run.permission_denials_history.length - MAX_PERMISSION_DENIALS_PER_RUN,
        );
      }
    }

    if (event.stage === "complete") {
      run.completed_at = event.timestamp;
      this.recentRuns = [
        deepClone(run),
        ...this.recentRuns.filter((entry) => entry.run_id !== run.run_id),
      ].slice(0, MAX_RECENT_RUNS);
    }

    this.persist();
  }

  recordTurnResult(input: {
    chat_id: string;
    turn_id: number;
    timestamp: string;
    success: boolean;
    subtype?: string;
    error?: string;
    cost_usd?: number;
    duration_ms?: number;
  }): void {
    this.turnResults = [
      {
        chat_id: input.chat_id,
        turn_id: input.turn_id,
        timestamp: input.timestamp,
        success: input.success,
        ...(input.subtype ? { subtype: input.subtype } : {}),
        ...(input.error ? { error: input.error } : {}),
        ...(typeof input.cost_usd === "number" ? { cost_usd: toNonNegativeNumber(input.cost_usd) } : {}),
        ...(typeof input.duration_ms === "number" && Number.isFinite(input.duration_ms) && input.duration_ms >= 0
          ? { duration_ms: input.duration_ms }
          : {}),
      },
      ...this.turnResults,
    ].slice(0, MAX_TURN_RESULTS);
    this.persist();
  }

  getRunCostSnapshots(): RepoCostRunSnapshot[] {
    return Array.from(this.runs.values()).map((run) => ({
      run_id: run.run_id,
      chat_id: run.chat_id,
      repo_address: run.repo_address,
      stage: run.stage,
      started_at: run.started_at,
      updated_at: run.updated_at,
      ...(typeof run.completed_at === "string" ? { completed_at: run.completed_at } : {}),
      total_cost_usd: toNonNegativeNumber(run.last_known_total_cost_usd),
      queue_cost_usd: toNonNegativeNumber(run.cost?.queue_cost_usd),
      context_cost_usd: toNonNegativeNumber(run.cost?.context_cost_usd),
      tool_call_count: Array.isArray(run.tool_calls) ? run.tool_calls.length : 0,
      permission_denial_count: Array.isArray(run.permission_denials_history)
        ? run.permission_denials_history.reduce(
            (count, entry) =>
              count + (Array.isArray(entry.denials) ? entry.denials.length : 0),
            0,
          )
        : 0,
    }));
  }

  private getOrCreateRun(event: RepoProgressEvent): RunCostLedgerEntry {
    const existing = this.runs.get(event.run_id);
    if (existing) {
      return existing;
    }

    const created: RunCostLedgerEntry = {
      run_id: event.run_id,
      chat_id: event.chat_id,
      repo_address: event.repo_address,
      started_at: event.timestamp,
      updated_at: event.timestamp,
      stage: event.stage,
      message: event.message,
      last_known_total_cost_usd: toNonNegativeNumber(event.cost?.total_cost_usd),
      totals: {
        tool_calls: 0,
        task_updates: 0,
        pipeline_events: 0,
      },
      task_costs: {},
      tool_calls: [],
      cost_history: [],
      permission_denials_history: [],
      ...(event.queue ? { queue: { ...event.queue } } : {}),
      ...(event.cost ? { cost: { ...event.cost } } : {}),
    };
    this.runs.set(event.run_id, created);
    return created;
  }

  private load(): void {
    try {
      const raw = readFileSync(REPO_COST_LEDGER_PATH, "utf-8");
      const parsed = JSON.parse(raw) as Partial<RepoCostLedgerFile>;
      if (!parsed || typeof parsed !== "object") {
        return;
      }

      if (parsed.active_runs && typeof parsed.active_runs === "object") {
        for (const [runId, run] of Object.entries(parsed.active_runs)) {
          if (!run || typeof run !== "object") {
            continue;
          }
          const candidate = run as RunCostLedgerEntry;
          if (typeof candidate.run_id !== "string" || candidate.run_id !== runId) {
            continue;
          }
          this.runs.set(runId, {
            ...candidate,
            totals: candidate.totals ?? {
              tool_calls: 0,
              task_updates: 0,
              pipeline_events: 0,
            },
            task_costs: candidate.task_costs ?? {},
            tool_calls: Array.isArray(candidate.tool_calls) ? candidate.tool_calls : [],
            cost_history: Array.isArray(candidate.cost_history) ? candidate.cost_history : [],
            permission_denials_history: Array.isArray(candidate.permission_denials_history)
              ? candidate.permission_denials_history
              : [],
          });
        }
      }

      if (Array.isArray(parsed.recent_runs)) {
        this.recentRuns = parsed.recent_runs
          .filter((run): run is RunCostLedgerEntry => Boolean(run && typeof run === "object" && typeof (run as RunCostLedgerEntry).run_id === "string"))
          .slice(0, MAX_RECENT_RUNS);
      }

      if (Array.isArray(parsed.turn_results)) {
        this.turnResults = parsed.turn_results
          .filter((entry): entry is TurnResultLedgerEntry =>
            Boolean(
              entry &&
                typeof entry === "object" &&
                typeof (entry as TurnResultLedgerEntry).chat_id === "string" &&
                typeof (entry as TurnResultLedgerEntry).turn_id === "number",
            ),
          )
          .slice(0, MAX_TURN_RESULTS);
      }
    } catch {
      // Ledger file is optional. Start fresh if missing/corrupt.
    }
  }

  private persist(): void {
    const payload: RepoCostLedgerFile = {
      version: 1,
      updated_at: new Date().toISOString(),
      active_runs: Object.fromEntries(this.runs.entries()),
      recent_runs: this.recentRuns,
      turn_results: this.turnResults,
    };

    mkdirSync(path.dirname(REPO_COST_LEDGER_PATH), { recursive: true });
    writeFileSync(REPO_COST_LEDGER_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  }
}

export const repoCostLedger = new RepoCostLedger();
