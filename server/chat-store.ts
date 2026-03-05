import { v4 as uuidv4 } from "uuid";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Chat, ChatMessage } from "./types.js";

interface PersistedChatStore {
  version: 1;
  chats: Chat[];
  messages: Record<string, ChatMessage[]>;
}

const CHAT_STORE_PATH = path.resolve(process.cwd(), "data/chats.json");

function parsePersistedStore(raw: unknown): PersistedChatStore | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as {
    version?: unknown;
    chats?: unknown;
    messages?: unknown;
  };

  if (candidate.version !== 1 || !Array.isArray(candidate.chats)) {
    return null;
  }

  const chats = candidate.chats.filter((chat): chat is Chat => {
    if (!chat || typeof chat !== "object") return false;
    const c = chat as Partial<Chat>;
    return (
      typeof c.id === "string" &&
      typeof c.title === "string" &&
      typeof c.createdAt === "string" &&
      typeof c.updatedAt === "string"
    );
  });

  const messages: Record<string, ChatMessage[]> = {};
  if (candidate.messages && typeof candidate.messages === "object" && !Array.isArray(candidate.messages)) {
    for (const [chatId, messageList] of Object.entries(candidate.messages)) {
      if (!Array.isArray(messageList)) continue;
      messages[chatId] = messageList.filter((message): message is ChatMessage => {
        if (!message || typeof message !== "object") return false;
        const m = message as Partial<ChatMessage>;
        return (
          typeof m.id === "string" &&
          typeof m.chatId === "string" &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          typeof m.timestamp === "string"
        );
      });
    }
  }

  return {
    version: 1,
    chats,
    messages,
  };
}

class ChatStore {
  private chats: Map<string, Chat> = new Map();
  private messages: Map<string, ChatMessage[]> = new Map();

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk() {
    try {
      const raw = readFileSync(CHAT_STORE_PATH, "utf-8");
      const parsed = parsePersistedStore(JSON.parse(raw) as unknown);
      if (!parsed) {
        console.warn("Ignoring invalid persisted chat store format.");
        return;
      }

      this.chats = new Map(parsed.chats.map((chat) => [chat.id, chat]));
      this.messages = new Map(
        Object.entries(parsed.messages).map(([chatId, chatMessages]) => [chatId, chatMessages]),
      );

      for (const chatId of this.chats.keys()) {
        if (!this.messages.has(chatId)) {
          this.messages.set(chatId, []);
        }
      }
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException;
      if (fileError.code !== "ENOENT") {
        console.error("Failed to load persisted chat store:", error);
      }
    }
  }

  private persistToDisk() {
    const store: PersistedChatStore = {
      version: 1,
      chats: Array.from(this.chats.values()),
      messages: Object.fromEntries(this.messages.entries()),
    };

    mkdirSync(path.dirname(CHAT_STORE_PATH), { recursive: true });
    writeFileSync(CHAT_STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
  }

  createChat(title?: string): Chat {
    const id = uuidv4();
    const now = new Date().toISOString();
    const chat: Chat = {
      id,
      title: title || "New Chat",
      createdAt: now,
      updatedAt: now,
    };
    this.chats.set(id, chat);
    this.messages.set(id, []);
    this.persistToDisk();
    return chat;
  }

  getChat(id: string): Chat | undefined {
    return this.chats.get(id);
  }

  getAllChats(): Chat[] {
    return Array.from(this.chats.values()).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  updateChatTitle(id: string, title: string): Chat | undefined {
    const chat = this.chats.get(id);
    if (chat) {
      chat.title = title;
      chat.updatedAt = new Date().toISOString();
      this.persistToDisk();
    }
    return chat;
  }

  deleteChat(id: string): boolean {
    this.messages.delete(id);
    const deleted = this.chats.delete(id);
    if (deleted) {
      this.persistToDisk();
    }
    return deleted;
  }

  addMessage(chatId: string, message: Omit<ChatMessage, "id" | "chatId" | "timestamp">): ChatMessage {
    const messages = this.messages.get(chatId);
    if (!messages) {
      throw new Error(`Chat ${chatId} not found`);
    }

    const newMessage: ChatMessage = {
      id: uuidv4(),
      chatId,
      timestamp: new Date().toISOString(),
      ...message,
    };
    messages.push(newMessage);

    // Update chat's updatedAt
    const chat = this.chats.get(chatId);
    if (chat) {
      chat.updatedAt = newMessage.timestamp;

      // Auto-generate title from first user message if still "New Chat"
      if (chat.title === "New Chat" && message.role === "user") {
        chat.title = message.content.slice(0, 50) + (message.content.length > 50 ? "..." : "");
      }
    }

    this.persistToDisk();
    return newMessage;
  }

  getMessages(chatId: string): ChatMessage[] {
    return this.messages.get(chatId) || [];
  }

  setMessageCost(chatId: string, messageId: string, costUsd: number): ChatMessage | undefined {
    const messages = this.messages.get(chatId);
    if (!messages) return undefined;

    const message = messages.find((msg) => msg.id === messageId);
    if (!message) return undefined;

    message.costUsd = costUsd;
    this.persistToDisk();
    return message;
  }
}

// Singleton instance
export const chatStore = new ChatStore();
