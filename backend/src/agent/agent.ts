import { Agent } from '@mastra/core/agent';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { mcpClient } from './mcp-client.js';

const modelName = 'claude-sonnet-4-6';

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

export async function initContextAgent() {
  let mcpTools: Record<string, unknown> = {};
  try {
    mcpTools = await mcpClient.listTools();
    console.log(`[Agent] MCP tools loaded: ${Object.keys(mcpTools).join(', ')}`);
  } catch (err) {
    console.warn('[Agent] MCP server unavailable, starting without MCP tools:', err instanceof Error ? err.message : err);
  }

  contextAgent = new Agent({
    id: 'context-retrieval-agent',
    name: 'context-retrieval-agent',
    instructions: [
      'You are the agent-service orchestration layer for this app.',
      'You have access to codebase knowledge tools (overview, architecture, file_tree, list_modules, get_module, search_file_summaries, get_file_summary) from the MCP server.',
      'Tool policy:',
      '1) For questions about the codebase structure, architecture, or specific files, use the codebase knowledge tools.',
      '   - Start with overview() or architecture() for high-level questions.',
      '   - Use list_modules() or file_tree() to orient in the codebase.',
      '   - Use get_file_summary() for questions about specific files.',
      '2) Use the JSON returned by tools as your evidence.',
      '3) Do not invent facts not supported by tool output.',
      '4) If a tool returns an error or no useful results, say so and ask the user to refine the query.',
      'Response policy:',
      '- Be concise and factual.',
      '- Include uncertainty when data is missing or ambiguous.',
    ].join('\n'),
    model: `anthropic/${modelName}`,
    tools: mcpTools as Record<string, any>,
    memory: agentMemory,
  });
}
