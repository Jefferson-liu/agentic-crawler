import { FormEvent, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const endOfMessagesRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Persist active threadId
  useEffect(() => {
    localStorage.setItem('chat-thread-id', threadId);
  }, [threadId]);

  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

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
    setSidebarOpen(false);
  }

  function switchThread(tid: string) {
    setThreadId(tid);
    setSidebarOpen(false);
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

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: message,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const res = await fetch(`${AGENT_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, threadId }),
      });

      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.json();
          detail = body.details || body.error || JSON.stringify(body);
        } catch {
          detail = await res.text().catch(() => '');
        }
        throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
      }

      const data = (await res.json()) as { reply: string; toolCalls?: ToolCall[] };
      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: data.reply,
        toolCalls: data.toolCalls,
      };
      setMessages((prev) => [...prev, assistantMessage]);
      // Refresh thread list so new threads appear in sidebar
      fetchThreads();
    } catch (err) {
      const errorMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      };
      setMessages((prev) => [...prev, errorMessage]);
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
    // Show date as fallback
    return new Date(t.createdAt).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  return (
    <div className="app">
      {/* Sidebar drawer */}
      <div className={`sidebar-backdrop ${sidebarOpen ? 'visible' : ''}`} onClick={() => setSidebarOpen(false)} />
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <span className="sidebar-title">Chats</span>
          <button className="icon-btn" onClick={() => setSidebarOpen(false)} title="Close sidebar">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="sidebar-body">
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
      </aside>

      {/* Main chat area */}
      <div className="chat-container">
        <header className="topbar">
          <button className="icon-btn" onClick={() => setSidebarOpen(true)} title="Chat history">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <h1 className="topbar-title">Context Agent</h1>
          <div className="topbar-spacer" />
        </header>

        <div className="messages-scroll">
          <div className="messages">
            {messages.map((message) => (
              <div key={message.id} className={`msg msg-${message.role}`}>
                <div className="msg-inner">
                  <div className="msg-avatar">{message.role === 'user' ? 'U' : 'A'}</div>
                  <div className="msg-content">
                    {message.role === 'assistant' ? (
                      <div className="markdown-body"><Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown></div>
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
              placeholder="Send a message..."
              rows={1}
            />
            <button type="submit" className="send-btn" disabled={isLoading || !input.trim()} title="Send">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
              </svg>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
