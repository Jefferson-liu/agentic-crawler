import { useEffect, useRef, useState } from 'react';
import type { PipelineRun } from '../types';

type FileDiagnostic = {
  subject_path: string;
  severity: string;
  message: string;
};

type SubRunData = {
  pipeline: any | null;
  fileSummary: any | null;
  fileDiagnostics: FileDiagnostic[];
  fileSummaryUsage: any | null;
  repoFullSummary: any | null;
  embedding: any | null;
  repoManager: any | null;
};

function fmt(ts: string | null | undefined): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return ts;
  }
}

function duration(start: string | null | undefined, end: string | null | undefined): string {
  if (!start || !end) return '—';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function StatRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="diag-stat-row">
      <span className="diag-stat-label">{label}</span>
      <span className="diag-stat-value">{value ?? '—'}</span>
    </div>
  );
}

function SectionHeader({ title, ok }: { title: string; ok?: boolean | null }) {
  return (
    <div className="diag-section-header">
      <span className="diag-section-title">{title}</span>
      {ok != null && (
        <span className={`diag-stage-badge ${ok ? 'diag-badge-ok' : 'diag-badge-fail'}`}>
          {ok ? 'OK' : 'Failed'}
        </span>
      )}
    </div>
  );
}

type Props = {
  run: PipelineRun;
  contextApiBase: string;
  onClose: () => void;
};

