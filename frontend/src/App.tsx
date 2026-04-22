import { FormEvent, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import mermaid from 'mermaid';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

mermaid.initialize({
  startOnLoad: false,
  theme: 'base',
  themeVariables: {
    primaryColor: '#e6f5f3',
    primaryBorderColor: '#0f766e',
    primaryTextColor: '#1a1a1a',
    lineColor: '#6b6b6b',
    secondaryColor: '#f7f7f8',
    tertiaryColor: '#ffffff',
    edgeLabelBackground: '#ffffff',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    fontSize: '14px',
    clusterBkg: '#f7f7f8',
    clusterBorder: '#e5e5e5',
    nodeBorder: '#0f766e',
    mainBkg: '#e6f5f3',
    titleColor: '#1a1a1a',
    background: '#ffffff',
  },
});

function MermaidExpandModal({ svgHtml, onClose }: { svgHtml: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const panStart = useRef({ x: 0, y: 0 });
  const canvasRef = useRef<HTMLDivElement>(null);
  // Keep zoom in a ref so the wheel handler (attached as non-passive) can read it
  const zoomRef = useRef(1);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Attach wheel as non-passive so we can preventDefault and stop page scroll
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    function handleWheel(e: WheelEvent) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.85 : 1.15;
      const next = Math.min(8, Math.max(0.3, zoomRef.current * delta));
      zoomRef.current = next;
      setZoom(next);
    }
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  function onMouseDown(e: React.MouseEvent) {
    dragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY };
    panStart.current = { ...pan };
  }

  function onMouseMove(e: React.MouseEvent) {
    if (!dragging.current) return;
    setPan({
      x: panStart.current.x + e.clientX - dragStart.current.x,
      y: panStart.current.y + e.clientY - dragStart.current.y,
    });
  }

  function onMouseUp() { dragging.current = false; }

  function resetView() { setZoom(1); zoomRef.current = 1; setPan({ x: 0, y: 0 }); }

  return (
    <div className="mermaid-expand-overlay" onClick={onClose}>
      <div
        className="mermaid-expand-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mermaid-expand-header">
          <span className="mermaid-expand-title">Diagram</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span className="mermaid-zoom-label">{Math.round(zoom * 100)}%</span>
            <button className="mermaid-zoom-btn" onClick={() => setZoom((z) => Math.min(8, z * 1.25))} title="Zoom in">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                <line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" />
              </svg>
            </button>
            <button className="mermaid-zoom-btn" onClick={() => setZoom((z) => Math.max(0.3, z * 0.8))} title="Zoom out">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                <line x1="8" y1="11" x2="14" y2="11" />
              </svg>
            </button>
            <button className="mermaid-zoom-btn" onClick={resetView} title="Reset view">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />
              </svg>
            </button>
            <button className="mermaid-expand-close" onClick={onClose} title="Close">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
        <div
          ref={canvasRef}
          className="mermaid-expand-canvas"
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
        >
          <div
            className="mermaid-expand-svg"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
            dangerouslySetInnerHTML={{
              // Strip width="100%" so the SVG uses its natural viewBox dimensions
              // instead of collapsing to 0 inside a flex container with no defined width.
              __html: svgHtml.replace(/(<svg\b[^>]*)\s+width="[^"]*"/, '$1'),
            }}
          />
        </div>
        <div className="mermaid-expand-hint">Scroll to zoom · Drag to pan</div>
      </div>
    </div>
  );
}

