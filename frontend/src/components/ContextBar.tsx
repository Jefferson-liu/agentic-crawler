import { useRef, useState, useEffect } from 'react';
import type { ActiveContext, AvailableContext } from '../types';

type Props = {
  availableContexts: AvailableContext[];
  activeContext: ActiveContext | null;
  onActivateContext: (ctx: AvailableContext) => void;
  onClearActiveContext: () => void;
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const GitHubIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.29-1.552 3.297-1.23 3.297-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12z" />
  </svg>
);

export function ContextBar({ availableContexts, activeContext, onActivateContext, onClearActiveContext }: Props) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dropdownOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [dropdownOpen]);

  function handleSelect(ctx: AvailableContext) {
    onActivateContext(ctx);
    setDropdownOpen(false);
  }

  const hasContexts = availableContexts.length > 0;

  return (
    <div className="ctx-selector" ref={containerRef}>
      {/* Trigger button */}
      {activeContext ? (
        <button
          type="button"
          className="ctx-trigger ctx-trigger-active"
          onClick={() => setDropdownOpen((o) => !o)}
          title={activeContext.repoFullName}
        >
          <GitHubIcon />
          <span className="ctx-trigger-name">{activeContext.repoName}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
          <span
            className="ctx-trigger-clear"
            role="button"
            tabIndex={0}
            title="Remove context"
            onClick={(e) => { e.stopPropagation(); onClearActiveContext(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onClearActiveContext(); }}}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </span>
        </button>
      ) : hasContexts ? (
        <button
          type="button"
          className="ctx-trigger ctx-trigger-empty"
          onClick={() => setDropdownOpen((o) => !o)}
        >
          <GitHubIcon />
          <span>Select codebase</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      ) : (
        <span className="ctx-trigger-none">
          <GitHubIcon />
          No indexed repos — open GitHub tab to index one
        </span>
      )}

      {/* Dropdown */}
      {dropdownOpen && hasContexts && (
        <div className="ctx-dropdown">
          <div className="ctx-dropdown-header">Indexed codebases</div>
          {availableContexts.map((ctx) => {
            const isActive = activeContext?.repoFullName === ctx.repoFullName;
            return (
              <button
                key={ctx.runId}
                type="button"
                className={`ctx-dropdown-item ${isActive ? 'ctx-dropdown-item-active' : ''}`}
                onClick={() => isActive ? setDropdownOpen(false) : handleSelect(ctx)}
              >
                <GitHubIcon />
                <span className="ctx-dropdown-name" title={ctx.repoFullName}>{ctx.repoName}</span>
                <span className="ctx-dropdown-time">{timeAgo(ctx.completedAt)}</span>
                {isActive && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
