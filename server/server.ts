import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import type { WSClient, IncomingWSMessage } from "./types.js";
import { chatStore } from "./chat-store.js";
import { repoCostLedger } from "./repo-cost-ledger.js";
import { Session } from "./session.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 4111;

// Express app
const app = express();
app.use(cors());
app.use(express.json());

function normalizeUsd(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
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

// Serve static files from client directory
app.use("/client", express.static(path.join(__dirname, "../client")));

// Serve index.html at root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/index.html"));
});

// Session management
const sessions: Map<string, Session> = new Map();

function getOrCreateSession(chatId: string): Session {
  let session = sessions.get(chatId);
  if (!session) {
    session = new Session(chatId);
    sessions.set(chatId, session);
  }
  return session;
}

// REST API: Get all chats
app.get("/api/chats", (req, res) => {
  const chats = chatStore.getAllChats();
  res.json(chats);
});

// REST API: Create new chat
app.post("/api/chats", (req, res) => {
  const chat = chatStore.createChat(req.body?.title);
  res.status(201).json(chat);
});

// REST API: Get single chat
app.get("/api/chats/:id", (req, res) => {
  const chat = chatStore.getChat(req.params.id);
  if (!chat) {
    return res.status(404).json({ error: "Chat not found" });
  }
  res.json(chat);
});

// REST API: Delete chat
app.delete("/api/chats/:id", (req, res) => {
  const deleted = chatStore.deleteChat(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: "Chat not found" });
  }
  const session = sessions.get(req.params.id);
  if (session) {
    session.close();
    sessions.delete(req.params.id);
  }
  res.json({ success: true });
});

// REST API: Get chat messages
app.get("/api/chats/:id/messages", (req, res) => {
  const messages = chatStore.getMessages(req.params.id);
  res.json(messages);
});

// REST API: Cost summary across chats and repo pipeline runs
app.get("/api/costs/summary", (req, res) => {
  const chats = chatStore.getAllChats();
  const perChat = new Map<string, ChatCostSummary>();
  let assistantMessageTotalUsd = 0;

  for (const chat of chats) {
    let assistantTurnCount = 0;
    let assistantMessageCostUsd = 0;
    const messages = chatStore.getMessages(chat.id);

    for (const message of messages) {
      if (message.role !== "assistant") {
        continue;
      }
      const messageCost = normalizeUsd(message.costUsd);
      if (messageCost <= 0) {
        continue;
      }
      assistantTurnCount += 1;
      assistantMessageCostUsd += messageCost;
    }

    assistantMessageTotalUsd += assistantMessageCostUsd;
    perChat.set(chat.id, {
      chat_id: chat.id,
      title: chat.title,
      updated_at: chat.updatedAt,
      assistant_turn_count: assistantTurnCount,
      repo_run_count: 0,
      assistant_message_cost_usd: assistantMessageCostUsd,
      repo_pipeline_cost_usd: 0,
      total_cost_usd: assistantMessageCostUsd,
    });
  }

  const runSnapshots = repoCostLedger.getRunCostSnapshots();
  let repoPipelineTotalUsd = 0;

  for (const run of runSnapshots) {
    const runCost = normalizeUsd(run.total_cost_usd);
    repoPipelineTotalUsd += runCost;

    const existing = perChat.get(run.chat_id);
    if (!existing) {
      const fallbackTitle =
        run.chat_id.trim().length > 0
          ? `Deleted chat (${run.chat_id.slice(0, 8)})`
          : "Deleted chat";
      perChat.set(run.chat_id, {
        chat_id: run.chat_id,
        title: fallbackTitle,
        updated_at: run.updated_at,
        assistant_turn_count: 0,
        repo_run_count: 1,
        assistant_message_cost_usd: 0,
        repo_pipeline_cost_usd: runCost,
        total_cost_usd: runCost,
        is_deleted_chat: true,
      });
      continue;
    }

    existing.repo_run_count += 1;
    existing.repo_pipeline_cost_usd += runCost;
    if (new Date(run.updated_at).getTime() > new Date(existing.updated_at).getTime()) {
      existing.updated_at = run.updated_at;
    }
  }

  const perChatList = Array.from(perChat.values())
    .map((entry) => ({
      ...entry,
      total_cost_usd:
        normalizeUsd(entry.assistant_message_cost_usd) +
        normalizeUsd(entry.repo_pipeline_cost_usd),
    }))
    .sort((a, b) => {
      const costDelta = b.total_cost_usd - a.total_cost_usd;
      if (costDelta !== 0) {
        return costDelta;
      }
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });

  const totalCostUsd = assistantMessageTotalUsd + repoPipelineTotalUsd;
  const chatsWithCostCount = perChatList.filter((entry) => entry.total_cost_usd > 0).length;

  res.json({
    generated_at: new Date().toISOString(),
    totals: {
      chat_count: perChatList.length,
      chats_with_cost_count: chatsWithCostCount,
      assistant_message_total_usd: assistantMessageTotalUsd,
      repo_pipeline_total_usd: repoPipelineTotalUsd,
      total_cost_usd: totalCostUsd,
    },
    per_chat: perChatList,
  });
});

// Create HTTP server
const server = createServer(app);

// WebSocket server
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws: WSClient) => {
  console.log("WebSocket client connected");
  ws.isAlive = true;

  ws.send(JSON.stringify({ type: "connected", message: "Connected to chat server" }));

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (data) => {
    try {
      const message: IncomingWSMessage = JSON.parse(data.toString());

      const attachToSession = (chatId: string): Session => {
        if (ws.sessionId && ws.sessionId !== chatId) {
          const previousSession = sessions.get(ws.sessionId);
          previousSession?.unsubscribe(ws);
        }

        const session = getOrCreateSession(chatId);
        session.subscribe(ws);
        return session;
      };

      switch (message.type) {
        case "subscribe": {
          const session = attachToSession(message.chatId);
          console.log(`Client subscribed to chat ${message.chatId}`);

          // Send existing messages
          const messages = chatStore.getMessages(message.chatId);
          ws.send(JSON.stringify({
            type: "history",
            messages,
            chatId: message.chatId,
          }));
          break;
        }

        case "chat": {
          const session = attachToSession(message.chatId);
          session.sendMessage(message.content);
          break;
        }

        case "stop": {
          const session = attachToSession(message.chatId);
          void session.stopCurrentTurn();
          break;
        }

        default:
          console.warn("Unknown message type:", (message as any).type);
      }
    } catch (error) {
      console.error("Error handling WebSocket message:", error);
      ws.send(JSON.stringify({ type: "error", error: "Invalid message format" }));
    }
  });

  ws.on("close", () => {
    console.log("WebSocket client disconnected");
    // Unsubscribe from all sessions
    for (const session of sessions.values()) {
      session.unsubscribe(ws);
    }
  });
});

// Heartbeat to detect dead connections
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    const client = ws as WSClient;
    if (client.isAlive === false) {
      return client.terminate();
    }
    client.isAlive = false;
    client.ping();
  });
}, 30000);

wss.on("close", () => {
  clearInterval(heartbeat);
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`WebSocket endpoint available at ws://localhost:${PORT}/ws`);
  console.log(`Visit http://localhost:${PORT} to view the chat interface`);
});
