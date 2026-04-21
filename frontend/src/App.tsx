import { FormEvent, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ContextBar } from './components/ContextBar';
import { GitHubPanel } from './components/GitHubPanel';
import { useGitHub } from './hooks/useGitHub';

const AGENT_BASE_URL = import.meta.env.VITE_AGENT_API_BASE_URL ?? 'http://localhost:4111';

type ToolCall = {
  name: string;
  args: unknown;
  result: unknown;
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
};

type Thread = {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
};

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
  const endOfMessagesRef = useRef<HTMLDivElement | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const github = useGitHub(AGENT_BASE_URL);

  // Persist active threadId
  useEffect(() => {
    localStorage.setItem('chat-thread-id', threadId);
  }, [threadId]);

  useEffect(() => {
    if (isAtBottomRef.current) {
      endOfMessagesRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLoading]);

  function handleMessagesScroll() {
    const el = messagesScrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAtBottomRef.current = distFromBottom < 80;
  }

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    }
  }, [input]);

  // Load threads + message history on mount and when threadId changes
  useEffect(() => {
    fetchThreads();
    loadHistory(threadId);
  }, [threadId]);

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
          setMessages(data.messages);
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
    isAtBottomRef.current = true; // always scroll to bottom when user sends

    const assistantMsgId = crypto.randomUUID();
    let started = false;
    let pendingThinking: string | undefined;

    try {
      const res = await fetch(`${AGENT_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ message, threadId, run_id: github.activeContext?.runId }),
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

          if (evt.type === 'thinking') {
            pendingThinking = evt.text;
          } else if (evt.type === 'text') {
            if (!started) {
              started = true;
              setIsLoading(false);
              setStreamingMsgId(assistantMsgId);
              setMessages((prev) => [...prev, {
                id: assistantMsgId,
                role: 'assistant',
                content: evt.text,
                thinking: pendingThinking,
              }]);
            } else {
              setMessages((prev) => prev.map((m) =>
                m.id === assistantMsgId ? { ...m, content: m.content + evt.text } : m
              ));
            }
          } else if (evt.type === 'done') {
            setStreamingMsgId(null);
            if (!started) {
              setIsLoading(false);
              setMessages((prev) => [...prev, {
                id: assistantMsgId,
                role: 'assistant',
                content: '',
                thinking: pendingThinking,
              }]);
            }
            if (evt.toolCalls?.length) {
              setMessages((prev) => prev.map((m) =>
                m.id === assistantMsgId ? { ...m, toolCalls: evt.toolCalls } : m
              ));
            }
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
      if (!started) setIsLoading(false);
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
            <GitHubPanel {...github} />
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
          {github.activeContext && (
            <div className="topbar-context-badge">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.29-1.552 3.297-1.23 3.297-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12z" />
              </svg>
              <span className="context-badge-label" title={github.activeContext.repoFullName}>
                {github.activeContext.repoName}
              </span>
              <button
                className="icon-btn icon-btn-sm"
                onClick={github.clearActiveContext}
                title="Clear context"
                style={{ padding: '2px', marginLeft: '2px' }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          )}
          <div className="topbar-spacer" />
        </header>

        <div className="messages-scroll" ref={messagesScrollRef} onScroll={handleMessagesScroll}>
          <div className="messages">
            {messages.map((message) => (
              <div key={message.id} className={`msg msg-${message.role}`}>
                <div className="msg-inner">
                  <div className="msg-avatar">{message.role === 'user' ? 'U' : 'A'}</div>
                  <div className="msg-content">
                    {message.role === 'assistant' && message.thinking && (
                      <details className="thinking-section">
                        <summary className="thinking-summary">Thought for a moment</summary>
                        <div className="thinking-body">{message.thinking}</div>
                      </details>
                    )}
                    {message.role === 'assistant' ? (
                      <div className="markdown-body">
                        <Markdown remarkPlugins={[remarkGfm]}>
                          {message.id === streamingMsgId ? message.content + '▍' : message.content}
                        </Markdown>
                      </div>
                    ) : (
                      <p>{message.content}</p>
                    )}
                    {message.toolCalls && message.toolCalls.length > 0 && (
                      <details className="tool-calls">
                        <summary>
                          {message.toolCalls.length} tool call{message.toolCalls.length > 1 ? 's' : ''}
                        </summary>
                        {message.toolCalls.map((tc, i) => (
                          <div key={i} className="tool-call">
                            <div className="tool-call-name">{tc.name}</div>
                            <details className="tool-call-detail">
                              <summary>Args</summary>
                              <pre>{tc.args !== undefined ? JSON.stringify(tc.args, null, 2) : '(none)'}</pre>
                            </details>
                            <details className="tool-call-detail">
                              <summary>Result</summary>
                              <pre>{tc.result !== undefined ? JSON.stringify(tc.result, null, 2) : '(none)'}</pre>
                            </details>
                          </div>
                        ))}
                      </details>
                    )}
                  </div>
                </div>
              </div>
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
              onKeyDown={handleKeyDown}
              placeholder={github.activeContext ? 'Ask about the codebase…' : 'Select a codebase to start chatting…'}
              rows={1}
              disabled={!github.activeContext}
            />
            <div className="composer-toolbar">
              <ContextBar
                availableContexts={github.availableContexts}
                activeContext={github.activeContext}
                onActivateContext={github.activateContext}
                onClearActiveContext={github.clearActiveContext}
              />
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
