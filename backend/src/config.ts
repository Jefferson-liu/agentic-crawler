import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 4111),
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000',
  contextApiBaseUrl: process.env.CONTEXT_API_BASE_URL ?? 'http://localhost:8000',
  modelName: process.env.MODEL_NAME ?? '',
};
