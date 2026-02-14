import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 4111),
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000',
  contextApiBaseUrl: process.env.CONTEXT_API_BASE_URL ?? 'http://localhost:8000',
  contextApiKey: process.env.CONTEXT_API_KEY ?? '',
  contextScope: process.env.CONTEXT_SCOPE ?? '',
  modelName: process.env.MODEL_NAME ?? 'claude-sonnet-4-20250514',
};
