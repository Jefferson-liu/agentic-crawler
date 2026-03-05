import { useState, useEffect, useCallback, useRef } from "react";
import useWebSocket, { ReadyState } from "react-use-websocket";
import { ChatList } from "./components/ChatList";
import { ChatWindow } from "./components/ChatWindow";

interface Chat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

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

interface ChatCostSummary {
  chat_id: string;
  title: string;
  updated_at: string;
  assistant_turn_count: number;
  repo_run_count: number;
  assistant_message_cost_usd: number;
  repo_pipeline_cost_usd: number;
  total_cost_usd: number;
  is_deleted_chat?: boolean;
}

interface CostSummary {
  generated_at: string;
  totals: {
    chat_count: number;
    chats_with_cost_count: number;
    assistant_message_total_usd: number;
    repo_pipeline_total_usd: number;
    total_cost_usd: number;
  };
  per_chat: ChatCostSummary[];
}

// Use relative URLs - Vite will proxy to the backend
const API_BASE = "/api";
const WS_URL = `ws://${window.location.hostname}:4111/ws`;

export default function App() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [repoProgress, setRepoProgress] = useState<RepoProgressEvent | null>(null);
  const [repoProgressEvents, setRepoProgressEvents] = useState<RepoProgressEvent[]>([]);
  const [costSummary, setCostSummary] = useState<CostSummary | null>(null);
  const selectedChatIdRef = useRef<string | null>(null);
  const repoToolEventIdsRef = useRef<Set<string>>(new Set());
  const costSummaryRefreshTimerRef = useRef<number | null>(null);

  useEffect(() => {
    selectedChatIdRef.current = selectedChatId;
  }, [selectedChatId]);

  const fetchChats = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/chats`);
      const data = await res.json();
      setChats(data);
    } catch (error) {
      console.error("Failed to fetch chats:", error);
    }
  }, []);

  const fetchCostSummary = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/costs/summary`);
      if (!res.ok) {
        throw new Error(`cost summary request failed (${res.status})`);
      }
      const data = (await res.json()) as CostSummary;
      setCostSummary(data);
    } catch (error) {
      console.error("Failed to fetch cost summary:", error);
    }
  }, []);

  const scheduleCostSummaryRefresh = useCallback(
    (delayMs = 200) => {
      if (costSummaryRefreshTimerRef.current !== null) {
        window.clearTimeout(costSummaryRefreshTimerRef.current);
      }
      costSummaryRefreshTimerRef.current = window.setTimeout(() => {
        costSummaryRefreshTimerRef.current = null;
        void fetchCostSummary();
      }, delayMs);
    },
    [fetchCostSummary],
  );

  useEffect(() => {
    return () => {
      if (costSummaryRefreshTimerRef.current !== null) {
        window.clearTimeout(costSummaryRefreshTimerRef.current);
      }
    };
  }, []);

  // Handle WebSocket messages
  const handleWSMessage = useCallback((message: any) => {
    const messageChatId =
      typeof message?.chatId === "string"
        ? message.chatId
        : typeof message?.chat_id === "string"
          ? message.chat_id
          : null;
    const isForCurrentChat =
      !messageChatId || messageChatId === selectedChatIdRef.current;

    switch (message.type) {
      case "connected":
        console.log("Connected to server");
        break;

      case "history":
        if (!isForCurrentChat) break;
        setMessages(message.messages || []);
        scheduleCostSummaryRefresh(120);
        break;

      case "user_message":
        if (!isForCurrentChat) break;
        // User message already added locally
        break;

      case "assistant_message":
        if (!isForCurrentChat) break;
        setMessages((prev) => [
          ...prev,
          {
            id: message.messageId ?? crypto.randomUUID(),
            role: "assistant",
            content: message.content,
            timestamp: new Date().toISOString(),
            turnId: message.turnId,
            costUsd: message.costUsd,
          },
        ]);
        setIsLoading(false);
        scheduleCostSummaryRefresh(120);
        break;

      case "tool_use":
        if (!isForCurrentChat) break;
        // Add tool use to messages array so it persists
        // Alternative: To show tool uses only while pending, store them in a
        // separate `pendingToolUses` state and clear it on "assistant_message" or "result"
        setMessages((prev) => [
          ...prev,
          {
            id: message.toolId ?? crypto.randomUUID(),
            role: "tool_use",
            content: "",
            timestamp: new Date().toISOString(),
            turnId: message.turnId,
            toolName: message.toolName,
            toolInput: message.toolInput,
          },
        ]);
        break;

      case "message_updated":
        if (!isForCurrentChat) break;
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === message.messageId
              ? { ...msg, costUsd: message.costUsd }
              : msg
          )
        );
        scheduleCostSummaryRefresh(80);
        break;

      case "result":
        if (!isForCurrentChat) {
          void fetchChats();
          scheduleCostSummaryRefresh(120);
          break;
        }
        if (message.success === false) {
          console.error(
            "Turn failed:",
            typeof message.error === "string" ? message.error : "unknown error",
            message,
          );
        }
        setIsLoading(false);
        // Refresh chat list to get updated titles
        void fetchChats();
        scheduleCostSummaryRefresh(120);
        break;

      case "turn_stopped":
        if (!isForCurrentChat) break;
        if (message.success === false) {
          console.warn(
            "Stop request reported failure:",
            typeof message.message === "string" ? message.message : message,
          );
        }
        setIsLoading(false);
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content:
              typeof message.message === "string" && message.message.trim().length > 0
                ? message.message
                : "Stop requested.",
            timestamp: new Date().toISOString(),
            turnId: message.turnId,
          },
        ]);
        scheduleCostSummaryRefresh(120);
        break;

      case "repo_progress":
        if (!isForCurrentChat) break;
        console.log(
          `[repo_progress][chat=${String(message.chat_id ?? message.chatId ?? "unknown")}][run=${String(
            message.run_id ?? "unknown",
          )}][${String(message.stage ?? "unknown")}] ${String(message.message ?? "")}`,
          message,
        );
        if (typeof message.error === "string" && message.error.trim().length > 0) {
          console.error(
            `[repo_progress:${String(message.stage ?? "unknown")}] ${message.error}`,
            message,
          );
        } else if (message.success === false) {
          console.warn(
            `[repo_progress:${String(message.stage ?? "unknown")}] reported unsuccessful state`,
            message,
          );
        }
        setRepoProgress(message as RepoProgressEvent);
        setRepoProgressEvents((prev) => {
          const next = [...prev, message as RepoProgressEvent];
          if (next.length > 1000) {
            next.splice(0, next.length - 1000);
          }
          return next;
        });
        if (
          !message.heartbeat &&
          (message.stage === "complete" ||
            typeof message.task_cost_usd === "number" ||
            (message.cost && typeof message.cost.total_cost_usd === "number"))
        ) {
          scheduleCostSummaryRefresh(120);
        }
        if (message.event_kind === "tool_use" || typeof message.tool_name === "string") {
          const toolEventKey = [
            String(message.run_id ?? "unknown-run"),
            String(message.task_id ?? "unknown-task"),
            String(message.tool_name ?? "unknown-tool"),
            String(message.subject ?? ""),
            typeof message.attempt === "number" ? String(message.attempt) : "",
            String(message.timestamp ?? ""),
          ].join("|");

          if (!repoToolEventIdsRef.current.has(toolEventKey)) {
            repoToolEventIdsRef.current.add(toolEventKey);
            setMessages((prev) => [
              ...prev,
              {
                id: `repo-tool-${toolEventKey}`,
                role: "tool_use",
                content: "",
                timestamp:
                  typeof message.timestamp === "string"
                    ? message.timestamp
                    : new Date().toISOString(),
                toolName:
                  typeof message.tool_name === "string" && message.tool_name.trim().length > 0
                    ? message.tool_name
                    : "unknown_tool",
                toolInput: {
                  source: "subagent_repo_progress",
                  subagent: message.subagent,
                  run_id: message.run_id,
                  task_id: message.task_id,
                  stage: message.stage,
                  subject: message.subject,
                  attempt: message.attempt,
                  input_summary: message.tool_input_summary,
                  event_message: message.message,
                  task_cost_usd: message.task_cost_usd,
                  total_cost_usd: message.cost?.total_cost_usd,
                  queue_cost_usd: message.cost?.queue_cost_usd,
                  context_cost_usd: message.cost?.context_cost_usd,
                  permission_denials: message.permission_denials,
                },
              },
            ]);
          }
        }
        break;

      case "error":
        console.error("Server error:", message.error);
        setIsLoading(false);
        break;
    }
  }, [fetchChats, scheduleCostSummaryRefresh]);

  const { sendJsonMessage, readyState, lastJsonMessage } = useWebSocket(WS_URL, {
    shouldReconnect: () => true,
    reconnectAttempts: 10,
    reconnectInterval: 3000,
    onOpen: () => {
      console.log("WebSocket opened");
    },
    onClose: (event) => {
      console.warn(
        `WebSocket closed (code=${event.code}, reason=${event.reason || "none"})`,
      );
    },
    onError: (event) => {
      console.error("WebSocket error event:", event);
    },
  });

  const isConnected = readyState === ReadyState.OPEN;

  // Handle incoming WebSocket messages
  useEffect(() => {
    if (lastJsonMessage) {
      handleWSMessage(lastJsonMessage);
    }
  }, [lastJsonMessage, handleWSMessage]);

  // Create new chat
  const createChat = async () => {
    try {
      const res = await fetch(`${API_BASE}/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const chat = await res.json();
      setChats((prev) => [chat, ...prev]);
      selectChat(chat.id);
      scheduleCostSummaryRefresh(80);
    } catch (error) {
      console.error("Failed to create chat:", error);
    }
  };

  // Delete chat
  const deleteChat = async (chatId: string) => {
    try {
      await fetch(`${API_BASE}/chats/${chatId}`, { method: "DELETE" });
      setChats((prev) => prev.filter((c) => c.id !== chatId));
      if (selectedChatId === chatId) {
        setSelectedChatId(null);
        setMessages([]);
      }
      scheduleCostSummaryRefresh(80);
    } catch (error) {
      console.error("Failed to delete chat:", error);
    }
  };

  // Select a chat
  const selectChat = (chatId: string) => {
    setSelectedChatId(chatId);
    setMessages([]);
    setIsLoading(false);
    setRepoProgress(null);
    setRepoProgressEvents([]);
    repoToolEventIdsRef.current = new Set();

    // Subscribe to chat via WebSocket
    sendJsonMessage({ type: "subscribe", chatId });
    scheduleCostSummaryRefresh(120);
  };

  // Send a message
  const handleSendMessage = (content: string) => {
    if (!selectedChatId || !isConnected) return;

    // Add message optimistically
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: "user",
        content,
        timestamp: new Date().toISOString(),
      },
    ]);

    setIsLoading(true);
    setRepoProgress(null);
    setRepoProgressEvents([]);

    // Send via WebSocket
    sendJsonMessage({
      type: "chat",
      content,
      chatId: selectedChatId,
    });
    scheduleCostSummaryRefresh(120);
  };

  const handleStopCurrentTurn = () => {
    if (!selectedChatId || !isConnected || !isLoading) return;

    sendJsonMessage({
      type: "stop",
      chatId: selectedChatId,
    });
  };

  // Initial fetch
  useEffect(() => {
    void fetchChats();
    void fetchCostSummary();
  }, [fetchChats, fetchCostSummary]);

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <div className="w-64 shrink-0">
        <ChatList
          chats={chats}
          selectedChatId={selectedChatId}
          onSelectChat={selectChat}
          onNewChat={createChat}
          onDeleteChat={deleteChat}
          costSummary={costSummary}
        />
      </div>

      {/* Main chat area */}
      <ChatWindow
        chatId={selectedChatId}
        messages={messages}
        isConnected={isConnected}
        isLoading={isLoading}
        repoProgress={repoProgress}
        repoProgressEvents={repoProgressEvents}
        onSendMessage={handleSendMessage}
        onStopCurrentTurn={handleStopCurrentTurn}
        canStop={Boolean(selectedChatId && isConnected && isLoading)}
      />
    </div>
  );
}
