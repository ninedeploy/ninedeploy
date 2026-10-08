import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Service } from '@ninedeploy/sdk';
import { GithubCard } from '../src/routes/service/GithubCard.js';
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

/** 0.13: the SettingsTab GitHub card (link state, feedback, migrate/finalize/revert). */

const SVC = { id: 5, name: 'web', slug: 'web', repoUrl: 'https://github.com/acme/web', sourceId: 2, sourceName: 'gh-pat', previewParentServiceId: null } as unknown as Service;

const LINK = {
  id: 1,
  serviceId: 5,
  installationRowId: 10,
  githubAppId: 1,
  sourceId: 7,
  repoId: 77,
  repoFullName: 'acme/web',
  enabled: true,
  tokenScope: 'repository' as const,
  watchPaths: null,
  reportStatus: false,
  prComment: true,
  previousSourceId: 2,
  active: true,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};

function signedIn(isOperator: boolean) {
  mockOf(useAuth).mockReturnValue({ user: { id: 1, isOperator }, loading: false } as never);
}

describe('GithubCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedIn(true);
    mockOf(api.services.github.get).mockResolvedValue({ link: null });
    mockOf(api.sources.list).mockResolvedValue([]);
  });

  it('renders nothing for a service without a repository, or a preview', () => {
    const image = renderWithProviders(<GithubCard svc={{ ...SVC, repoUrl: null } as Service} />);
    expect(screen.queryByText('GitHub App')).toBeNull();
    image.unmount();
    renderWithProviders(<GithubCard svc={{ ...SVC, isEphemeralPreview: true } as Service} />);
    expect(api.services.github.get).not.toHaveBeenCalled();
  });

  it('renders nothing when unlinked and no App source exists (or for a member)', async () => {
    const op = renderWithProviders(<GithubCard svc={SVC} />);
    await waitFor(() => expect(api.sources.list).toHaveBeenCalled());
    expect(screen.queryByText('GitHub App')).toBeNull();
    op.unmount();
    signedIn(false);
    mockOf(api.sources.list).mockClear();
    renderWithProviders(<GithubCard svc={SVC} />);
    await waitFor(() => expect(api.services.github.get).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('GitHub App')).toBeNull();
    expect(api.sources.list).not.toHaveBeenCalled();
  });

  it('lets an operator migrate an unlinked service onto an App installation', async () => {
    mockOf(api.sources.list).mockResolvedValue([
      { id: 2, name: 'gh-pat', type: 'github' },
      { id: 7, name: 'gh-app:acme', type: 'github_app' },
      { id: 8, name: 'gh-app:other', type: 'github_app' },
    ]);
    mockOf(api.services.github.migrate).mockRejectedValueOnce(new Error('cannot see acme/web')).mockResolvedValueOnce({ link: LINK });
    const user = userEvent.setup();
    renderWithProviders(<GithubCard svc={SVC} />);
    expect(await screen.findByText(/current source \(gh-pat\)/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('GitHub App installation'), '8');
    await user.click(screen.getByRole('button', { name: 'Migrate to GitHub App' }));
    expect(await screen.findByText('Could not migrate: cannot see acme/web')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Migrate to GitHub App' }));
    await waitFor(() => expect(api.services.github.migrate).toHaveBeenLastCalledWith(5, 8));
    expect(await screen.findByText(/previous source stays as a fallback/)).toBeInTheDocument();
  });

  it('omits the source name when the service has none', async () => {
    mockOf(api.sources.list).mockResolvedValue([{ id: 7, name: 'gh-app:acme', type: 'github_app' }]);
    renderWithProviders(<GithubCard svc={{ ...SVC, sourceName: null } as unknown as Service} />);
    expect(await screen.findByText(/while the current source and webhook stay/)).toBeInTheDocument();
  });

  it('shows the link to a member, with feedback toggles but no operator controls', async () => {
    signedIn(false);
    mockOf(api.services.github.get).mockResolvedValue({ link: LINK });
    mockOf(api.services.github.feedback).mockRejectedValueOnce(new Error('forbidden'));
    const user = userEvent.setup();
    renderWithProviders(<GithubCard svc={SVC} />);
    expect(await screen.findByText('acme/web')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText(/per-service webhook is skipped/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Revert/ })).toBeNull();
    await user.click(screen.getByRole('switch', { name: 'Commit statuses' }));
    expect(await screen.findByText('Could not change GitHub feedback: forbidden')).toBeInTheDocument();
  });

  it('toggles feedback, token scope and the link as an operator', async () => {
    mockOf(api.services.github.get).mockResolvedValue({ link: LINK });
    mockOf(api.services.github.feedback).mockResolvedValue({ link: LINK });
    mockOf(api.services.github.link).mockResolvedValueOnce({ link: LINK }).mockRejectedValueOnce(new Error('suspended'));
    const user = userEvent.setup();
    renderWithProviders(<GithubCard svc={SVC} />);
    await screen.findByText('acme/web');
    await user.click(screen.getByRole('switch', { name: 'Commit statuses' }));
    await waitFor(() => expect(api.services.github.feedback).toHaveBeenCalledWith(5, { reportStatus: true }));
    expect(await screen.findByText('GitHub feedback updated')).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'PR comments' }));
    await waitFor(() => expect(api.services.github.feedback).toHaveBeenLastCalledWith(5, { prComment: false }));
    await user.selectOptions(screen.getByLabelText('Clone token scope'), 'installation');
    await waitFor(() => expect(api.services.github.link).toHaveBeenCalledWith(5, { sourceId: 7, tokenScope: 'installation' }));
    expect(await screen.findByText('GitHub link updated')).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Link enabled' }));
    await waitFor(() => expect(api.services.github.link).toHaveBeenLastCalledWith(5, { sourceId: 7, enabled: false }));
    expect(await screen.findByText('Could not update the GitHub link: suspended')).toBeInTheDocument();
  });

  it('finalizes after confirmation and shows a refused finalize', async () => {
    mockOf(api.services.github.get).mockResolvedValue({ link: LINK });
    mockOf(api.services.github.finalize).mockResolvedValueOnce({ link: LINK, webhooksDeactivated: 2 }).mockRejectedValueOnce(new Error('needs a live installation'));
    const user = userEvent.setup();
    renderWithProviders(<GithubCard svc={SVC} />);
    await screen.findByText('acme/web');
    await user.click(screen.getByRole('button', { name: 'Finalize migration' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.services.github.finalize).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Finalize migration' }));
    await user.click(screen.getByRole('button', { name: 'Finalize' }));
    expect(await screen.findByText('Migration finalized; 2 webhook(s) switched off')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Finalize migration' }));
    await user.click(screen.getByRole('button', { name: 'Finalize' }));
    expect(await screen.findByText('Could not finalize: needs a live installation')).toBeInTheDocument();
  });

  it('keeps the 409 revert reason on screen, and reverts when allowed', async () => {
    mockOf(api.services.github.get).mockResolvedValue({ link: LINK });
    mockOf(api.services.github.unlink)
      .mockRejectedValueOnce(new Error('This service clones through the GitHub App source itself; attach another source first'))
      .mockResolvedValueOnce({ ok: true, sourceId: 2, webhooksReactivated: 1 });
    const user = userEvent.setup();
    renderWithProviders(<GithubCard svc={SVC} />);
    await screen.findByText('acme/web');
    await user.click(screen.getByRole('button', { name: 'Revert to previous source' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('clones through the GitHub App source itself');
    await user.click(screen.getByRole('button', { name: 'Revert to previous source' }));
    expect(await screen.findByText('Unlinked from the GitHub App; 1 webhook(s) switched back on')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('explains an inactive link (suspended installation, or disabled) and locks relinking without a source', async () => {
    mockOf(api.services.github.get).mockResolvedValueOnce({ link: { ...LINK, active: false, sourceId: null } });
    const first = renderWithProviders(<GithubCard svc={SVC} />);
    expect(await screen.findByText(/installation is suspended or removed/)).toBeInTheDocument();
    expect(screen.getByLabelText('Clone token scope')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Finalize migration' })).toBeDisabled();
    first.unmount();
    mockOf(api.services.github.get).mockResolvedValueOnce({ link: { ...LINK, active: false, enabled: false } });
    renderWithProviders(<GithubCard svc={SVC} />);
    expect(await screen.findByText(/The link is disabled/)).toBeInTheDocument();
  });
});