function MermaidBlock({ code }: { code: string }) {
  const [svgHtml, setSvgHtml] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Unique ID per render attempt avoids mermaid conflicts when React StrictMode
    // double-fires effects with the same component instance.
    const renderId = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    mermaid.render(renderId, code)
      .then(({ svg }) => { if (!cancelled) setSvgHtml(svg); })
      .catch(() => { if (!cancelled) setSvgHtml(''); });
    return () => { cancelled = true; };
  }, [code]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  return (
    <div className="mermaid-block">
      <div className="mermaid-toolbar">
        <button className="mermaid-toggle-btn" onClick={() => setShowCode((v) => !v)}>
          {showCode ? (
            <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg> Diagram</>
          ) : (
            <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg> Code</>
          )}
        </button>
        {!showCode && svgHtml && (
          <span className="mermaid-hint">Click diagram to expand</span>
        )}
      </div>
      {showCode ? (
        <pre className="mermaid-code-view">{code}</pre>
      ) : svgHtml ? (
        <div
          className="mermaid-svg-inner mermaid-svg-clickable"
          dangerouslySetInnerHTML={{ __html: svgHtml }}
          onClick={() => setExpanded(true)}
          title="Click to expand"
        />
      ) : (
        <pre className="mermaid-code-view">{code}</pre>
      )}
      {expanded && (
        <MermaidExpandModal svgHtml={svgHtml} onClose={() => setExpanded(false)} />
      )}
    </div>
  );
}
import { ContextBar } from './components/ContextBar';
import { GitHubPanel } from './components/GitHubPanel';
import { useGitHub } from './hooks/useGitHub';

const AGENT_BASE_URL = import.meta.env.VITE_AGENT_API_BASE_URL ?? 'http://localhost:4111';
const TEXTAREA_MAX_VIEWPORT_RATIO = 0.4;

const MODELS = [
  { id: 'claude-haiku-4-5', label: 'Haiku' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet' },
  { id: 'claude-opus-4-7', label: 'Opus' },
] as const;

type ToolCall = {
  toolCallId: string;
  toolName: string;
  state: 'partial-call' | 'call' | 'result';
  args: unknown;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
};

type AssistantDisplayPart =
  | {
      type: 'text';
      text: string;
    }
  | ({
      type: 'tool';
    } & ToolCall);

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  displayParts?: AssistantDisplayPart[];
  toolInvocations?: ToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
  costUsd?: number;
};

type Thread = {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
};

type AssistantArtifact = Pick<ChatMessage, 'id' | 'content' | 'thinking' | 'displayParts' | 'toolInvocations' | 'usage' | 'costUsd'>;

const ASSISTANT_ARTIFACTS_STORAGE_PREFIX = 'assistant-artifacts-';

function toolStateRank(state: ToolCall['state'] | undefined): number {
  if (state === 'result') return 3;
  if (state === 'call') return 2;
  return 1;
}

function mergeToolInvocations(primary?: ToolCall[], secondary?: ToolCall[]): ToolCall[] | undefined {
  const merged = new Map<string, ToolCall>();
  const order: string[] = [];

  const apply = (items?: ToolCall[]) => {
    if (!items?.length) return;
    for (const item of items) {
      if (!order.includes(item.toolCallId)) order.push(item.toolCallId);
      const previous = merged.get(item.toolCallId);
      merged.set(item.toolCallId, {
        toolCallId: item.toolCallId,
        toolName: item.toolName ?? previous?.toolName ?? '(unknown)',
        state:
          toolStateRank(item.state) >= toolStateRank(previous?.state)
            ? item.state
            : previous?.state ?? item.state,
        args: item.args ?? previous?.args,
        argsText: item.argsText ?? previous?.argsText,
        result: item.result ?? previous?.result,
        isError: typeof item.isError === 'boolean' ? item.isError : previous?.isError,
      });
    }
  };

  apply(secondary);
  apply(primary);

  if (!order.length) return undefined;
  return order.map((toolCallId) => merged.get(toolCallId)!);
}

function appendDisplayText(
  displayParts: AssistantDisplayPart[] | undefined,
  text: string | undefined,
): AssistantDisplayPart[] | undefined {
  if (!text) return displayParts;

  const next = [...(displayParts ?? [])];
  const lastPart = next[next.length - 1];
  if (lastPart?.type === 'text') {
    next[next.length - 1] = { ...lastPart, text: `${lastPart.text}${text}` };
    return next;
  }

  next.push({ type: 'text', text });
  return next;
}

