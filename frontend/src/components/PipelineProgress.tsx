import type { PipelineRun } from '../types';

const STAGE_LABELS: Record<PipelineRun['status'], string> = {
  queued: 'Queued…',
  ingestion: 'Cloning & indexing files…',
  file_summary: 'Summarizing files…',
  repo_full_summary: 'Generating repo summary…',
  embedding: 'Embedding files…',
  repo_manager: 'Grouping modules…',
  architecture: 'Building architecture diagram…',
  completed: 'Indexed successfully',
  failed: 'Failed',
};

function Spinner() {
  return <span className="pipeline-spinner" aria-hidden="true" />;
}

function Bar({ completed, total }: { completed: number; total: number }) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <div className="pipeline-bar-row">
      <div className="pipeline-bar-track">
        <div className="pipeline-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="pipeline-count">{completed} / {total}</span>
    </div>
  );
}

type Props = { run: PipelineRun };

export function PipelineProgress({ run }: Props) {
  const { stageHistory = [], stageProgress, filesSeen = 0, filesIngested = 0 } = run;

  // Determine current-stage progress node
  let currentProgress: React.ReactNode = null;
  if (run.status === 'ingestion') {
    if (filesSeen > 0) {
      // Have both counts — show bar + ratio
      currentProgress = <Bar completed={filesIngested} total={filesSeen} />;
    } else if (filesIngested > 0) {
      // Files arriving but total not known yet — show live counter
      currentProgress = <span className="pipeline-count">{filesIngested} files indexed…</span>;
    } else {
      // Truly just started
      currentProgress = <Spinner />;
    }
  } else if (run.status === 'file_summary' || run.status === 'embedding') {
    currentProgress = stageProgress && stageProgress.items_total > 0
      ? <Bar completed={stageProgress.items_completed} total={stageProgress.items_total} />
      : <Spinner />;
  } else if (run.status !== 'completed' && run.status !== 'failed') {
    currentProgress = <Spinner />;
  }

  return (
    <div className="pipeline-progress">
      {/* Completed stage history */}
      {stageHistory.length > 0 && (
        <ul className="pipeline-history">
          {stageHistory.map((s, i) => (
            <li key={i} className="pipeline-history-item">
              <svg className="pipeline-check-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span className="pipeline-history-label">{s.label}</span>
              {s.detail && <span className="pipeline-history-detail">{s.detail}</span>}
            </li>
          ))}
        </ul>
      )}

      {/* Current stage */}
      {run.status === 'completed' ? (
        <div className="pipeline-complete">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          {STAGE_LABELS.completed}
        </div>
      ) : run.status === 'failed' ? (
        <div className="pipeline-error">
          {STAGE_LABELS.failed}{run.error ? ` — ${run.error}` : ''}
        </div>
      ) : (
        <div className="pipeline-current">
          <div className="pipeline-stage-label">{STAGE_LABELS[run.status]}</div>
          {currentProgress}
        </div>
      )}
    </div>
  );
}
