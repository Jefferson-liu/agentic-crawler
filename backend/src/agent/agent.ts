import { Agent } from '@mastra/core/agent';
import { Memory } from "@mastra/memory";
import { config } from '../config.js';
import { contextSearchTool } from './tools/context-search.tool.js';
import { PostgresStore } from "@mastra/pg";

const storage = new PostgresStore({
  id: 'pg-storage',
  connectionString: process.env.DATABASE_URL,
});

const modelName = config.modelName?.trim() || 'claude-sonnet-4-20250514';

export const contextAgent = new Agent({
  id: 'context-retrieval-agent',
  name: 'context-retrieval-agent',
  instructions: [
    'You are the agent-service orchestration layer for this app.',
    'External context backend is the source of truth for retrieval.',
    'Tool policy:',
    '1) For questions that require retrieval, call `context-search` with a plain-language query string.',
    '2) Use the JSON returned by the tool as your evidence.',
    '3) Do not invent facts not supported by tool output.',
    '4) If the tool returns an error or no useful results, say so and ask the user to refine the query.',
    'Response policy:',
    '- Be concise and factual.',
    '- Include uncertainty when backend data is missing or ambiguous.',
  ].join('\n'),
  model: `anthropic/${modelName}`,
  tools: {
    contextSearch: contextSearchTool,
  },
  memory: new Memory({
    options: {
      observationalMemory: true,
    },
  }),
});
