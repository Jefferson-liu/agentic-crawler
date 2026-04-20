import { Router } from 'express';
import { z } from 'zod';
import { contextAgent, agentMemory } from '../agent/agent.js';

const RESOURCE_ID = 'default-user';

const chatBody = z.object({
  message: z.string().min(1),
  threadId: z.string().min(1),
});

export const chatRouter = Router();

function logStep(stepIndex: number, step: any) {
  console.log(`\n[LLM Step ${stepIndex}] ${'─'.repeat(50)}`);
  console.log(`  Finish reason : ${step.finishReason}`);

  if (step.usage) {
    console.log(`  Tokens        : prompt=${step.usage.promptTokens} completion=${step.usage.completionTokens}`);
  }

  if (step.request?.body) {
    try {
      const body = typeof step.request.body === 'string' ? JSON.parse(step.request.body) : step.request.body;
      console.log('  Request body  :');
      console.log(JSON.stringify(body, null, 2));
    } catch {
      console.log('  Request body  :', step.request.body);
    }
  }

  if (step.toolCalls?.length) {
    console.log(`  Tool calls (${step.toolCalls.length}):`);
    for (const tc of step.toolCalls) {
      const p = tc.payload ?? tc;
      console.log(`    → ${p.toolName ?? tc.toolName ?? '(unknown)'}`);
      console.log(`      args: ${JSON.stringify(p.args ?? tc.args, null, 2)}`);
    }
  }

  if (step.toolResults?.length) {
    console.log(`  Tool results (${step.toolResults.length}):`);
    for (const tr of step.toolResults) {
      const p = tr.payload ?? tr;
      console.log(`    ← ${p.toolName ?? tr.toolName ?? '(unknown)'}`);
      console.log(`      result: ${JSON.stringify(p.result ?? tr.result, null, 2)}`);
    }
  }

  if (step.text) {
    console.log(`  Text          : ${step.text}`);
  }

  console.log(`${'─'.repeat(56)}\n`);
}

// List all threads
chatRouter.get('/threads', async (_req, res) => {
  try {
    const { threads } = await agentMemory.listThreads({ resourceId: RESOURCE_ID });
    const list = threads.map((t: any) => ({
      id: t.id,
      title: t.title || null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }));
    // Newest first
    list.sort((a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return res.json({ threads: list });
  } catch (error) {
    console.error('[Chat] Failed to list threads:', error);
    return res.json({ threads: [] });
  }
});

// Delete a thread
chatRouter.delete('/threads/:id', async (req, res) => {
  try {
    await agentMemory.deleteThread(req.params.id);
    return res.json({ ok: true });
  } catch (error) {
    console.error('[Chat] Failed to delete thread:', error);
    return res.status(500).json({ error: 'Failed to delete thread' });
  }
});

// Retrieve stored message history for a thread
chatRouter.get('/history', async (req, res) => {
  const threadId = req.query.threadId as string;
  if (!threadId) {
    return res.status(400).json({ error: 'threadId query param required' });
  }

  try {
    const { messages } = await agentMemory.recall({ threadId });

    const history = messages
      .filter((m: any) => m.role === 'user' || m.role === 'assistant')
      .map((m: any) => {
        let text = '';
        if (m.content?.parts) {
          text = m.content.parts
            .filter((p: any) => p.type === 'text')
            .map((p: any) => p.text ?? '')
            .join('');
        } else if (typeof m.content === 'string') {
          text = m.content;
        }
        return { id: m.id, role: m.role, content: text };
      })
      .filter((m: any) => m.content);

    return res.json({ messages: history });
  } catch (error) {
    console.error('[Chat] Failed to load history:', error);
    return res.json({ messages: [] });
  }
});

chatRouter.post('/', async (req, res) => {
  const parsed = chatBody.safeParse(req.body);
  if (!parsed.success) {
    console.error('Invalid request body:', parsed.error);
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const { message: userMessage, threadId } = parsed.data;
  console.log(`\n[Chat] ══════════════════════════════════════════`);
  console.log(`[Chat] Message  : "${userMessage}"`);
  console.log(`[Chat] Thread   : ${threadId}`);

  let stepCount = 0;

  try {
    const result = await contextAgent.generate(userMessage, {
      memory: { resource: RESOURCE_ID, thread: threadId },
      onStepFinish: (step: any) => {
        logStep(++stepCount, step);
      },
    });

    console.log(`[Chat] Final reply: "${result.text}"`);
    console.log(`[Chat] ══════════════════════════════════════════\n`);

    const toolCalls = (result.steps ?? []).flatMap((step: any) =>
      (step.toolResults ?? []).map((tr: any) => {
        const p = tr.payload ?? tr;
        return {
          name: p.toolName ?? '(unknown)',
          args: p.args,
          result: p.result,
        };
      })
    );

    return res.json({ reply: result.text, toolCalls });
  } catch (error) {
    console.error('[Chat] Agent generation failed:', error);
    return res.status(500).json({
      error: 'Agent generation failed',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});
