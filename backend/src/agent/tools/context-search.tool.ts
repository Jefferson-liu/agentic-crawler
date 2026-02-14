import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { config } from '../../config.js';

const inputSchema = z.object({
  query: z.string().min(1).describe('Search query text for context retrieval'),
});

export const contextSearchTool = createTool({
  id: 'context-search',
  description:
    'Returns relevant contextual information based on a search query. Useful for retrieving documents, knowledge snippets, or any relevant data that can assist in answering questions or providing insights.',
  inputSchema: z.object({
    input: z.string(),
  }),
  outputSchema: z.object({
    output: z.string(),
  }),
  execute: async (inputData) => {
    const baseUrl = config.contextApiBaseUrl;
    const endpoint = new URL('search', baseUrl);
    endpoint.searchParams.set('q', inputData.input);

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    const resolvedScope = config.contextScope.trim();
    if (resolvedScope) {
      headers['X-Scope'] = resolvedScope;
    }

    const apiKey = config.contextApiKey.trim();
    if (apiKey) {
      headers['X-API-Key'] = apiKey;
    }

    try {
      const response = await fetch(endpoint.toString(), {
        method: 'GET',
        headers,
      });

      let parsed: unknown = null;
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        parsed = await response.json();
      } else {
        const text = await response.text();
        parsed = text || null;
      }

      if (!response.ok) {
        return {
          success: false,
          output: parsed,
          error: `Context backend search failed (${response.status})`,
        };
      }

      return {
        success: true,
        output: parsed,
        error: null,
      };
    } catch (error) {
      return {
        success: false,
        output: null,
        error: error instanceof Error ? error.message : 'Unknown network error',
      };
    }
  },
});
