import type { UseGitHubReturn } from '../hooks/useGitHub';
import { GitHubAuth } from './GitHubAuth';
import { GitHubConnectedView } from './GitHubConnectedView';

type Props = UseGitHubReturn & { contextApiBase: string };

export function GitHubPanel({
  pat,
  user,
  connectPAT,
  connectError,
  contextApiBase,
  availableContexts: _ac,
  activeContext: _ctx,
  activateContext: _activate,
  clearActiveContext: _clear,
  ...rest
}: Props) {
  if (!pat || !user) {
    return <GitHubAuth onConnect={connectPAT} error={connectError} />;
  }

  return <GitHubConnectedView user={user} contextApiBase={contextApiBase} {...rest} />;
}
