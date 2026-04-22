import { Router } from 'express';

export const scopeRouter = Router();

// This route is no longer used now that run_id is injected directly per chat
// request. Keep a harmless stub so the file still compiles if it is imported.
scopeRouter.all('/', (_req, res) => {
  return res.status(410).json({ error: 'Scope route deprecated; use /api/chat run_id instead.' });
});
