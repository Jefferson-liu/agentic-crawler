import { useCallback, useEffect, useState } from 'react';
import type { ActiveContext, AvailableContext, GitHubRepo, GitHubUser, PipelineRun, StageRecord } from '../types';

const TERMINAL = new Set(['completed', 'failed']);

function buildStageRecord(r: PipelineRun): StageRecord | null {
  switch (r.status) {
    case 'ingestion':
      return {
        stage: 'ingestion',
        label: 'Cloned & indexed files',
        detail: r.filesSeen ? `${r.filesIngested ?? 0} / ${r.filesSeen} files` : undefined,
      };
    case 'file_summary':
      return {
        stage: 'file_summary',
        label: 'Summarized files',
        detail: r.stageProgress?.items_total
          ? `${r.stageProgress.items_completed} / ${r.stageProgress.items_total} files`
          : undefined,
      };
    case 'embedding':
      return {
        stage: 'embedding',
        label: 'Embedded files',
        detail: r.stageProgress?.items_total
          ? `${r.stageProgress.items_completed} / ${r.stageProgress.items_total} files`
          : undefined,
      };
    case 'repo_full_summary':
      return { stage: 'repo_full_summary', label: 'Generated repo summary' };
    case 'repo_manager':
      return { stage: 'repo_manager', label: 'Grouped modules' };
    case 'architecture':
      return { stage: 'architecture', label: 'Built architecture diagram' };
    default:
      return null;
  }
}


