import type { WebSocket } from "ws";

// WebSocket client with session data
export interface WSClient extends WebSocket {
  sessionId?: string;
  isAlive?: boolean;
}

// Chat stored in memory
export interface Chat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

// Message stored in memory
export interface ChatMessage {
  id: string;
  chatId: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  turnId?: number;
  costUsd?: number;
}

// WebSocket incoming messages
export interface WSChatMessage {
  type: "chat";
  content: string;
  chatId: string;
}

export interface WSSubscribeMessage {
  type: "subscribe";
  chatId: string;
}

export interface WSStopMessage {
  type: "stop";
  chatId: string;
}

export type IncomingWSMessage = WSChatMessage | WSSubscribeMessage | WSStopMessage;

export interface WSRepoProgressMessage {
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
