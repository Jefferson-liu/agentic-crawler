import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// .env lives at the monorepo root; backend runs from backend/ so we go up two levels
dotenv.config({ path: resolve(__dirname, '../../.env') });

export const config = {
  port: Number(process.env.PORT ?? 4111),
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000',
  contextApiBaseUrl: process.env.CONTEXT_API_BASE_URL ?? 'http://localhost:8000',
  mcpServerUrl: process.env.MCP_SERVER_URL ?? 'http://localhost:8000/mcp',
};