function upsertDisplayTool(
  displayParts: AssistantDisplayPart[] | undefined,
  update: Pick<ToolCall, 'toolCallId'> & Partial<ToolCall>,
): AssistantDisplayPart[] {
  const next = [...(displayParts ?? [])];
  const index = next.findIndex((part) => part.type === 'tool' && part.toolCallId === update.toolCallId);

  if (index === -1) {
    next.push({
      type: 'tool',
      toolCallId: update.toolCallId,
      toolName: update.toolName ?? '(unknown)',
      state: update.state ?? 'partial-call',
      args: update.args,
      argsText: update.argsText,
      result: update.result,
      isError: update.isError,
    });
    return next;
  }

  const previous = next[index];
  if (previous?.type !== 'tool') return next;

  next[index] = {
    ...previous,
    ...update,
    type: 'tool',
    toolName: update.toolName ?? previous.toolName,
    state:
      toolStateRank(update.state) >= toolStateRank(previous.state)
        ? update.state ?? previous.state
        : previous.state,
    args: update.args ?? previous.args,
    argsText: update.argsText ?? previous.argsText,
    result: update.result ?? previous.result,
    isError: typeof update.isError === 'boolean' ? update.isError : previous.isError,
  };
  return next;
}

function getDisplayParts(message: ChatMessage): AssistantDisplayPart[] | undefined {
  if (message.displayParts?.length) return message.displayParts;

  const fallback: AssistantDisplayPart[] = [];
  if (message.toolInvocations?.length) {
    fallback.push(...message.toolInvocations.map((tool) => ({ type: 'tool' as const, ...tool })));
  }
  if (message.content) {
    fallback.push({ type: 'text', text: message.content });
  }

  return fallback.length ? fallback : undefined;
}

function getStoredAssistantArtifacts(threadId: string): Record<string, AssistantArtifact> {
  try {
    return JSON.parse(localStorage.getItem(`${ASSISTANT_ARTIFACTS_STORAGE_PREFIX}${threadId}`) ?? '{}');
  } catch {
    return {};
  }
}

function persistAssistantArtifacts(threadId: string, messages: ChatMessage[]) {
  try {
    const artifacts = Object.fromEntries(
      messages
        .filter((message) =>
          message.role === 'assistant' &&
          (message.content || message.thinking || message.toolInvocations?.length)
        )
        .map((message) => [
          message.id,
          {
            id: message.id,
            content: message.content,
            thinking: message.thinking,
            displayParts: message.displayParts,
            toolInvocations: message.toolInvocations,
            usage: message.usage,
            costUsd: message.costUsd,
          } satisfies AssistantArtifact,
        ])
    );

    localStorage.setItem(`${ASSISTANT_ARTIFACTS_STORAGE_PREFIX}${threadId}`, JSON.stringify(artifacts));
  } catch {
    // Ignore persistence failures
  }
}

function mergeHistoryWithStoredArtifacts(messages: ChatMessage[], stored: Record<string, AssistantArtifact>): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message;

    const storedArtifact = stored[message.id];
    if (!storedArtifact) return message;

    return {
      ...message,
      content: message.content || storedArtifact.content || '',
      thinking: message.thinking || storedArtifact.thinking,
      displayParts:
        (message.displayParts && message.displayParts.length > 0)
          ? message.displayParts
          : storedArtifact.displayParts,
      toolInvocations: mergeToolInvocations(message.toolInvocations, storedArtifact.toolInvocations),
      usage: message.usage ?? storedArtifact.usage,
      costUsd: message.costUsd ?? storedArtifact.costUsd,
    };
  });
}