export function RunDiagnosticsModal({ run, contextApiBase, onClose }: Props) {
  const [data, setData] = useState<SubRunData>({
    pipeline: null, fileSummary: null, fileDiagnostics: [], fileSummaryUsage: null,
    repoFullSummary: null, embedding: null, repoManager: null,
  });
  const [loading, setLoading] = useState(true);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const base = contextApiBase;

      // Phase 1: fetch pipeline run to get sub-run IDs
      let pipeline: any = null;
      try {
        const r = await fetch(`${base}/repo-knowledge/pipeline-runs/${run.runId}`);
        if (r.ok) pipeline = await r.json();
      } catch {}

      const fsId = pipeline?.file_summary_run_id ?? run.fileSummaryRunId ?? null;
      const rfsId = pipeline?.repo_full_summary_run_id ?? null;
      const embId = pipeline?.embedding_run_id ?? null;
      const rmId = pipeline?.repo_manager_run_id ?? null;

      // Phase 2: fetch all sub-runs in parallel
      async function safeGet(url: string) {
        try {
          const r = await fetch(url);
          return r.ok ? r.json() : null;
        } catch { return null; }
      }

      const [fileSummary, fileDiagsRaw, fileSummaryUsage, repoFullSummary, embedding, repoManager] =
        await Promise.all([
          fsId ? safeGet(`${base}/repo-knowledge/file-summary-runs/${fsId}`) : null,
          fsId ? safeGet(`${base}/repo-knowledge/file-summary-runs/${fsId}/diagnostics?limit=50`) : null,
          fsId ? safeGet(`${base}/repo-knowledge/file-summary-runs/${fsId}/usage/summary`) : null,
          rfsId ? safeGet(`${base}/repo-knowledge/repo-full-summary-runs/${rfsId}`) : null,
          embId ? safeGet(`${base}/repo-knowledge/embedding-runs/${embId}`) : null,
          rmId ? safeGet(`${base}/repo-knowledge/repo-manager-runs/${rmId}`) : null,
        ]);

      const fileDiagnostics: FileDiagnostic[] = Array.isArray(fileDiagsRaw)
        ? fileDiagsRaw
        : (fileDiagsRaw?.diagnostics ?? fileDiagsRaw?.items ?? []);

      setData({ pipeline, fileSummary, fileDiagnostics, fileSummaryUsage, repoFullSummary, embedding, repoManager });
      setLoading(false);
    }
    load();
  }, [run.runId, contextApiBase]);

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const p = data.pipeline;
  const pipelineStarted = p?.created_at ?? p?.started_at ?? run.startedAt;
  const pipelineEnded = p?.completed_at ?? p?.ended_at ?? run.completedAt;
  const pipelineStatus = p?.stage ?? p?.status ?? run.status;
  const pipelineError = p?.error_message ?? p?.stage_error_message ?? run.error;

  const fs = data.fileSummary;
  const rfs = data.repoFullSummary;
  const emb = data.embedding;
  const rm = data.repoManager;

  return (
    <div className="diag-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="diag-modal">
        <div className="diag-modal-header">
          <div>
            <div className="diag-modal-title">{run.repoName}</div>
            <div className="diag-modal-sub">{run.repoFullName}</div>
          </div>
          <button className="diag-close-btn" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="diag-modal-body">
          {loading ? (
            <div className="diag-loading">Loading diagnostics…</div>
          ) : (
            <>
              {/* Pipeline overview */}
              <section className="diag-section">
                <SectionHeader
                  title="Pipeline"
                  ok={pipelineStatus === 'completed' ? true : pipelineStatus === 'failed' ? false : null}
                />
                <StatRow label="Started" value={fmt(pipelineStarted)} />
                <StatRow label="Completed" value={fmt(pipelineEnded)} />
                <StatRow label="Duration" value={duration(pipelineStarted, pipelineEnded)} />
                <StatRow label="Run ID" value={run.runId} />
                {pipelineError && (
                  <div className="diag-error-msg">{pipelineError}</div>
                )}
              </section>

              {/* File Summary stage */}
              {fs && (
                <section className="diag-section">
                  <SectionHeader
                    title="File Summarization"
                    ok={fs.status === 'completed' ? true : fs.status === 'failed' ? false : null}
                  />
                  <StatRow label="Files seen" value={fs.files_seen ?? fs.total_files} />
                  <StatRow label="Summarized" value={fs.files_summarized ?? fs.summarized_files} />
                  <StatRow label="Failed" value={fs.files_failed ?? fs.failed_files} />
                  <StatRow label="Started" value={fmt(fs.created_at ?? fs.started_at)} />
                  <StatRow label="Completed" value={fmt(fs.completed_at ?? fs.ended_at)} />
                  <StatRow label="Duration" value={duration(fs.created_at ?? fs.started_at, fs.completed_at ?? fs.ended_at)} />
                  {data.fileSummaryUsage && (
                    <>
                      <StatRow label="Total tokens" value={data.fileSummaryUsage.total_tokens?.toLocaleString()} />
                      <StatRow
                        label="Avg time/file"
                        value={data.fileSummaryUsage.avg_duration_ms != null
                          ? `${Math.round(data.fileSummaryUsage.avg_duration_ms)}ms`
                          : null}
                      />
                    </>
                  )}
                  {fs.error_message && (
                    <div className="diag-error-msg">{fs.error_message}</div>
                  )}
                  {data.fileDiagnostics.length > 0 && (
                    <div className="diag-sub-section">
                      <div className="diag-sub-title">File diagnostics ({data.fileDiagnostics.length})</div>
                      <div className="diag-diagnostics-list">
                        {data.fileDiagnostics.map((d, i) => (
                          <div key={i} className={`diag-diagnostic-item diag-severity-${(d.severity ?? 'warning').toLowerCase()}`}>
                            <div className="diag-diagnostic-path">{d.subject_path ?? '(unknown)'}</div>
                            <div className="diag-diagnostic-msg">{d.message}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </section>
              )}

              {/* Repo Full Summary stage */}
              {rfs && (
                <section className="diag-section">
                  <SectionHeader
                    title="Repo Full Summary"
                    ok={rfs.status === 'completed' ? true : rfs.status === 'failed' ? false : null}
                  />
                  <StatRow label="Files used" value={rfs.files_used} />
                  <StatRow label="Mode" value={rfs.mode ?? rfs.raw_output?.mode} />
                  <StatRow label="Started" value={fmt(rfs.created_at ?? rfs.started_at)} />
                  <StatRow label="Completed" value={fmt(rfs.completed_at ?? rfs.ended_at)} />
                  <StatRow label="Duration" value={duration(rfs.created_at ?? rfs.started_at, rfs.completed_at ?? rfs.ended_at)} />
                  {rfs.error_message && (
                    <div className="diag-error-msg">{rfs.error_message}</div>
                  )}
                </section>
              )}

              {/* Embedding stage */}
              {emb && (
                <section className="diag-section">
                  <SectionHeader
                    title="Embedding"
                    ok={emb.status === 'completed' ? true : emb.status === 'failed' ? false : null}
                  />
                  <StatRow label="Subjects seen" value={emb.subjects_seen} />
                  <StatRow label="Embedded" value={emb.subjects_embedded} />
                  <StatRow label="Failed" value={emb.subjects_failed} />
                  <StatRow label="Started" value={fmt(emb.created_at ?? emb.started_at)} />
                  <StatRow label="Completed" value={fmt(emb.completed_at ?? emb.ended_at)} />
                  <StatRow label="Duration" value={duration(emb.created_at ?? emb.started_at, emb.completed_at ?? emb.ended_at)} />
                  {emb.error_message && (
                    <div className="diag-error-msg">{emb.error_message}</div>
                  )}
                </section>
              )}

              {/* Repo Manager stage */}
              {rm && (
                <section className="diag-section">
                  <SectionHeader
                    title="Module Grouping"
                    ok={rm.status === 'completed' ? true : rm.status === 'failed' ? false : null}
                  />
                  <StatRow label="Groups seen" value={rm.groups_seen} />
                  <StatRow label="Summarized" value={rm.groups_summarized} />
                  <StatRow label="Failed" value={rm.groups_failed} />
                  <StatRow label="Members seen" value={rm.members_seen} />
                  <StatRow label="Started" value={fmt(rm.created_at ?? rm.started_at)} />
                  <StatRow label="Completed" value={fmt(rm.completed_at ?? rm.ended_at)} />
                  <StatRow label="Duration" value={duration(rm.created_at ?? rm.started_at, rm.completed_at ?? rm.ended_at)} />
                  {rm.error_message && (
                    <div className="diag-error-msg">{rm.error_message}</div>
                  )}
                </section>
              )}

              {!fs && !rfs && !emb && !rm && !loading && (
                <div className="diag-empty">No sub-run details available yet.</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
