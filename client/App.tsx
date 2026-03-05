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

interface ChatCostSummary {
  chat_id: string;
  title: string;
  updated_at: string;
  assistant_turn_count: number;
  assistant_message_cost_usd: number;
  total_cost_usd: number;
}

interface CostSummary {
  generated_at: string;
  totals: {
    chat_count: number;
    chats_with_cost_count: number;
    assistant_message_total_usd: number;
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
  const [costSummary, setCostSummary] = useState<CostSummary | null>(null);
  const selectedChatIdRef = useRef<string | null>(null);
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
    const isForCurrentChat = !messageChatId || messageChatId === selectedChatIdRef.current;

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
            msg.id === message.messageId ? { ...msg, costUsd: message.costUsd } : msg,
          ),
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
      console.warn(`WebSocket closed (code=${event.code}, reason=${event.reason || "none"})`);
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
        onSendMessage={handleSendMessage}
        onStopCurrentTurn={handleStopCurrentTurn}
        canStop={Boolean(selectedChatId && isConnected && isLoading)}
      />
    </div>
  );
}