function upsertToolInvocation(
  toolInvocations: ToolCall[] | undefined,
  update: Pick<ToolCall, 'toolCallId'> & Partial<ToolCall>
): ToolCall[] {
  const next = [...(toolInvocations ?? [])];
  const index = next.findIndex((tool) => tool.toolCallId === update.toolCallId);

  if (index === -1) {
    next.push({
      toolCallId: update.toolCallId,
      toolName: update.toolName ?? '(unknown)',
      state: update.state ?? 'partial-call',
      args: update.args,
      argsText: update.argsText,
      result: update.result,
      isError: update.isError,
    });
    return next;
  }

  const previous = next[index];
  next[index] = {
    ...previous,
    ...update,
    toolName: update.toolName ?? previous.toolName,
    state:
      toolStateRank(update.state) >= toolStateRank(previous.state)
        ? update.state ?? previous.state
        : previous.state,
    args: update.args ?? previous.args,
    argsText: update.argsText ?? previous.argsText,
    result: update.result ?? previous.result,
    isError: typeof update.isError === 'boolean' ? update.isError : previous.isError,
  };
  return next;
}

function summarizeValue(value: unknown, maxLength = 120): string | null {
  if (value === undefined || value === null) return null;
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (!text) return null;
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
  } catch {
    return String(value);
  }
}

function toolSummaryLabel(tool: ToolCall): string {
  if (tool.state !== 'result') return `Calling ${tool.toolName}`;
  if (tool.isError) return `${tool.toolName} returned an error`;
  return `Called ${tool.toolName}`;
}

