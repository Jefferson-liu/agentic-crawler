import { Router } from 'express';
import { z } from 'zod';
import { getAgentForModel, agentMemory, ensureMcpTools } from '../agent/agent.js';
import { setActiveRunId } from '../agent/scope-store.js';

const RESOURCE_ID = 'default-user';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_AGENT_STEPS = 20;

// Anthropic pricing per million tokens (input / output)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5':  { input: 0.80,  output: 4.00  },
  'claude-sonnet-4-6': { input: 3.00,  output: 15.00 },
  'claude-opus-4-7':   { input: 15.00, output: 75.00 },
};

const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? '';
const IS_ANTHROPIC_DIRECT = !ANTHROPIC_BASE_URL || ANTHROPIC_BASE_URL.startsWith('https://api.anthropic.com');

function calcCost(model: string, promptTokens: number, completionTokens: number): number | undefined {
  if (!IS_ANTHROPIC_DIRECT) return undefined;
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING[DEFAULT_MODEL];
  return (promptTokens / 1_000_000) * pricing.input + (completionTokens / 1_000_000) * pricing.output;
}

const chatBody = z.object({
  message: z.string().min(1),
  threadId: z.string().min(1),
  run_id: z.string().optional(),
  model: z.string().optional(),
});

export const chatRouter = Router();

type ToolInvocationState = 'partial-call' | 'call' | 'result';

type HistoryToolInvocation = {
  toolCallId: string;
  toolName: string;
  state: ToolInvocationState;
  args?: unknown;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
};

type HistoryDisplayPart =
  | {
      type: 'text';
      text: string;
    }
  | ({
      type: 'tool';
    } & HistoryToolInvocation);

function appendText(existing: string, next: unknown): string {
  return typeof next === 'string' && next ? `${existing}${next}` : existing;
}

function upsertDisplayText(parts: HistoryDisplayPart[], text: unknown) {
  if (typeof text !== 'string' || !text) return;

  const lastPart = parts[parts.length - 1];
  if (lastPart?.type === 'text') {
    lastPart.text = `${lastPart.text}${text}`;
    return;
  }

  parts.push({ type: 'text', text });
}

function mergeHistoryToolInvocation(
  previous: HistoryToolInvocation | undefined,
  invocation: any,
): HistoryToolInvocation {
  return {
    toolCallId: invocation.toolCallId,
    toolName: invocation.toolName ?? previous?.toolName ?? '(unknown)',
    state: invocation.state ?? previous?.state ?? 'call',
    args: invocation.args ?? previous?.args,
    argsText: invocation.argsText ?? previous?.argsText,
    result: invocation.result ?? previous?.result,
    isError:
      typeof invocation.result?.isError === 'boolean'
        ? invocation.result.isError
        : previous?.isError,
  };
}

function parseStoredToolInvocations(parts: any[]): HistoryToolInvocation[] | undefined {
  const order: string[] = [];
  const invocations = new Map<string, HistoryToolInvocation>();

  for (const part of parts) {
    if (part?.type !== 'tool-invocation' || !part.toolInvocation?.toolCallId) continue;
    const invocation = part.toolInvocation;
    const toolCallId = invocation.toolCallId;

    if (!order.includes(toolCallId)) order.push(toolCallId);

    invocations.set(toolCallId, mergeHistoryToolInvocation(invocations.get(toolCallId), invocation));
  }

  if (!order.length) return undefined;
  return order.map((toolCallId) => invocations.get(toolCallId)!);
}

function parseDisplayParts(parts: any[]): HistoryDisplayPart[] | undefined {
  const displayParts: HistoryDisplayPart[] = [];
  const toolIndexes = new Map<string, number>();

  for (const part of parts) {
    if (part?.type === 'reasoning') continue;

    if (part?.type === 'text') {
      upsertDisplayText(displayParts, part.text);
      continue;
    }

    if (part?.type !== 'tool-invocation' || !part.toolInvocation?.toolCallId) continue;

    const invocation = part.toolInvocation;
    const toolCallId = invocation.toolCallId;
    const previousIndex = toolIndexes.get(toolCallId);
    const previous =
      previousIndex !== undefined && displayParts[previousIndex]?.type === 'tool'
        ? (displayParts[previousIndex] as Extract<HistoryDisplayPart, { type: 'tool' }>)
        : undefined;
    const nextToolPart: Extract<HistoryDisplayPart, { type: 'tool' }> = {
      type: 'tool',
      ...mergeHistoryToolInvocation(previous, invocation),
    };

    if (previousIndex === undefined) {
      toolIndexes.set(toolCallId, displayParts.length);
      displayParts.push(nextToolPart);
      continue;
    }

    displayParts[previousIndex] = nextToolPart;
  }

  return displayParts.length ? displayParts : undefined;
}

function parseHistoryMessage(message: any) {
  const parts = Array.isArray(message.content?.parts) ? message.content.parts : [];

  let content = '';
  let thinking = '';

  for (const part of parts) {
    if (part?.type === 'text') {
      content = appendText(content, part.text);
      continue;
    }
    if (part?.type === 'reasoning') {
      thinking = appendText(thinking, part.reasoning ?? part.text);
    }
  }

  if (!content && typeof message.content === 'string') {
    content = message.content;
  } else if (!content && typeof message.content?.content === 'string') {
    content = message.content.content;
  }

  const toolInvocations = parseStoredToolInvocations(parts);
  const displayParts = parseDisplayParts(parts);

  return {
    id: message.id,
    role: message.role,
    content,
    thinking: thinking || undefined,
    displayParts,
    toolInvocations,
  };
}

