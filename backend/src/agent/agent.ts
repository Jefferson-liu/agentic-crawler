import { Agent } from '@mastra/core/agent';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { MCPClient } from '@mastra/mcp';
import { config } from '../config.js';
import { getActiveRunId } from './scope-store.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

export const AVAILABLE_MODELS = [
  { id: 'claude-haiku-4-5', label: 'Haiku' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet' },
  { id: 'claude-opus-4-7', label: 'Opus' },
] as const;

export const agentMemory = new Memory({
  storage: new LibSQLStore({
    id: 'mastra-storage',
    url: 'file:../data/mastra.db',
  }),
  options: {
    lastMessages: 40,
  },
});

export let contextAgent: Agent;
let loadedMcpTools: Record<string, any> = {};
const agentCache = new Map<string, Agent>();

type ModelDescriptor =
  | string
  | {
      provider?: string | null;
      modelId?: string | null;
    }
  | undefined;

function makeMcpClient(): MCPClient {
  return new MCPClient({
    id: 'codebase-knowledge',
    servers: {
      codebase: {
        url: new URL(config.mcpServerUrl),
      },
    },
  });
}

// Wrap each MCP tool so run_id is injected deterministically at call time.
// The LLM never sees run_id as a parameter it can influence.
function wrapToolsWithScope(tools: Record<string, any>): Record<string, any> {
  const wrapped: Record<string, any> = {};
  for (const [name, tool] of Object.entries(tools)) {
    wrapped[name] = {
      ...tool,
      execute: async (args: Record<string, unknown>, options: unknown) => {
        const run_id = getActiveRunId();
        const injected = run_id ? { ...args, run_id } : args;
        return tool.execute(injected, options);
      },
    };
  }
  return wrapped;
}

async function tryLoadMcpTools(maxAttempts = 8, baseDelayMs = 3000): Promise<Record<string, any>> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const client = makeMcpClient();
      const raw = await client.listTools();
      const tools = wrapToolsWithScope(raw as Record<string, any>);
      console.log(`[Agent] MCP tools loaded (attempt ${attempt}/${maxAttempts}): ${Object.keys(tools).join(', ')}`);
      return tools;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Agent] MCP connect attempt ${attempt}/${maxAttempts} failed: ${msg}`);
      if (attempt < maxAttempts) {
        const delay = Math.min(baseDelayMs * attempt, 30_000);
        console.log(`[Agent] Retrying MCP in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  console.warn('[Agent] Starting without MCP tools after all retries exhausted.');
  return {};
}

function getModelProvider(model: ModelDescriptor): string | undefined {
  if (!model) return undefined;

  if (typeof model === 'string') {
    const [provider] = model.split('/', 1);
    return provider?.toLowerCase();
  }

  return typeof model.provider === 'string' ? model.provider.toLowerCase() : undefined;
}

