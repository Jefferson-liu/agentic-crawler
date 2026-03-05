import type { WSClient } from "./types.js";
import { AgentSession } from "./ai-client.js";
import { chatStore } from "./chat-store.js";
import { repoProgressBus, type RepoProgressEvent } from "./repo-progress-bus.js";
import { repoCostLedger } from "./repo-cost-ledger.js";

// Session manages a single chat conversation with a long-lived agent
export class Session {
  public readonly chatId: string;
  private subscribers: Set<WSClient> = new Set();
  private agentSession: AgentSession;
  private isListening = false;
  private nextTurnId = 0;
  private pendingTurnQueue: number[] = [];
  private turnAssistantMessageIds: Map<number, string[]> = new Map();
  private turnRepoCompleteEvents: Map<number, RepoProgressEvent> = new Map();
  private turnToolUseIds: Map<number, Set<string>> = new Map();
  private turnToolNamesById: Map<number, Map<string, string>> = new Map();
  private lastTotalCostUsd = 0;
  private unsubscribeRepoProgress: (() => void) | null = null;

  constructor(chatId: string) {
    this.chatId = chatId;
    this.agentSession = new AgentSession(chatId);
    this.unsubscribeRepoProgress = repoProgressBus.subscribe(chatId, (event) => {
      this.broadcastRepoProgress(event);
    });
  }

  // Start listening to agent output (call once)
  private async startListening() {
    if (this.isListening) return;
    this.isListening = true;

    try {
      for await (const message of this.agentSession.getOutputStream()) {
        this.handleSDKMessage(message);
      }
    } catch (error) {
      console.error(`Error in session ${this.chatId}:`, error);
      this.broadcastError((error as Error).message);
    }
  }

  // Send a user message to the agent
  sendMessage(content: string) {
    const turnId = ++this.nextTurnId;
    this.pendingTurnQueue.push(turnId);
    this.turnAssistantMessageIds.set(turnId, []);
    this.turnToolUseIds.set(turnId, new Set());
    this.turnToolNamesById.set(turnId, new Map());

    // Store user message
    chatStore.addMessage(this.chatId, {
      role: "user",
      content,
      turnId,
    });

    // Broadcast user message to subscribers
    this.broadcast({
      type: "user_message",
      content,
      chatId: this.chatId,
      turnId,
    });

    // Send to agent first (this starts the session if needed)
    this.agentSession.sendMessage(content);

    // Start listening if not already
    if (!this.isListening) {
      this.startListening();
    }
  }

  async stopCurrentTurn() {
    const turnId = this.getActiveTurnId();
    if (typeof turnId !== "number") {
      this.broadcast({
        type: "turn_stopped",
        chatId: this.chatId,
        success: false,
        message: "No active turn to stop.",
      });
      return;
    }

    const interruptResult = await this.agentSession.interruptCurrentTurn();
    this.broadcast({
      type: "turn_stopped",
      chatId: this.chatId,
      turnId,
      success: interruptResult.success,
      message: interruptResult.message,
    });
  }

  private getActiveTurnId(): number | undefined {
    return this.pendingTurnQueue[0];
  }