const MessageItem = memo(function MessageItem({ message, isStreaming }: { message: ChatMessage; isStreaming: boolean }) {
  const [copied, setCopied] = useState(false);
  const displayParts = getDisplayParts(message);
  const copyableText = useMemo(() => {
    if (message.role === 'user') return message.content;
    if (!displayParts?.length) return message.content;
    return displayParts
      .filter((part): part is Extract<AssistantDisplayPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('');
  }, [displayParts, message.content, message.role]);

  function handleCopy() {
    navigator.clipboard.writeText(copyableText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const components = useMemo(() => ({
    code({ className, children, ...props }: any) {
      const lang = /language-(\w+)/.exec(className || '')?.[1];
      if (lang === 'mermaid' && !isStreaming) {
        return <MermaidBlock code={String(children).replace(/\n$/, '')} />;
      }
      return <code className={className} {...props}>{children}</code>;
    },
  }), [isStreaming]);

  return (
    <div className={`msg msg-${message.role}`}>
      <div className="msg-inner">
        <div className="msg-avatar">{message.role === 'user' ? 'U' : 'A'}</div>
        <div className="msg-content">
          {copyableText && (
            <button
              className={`msg-copy-btn ${copied ? 'msg-copy-btn-done' : ''}`}
              title={copied ? 'Copied!' : 'Copy message'}
              onClick={handleCopy}
            >
              {copied ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          )}
          {message.role === 'assistant' && message.thinking && (
            <details className="thinking-section">
              <summary className="thinking-summary">{isStreaming ? 'Thinking' : 'Thought process'}</summary>
              <div className="thinking-body">{message.thinking}</div>
            </details>
          )}
          {message.role === 'assistant' && displayParts?.length ? (
            <div className="assistant-flow">
              {displayParts.map((part, index) => {
                if (part.type === 'text') {
                  return (
                    <div key={`text-${index}`} className="markdown-body">
                      <Markdown remarkPlugins={[remarkGfm]} components={components}>
                        {part.text}
                      </Markdown>
                    </div>
                  );
                }

                const preview = summarizeValue(part.argsText ?? part.args, 90);
                return (
                  <details key={part.toolCallId} className={`tool-inline ${part.isError ? 'tool-inline-error' : ''}`}>
                    <summary className="tool-inline-summary">
                      <span className="tool-inline-status" aria-hidden="true">
                        {part.state === 'result' ? (
                          part.isError ? <span className="tool-status-error">!</span> : <span className="tool-status-done">✓</span>
                        ) : (
                          <span className="pipeline-spinner" />
                        )}
                      </span>
                      <span className="tool-inline-copy">
                        <span className="tool-inline-title">{toolSummaryLabel(part)}</span>
                        {preview && <span className="tool-inline-preview">{preview}</span>}
                      </span>
                    </summary>
                    <div className="tool-inline-body">
                      {part.args !== undefined && (
                        <details className="tool-call-detail">
                          <summary>Args</summary>
                          <pre>{JSON.stringify(part.args, null, 2)}</pre>
                        </details>
                      )}
                      {part.result !== undefined && (
                        <details className="tool-call-detail">
                          <summary>{part.isError ? 'Error' : 'Result'}</summary>
                          <pre>{JSON.stringify(part.result, null, 2)}</pre>
                        </details>
                      )}
                    </div>
                  </details>
                );
              })}
            </div>
          ) : message.role === 'assistant' && message.content ? (
            <div className="markdown-body">
              <Markdown remarkPlugins={[remarkGfm]} components={components}>
                {message.content}
              </Markdown>
            </div>
          ) : message.role === 'user' ? (
            <p>{message.content}</p>
          ) : null}
          {message.role === 'assistant' && !displayParts?.length && !message.content && isStreaming && !message.thinking && !message.toolInvocations?.length && (
            <div className="tool-activity-skeleton">Thinking...</div>
          )}
          {message.role === 'assistant' && !isStreaming && message.usage && (
            <div className="msg-cost">
              <span>{message.usage.promptTokens.toLocaleString()} in · {message.usage.completionTokens.toLocaleString()} out</span>
              {message.costUsd != null && (
                <span> · ~${message.costUsd < 0.01 ? message.costUsd.toFixed(4) : message.costUsd.toFixed(3)}</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

export default function App() {
  const [threadId, setThreadId] = useState(() => {
    return localStorage.getItem('chat-thread-id') || crypto.randomUUID();
  });
  const [threads, setThreads] = useState<Thread[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<'chats' | 'github'>('chats');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);
  const [model, setModel] = useState<string>(() => localStorage.getItem('chat-model') ?? 'claude-sonnet-4-6');
  const endOfMessagesRef = useRef<HTMLDivElement | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const github = useGitHub(AGENT_BASE_URL);

  // Persist active threadId
  useEffect(() => {
    localStorage.setItem('chat-thread-id', threadId);
  }, [threadId]);

  // Only scroll on message count changes (new msg added) or loading state change,
  // not on every content update during streaming (which causes jarring scroll jitter).
  useEffect(() => {
    if (!isAtBottomRef.current) return;
    programmaticScrollRef.current = true;
    endOfMessagesRef.current?.scrollIntoView({ behavior: 'smooth' });
    requestAnimationFrame(() => { programmaticScrollRef.current = false; });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, isLoading]);

  function handleMessagesScroll() {
    if (programmaticScrollRef.current) return;
    const el = messagesScrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAtBottomRef.current = distFromBottom < 80;
  }

  // Auto-resize textarea — useLayoutEffect fires before paint (handles programmatic clears)
  useLayoutEffect(() => {
    resizeTextarea(textareaRef.current);
  }, [input]);

  useEffect(() => {
    const onResize = () => resizeTextarea(textareaRef.current);
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
    };
  }, []);

  function resizeTextarea(ta: HTMLTextAreaElement | null) {
    if (!ta) return;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const maxH = Math.floor(viewportHeight * TEXTAREA_MAX_VIEWPORT_RATIO);
    ta.style.maxHeight = `${maxH}px`;
    ta.style.overflowY = 'hidden';
    ta.style.height = '0px';
    const h = ta.scrollHeight;
    ta.style.height = Math.min(h, maxH) + 'px';
    ta.style.overflowY = h > maxH ? 'auto' : 'hidden';
  }

  // Load threads + message history on mount and when threadId changes
  useEffect(() => {
    fetchThreads();
    loadHistory(threadId);
  }, [threadId]);

  useEffect(() => {
    persistAssistantArtifacts(threadId, messages);
  }, [messages, threadId]);

  async function fetchThreads() {
    try {
      const res = await fetch(`${AGENT_BASE_URL}/api/chat/threads`);
      if (res.ok) {
        const data = await res.json();
        setThreads(data.threads ?? []);
      }
    } catch {
      // Backend not reachable
    }
  }

  async function loadHistory(tid: string) {
    try {
      const res = await fetch(`${AGENT_BASE_URL}/api/chat/history?threadId=${tid}`);
      if (res.ok) {
        const data = await res.json();
        if (data.messages?.length) {
          setMessages(mergeHistoryWithStoredArtifacts(data.messages, getStoredAssistantArtifacts(tid)));
          return;
        }
      }
    } catch {
      // Backend not reachable
    }
    setMessages([{
      id: 'assistant-welcome',
      role: 'assistant',
      content: 'Hello. How can I help you today?',
    }]);
  }

  function startNewChat() {
    const newId = crypto.randomUUID();
    setThreadId(newId);
    if (window.innerWidth <= 640) setSidebarOpen(false);
  }

  function switchThread(tid: string) {
    setThreadId(tid);
    if (window.innerWidth <= 640) setSidebarOpen(false);
  }

  async function deleteThread(tid: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm('Delete this conversation?')) return;
    try {
      await fetch(`${AGENT_BASE_URL}/api/chat/threads/${tid}`, { method: 'DELETE' });
      localStorage.removeItem(`${ASSISTANT_ARTIFACTS_STORAGE_PREFIX}${tid}`);
      setThreads((prev) => prev.filter((t) => t.id !== tid));
      if (tid === threadId) startNewChat();
    } catch {
      alert('Failed to delete.');
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = input.trim();
    if (!message) return;

    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', content: message }]);
    setInput('');
    setIsLoading(true);
    isAtBottomRef.current = true;
    let assistantMsgId: string | null = null;

    const ensureAssistantMessage = (messageId?: string) => {
      const id = messageId ?? assistantMsgId;
      if (!id) return null;

      assistantMsgId = id;
      setIsLoading(false);
      setStreamingMsgId(id);
      setMessages((prev) => {
        if (prev.some((message) => message.id === id)) return prev;
        return [...prev, {
          id,
          role: 'assistant',
          content: '',
          thinking: '',
          displayParts: [],
          toolInvocations: [],
        }];
      });
      return id;
    };

    const updateAssistantMessage = (messageId: string, updater: (message: ChatMessage) => ChatMessage) => {
      setMessages((prev) => {
        const index = prev.findIndex((existing) => existing.id === messageId);
        if (index === -1) {
          const created = updater({
            id: messageId,
            role: 'assistant',
            content: '',
            thinking: '',
            displayParts: [],
            toolInvocations: [],
          });
          return [...prev, created];
        }

        const next = [...prev];
        next[index] = updater(next[index]);
        return next;
      });
    };

    try {
      const res = await fetch(`${AGENT_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ message, threadId, run_id: github.activeContext?.runId, model }),
      });

      if (!res.ok) {
        let detail = '';
        try { const body = await res.json(); detail = body.details || body.error || JSON.stringify(body); }
        catch { detail = await res.text().catch(() => ''); }
        throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          const evt = JSON.parse(raw);

          if (evt.type === 'assistant_message') {
            ensureAssistantMessage(evt.messageId);
          } else if (evt.type === 'thinking') {
            const messageId = ensureAssistantMessage(evt.messageId);
            if (!messageId) continue;
            updateAssistantMessage(messageId, (current) => ({
              ...current,
              thinking: `${current.thinking ?? ''}${evt.text ?? ''}`,
            }));
          } else if (evt.type === 'tool_call_start') {
            const messageId = ensureAssistantMessage(evt.messageId);
            if (!messageId || !evt.toolCallId) continue;
            updateAssistantMessage(messageId, (current) => ({
              ...current,
              displayParts: upsertDisplayTool(current.displayParts, {
                toolCallId: evt.toolCallId,
                toolName: evt.toolName,
                state: 'partial-call',
              }),
              toolInvocations: upsertToolInvocation(current.toolInvocations, {
                toolCallId: evt.toolCallId,
                toolName: evt.toolName,
                state: 'partial-call',
              }),
            }));
          } else if (evt.type === 'tool_call_delta') {
            const messageId = ensureAssistantMessage(evt.messageId);
            if (!messageId || !evt.toolCallId) continue;
            updateAssistantMessage(messageId, (current) => ({
              ...current,
              displayParts: upsertDisplayTool(current.displayParts, {
                toolCallId: evt.toolCallId,
                toolName: evt.toolName,
                state: 'partial-call',
                argsText: `${current.toolInvocations?.find((tool) => tool.toolCallId === evt.toolCallId)?.argsText ?? ''}${evt.argsText ?? ''}`,
              }),
              toolInvocations: upsertToolInvocation(current.toolInvocations, {
                toolCallId: evt.toolCallId,
                toolName: evt.toolName,
                state: 'partial-call',
                argsText: `${current.toolInvocations?.find((tool) => tool.toolCallId === evt.toolCallId)?.argsText ?? ''}${evt.argsText ?? ''}`,
              }),
            }));
          } else if (evt.type === 'tool_call') {
            const messageId = ensureAssistantMessage(evt.messageId);
            if (!messageId || !evt.toolCallId) continue;
            updateAssistantMessage(messageId, (current) => ({
              ...current,
              displayParts: upsertDisplayTool(current.displayParts, {
                toolCallId: evt.toolCallId,
                toolName: evt.toolName,
                state: 'call',
                args: evt.args,
              }),
              toolInvocations: upsertToolInvocation(current.toolInvocations, {
                toolCallId: evt.toolCallId,
                toolName: evt.toolName,
                state: 'call',
                args: evt.args,
              }),
            }));
          } else if (evt.type === 'tool_result') {
            const messageId = ensureAssistantMessage(evt.messageId);
            if (!messageId || !evt.toolCallId) continue;
            updateAssistantMessage(messageId, (current) => ({
              ...current,
              displayParts: upsertDisplayTool(current.displayParts, {
                toolCallId: evt.toolCallId,
                toolName: evt.toolName,
                state: 'result',
                args: evt.args,
                result: evt.result,
                isError: evt.isError,
              }),
              toolInvocations: upsertToolInvocation(current.toolInvocations, {
                toolCallId: evt.toolCallId,
                toolName: evt.toolName,
                state: 'result',
                args: evt.args,
                result: evt.result,
                isError: evt.isError,
              }),
            }));
          } else if (evt.type === 'text') {
            const messageId = ensureAssistantMessage(evt.messageId);
            if (!messageId) continue;
            updateAssistantMessage(messageId, (current) => ({
              ...current,
              content: `${current.content}${evt.text ?? ''}`,
              displayParts: appendDisplayText(current.displayParts, evt.text ?? ''),
            }));
          } else if (evt.type === 'done') {
            if (assistantMsgId && (evt.usage || evt.costUsd != null)) {
              updateAssistantMessage(assistantMsgId, (current) => ({
                ...current,
                usage: evt.usage,
                costUsd: evt.costUsd,
              }));
            }
            setStreamingMsgId(null);
            setIsLoading(false);
            fetchThreads();
          } else if (evt.type === 'error') {
            throw new Error(evt.message);
          }
        }
      }
    } catch (err) {
      setStreamingMsgId(null);
      setIsLoading(false);
      setMessages((prev) => [...prev, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      }]);
    } finally {
      setIsLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    }
  }

  function threadLabel(t: Thread) {
    if (t.title) return t.title;
    return new Date(t.createdAt).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  return (
    <div className="app">
      {/* Sidebar drawer */}
      <div className={`sidebar-backdrop ${sidebarOpen ? 'visible' : ''}`} onClick={() => setSidebarOpen(false)} />
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
      <div className="sidebar-inner">
        <div className="sidebar-header">
          <div className="sidebar-tabs">
            <button
              className={`sidebar-tab ${sidebarTab === 'chats' ? 'active' : ''}`}
              onClick={() => setSidebarTab('chats')}
            >
              Chats
            </button>
            <button
              className={`sidebar-tab ${sidebarTab === 'github' ? 'active' : ''}`}
              onClick={() => setSidebarTab('github')}
            >
              GitHub
            </button>
          </div>
          <button className="icon-btn" onClick={() => setSidebarOpen(false)} title="Close sidebar">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="sidebar-body">
          {sidebarTab === 'chats' ? (
            <div className="sidebar-body-chats">
              <button className="btn btn-primary btn-full new-chat-btn" onClick={startNewChat}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                New Chat
              </button>

              <div className="thread-list">
                {threads.map((t) => (
                  <div
                    key={t.id}
                    className={`thread-item ${t.id === threadId ? 'thread-item-active' : ''}`}
                    onClick={() => switchThread(t.id)}
                  >
                    <span className="thread-label">{threadLabel(t)}</span>
                    <button
                      className="icon-btn icon-btn-sm icon-btn-danger thread-delete"
                      onClick={(e) => deleteThread(t.id, e)}
                      title="Delete"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                ))}
                {threads.length === 0 && (
                  <p className="empty-text">No previous chats.</p>
                )}
              </div>
            </div>
          ) : (
            <GitHubPanel {...github} contextApiBase={`${AGENT_BASE_URL}/api/context`} />
          )}
        </div>
      </div>
      </aside>

      {/* Main chat area */}
      <div className="chat-container">
        <header className="topbar">
          <button className="icon-btn" onClick={() => setSidebarOpen((o) => !o)} title="Toggle sidebar">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <h1 className="topbar-title">Context Agent</h1>
          <div className="topbar-spacer" />
        </header>

        <div className="messages-scroll" ref={messagesScrollRef} onScroll={handleMessagesScroll}>
          <div className="messages">
            {messages.map((message) => (
              <MessageItem
                key={message.id}
                message={message}
                isStreaming={message.id === streamingMsgId}
              />
            ))}
            {isLoading && (
              <div className="msg msg-assistant">
                <div className="msg-inner">
                  <div className="msg-avatar">A</div>
                  <div className="msg-content">
                    <div className="typing-indicator"><span /><span /><span /></div>
                  </div>
                </div>
              </div>
            )}
            <div ref={endOfMessagesRef} />
          </div>
        </div>

        <div className="composer-wrapper">
          <form className="composer" onSubmit={onSubmit}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onInput={(e) => resizeTextarea(e.currentTarget)}
              onKeyDown={handleKeyDown}
              placeholder={github.activeContext ? 'Ask about the codebase…' : 'Select a codebase to start chatting…'}
              disabled={!github.activeContext}
            />
            <div className="composer-toolbar">
              <ContextBar
                availableContexts={github.availableContexts}
                activeContext={github.activeContext}
                onActivateContext={github.activateContext}
                onClearActiveContext={github.clearActiveContext}
              />
              <select
                className="model-select"
                value={model}
                onChange={(e) => { setModel(e.target.value); localStorage.setItem('chat-model', e.target.value); }}
                disabled={isLoading}
                title="Model"
              >
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              <button type="submit" className="send-btn" disabled={isLoading || !input.trim() || !github.activeContext} title="Send">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
                </svg>
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
