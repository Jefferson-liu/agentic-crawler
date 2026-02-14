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
    console.error('Invalid request body:', parsed.error);
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const userMessage = parsed.data.message;
  console.log(`[Chat] Received message: "${userMessage}"`);

  try {
    console.log('[Chat] Generating response...');
    const result = await contextAgent.generate(userMessage);
    console.log(`[Chat] Response generated: "${result.text}"`);
    return res.json({ reply: result.text });
  } catch (error) {
    console.error('[Chat] Agent generation failed:', error);
    return res.status(500).json({ 
      error: 'Agent generation failed',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});
