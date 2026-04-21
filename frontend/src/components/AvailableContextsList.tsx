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

export function AvailableContextsList({
  availableContexts,
  activeContext,
  onActivateContext,
  onClearActiveContext,
}: Props) {
  return (
    <div className="contexts-section">
      <p className="contexts-section-title">Available Contexts</p>
      {availableContexts.length === 0 ? (
        <p className="empty-text" style={{ margin: '0.5rem 0' }}>No repos indexed yet.</p>
      ) : (
        availableContexts.map((ctx) => {
          const isActive = activeContext?.repoFullName === ctx.repoFullName;
          return (
            <div key={ctx.runId} className="context-item">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="context-item-name" title={ctx.repoFullName}>{ctx.repoName}</div>
                <div className="context-item-time">{timeAgo(ctx.completedAt)}</div>
              </div>
              {isActive ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0 }}>
                  <button className="context-use-btn context-use-btn-active" disabled>Active</button>
                  <button className="context-clear-link" onClick={onClearActiveContext}>Clear</button>
                </div>
              ) : (
                <button className="context-use-btn" onClick={() => onActivateContext(ctx)}>
                  Use
                </button>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
