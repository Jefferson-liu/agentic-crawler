import { useState } from 'react';
import type { GitHubRepo, PipelineRun } from '../types';
import { PipelineProgress } from './PipelineProgress';

// Subset of GitHub's language color map
const LANG_COLORS: Record<string, string> = {
  TypeScript: '#3178c6', JavaScript: '#f1e05a', Python: '#3572A5', Go: '#00ADD8',
  Rust: '#dea584', Java: '#b07219', 'C++': '#f34b7d', C: '#555555', Ruby: '#701516',
  Swift: '#F05138', Kotlin: '#A97BFF', 'C#': '#178600', PHP: '#4F5D95', Shell: '#89e051',
  HTML: '#e34c26', CSS: '#563d7c', Vue: '#41b883', Dart: '#00B4AB',
};

const TERMINAL = new Set(['completed', 'failed']);

type Props = {
  repos: GitHubRepo[];
  reposLoading: boolean;
  reposError: string | null;
  pipelineRuns: PipelineRun[];
  onIndexRepo: (repo: GitHubRepo) => void;
  onRetryRun: (repo: GitHubRepo, failedRun: PipelineRun) => void;
  onCancelRun: (runId: string) => void;
};

export function RepoBrowser({ repos, reposLoading, reposError, pipelineRuns, onIndexRepo, onRetryRun, onCancelRun }: Props) {
  const [query, setQuery] = useState('');
  const [indexingError, setIndexingError] = useState<string | null>(null);

  const filtered = query.trim()
    ? repos.filter(
        (r) =>
          r.name.toLowerCase().includes(query.toLowerCase()) ||
          (r.description ?? '').toLowerCase().includes(query.toLowerCase())
      )
    : repos;

  function getRunForRepo(repo: GitHubRepo): PipelineRun | undefined {
    return pipelineRuns.find((r) => r.repoFullName === repo.full_name);
  }

  async function handleIndex(repo: GitHubRepo) {
    setIndexingError(null);
    try {
      await onIndexRepo(repo);
    } catch (err) {
      setIndexingError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRetry(repo: GitHubRepo, failedRun: PipelineRun) {
    setIndexingError(null);
    try {
      await onRetryRun(repo, failedRun);
    } catch (err) {
      setIndexingError(err instanceof Error ? err.message : String(err));
    }
  }

  function repoActions(repo: GitHubRepo, run: PipelineRun | undefined) {
    const isActive = run && !TERMINAL.has(run.status);
    if (isActive) {
      return (
        <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center', flexShrink: 0 }}>
          <button className="repo-index-btn repo-index-btn-indexing" disabled>
            Indexing…
          </button>
          <button
            className="repo-cancel-btn"
            onClick={() => onCancelRun(run.runId)}
            title="Cancel indexing"
          >
            Cancel
          </button>
        </div>
      );
    }
    if (!run) {
      return (
        <button className="repo-index-btn" onClick={() => handleIndex(repo)}>
          Index
        </button>
      );
    }
    if (run.status === 'failed') {
      return (
        <button className="repo-index-btn" onClick={() => handleRetry(repo, run)}>
          Retry
        </button>
      );
    }
    // completed
    return (
      <button className="repo-index-btn" onClick={() => handleIndex(repo)}>
        Re-index
      </button>
    );
  }

  return (
    <div>
      <div className="repo-search-wrapper">
        <input
          className="repo-search-input"
          type="text"
          placeholder="Search repos…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {indexingError && <p className="github-auth-error" style={{ padding: '0 0.75rem' }}>{indexingError}</p>}
      {reposLoading && <p className="empty-text">Loading repos…</p>}
      {reposError && <p className="github-auth-error" style={{ padding: '0 0.75rem' }}>{reposError}</p>}
      {!reposLoading && !reposError && (
        <div className="repo-list">
          {filtered.map((repo) => {
            const run = getRunForRepo(repo);
            const langColor = repo.language ? (LANG_COLORS[repo.language] ?? '#6b6b6b') : null;
            return (
              <div key={repo.id} className="repo-item">
                <div className="repo-item-header">
                  <span className="repo-name" title={repo.full_name}>{repo.name}</span>
                  <span className={`repo-badge ${repo.private ? 'repo-badge-private' : 'repo-badge-public'}`}>
                    {repo.private ? 'private' : 'public'}
                  </span>
                  {repoActions(repo, run)}
                </div>
                {repo.description && (
                  <div className="repo-description" title={repo.description}>{repo.description}</div>
                )}
                {repo.language && langColor && (
                  <div className="repo-language">
                    <span className="repo-lang-dot" style={{ background: langColor }} />
                    {repo.language}
                  </div>
                )}
                {run && <PipelineProgress run={run} />}
              </div>
            );
          })}
          {filtered.length === 0 && !reposLoading && (
            <p className="empty-text">No repos found.</p>
          )}
        </div>
      )}
    </div>
  );
}
