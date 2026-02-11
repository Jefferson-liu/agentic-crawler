import { Agent } from '@mastra/core/agent';

// Basic placeholder agent. Extend this with context-backend tools and workflows.
export const contextAgent = new Agent({
  name: 'context-retrieval-agent',
  instructions:
    'You are the orchestration layer. Use the external backend for retrieval and return concise answers.',
  model: {
    provider: 'openai',
    name: 'gpt-4o-mini',
  },
});