function unwrapStreamEnvelope(part: any): { type: string; payload: any } {
  if (part && typeof part === 'object' && typeof part.type === 'string') {
    if ('payload' in part) return { type: part.type, payload: part.payload };
    return { type: part.type, payload: part };
  }
  return { type: 'unknown', payload: part };
}

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
    const { threads } = await agentMemory.listThreads({
      filter: { resourceId: RESOURCE_ID },
    });
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
      .map((m: any) => parseHistoryMessage(m))
      .filter((m: any) => m.content || m.thinking || m.toolInvocations?.length);

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

  const { message: userMessage, threadId, run_id, model } = parsed.data;
  const modelName = model ?? DEFAULT_MODEL;
  console.log(`\n[Chat] ══════════════════════════════════════════`);
  console.log(`[Chat] Message  : "${userMessage}"`);
  console.log(`[Chat] Thread   : ${threadId}`);
  console.log(`[Chat] run_id   : ${run_id ?? '(none)'}`);
  console.log(`[Chat] Model    : ${modelName}`);

  // Inject run_id so MCP tool wrappers pick it up for this request
  setActiveRunId(run_id ?? null);

  // Reconnect to MCP if tools weren't loaded at startup
  await ensureMcpTools();

  const agent = getAgentForModel(modelName);
  const wantsStream = req.headers.accept?.includes('text/event-stream');

  if (!wantsStream) {
    // Non-streaming fallback
    let stepCount = 0;
    try {
      const result = await agent.generate(userMessage, {
        memory: { resource: RESOURCE_ID, thread: threadId },
        maxSteps: MAX_AGENT_STEPS,
        onStepFinish: (step: any) => { logStep(++stepCount, step); },
      });
      const toolCalls = (result.steps ?? []).flatMap((step: any) =>
        (step.toolResults ?? []).map((tr: any) => {
          const p = tr.payload ?? tr;
          return { name: p.toolName ?? '(unknown)', args: p.args, result: p.result };
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
  }

  // Streaming path — SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (payload: object) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  let stepCount = 0;

  try {
    const streamResult = await agent.stream(userMessage, {
      memory: { resource: RESOURCE_ID, thread: threadId },
      maxSteps: MAX_AGENT_STEPS,
      onStepFinish: (step: any) => { logStep(++stepCount, step); },
    });

    let assistantMessageId: string | undefined;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    for await (const rawPart of (streamResult as any).fullStream) {
      const { type, payload } = unwrapStreamEnvelope(rawPart);

      if (type === 'step-finish' || type === 'finish') {
        // Mastra wraps Vercel AI SDK step usage at payload.output.usage
        const u = payload?.output?.usage ?? payload?.usage;
        if (u) {
          totalPromptTokens += u.promptTokens ?? u.inputTokens ?? 0;
          totalCompletionTokens += u.completionTokens ?? u.outputTokens ?? 0;
        }
        if (type === 'step-finish') continue;
      }

      if (type === 'step-start') {
        assistantMessageId = payload?.messageId ?? assistantMessageId;
        if (assistantMessageId) {
          sendEvent({ type: 'assistant_message', messageId: assistantMessageId });
        }
        continue;
      }

      if (type === 'reasoning') {
        const text = payload?.textDelta ?? payload?.text ?? payload?.reasoning;
        if (text) {
          sendEvent({
            type: 'thinking',
            messageId: assistantMessageId,
            text,
          });
        }
        continue;
      }

      if (type === 'text-delta') {
        const text = payload?.text ?? payload?.textDelta;
        if (text) {
          sendEvent({
            type: 'text',
            messageId: assistantMessageId,
            text,
          });
        }
        continue;
      }

      if (type === 'tool-call-streaming-start') {
        sendEvent({
          type: 'tool_call_start',
          messageId: assistantMessageId,
          toolCallId: payload?.toolCallId,
          toolName: payload?.toolName,
        });
        continue;
      }

      if (type === 'tool-call-delta') {
        sendEvent({
          type: 'tool_call_delta',
          messageId: assistantMessageId,
          toolCallId: payload?.toolCallId,
          toolName: payload?.toolName,
          argsText: payload?.argsTextDelta,
        });
        continue;
      }

      if (type === 'tool-call') {
        sendEvent({
          type: 'tool_call',
          messageId: assistantMessageId,
          toolCallId: payload?.toolCallId,
          toolName: payload?.toolName,
          args: payload?.args,
        });
        continue;
      }

      if (type === 'tool-result') {
        sendEvent({
          type: 'tool_result',
          messageId: assistantMessageId,
          toolCallId: payload?.toolCallId,
          toolName: payload?.toolName,
          args: payload?.args,
          result: payload?.result,
          isError: Boolean(payload?.result?.isError),
        });
      }
    }

    console.log(`[Chat] ══════════════════════════════════════════\n`);

    const costUsd = calcCost(modelName, totalPromptTokens, totalCompletionTokens);
    sendEvent({
      type: 'done',
      messageId: assistantMessageId,
      usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
      costUsd,
    });
    res.end();
  } catch (error) {
    console.error('[Chat] Stream failed:', error);
    sendEvent({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    res.end();
  }
});
