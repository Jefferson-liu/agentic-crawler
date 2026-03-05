import React, { useState, useRef, useEffect } from "react";

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

interface ChatWindowProps {
  chatId: string | null;
  messages: Message[];
  isConnected: boolean;
  isLoading: boolean;
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

function ToolUseBlock({ message }: { message: Message }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const getToolSummary = () => {
    const input = message.toolInput || {};
    switch (message.toolName) {
      case "Read":
      case "Write":
      case "Edit":
        return typeof input.file_path === "string" ? input.file_path : "file operation";
      case "Bash":
        return typeof input.command === "string" ? truncate(input.command, 80) : "shell command";
      case "Grep":
        return `"${String(input.pattern ?? "")}" in ${String(input.path ?? ".")}`;
      case "Glob":
        return String(input.pattern ?? "pattern match");
      case "WebSearch":
        return String(input.query ?? "search");
      case "WebFetch":
        return String(input.url ?? "fetch");
      default:
        return truncate(JSON.stringify(input), 80);
    }
  };

  return (
    <div className="my-2 rounded border border-gray-200 bg-gray-50">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center justify-between p-2 text-left hover:bg-gray-100"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase text-gray-600">{message.toolName}</span>
          <span className="max-w-md truncate text-xs text-gray-500">{getToolSummary()}</span>
        </div>
        <span className="text-xs text-gray-400">{isExpanded ? "▼" : "▶"}</span>
      </button>
      {isExpanded && (
        <div className="border-t border-gray-200 p-2">
          <pre className="overflow-x-auto rounded bg-white p-2 text-xs">
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
          isUser ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-900"
        }`}
      >
        <p className="whitespace-pre-wrap">{message.content}</p>
        {showCost && <p className="mt-1 text-xs text-gray-500">Cost: ${message.costUsd!.toFixed(6)}</p>}
      </div>
    </div>
  );
}

export function ChatWindow({
  chatId,
  messages,
  isConnected,
  isLoading,
  onSendMessage,
  onStopCurrentTurn,
  canStop,
}: ChatWindowProps) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !chatId || isLoading || !isConnected) return;
    onSendMessage(input.trim());
    setInput("");
  };

  if (!chatId) {
    return (
      <div className="flex flex-1 items-center justify-center bg-gray-50">
        <div className="text-center text-gray-500">
          <p className="text-lg">Welcome to Simple Chat</p>
          <p className="mt-2 text-sm">Select a chat or create a new one to get started</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <h2 className="font-semibold text-gray-800">Chat</h2>
        <div className="flex items-center gap-2">
          {isConnected ? (
            <span className="text-xs text-green-600">● Connected</span>
          ) : (
            <span className="text-xs text-red-600">○ Disconnected</span>
          )}
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="mt-8 text-center text-gray-400">
            <p>Start a conversation</p>
          </div>
        ) : (
          <>
            {messages.map((msg) =>
              msg.role === "tool_use" ? (
                <ToolUseBlock key={msg.id} message={msg} />
              ) : (
                <MessageBubble key={msg.id} message={msg} />
              ),
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

      <div className="border-t border-gray-200 p-4">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={isConnected ? "Type a message..." : "Connecting..."}
            disabled={!isConnected || isLoading}
            className="flex-1 rounded-lg border border-gray-300 px-4 py-2 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
          />
          <button
            type="submit"
            disabled={!input.trim() || !isConnected || isLoading}
            className="rounded-lg bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Send
          </button>
          <button
            type="button"
            onClick={onStopCurrentTurn}
            disabled={!canStop}
            className="rounded-lg bg-red-600 px-4 py-2 text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Stop
          </button>
        </form>
      </div>
    </div>
  );
}
