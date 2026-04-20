import { MCPClient } from '@mastra/mcp';
import { config } from '../config.js';

export const mcpClient = new MCPClient({
  id: 'codebase-knowledge',
  servers: {
    codebase: {
      url: new URL(config.mcpServerUrl),
    },
  },
});
