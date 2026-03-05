import {
  query,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";
import { customServer } from "./custom-tools";

const SKILL_SYSTEM_PROMPT = `You are a helpful AI product management assistant.

For repository architecture, codebase summaries, cross-file relationships, or repository refresh requests, use the Skill tool and invoke the "repo-crawling-analysis" project skill.
When the user sends "/repo refresh", treat it as a forced rebuild request instead of using cached summary output.

For non-repository questions, answer directly and concisely.`;

const LEGACY_SYSTEM_PROMPT = `You are a helpful AI product management assistant.

Answer clearly and concisely. Use available tools when needed to inspect files, references, and summaries.`;

const SKILL_ALLOWED_TOOLS = [
  "Skill",
  "Bash",
  "Read",
  "Glob",
  "Grep",
  "Write",
  "mcp__file__read_context_summary",
  "mcp__file__read_file_summaries",
  "mcp__file__index_repository_ast",
  "mcp__file__list_reference_subjects",
  "mcp__file__read_file",
  "mcp__file__return_reference_graph",
  "mcp__file__write_file_summary",
  "mcp__file__write_context_summary",
];

type AgentModel = "sonnet" | "haiku" | "opus" | "inherit";

function resolveAgentModel(value: string | undefined, fallback: AgentModel): AgentModel {
  if (value === "sonnet" || value === "haiku" || value === "opus" || value === "inherit") {
    return value;
  }
  return fallback;
}

const MAIN_AGENT_MODEL = resolveAgentModel(process.env.MAIN_AGENT_MODEL, "sonnet");
const REPO_ANALYSIS_SKILL_ENABLED = process.env.REPO_ANALYSIS_SKILL_ENABLED !== "0";

class MessageQueue {
  private messages: Array<{
    type: "user";
    message: { role: "user"; content: string };
    parent_tool_use_id: string | null;
  }> = [];
  private waiting:
    | ((msg: {
        type: "user";
        message: { role: "user"; content: string };
        parent_tool_use_id: string | null;
      }) => void)
    | null = null;
  private closed = false;

  push(content: string) {
    const msg = {
      type: "user",
      message: {
        role: "user",
        content,
      },
      parent_tool_use_id: null,
    };

    if (this.waiting) {
      this.waiting(msg);
      this.waiting = null;
    } else {
      this.messages.push(msg);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<any> {
    while (!this.closed) {
      if (this.messages.length > 0) {
        yield this.messages.shift()!;
      } else {
        yield await new Promise<any>((resolve) => {
          this.waiting = resolve;
        });
      }
    }
  }

  close() {
    this.closed = true;
  }
}

function mapSpecialCommand(content: string): string {
  const normalized = content.trim();
  if (/^\/repo\s+refresh$/i.test(normalized)) {
    return "Refresh repository analysis now. Force a full rebuild instead of using cached summaries.";
  }
  return content;
}

export class AgentSession {
  private queue = new MessageQueue();
  private queryStream: Query | null = null;
  private outputIterator: AsyncIterator<any> | null = null;

  constructor() {
    const options: Record<string, unknown> = {
      maxTurns: 300,
      model: MAIN_AGENT_MODEL,
      permissionMode: "acceptEdits",
      mcpServers: {
        file: customServer,
      },
      cwd: process.cwd(),
      systemPrompt: REPO_ANALYSIS_SKILL_ENABLED ? SKILL_SYSTEM_PROMPT : LEGACY_SYSTEM_PROMPT,
    };

    if (REPO_ANALYSIS_SKILL_ENABLED) {
      options.settingSources = ["user", "project"];
      options.allowedTools = SKILL_ALLOWED_TOOLS;
    }

    this.queryStream = query({
      prompt: this.queue,
      options: options as any,
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