function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function fetchAllPages(url: string, pat: string): Promise<GitHubRepo[]> {
  const results: GitHubRepo[] = [];
  let next: string | null = url;
  while (next) {
    const res: Response = await fetch(next, {
      headers: { Authorization: `token ${pat}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub API error ${res.status}`);
    const page = (await res.json()) as GitHubRepo[];
    results.push(...page);
    const link: string = res.headers.get('Link') ?? '';
    const match: RegExpMatchArray | null = link.match(/<([^>]+)>;\s*rel="next"/);
    next = match ? match[1] : null;
  }
  return results;
}

export function useGitHub(agentApiBase: string) {
  const contextApiBase = `${agentApiBase}/api/context`;

  const [pat, setPat] = useState<string | null>(() => localStorage.getItem('github-pat'));
  const [user, setUser] = useState<GitHubUser | null>(() => loadJSON('github-user', null));
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [pipelineRuns, setPipelineRuns] = useState<PipelineRun[]>(() =>
    loadJSON('pipeline-runs', [])
  );
  const [availableContexts, setAvailableContexts] = useState<AvailableContext[]>(() =>
    loadJSON('available-contexts', [])
  );
  const [activeContext, setActiveContext] = useState<ActiveContext | null>(() =>
    loadJSON('active-context', null)
  );

  // Persist to localStorage
  useEffect(() => {
    if (pat) localStorage.setItem('github-pat', pat);
    else localStorage.removeItem('github-pat');
  }, [pat]);

  useEffect(() => {
    if (user) localStorage.setItem('github-user', JSON.stringify(user));
    else localStorage.removeItem('github-user');
  }, [user]);

  useEffect(() => {
    localStorage.setItem('pipeline-runs', JSON.stringify(pipelineRuns));
  }, [pipelineRuns]);

  useEffect(() => {
    localStorage.setItem('available-contexts', JSON.stringify(availableContexts));
  }, [availableContexts]);

  useEffect(() => {
    if (activeContext) localStorage.setItem('active-context', JSON.stringify(activeContext));
    else localStorage.removeItem('active-context');
  }, [activeContext]);

  // Fetch repos when pat is available
  useEffect(() => {
    if (!pat) return;
    fetchRepos(pat);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pat]);


  // Poll non-terminal pipeline runs
  useEffect(() => {
    const active = pipelineRuns.filter((r) => !TERMINAL.has(r.status));
    if (active.length === 0) return;

    const id = setInterval(async () => {
      for (const run of active) {
        try {
          const res = await fetch(
            `${contextApiBase}/repo-knowledge/pipeline-runs/${run.runId}`
          );
          if (res.status === 404) {
            // Run no longer exists on the backend (restart/lost state) — mark failed
            setPipelineRuns((prev) =>
              prev.map((r) =>
                r.runId !== run.runId ? r : { ...r, status: 'failed', error: 'Run not found — the backend may have restarted. Try re-indexing.' }
              )
            );
            continue;
          }
          if (!res.ok) continue;
          const data = await res.json();
          console.log(`[pipeline poll] run=${run.runId}`, data);
          const newStatus: PipelineRun['status'] = data.stage ?? data.status;
          setPipelineRuns((prev) =>
            prev.map((r) => {
              if (r.runId !== run.runId) return r;
              // When a stage transitions, snapshot the outgoing stage's final counts
              const stageChanged = newStatus !== r.status && !TERMINAL.has(r.status);
              let stageHistory = r.stageHistory;
              if (stageChanged) {
                const record = buildStageRecord(r);
                if (record) stageHistory = [...stageHistory, record];
              }
              return {
                ...r,
                status: newStatus,
                stageProgress: data.stage_progress ?? null,
                filesSeen: data.files_seen ?? r.filesSeen,
                filesIngested: data.files_ingested ?? r.filesIngested,
                stageHistory,
                fileSummaryRunId: data.file_summary_run_id ?? r.fileSummaryRunId,
                fileSummaryRunStatus: data.file_summary_run_status ?? r.fileSummaryRunStatus,
                repoFullSummaryRunStatus: data.repo_full_summary_run_status ?? r.repoFullSummaryRunStatus,
                embeddingRunStatus: data.embedding_run_status ?? r.embeddingRunStatus,
                repoManagerRunStatus: data.repo_manager_run_status ?? r.repoManagerRunStatus,
                ...(newStatus === 'completed' ? { completedAt: new Date().toISOString() } : {}),
                ...(newStatus === 'failed'
                  ? { error: data.error_message ?? data.stage_error_message ?? 'Unknown error' }
                  : {}),
              };
            })
          );
          if (newStatus === 'completed') {
            const ctx: AvailableContext = {
              repoFullName: run.repoFullName,
              repoName: run.repoName,
              completedAt: new Date().toISOString(),
              runId: run.runId,
            };
            setAvailableContexts((prev) => [
              ctx,
              ...prev.filter((c) => c.repoFullName !== run.repoFullName),
            ]);
          }
        } catch {
          // retry next tick
        }
      }
    }, 3000);

    return () => clearInterval(id);
  }, [pipelineRuns, contextApiBase]);

  async function fetchRepos(token: string) {
    setReposLoading(true);
    setReposError(null);
    try {
      const all = await fetchAllPages(
        'https://api.github.com/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=updated',
        token
      );
      setRepos(all);
    } catch (err) {
      setReposError(err instanceof Error ? err.message : String(err));
    } finally {
      setReposLoading(false);
    }
  }

  const connectPAT = useCallback(async (token: string) => {
    setConnectError(null);
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      const msg = res.status === 401 ? 'Invalid token — check scopes and try again.' : `GitHub error ${res.status}`;
      setConnectError(msg);
      throw new Error(msg);
    }
    const u = (await res.json()) as GitHubUser;
    setPat(token);
    setUser(u);
  }, []);

  const disconnectPAT = useCallback(() => {
    ['github-pat', 'github-user', 'pipeline-runs', 'available-contexts', 'active-context'].forEach(
      (k) => localStorage.removeItem(k)
    );
    setPat(null);
    setUser(null);
    setRepos([]);
    setPipelineRuns([]);
    setAvailableContexts([]);
    setActiveContext(null);
    setConnectError(null);
  }, [agentApiBase]);

  const indexRepo = useCallback(
    async (repo: GitHubRepo) => {
      const res = await fetch(`${contextApiBase}/repo-knowledge/pipeline-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_type: 'git_url',
          source_path: repo.clone_url,
          git_token: pat,
          repo_address: repo.full_name,
        }),
      });
      if (!res.ok) throw new Error(`Pipeline start failed: ${res.status}`);
      const data = await res.json();
      const newRun: PipelineRun = {
        runId: data.run_id,
        repoFullName: repo.full_name,
        repoName: repo.name,
        status: data.stage ?? data.status ?? 'queued',
        stageProgress: null,
        stageHistory: [],
        startedAt: new Date().toISOString(),
      };
      setPipelineRuns((prev) => [newRun, ...prev.filter((r) => r.repoFullName !== repo.full_name)]);
    },
    [contextApiBase, pat]
  );

  const retryRun = useCallback(
    async (repo: GitHubRepo, failedRun: PipelineRun) => {
      const canResume =
        failedRun.fileSummaryRunId &&
        failedRun.fileSummaryRunStatus === 'completed';

      const body: Record<string, unknown> = {
        source_type: 'git_url',
        source_path: repo.clone_url,
        git_token: pat,
        repo_address: repo.full_name,
      };

      if (canResume) {
        body.resume_from_file_summary_run_id = failedRun.fileSummaryRunId;
        body.force_rerepo_summary = failedRun.repoFullSummaryRunStatus !== 'completed';
        body.force_reembed = failedRun.embeddingRunStatus !== 'completed';
        body.force_rerepo_manager = failedRun.repoManagerRunStatus !== 'completed';
      }

      const res = await fetch(`${contextApiBase}/repo-knowledge/pipeline-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Retry failed: ${res.status}`);
      const data = await res.json();

      const newRun: PipelineRun = {
        runId: data.run_id,
        repoFullName: repo.full_name,
        repoName: repo.name,
        status: data.stage ?? data.status ?? 'queued',
        stageProgress: null,
        // On resume, carry forward completed sub-run statuses so history is preserved
        stageHistory: canResume ? (failedRun.stageHistory ?? []) : [],
        ...(canResume ? {
          fileSummaryRunId: failedRun.fileSummaryRunId,
          fileSummaryRunStatus: failedRun.fileSummaryRunStatus,
        } : {}),
        startedAt: new Date().toISOString(),
      };
      setPipelineRuns((prev) => [newRun, ...prev.filter((r) => r.repoFullName !== repo.full_name)]);
    },
    [contextApiBase, pat]
  );

  const activateContext = useCallback((ctx: AvailableContext) => {
    setActiveContext({
      repoFullName: ctx.repoFullName,
      repoName: ctx.repoName,
      runId: ctx.runId,
      activatedAt: new Date().toISOString(),
    });
  }, []);

  const clearActiveContext = useCallback(() => {
    setActiveContext(null);
  }, []);

  const cancelRun = useCallback((runId: string) => {
    setPipelineRuns((prev) =>
      prev.map((r) =>
        r.runId !== runId ? r : { ...r, status: 'failed', error: 'Cancelled' }
      )
    );
  }, []);

  return {
    pat,
    user,
    repos,
    reposLoading,
    reposError,
    connectError,
    pipelineRuns,
    availableContexts,
    activeContext,
    connectPAT,
    disconnectPAT,
    indexRepo,
    retryRun,
    cancelRun,
    activateContext,
    clearActiveContext,
  };
}

export type UseGitHubReturn = ReturnType<typeof useGitHub>;