  private handleSDKMessage(message: any) {
    if (message.type === "assistant") {
      const content = message.message.content;
      const turnId = this.getActiveTurnId();

      if (typeof content === "string") {
        const savedMessage = chatStore.addMessage(this.chatId, {
          role: "assistant",
          content,
          turnId,
        });
        if (typeof turnId === "number") {
          this.turnAssistantMessageIds.get(turnId)?.push(savedMessage.id);
        }
        this.broadcast({
          type: "assistant_message",
          messageId: savedMessage.id,
          content,
          chatId: this.chatId,
          turnId,
        });
      } else if (Array.isArray(content)) {
        const textBlocks: string[] = [];

        for (const block of content) {
          if (block.type === "text") {
            textBlocks.push(block.text);
          } else if (block.type === "tool_use") {
            this.broadcastToolUseEvent({
              turnId,
              toolName: block.name,
              toolId: block.id,
              toolInput: block.input,
            });
          }
        }

        if (textBlocks.length > 0) {
          const mergedContent = textBlocks.join("\n\n");
          const savedMessage = chatStore.addMessage(this.chatId, {
            role: "assistant",
            content: mergedContent,
            turnId,
          });
          if (typeof turnId === "number") {
            this.turnAssistantMessageIds.get(turnId)?.push(savedMessage.id);
          }
          this.broadcast({
            type: "assistant_message",
            messageId: savedMessage.id,
            content: mergedContent,
            chatId: this.chatId,
            turnId,
          });
        }
      }
    } else if (message.type === "user") {
      const turnId = this.getActiveTurnId();
      if (typeof turnId !== "number") {
        return;
      }

      const content = message?.message?.content;
      if (!Array.isArray(content)) {
        return;
      }

      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const typedBlock = block as {
          type?: unknown;
          tool_use_id?: unknown;
          is_error?: unknown;
          content?: unknown;
        };
        if (typedBlock.type !== "tool_result") {
          continue;
        }

        const toolUseId =
          typeof typedBlock.tool_use_id === "string" && typedBlock.tool_use_id.trim().length > 0
            ? typedBlock.tool_use_id
            : undefined;
        if (!toolUseId) {
          continue;
        }

        const knownToolName = this.turnToolNamesById.get(turnId)?.get(toolUseId);
        const inferredToolName = this.inferToolNameFromToolResult(typedBlock.content);
        const toolName = knownToolName ?? inferredToolName ?? "unknown_tool";

        this.broadcastToolUseEvent({
          turnId,
          toolName,
          toolId: toolUseId,
          toolInput: {
            source: "tool_result_inferred",
            is_error: typedBlock.is_error === true,
            ...(typeof inferredToolName === "string" && !knownToolName
              ? { inferred_tool_name: inferredToolName }
              : {}),
            result_summary: this.summarizeToolResultContent(typedBlock.content),
          },
        });
      }
    } else if (message.type === "tool_progress") {
      const turnId = this.getActiveTurnId();
      const toolName =
        typeof message?.tool_name === "string" && message.tool_name.trim().length > 0
          ? message.tool_name
          : "UnknownTool";
      const toolId =
        typeof message?.tool_use_id === "string" && message.tool_use_id.trim().length > 0
          ? message.tool_use_id
          : undefined;
      const toolInput: Record<string, unknown> = {};
      if (typeof message?.elapsed_time_seconds === "number") {
        toolInput.elapsed_time_seconds = message.elapsed_time_seconds;
      }
      if (typeof message?.parent_tool_use_id === "string" && message.parent_tool_use_id.trim().length > 0) {
        toolInput.parent_tool_use_id = message.parent_tool_use_id;
      }

      this.broadcastToolUseEvent({
        turnId,
        toolName,
        toolId,
        toolInput: Object.keys(toolInput).length > 0 ? toolInput : undefined,
      });
    } else if (message.type === "result") {
      const turnId = this.pendingTurnQueue.shift();
      const success = message.subtype === "success";
      const error = this.getResultError(message, success);
      const totalCost = typeof message.total_cost_usd === "number" ? message.total_cost_usd : undefined;
      const cost = this.getTurnCost(totalCost);

      if (typeof turnId === "number") {
        const assistantMessageIds = this.turnAssistantMessageIds.get(turnId) || [];
        const repoCompleteEvent = this.turnRepoCompleteEvents.get(turnId);

        if (assistantMessageIds.length === 0) {
          const fallbackAssistantContent = this.buildFallbackAssistantMessage(
            message,
            repoCompleteEvent,
            cost,
            error,
            success,
          );
          if (fallbackAssistantContent) {
            const savedMessage = chatStore.addMessage(this.chatId, {
              role: "assistant",
              content: fallbackAssistantContent,
              turnId,
            });
            assistantMessageIds.push(savedMessage.id);
            this.broadcast({
              type: "assistant_message",
              messageId: savedMessage.id,
              content: fallbackAssistantContent,
              chatId: this.chatId,
              turnId,
            });
          }
        }

        const lastAssistantMessageId = assistantMessageIds[assistantMessageIds.length - 1];

        if (lastAssistantMessageId && typeof cost === "number") {
          const updated = chatStore.setMessageCost(this.chatId, lastAssistantMessageId, cost);
          if (updated) {
            this.broadcast({
              type: "message_updated",
              chatId: this.chatId,
              messageId: updated.id,
              costUsd: cost,
            });
          }
        }

        this.turnAssistantMessageIds.delete(turnId);
        this.turnRepoCompleteEvents.delete(turnId);
        this.turnToolUseIds.delete(turnId);
        this.turnToolNamesById.delete(turnId);

        repoCostLedger.recordTurnResult({
          chat_id: this.chatId,
          turn_id: turnId,
          timestamp: new Date().toISOString(),
          success,
          ...(typeof message?.subtype === "string" ? { subtype: message.subtype } : {}),
          ...(typeof error === "string" ? { error } : {}),
          ...(typeof cost === "number" ? { cost_usd: cost } : {}),
          ...(typeof message?.duration_ms === "number" && Number.isFinite(message.duration_ms)
            ? { duration_ms: message.duration_ms }
            : {}),
        });
      }

      if (!success) {
        const failureDetails = {
          subtype: message?.subtype,
          result: message?.result,
          error: message?.error,
          permission_denials: message?.permission_denials,
          duration_ms: message?.duration_ms,
          total_cost_usd: message?.total_cost_usd,
        };
        console.error(
          `[Session ${this.chatId}] turn ${typeof turnId === "number" ? turnId : "unknown"} failed: ${
            error ?? "unknown error"
          }`,
        );
        console.error(`[Session ${this.chatId}] failure details:`, failureDetails);
      }

      this.broadcast({
        type: "result",
        success,
        chatId: this.chatId,
        turnId,
        cost,
        duration: message.duration_ms,
        ...(error ? { error } : {}),
      });
    }
  }

  private getTurnCost(totalCostUsd?: number): number | undefined {
    if (typeof totalCostUsd !== "number") {
      return undefined;
    }

    // SDK reports cumulative session cost; convert to incremental per-turn cost.
    const deltaCost = totalCostUsd - this.lastTotalCostUsd;
    this.lastTotalCostUsd = totalCostUsd;

    if (deltaCost < 0) {
      return totalCostUsd;
    }

    return deltaCost;
  }

  private getResultError(message: any, success: boolean): string | undefined {
    if (success) {
      return undefined;
    }

    if (typeof message?.result === "string" && message.result.trim().length > 0) {
      return message.result.trim();
    }

    if (typeof message?.error === "string" && message.error.trim().length > 0) {
      return message.error.trim();
    }

    if (Array.isArray(message?.permission_denials) && message.permission_denials.length > 0) {
      return `permission_denials=${message.permission_denials.length}`;
    }

    return typeof message?.subtype === "string"
      ? `result subtype=${message.subtype}`
      : "result was not successful";
  }

  private buildFallbackAssistantMessage(
    message: any,
    repoCompleteEvent?: RepoProgressEvent,
    turnCostUsd?: number,
    resultError?: string,
    success?: boolean,
  ): string | undefined {
    const resultText =
      typeof message?.result === "string" && message.result.trim().length > 0
        ? message.result.trim()
        : undefined;
    const lines: string[] = [];

    if (resultText) {
      lines.push(resultText);
    }

    if (typeof resultError === "string" && resultError.trim().length > 0) {
      lines.push(`Turn status: failed (${resultError.trim()}).`);
    } else if (success === false && typeof message?.subtype === "string") {
      lines.push(`Turn status: failed (${message.subtype}).`);
    }

    if (repoCompleteEvent) {
      if (!resultText || resultText !== repoCompleteEvent.message) {
        lines.push(repoCompleteEvent.message);
      }
      if (repoCompleteEvent.queue) {
        const queue = repoCompleteEvent.queue;
        lines.push(
          `Queue: completed ${queue.completed}/${queue.total}, failed ${queue.failed}, retries ${queue.retry_count}.`,
        );
      }
      if (repoCompleteEvent.cost) {
        const cost = repoCompleteEvent.cost;
        lines.push(
          `Pipeline cost: total $${cost.total_cost_usd.toFixed(6)} (queue $${cost.queue_cost_usd.toFixed(
            6,
          )}, context $${cost.context_cost_usd.toFixed(6)}).`,
        );
      }
    }

    if (typeof turnCostUsd === "number") {
      lines.push(`Turn cost: $${turnCostUsd.toFixed(6)}.`);
    }

    if (lines.length === 0) {
      return undefined;
    }

    return lines.join("\n");
  }

  private broadcastToolUseEvent(input: {
    turnId: number | undefined;
    toolName: unknown;
    toolId: unknown;
    toolInput?: unknown;
  }) {
    const { turnId } = input;
    if (typeof turnId !== "number") {
      return;
    }

    const toolName =
      typeof input.toolName === "string" && input.toolName.trim().length > 0
        ? input.toolName
        : "UnknownTool";

    const toolId =
      typeof input.toolId === "string" && input.toolId.trim().length > 0
        ? input.toolId
        : undefined;

    const seenIds = this.turnToolUseIds.get(turnId) ?? new Set<string>();
    this.turnToolUseIds.set(turnId, seenIds);

    if (toolId && seenIds.has(toolId)) {
      return;
    }
    if (toolId) {
      seenIds.add(toolId);
      const byId = this.turnToolNamesById.get(turnId) ?? new Map<string, string>();
      byId.set(toolId, toolName);
      this.turnToolNamesById.set(turnId, byId);
    }

    this.broadcast({
      type: "tool_use",
      toolName,
      toolId: toolId ?? `${toolName}-${Date.now()}`,
      toolInput: input.toolInput,
      chatId: this.chatId,
      turnId,
    });
  }

  private summarizeToolResultContent(content: unknown): string {
    if (typeof content === "string") {
      return content.slice(0, 240);
    }
    if (Array.isArray(content)) {
      const textParts: string[] = [];
      for (const item of content) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const block = item as { type?: unknown; text?: unknown };
        if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
          textParts.push(block.text.trim());
        }
      }
      if (textParts.length > 0) {
        return textParts.join(" ").slice(0, 240);
      }
      return JSON.stringify(content).slice(0, 240);
    }
    if (content && typeof content === "object") {
      return JSON.stringify(content).slice(0, 240);
    }
    return "";
  }

  private inferToolNameFromToolResult(content: unknown): string | undefined {
    const summary = this.summarizeToolResultContent(content);
    if (!summary) {
      return undefined;
    }

    const autoDeniedMatch = summary.match(
      /Permission to use ([A-Za-z0-9_:.\\/-]+) has been auto-denied/i,
    );
    if (autoDeniedMatch?.[1]) {
      return autoDeniedMatch[1];
    }

    const backtickToolMatch = summary.match(/`([A-Za-z0-9_:.\\/-]+)`/);
    if (backtickToolMatch?.[1] && backtickToolMatch[1].startsWith("mcp__")) {
      return backtickToolMatch[1];
    }

    return undefined;
  }

  subscribe(client: WSClient) {
    this.subscribers.add(client);
    client.sessionId = this.chatId;
  }

  unsubscribe(client: WSClient) {
    this.subscribers.delete(client);
  }

  hasSubscribers(): boolean {
    return this.subscribers.size > 0;
  }

  private broadcast(message: any) {
    const messageStr = JSON.stringify(message);
    for (const client of this.subscribers) {
      try {
        if (client.readyState === client.OPEN) {
          client.send(messageStr);
        }
      } catch (error) {
        console.error("Error broadcasting to client:", error);
        this.subscribers.delete(client);
      }
    }
  }

  private broadcastError(error: string) {
    this.broadcast({
      type: "error",
      error,
      chatId: this.chatId,
    });
  }

  private broadcastRepoProgress(event: RepoProgressEvent) {
    const activeTurnId = this.getActiveTurnId();
    if (event.stage === "complete" && typeof activeTurnId === "number") {
      this.turnRepoCompleteEvents.set(activeTurnId, event);
    }
    repoCostLedger.recordRepoProgressEvent(event);

    const kind = event.event_kind ?? "pipeline";
    const task = event.task_id ? ` task=${event.task_id}` : "";
    const tool = event.tool_name ? ` tool=${event.tool_name}` : "";
    const queue = event.queue
      ? ` queue(total=${event.queue.total},pending=${event.queue.pending},running=${event.queue.running},completed=${event.queue.completed},failed=${event.queue.failed},retries=${event.queue.retry_count})`
      : "";
    const cost = event.cost
      ? ` cost(total=${event.cost.total_cost_usd.toFixed(6)},queue=${event.cost.queue_cost_usd.toFixed(6)},context=${event.cost.context_cost_usd.toFixed(6)})`
      : "";
    const error = event.error ? ` error=${event.error}` : "";
    const permissionDenials =
      Array.isArray(event.permission_denials) && event.permission_denials.length > 0
        ? ` permission_denials=${event.permission_denials
            .map((denial) =>
              `${denial.tool_name}${denial.tool_use_id ? `#${denial.tool_use_id}` : ""}${
                denial.tool_input_summary ? `(${denial.tool_input_summary})` : ""
              }`,
            )
            .join(",")}`
        : "";
    const heartbeat = event.heartbeat
      ? ` heartbeat(seq=${event.heartbeat.seq},elapsed_ms=${event.heartbeat.elapsed_ms},idle_ms=${event.heartbeat.idle_ms},last_event=${event.heartbeat.last_event_type ?? "none"},last_tool=${event.heartbeat.last_tool_name ?? "none"},tool_use_count=${event.heartbeat.tool_use_count},tool_progress_count=${event.heartbeat.tool_progress_count},permission_denials_count=${event.heartbeat.permission_denials_count})`
      : "";
    console.log(
      `[repo_progress][session=${this.chatId}][run=${event.run_id}][${event.stage}] kind=${kind}${task}${tool}${permissionDenials}${heartbeat} ${event.message}${queue}${cost}${error}`,
    );

    this.broadcast({
      ...event,
      chatId: this.chatId,
    });
  }

  // Close the session
  close() {
    if (this.unsubscribeRepoProgress) {
      this.unsubscribeRepoProgress();
      this.unsubscribeRepoProgress = null;
    }
    this.agentSession.close();
  }
}
