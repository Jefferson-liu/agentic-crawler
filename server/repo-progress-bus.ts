export type RepoProgressStage =
  | "status"
  | "index"
  | "prepare"
  | "queue"
  | "context"
  | "complete";

export type RepoProgressEventKind = "pipeline" | "task_update" | "tool_use";
export type RepoProgressSubagent = "file-summarizer" | "context-generator" | "repo-orchestrator";
export type RepoTaskStatus = "running" | "completed" | "failed";

export interface RepoPermissionDenial {
  tool_name: string;
  tool_use_id?: string;
  tool_input_summary?: string;
}

export interface RepoProgressQueueState {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  retry_count: number;
}

export interface RepoProgressCostState {
  queue_cost_usd: number;
  context_cost_usd: number;
  total_cost_usd: number;
  avg_cost_per_completed_file_usd: number;
  last_job_cost_usd?: number;
}

export interface RepoProgressHeartbeatState {
  seq: number;
  elapsed_ms: number;
  idle_ms: number;
  last_event_type?: string;
  last_tool_name?: string;
  tool_use_count: number;
  tool_progress_count: number;
  permission_denials_count: number;
}

export interface RepoProgressEvent {
  type: "repo_progress";
  chat_id: string;
  run_id: string;
  repo_address: string;
  stage: RepoProgressStage;
  event_kind?: RepoProgressEventKind;
  subagent?: RepoProgressSubagent;
  task_id?: string;
  task_status?: RepoTaskStatus;
  task_cost_usd?: number;
  tool_name?: string;
  tool_input_summary?: string;
  message: string;
  queue?: RepoProgressQueueState;
  cost?: RepoProgressCostState;
  subject?: string;
  attempt?: number;
  success?: boolean;
  error?: string;
  permission_denials?: RepoPermissionDenial[];
  heartbeat?: RepoProgressHeartbeatState;
  timestamp: string;
}

type RepoProgressListener = (event: RepoProgressEvent) => void;

class RepoProgressBus {
  private listenersByChatId = new Map<string, Set<RepoProgressListener>>();

  subscribe(chatId: string, listener: RepoProgressListener): () => void {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return () => undefined;
    }

    const listeners = this.listenersByChatId.get(normalizedChatId) ?? new Set<RepoProgressListener>();
    listeners.add(listener);
    this.listenersByChatId.set(normalizedChatId, listeners);

    return () => {
      const existingListeners = this.listenersByChatId.get(normalizedChatId);
      if (!existingListeners) {
        return;
      }
      existingListeners.delete(listener);
      if (existingListeners.size === 0) {
        this.listenersByChatId.delete(normalizedChatId);
      }
    };
  }

  emit(event: RepoProgressEvent): void {
    const normalizedChatId = event.chat_id.trim();
    if (!normalizedChatId) {
      return;
    }

    const listeners = this.listenersByChatId.get(normalizedChatId);
    if (!listeners || listeners.size === 0) {
      return;
    }

    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("repo-progress listener failed:", error);
      }
    }
  }
}

export const repoProgressBus = new RepoProgressBus();
