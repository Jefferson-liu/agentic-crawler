import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { config } from './config.js';
import { chatRouter } from './routes/chat.js';

const app = express();

app.use(
  cors({
    origin: config.frontendOrigin,
  })
);

// Proxy context requests - BEFORE body parsers to ensure stream integrity for uploads
app.use(
  '/api/context',
  createProxyMiddleware({
    target: config.contextApiBaseUrl,
    changeOrigin: true,
    pathRewrite: {
      '^/api/context': '', // remove base path
    },
  })
);

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'agent-service' });
});

app.use('/api/chat', chatRouter);

app.listen(config.port, () => {
  console.log(`agent-service listening on http://localhost:${config.port}`);
});
