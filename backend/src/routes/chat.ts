import { Router } from 'express';
import { z } from 'zod';
import { contextAgent } from '../agent/agent.js';

const chatBody = z.object({
  message: z.string().min(1),
});

export const chatRouter = Router();

chatRouter.post('/', async (req, res) => {
  const parsed = chatBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  try {
    const result = await contextAgent.generate(parsed.data.message);
    return res.json({ reply: result.text });
  } catch {
    return res.status(500).json({ error: 'Agent generation failed' });
  }
});
