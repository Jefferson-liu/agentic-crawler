import { query, type Query, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { customServer } from "./custom-tools";
import { load_prompt_sync } from "./prompt-loader";

const DEFAULT_REPO_KNOWLEDGE_PROMPT =
  "You are a cache-first repo knowledge orchestrator. Reuse cache when valid, rebuild when stale.";

const SYSTEM_PROMPT = `You are a helpful AI product management assistant.

For repository/codebase questions (architecture, file roles, cross-file relationships, technical summaries), you MUST delegate to the "repo-knowledge" subagent via Task before answering.
Do not provide repository analysis directly from the top-level agent.
Wait for the delegated repo-knowledge workflow to finish before producing the final repository answer.

If the user asks to refresh repository knowledge, or uses the command \`/repo-knowledge refresh [repo_path?]\`, invoke "repo-knowledge" with force_refresh=true.

For non-repository requests, answer directly and concisely.`;

type AgentModel = "sonnet" | "haiku" | "opus" | "inherit";

function resolveAgentModel(value: string | undefined, fallback: AgentModel): AgentModel {
  if (value === "sonnet" || value === "haiku" || value === "opus" || value === "inherit") {
    return value;
  }
  return fallback;
}

function safeLoadPrompt(promptName: string, fallback: string): string {
  try {
    return load_prompt_sync(promptName);
  } catch (error) {
    console.error(`Failed to load prompt "${promptName}":`, error);
    return fallback;
  }
}

const REPO_KNOWLEDGE_PROMPT = safeLoadPrompt(
  "repo_knowledge_orchestrator",
  DEFAULT_REPO_KNOWLEDGE_PROMPT,
);

const MAIN_AGENT_MODEL = resolveAgentModel(process.env.MAIN_AGENT_MODEL, "sonnet");
const REPO_KNOWLEDGE_MODEL = resolveAgentModel(
  process.env.REPO_KNOWLEDGE_MODEL,
  "sonnet",
);

const REPO_KNOWLEDGE_ALLOWED_MCP_TOOLS = new Set([
  "mcp__file__run_repo_knowledge_team_pipeline",
  "mcp__file__read_context_summary",
]);
const TOP_LEVEL_ALLOWED_TOOLS = new Set([
  "Task",
  ...REPO_KNOWLEDGE_ALLOWED_MCP_TOOLS,
]);

type CanUseToolOptions = Parameters<CanUseTool>[2];
type CanUseToolSuggestions = CanUseToolOptions["suggestions"];

function allowTool(input: Record<string, unknown>, suggestions?: CanUseToolSuggestions) {
  return {
    behavior: "allow" as const,
    updatedInput: input,
    ...(Array.isArray(suggestions) && suggestions.length > 0
      ? { updatedPermissions: suggestions }
      : {}),
  };
}

function denyTool(message: string) {
  return {
    behavior: "deny" as const,
    message,
  };
}

type UserMessage = {
  type: "user";
  message: { role: "user"; content: string };
};

function mapSpecialCommand(content: string): string {
  const refreshMatch = content.match(/^\/repo-knowledge\s+refresh(?:\s+(.+))?$/i);
  if (!refreshMatch) {
    return content;
  }

  const repoAddress = refreshMatch[1]?.trim();
  if (repoAddress) {
    const quotedRepoAddress = JSON.stringify(repoAddress);
    return `Refresh repository knowledge now by delegating to the repo-knowledge subagent with force_refresh=true and repo_address=${quotedRepoAddress}. Return the refresh status and missing summaries.`;
  }

  return "Refresh repository knowledge now by delegating to the repo-knowledge subagent with force_refresh=true for the current working directory. Return the refresh status and missing summaries.";
}

class MessageQueue {
  private messages: UserMessage[] = [];
  private waiting: ((msg: UserMessage) => void) | null = null;
  private closed = false;

  push(content: string) {
    const msg: UserMessage = {
      type: "user",
      message: {
        role: "user",
        content,
      },
    };

    if (this.waiting) {
      this.waiting(msg);
      this.waiting = null;
    } else {
      this.messages.push(msg);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<UserMessage> {
    while (!this.closed) {
      if (this.messages.length > 0) {
        yield this.messages.shift()!;
      } else {
        yield await new Promise<UserMessage>((resolve) => {
          this.waiting = resolve;
        });
      }
    }
  }

  close() {
    this.closed = true;
  }
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  return { ...(input as Record<string, unknown>) };
}

export class AgentSession {
  private queue = new MessageQueue();
  private queryStream: Query | null = null;
  private outputIterator: AsyncIterator<any> | null = null;
  private readonly chatId: string;

  constructor(chatId: string) {
    this.chatId = chatId;

    this.queryStream = query({
      prompt: this.queue as any,
      options: {
        maxTurns: 300,
        model: MAIN_AGENT_MODEL,
        allowedTools: Array.from(TOP_LEVEL_ALLOWED_TOOLS),
        permissionMode: "dontAsk",
        mcpServers: {
          file: customServer,
        },
        agents: {
          "repo-knowledge": {
            description:
              "Cache-first repository knowledge orchestrator that runs a service-level queue pipeline tool for indexing, file summaries, and context generation.",
            prompt: REPO_KNOWLEDGE_PROMPT,
            model: REPO_KNOWLEDGE_MODEL,
            tools: [
              "mcp__file__run_repo_knowledge_team_pipeline",
              "mcp__file__read_context_summary",
            ],
            mcpServers: ["file"],
          },
        },
        canUseTool: (async (
          toolName: string,
          input: Record<string, unknown>,
          options: CanUseToolOptions,
        ) => {
          const isTopLevelAgent = !options.agentID;

          if (toolName === "Task") {
            if (isTopLevelAgent) {
              return allowTool(normalizeToolInput(input), options.suggestions);
            }
            return denyTool("Nested Task is disabled. Use service-level repo team pipeline.");
          }

          if (isTopLevelAgent && !TOP_LEVEL_ALLOWED_TOOLS.has(toolName)) {
            return denyTool(`${toolName} is disabled at top level. Delegate through Task.`);
          }

          if (REPO_KNOWLEDGE_ALLOWED_MCP_TOOLS.has(toolName)) {
            const normalizedInput = normalizeToolInput(input);
            if (toolName === "mcp__file__run_repo_knowledge_team_pipeline") {
              normalizedInput.chat_id = this.chatId;
            }
            return allowTool(normalizedInput, options.suggestions);
          }

          return denyTool(`${toolName} is not allowed in this session.`);
        }) satisfies CanUseTool,
        systemPrompt: SYSTEM_PROMPT,
      } as any,
    });
    this.outputIterator = this.queryStream[Symbol.asyncIterator]();
  }

  sendMessage(content: string) {
    this.queue.push(mapSpecialCommand(content));
  }

  async *getOutputStream() {
    if (!this.outputIterator) {
      throw new Error("Session not initialized");
    }
    while (true) {
      const { value, done } = await this.outputIterator.next();
      if (done) {
        break;
      }
      yield value;
    }
  }

  async interruptCurrentTurn(): Promise<{ success: boolean; message: string }> {
    if (!this.queryStream || typeof this.queryStream.interrupt !== "function") {
      return {
        success: false,
        message: "Interrupt is unavailable for this session.",
      };
    }

    try {
      await this.queryStream.interrupt();
      return {
        success: true,
        message: "Requested interruption of the active turn.",
      };
    } catch (error) {
      return {
        success: false,
        message:
          error instanceof Error ? error.message : "Failed to interrupt the active turn.",
      };
    }
  }

  close() {
    this.queue.close();
  }
}
