import { Router } from 'express';
import { z } from 'zod';
import { clearActiveScope, setActiveScope } from '../agent/scope-store.js';

export const scopeRouter = Router();

const scopeBody = z.object({
  repoFullName: z.string().min(1),
});

// Set active scope when user selects a repo as context
scopeRouter.post('/', (req, res) => {
  const parsed = scopeBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'repoFullName required' });
  }
  const userId = parsed.data.repoFullName.replace('/', '__');
  setActiveScope('demo_tenant', userId);
  return res.json({ ok: true });
});

// Reset scope to defaults when user clears context
scopeRouter.delete('/', (_req, res) => {
  clearActiveScope();
  return res.json({ ok: true });
});
