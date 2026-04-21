import type { UseGitHubReturn } from '../hooks/useGitHub';
import { RepoBrowser } from './RepoBrowser';

type Props = Omit<UseGitHubReturn, 'connectPAT' | 'connectError' | 'pat' | 'availableContexts' | 'activeContext' | 'activateContext' | 'clearActiveContext'>;

export function GitHubConnectedView({
  user,
  repos,
  reposLoading,
  reposError,
  pipelineRuns,
  disconnectPAT,
  indexRepo,
  retryRun,
  cancelRun,
}: Props) {
  if (!user) return null;

  return (
    <div>
      <div className="github-user-header">
        <div className="github-avatar">
          <img src={user.avatar_url} alt={user.login} />
        </div>
        <span className="github-login">@{user.login}</span>
        <button className="github-disconnect-btn" onClick={disconnectPAT}>Disconnect</button>
      </div>

      <RepoBrowser
        repos={repos}
        reposLoading={reposLoading}
        reposError={reposError}
        pipelineRuns={pipelineRuns}
        onIndexRepo={indexRepo}
        onRetryRun={retryRun}
        onCancelRun={cancelRun}
      />
    </div>
  );
}
