import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { GithubAppCallback, GithubAppInstalled } from '../src/routes/githubApps/GithubAppPages.js';
import { api } from '../src/lib/api.js';
import { useAuth } from '../src/lib/auth.js';
import { mockOf, renderWithProviders } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});
vi.mock('../src/lib/auth.js', async () => {
  const { createAuthMock } = await import('./apiMock.js');
  return createAuthMock();
});

/** 0.13: the SPA pages GitHub redirects the browser to during App setup. */

const APP = { id: 1, name: 'NineDeploy panel.example', installUrl: 'https://github.com/apps/x/installations/new' };

function signedIn(isOperator = true) {
  mockOf(useAuth).mockReturnValue({ user: { id: 1, isOperator }, loading: false } as never);
}

describe('GithubAppCallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedIn();
  });

  it('completes the manifest exactly once (StrictMode included) and offers the install link', async () => {
    mockOf(api.githubApps.completeManifest).mockResolvedValue(APP);
    renderWithProviders(
      <StrictMode>
        <GithubAppCallback />
      </StrictMode>,
      { route: '/github-apps/callback?code=abc123&state=s.sig' },
    );
    expect(screen.getByText(/Saving the GitHub App/)).toBeInTheDocument();
    expect(await screen.findByTestId('github-app-registered')).toHaveTextContent('NineDeploy panel.example');
    expect(api.githubApps.completeManifest).toHaveBeenCalledTimes(1);
    expect(api.githubApps.completeManifest).toHaveBeenCalledWith({ code: 'abc123', state: 's.sig' });
    expect(screen.getByText('Install the App').closest('a')).toHaveAttribute('href', APP.installUrl);
    expect(screen.getByRole('button', { name: 'Back to Sources' })).toBeInTheDocument();
  });

  it('shows the server refusal (expired or reused state)', async () => {
    mockOf(api.githubApps.completeManifest).mockRejectedValue(new Error('This setup state was already used'));
    renderWithProviders(<GithubAppCallback />, { route: '/github-apps/callback?code=abc&state=s' });
    expect(await screen.findByTestId('github-app-failed')).toHaveTextContent('This setup state was already used');
  });

  it('stringifies a non-Error refusal and hides a missing install link', async () => {
    mockOf(api.githubApps.completeManifest).mockResolvedValueOnce({ ...APP, installUrl: null });
    const first = renderWithProviders(<GithubAppCallback />, { route: '/github-apps/callback?code=a&state=s' });
    expect(await screen.findByTestId('github-app-registered')).toBeInTheDocument();
    expect(screen.queryByText('Install the App')).toBeNull();
    first.unmount();
    mockOf(api.githubApps.completeManifest).mockRejectedValueOnce('raw failure');
    renderWithProviders(<GithubAppCallback />, { route: '/github-apps/callback?code=a&state=s' });
    expect(await screen.findByTestId('github-app-failed')).toHaveTextContent('raw failure');
  });

  it('refuses to call the server without a code or state', () => {
    renderWithProviders(<GithubAppCallback />, { route: '/github-apps/callback?state=s' });
    expect(screen.getByTestId('github-app-failed')).toHaveTextContent('GitHub did not return a setup code');
    expect(api.githubApps.completeManifest).not.toHaveBeenCalled();
  });

  it('is operator-only', () => {
    signedIn(false);
    renderWithProviders(<GithubAppCallback />, { route: '/github-apps/callback?code=a&state=s' });
    expect(screen.getByText(/limited to instance operators/)).toBeInTheDocument();
    expect(api.githubApps.completeManifest).not.toHaveBeenCalled();
  });
});

describe('GithubAppInstalled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedIn();
  });

  it('syncs every App once, never trusting installation_id, and reports per-App results', async () => {
    mockOf(api.githubApps.list).mockResolvedValue([APP, { ...APP, id: 2, name: 'Broken' }, { ...APP, id: 3, name: 'Odd' }]);
    mockOf(api.githubApps.syncInstallations).mockImplementation(async (id: number) => {
      if (id === 2) throw new Error('GitHub refused the App credentials');
      if (id === 3) throw 'odd failure';
      return { created: 1, updated: 0, removed: 0, sourcesCreated: 1, truncated: false, installations: [] };
    });
    renderWithProviders(
      <StrictMode>
        <GithubAppInstalled />
      </StrictMode>,
      { route: '/github-apps/installed?installation_id=999&setup_action=install' },
    );
    expect(screen.getByText(/Syncing installations from GitHub/)).toBeInTheDocument();
    const done = await screen.findByTestId('github-app-synced');
    expect(done).toHaveTextContent('NineDeploy panel.example: 1 new installation(s), 1 new source(s)');
    expect(done).toHaveTextContent('Broken: sync failed: GitHub refused the App credentials');
    expect(done).toHaveTextContent('Odd: sync failed: odd failure');
    expect(api.githubApps.list).toHaveBeenCalledTimes(1);
    expect(mockOf(api.githubApps.syncInstallations).mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
  });

  it('says when no App is registered', async () => {
    mockOf(api.githubApps.list).mockResolvedValue([]);
    renderWithProviders(<GithubAppInstalled />, { route: '/github-apps/installed' });
    expect(await screen.findByText('No GitHub App is registered on this panel yet.')).toBeInTheDocument();
  });

  it('shows a failed App listing', async () => {
    mockOf(api.githubApps.list).mockRejectedValue(new Error('forbidden'));
    renderWithProviders(<GithubAppInstalled />, { route: '/github-apps/installed' });
    expect(await screen.findByTestId('github-app-failed')).toHaveTextContent('forbidden');
  });

  it('is operator-only', async () => {
    signedIn(false);
    renderWithProviders(<GithubAppInstalled />, { route: '/github-apps/installed' });
    expect(screen.getByText(/limited to instance operators/)).toBeInTheDocument();
    await waitFor(() => expect(api.githubApps.list).not.toHaveBeenCalled());
  });
});