function sanitizeModelSettingsForProvider(
  model: ModelDescriptor,
  modelSettings: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!modelSettings) return modelSettings;

  const provider = getModelProvider(model);
  if (!provider?.startsWith('anthropic')) return modelSettings;
  if (!Object.prototype.hasOwnProperty.call(modelSettings, 'temperature')) return modelSettings;

  const { temperature: _temperature, ...rest } = modelSettings;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function buildAgent(tools: Record<string, any>, modelName: string = DEFAULT_MODEL): Agent {
  return new Agent({
    id: 'context-retrieval-agent',
    name: 'context-retrieval-agent',
    instructions: `
You are a codebase assistant with MCP tools that give you direct read access to an indexed repository.

## Tools
- overview() — high-level project summary
- architecture() — architecture diagram (Mermaid)
- file_tree() — directory listing
- list_modules() / get_module(name) — architectural modules and their members
- search_file_summaries(query) / get_file_summary(path) — LLM-generated per-file summaries
- glob_files(pattern) — find files by path pattern, e.g. \`src/**/*.ts\`, \`*.py\`
- grep_code(pattern) — regex search across file contents
- get_file(path, start_line, end_line, max_lines) — read a bounded file slice with line metadata

## Mandatory rules

**Never answer from memory or training data.** Every factual claim about the codebase must come from tool output in this session. If you have not called a tool, you do not know.

**Name things exactly.** When you reference a symbol, always state:
- The exact function signature as it appears in the source: \`def summarize(self, payload: SummaryPayload) -> SummaryResult\`
- The exact class name: \`class RepoFileSummarizer\`, not "the summarizer class"
- The exact env var name: \`SEMAPHORE_LIMIT\`, not "the concurrency setting"
- The exact file path and line number: \`services/repo_knowledge/file_summarizer.py:142\`
- The exact CLI flag or config key: \`--max-iterations\` / \`REPO_SUMMARY_MAX_ITERATIONS\`

**No hedging.** Do not use "may", "might", "could", "seems to", "appears to", "probably", "likely", "typically", "generally", or "usually" when describing what the code does. If you are not sure, call a tool to verify. If the tool returns no result, say "not found" — do not speculate.

## Decision tree for codebase questions

1. Start with overview() or file_tree() if you need orientation.
2. Use get_file_summary(path) or search_file_summaries(query) for questions about what a file does, its role, or its relationships. This is sufficient for architecture and purpose questions — do not read raw files for this.
3. Use grep_code(pattern) to locate a specific function, class, constant, or env var by name.
4. Use get_file(path, ...) only after narrowing scope with summaries or grep. Start with a tight range (for example max_lines=120) and paginate only if needed.
5. Use glob_files(pattern) when looking for files by extension or directory: \`glob_files("services/**/*.py", limit=200)\`.
6. Chain tools: glob → grep → get_file(range), or file_tree → get_file_summary → grep → get_file(range).
7. If a tool returns no results or an error, report that and stop. Do not fall back to guessing.
8. If the question is about runtime behavior, production data, or anything not in the source, say so explicitly.

## Response format
- State exact names, paths, and line numbers for every code reference.
- For code snippets, use the literal text returned by get_file or grep_code — do not paraphrase.
- No filler, no preamble. Answer directly.
`.trim(),
    model: `anthropic/${modelName}` as any,
    tools,
    memory: agentMemory,
    defaultOptions: {
      // Mastra currently injects temperature: 0 by default. Anthropic rejects
      // that parameter for the Claude 4 family, so strip it before each step.
      prepareStep: ({ model, modelSettings }) => {
        const sanitizedModelSettings = sanitizeModelSettingsForProvider(
          model as ModelDescriptor,
          modelSettings as Record<string, unknown> | undefined,
        );

        if (sanitizedModelSettings === modelSettings) return undefined;
        return { modelSettings: sanitizedModelSettings as any };
      },
    },
  });
}

export function getAgentForModel(modelName: string): Agent {
  if (!agentCache.has(modelName)) {
    agentCache.set(modelName, buildAgent(loadedMcpTools, modelName));
  }
  return agentCache.get(modelName)!;
}

export async function initContextAgent(): Promise<void> {
  loadedMcpTools = await tryLoadMcpTools();
  contextAgent = buildAgent(loadedMcpTools);
  agentCache.set(DEFAULT_MODEL, contextAgent);
}

// Called at the start of each chat request — reconnects if tools weren't loaded at startup.
export async function ensureMcpTools(): Promise<void> {
  if (Object.keys(loadedMcpTools).length > 0) return;
  console.log('[Agent] No MCP tools loaded — attempting reconnect...');
  loadedMcpTools = await tryLoadMcpTools(3, 1000);
  if (Object.keys(loadedMcpTools).length > 0) {
    agentCache.clear();
    contextAgent = buildAgent(loadedMcpTools);
    agentCache.set(DEFAULT_MODEL, contextAgent);
    console.log('[Agent] Agent rebuilt with MCP tools.');
  }
}
