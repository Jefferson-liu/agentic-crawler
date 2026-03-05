import React from "react";

interface Chat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface ChatListProps {
  chats: Chat[];
  selectedChatId: string | null;
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
  onDeleteChat: (chatId: string) => void;
  costSummary?: {
    generated_at: string;
    totals: {
      chat_count: number;
      chats_with_cost_count: number;
      assistant_message_total_usd: number;
      total_cost_usd: number;
    };
    per_chat: Array<{
      chat_id: string;
      title: string;
      updated_at: string;
      assistant_turn_count: number;
      assistant_message_cost_usd: number;
      total_cost_usd: number;
    }>;
  } | null;
}

export function ChatList({
  chats,
  selectedChatId,
  onSelectChat,
  onNewChat,
  onDeleteChat,
  costSummary,
}: ChatListProps) {
  const costByChatId = new Map((costSummary?.per_chat ?? []).map((entry) => [entry.chat_id, entry]));
  const topCostChats = (costSummary?.per_chat ?? [])
    .filter((entry) => entry.total_cost_usd > 0)
    .slice(0, 5);
  const formatUsd = (value: number) => `$${value.toFixed(6)}`;

  return (
    <div className="flex h-full flex-col bg-gray-900 text-white">
      <div className="border-b border-gray-700 p-4">
        <button
          onClick={onNewChat}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-gray-700 px-4 py-2 transition-colors hover:bg-gray-600"
        >
          <span>+</span>
          <span>New Chat</span>
        </button>
      </div>

      {costSummary && (
        <div className="border-b border-gray-700 bg-gray-950/40 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-300">Cost Tracker</p>
          <p className="mt-1 text-xs text-gray-200">total={formatUsd(costSummary.totals.total_cost_usd)}</p>
          <p className="mt-1 text-[11px] text-gray-400">
            assistant={formatUsd(costSummary.totals.assistant_message_total_usd)}
          </p>
          <p className="mt-1 text-[11px] text-gray-500">
            chats_with_cost={costSummary.totals.chats_with_cost_count}/{costSummary.totals.chat_count}
          </p>
          {topCostChats.length > 0 && (
            <div className="mt-2 space-y-1">
              {topCostChats.map((entry) => (
                <p key={entry.chat_id} className="truncate text-[11px] text-gray-400">
                  {entry.title}: {formatUsd(entry.total_cost_usd)}
                </p>
              ))}
            </div>
          )}
          <p className="mt-2 text-[10px] text-gray-500">
            updated {new Date(costSummary.generated_at).toLocaleTimeString()}
          </p>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {chats.length === 0 ? (
          <div className="p-4 text-center text-gray-500">
            <p className="text-sm">No chats yet</p>
            <p className="mt-1 text-xs">Click "New Chat" to start</p>
          </div>
        ) : (
          <div className="space-y-1 p-2">
            {chats.map((chat) => {
              const chatCost = costByChatId.get(chat.id);
              return (
                <div
                  key={chat.id}
                  className={`group flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 transition-colors ${
                    selectedChatId === chat.id ? "bg-gray-700" : "hover:bg-gray-800"
                  }`}
                  onClick={() => onSelectChat(chat.id)}
                >
                  <span className="shrink-0 text-gray-400">💬</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{chat.title}</p>
                    {chatCost && chatCost.total_cost_usd > 0 && (
                      <p className="text-[11px] text-gray-400">cost={formatUsd(chatCost.total_cost_usd)}</p>
                    )}
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteChat(chat.id);
                    }}
                    className="p-1 text-gray-400 opacity-0 transition-all hover:bg-gray-600 hover:text-white group-hover:opacity-100"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="border-t border-gray-700 p-4">
        <p className="text-center text-xs text-gray-500">Simple Chat App</p>
      </div>
    </div>
  );
}
