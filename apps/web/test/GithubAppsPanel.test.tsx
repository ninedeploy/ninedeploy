import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GithubAppsPanel, manifestNavigation } from '../src/routes/githubApps/GithubAppsPanel.js';
import { api } from '../src/lib/api.js';
import { mockOf, renderWithProviders } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

/** 0.13: the GitHub Apps panel on the Sources page. */

const APP = {
  id: 1,
  name: 'NineDeploy panel.example',
  appId: 4242,
  slug: 'ninedeploy-panel',
  clientId: 'Iv1.x',
  ownerLogin: 'acme',
  ownerType: 'Organization',
  webBaseUrl: 'https://github.com',
  apiBaseUrl: 'https://api.github.com',
  htmlUrl: 'https://github.com/apps/ninedeploy-panel',
  permissions: { contents: 'read' },
  events: ['push'],
  webhookUrl: 'https://panel.example/v1/hooks/github-app/abc',
  installUrl: 'https://github.com/apps/ninedeploy-panel/installations/new',
  hasPrivateKey: true,
  hasClientSecret: false,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};

const INST = {
  id: 10,
  githubAppId: 1,
  installationId: 555,
  accountLogin: 'acme',
  accountType: 'Organization',
  accountId: 9,
  repositorySelection: 'selected' as const,
  permissions: null,
  sourceId: 7,
  suspendedAt: null,
  removedAt: null,
  configureUrl: 'https://github.com/organizations/acme/settings/installations/555',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};

describe('GithubAppsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOf(api.githubApps.list).mockResolvedValue([]);
    mockOf(api.githubApps.installations).mockResolvedValue([]);
    mockOf(api.sources.list).mockResolvedValue([]);
  });

  it('says when no App is registered, and when the list fails', async () => {
    renderWithProviders(<GithubAppsPanel />);
    expect(await screen.findByText('No GitHub App registered yet.')).toBeInTheDocument();
  });

  it('shows the load error', async () => {
    mockOf(api.githubApps.list).mockRejectedValue(new Error('forbidden'));
    renderWithProviders(<GithubAppsPanel />);
    expect(await screen.findByText('Could not load GitHub Apps: forbidden')).toBeInTheDocument();
  });

  it('starts the manifest flow for a personal account and hands the manifest to the form POST', async () => {
    const submit = vi.spyOn(manifestNavigation, 'submit').mockImplementation(() => {});
    mockOf(api.githubApps.manifest).mockResolvedValue({ postUrl: 'https://github.com/settings/apps/new?state=s', manifest: { name: 'n' }, state: 's' });
    const user = userEvent.setup();
    renderWithProviders(<GithubAppsPanel />);
    await user.click(screen.getByRole('button', { name: /Create GitHub App/ }));
    await user.click(screen.getByRole('button', { name: 'Continue on GitHub' }));
    await waitFor(() => expect(api.githubApps.manifest).toHaveBeenCalledWith({ target: 'user' }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith('https://github.com/settings/apps/new?state=s', { name: 'n' }));
    submit.mockRestore();
  });

  it('needs an organization login for an org App, and toasts a refused start', async () => {
    mockOf(api.githubApps.manifest).mockRejectedValue(new Error('panel_origin_local'));
    const user = userEvent.setup();
    renderWithProviders(<GithubAppsPanel />);
    await user.click(screen.getByRole('button', { name: /Create GitHub App/ }));
    await user.click(screen.getByRole('button', { name: 'Organization' }));
    const form = screen.getByRole('form', { name: 'Create GitHub App' });
    fireEvent.submit(form);
    expect(api.githubApps.manifest).not.toHaveBeenCalled();
    await user.type(screen.getByPlaceholderText('acme'), ' acme ');
    await user.click(screen.getByRole('button', { name: 'Continue on GitHub' }));
    await waitFor(() => expect(api.githubApps.manifest).toHaveBeenCalledWith({ target: 'org', org: 'acme' }));
    expect(await screen.findByText('Could not start the GitHub App setup: panel_origin_local')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Create GitHub App' })).toBeNull();
  });

  it('registers an App manually (GHES) and closes the form', async () => {
    mockOf(api.githubApps.create).mockResolvedValue(APP);
    const user = userEvent.setup();
    renderWithProviders(<GithubAppsPanel />);
    await user.click(screen.getByRole('button', { name: 'Add manually (GHES)' }));
    const form = screen.getByRole('form', { name: 'Add GitHub App manually' });
    fireEvent.submit(form);
    expect(api.githubApps.create).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Name'), 'ghes');
    await user.type(screen.getByLabelText('App ID'), '12');
    fireEvent.change(screen.getByLabelText('Private key (.pem)'), { target: { value: 'PEM' } });
    await user.type(screen.getByLabelText('Webhook secret'), 'whsec');
    await user.type(screen.getByLabelText('Web base URL'), 'https://ghe.example');
    await user.type(screen.getByLabelText('API base URL'), 'https://ghe.example/api/v3');
    await user.click(screen.getByRole('button', { name: 'Save GitHub App' }));
    await waitFor(() =>
      expect(api.githubApps.create).toHaveBeenCalledWith({
        name: 'ghes',
        appId: 12,
        privateKey: 'PEM',
        webhookSecret: 'whsec',
        webBaseUrl: 'https://ghe.example',
        apiBaseUrl: 'https://ghe.example/api/v3',
      }),
    );
    expect(await screen.findByText('GitHub App registered')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Add GitHub App manually' })).toBeNull();
  });

  it('sends a github.com App without base URLs or secret, and shows a refused key', async () => {
    mockOf(api.githubApps.create).mockRejectedValue(new Error('privateKey must be a PEM private key'));
    const user = userEvent.setup();
    renderWithProviders(<GithubAppsPanel />);
    await user.click(screen.getByRole('button', { name: 'Add manually (GHES)' }));
    await user.type(screen.getByLabelText('Name'), 'gh');
    await user.type(screen.getByLabelText('App ID'), '3');
    fireEvent.change(screen.getByLabelText('Private key (.pem)'), { target: { value: 'bad' } });
    await user.click(screen.getByRole('button', { name: 'Save GitHub App' }));
    await waitFor(() => expect(api.githubApps.create).toHaveBeenCalledWith({ name: 'gh', appId: 3, privateKey: 'bad' }));
    expect(await screen.findByText('Could not register the GitHub App: privateKey must be a PEM private key')).toBeInTheDocument();
    // Toggling the same button closes the form.
    await user.click(screen.getByRole('button', { name: 'Add manually (GHES)' }));
    expect(screen.queryByRole('form', { name: 'Add GitHub App manually' })).toBeNull();
  });

  it('lists Apps with their installations as generated sources, and syncs', async () => {
    mockOf(api.githubApps.list).mockResolvedValue([APP, { ...APP, id: 2, name: 'GHES app', slug: null, ownerLogin: null, installUrl: null, webBaseUrl: 'https://ghe.example' }]);
    mockOf(api.githubApps.installations).mockImplementation(async (id: number) =>
      id === 1
        ? [
            INST,
            { ...INST, id: 11, accountLogin: null, accountType: null, sourceId: 99, suspendedAt: '2026-10-02T00:00:00Z', repositorySelection: 'all', configureUrl: null },
            { ...INST, id: 12, sourceId: null, removedAt: '2026-10-03T00:00:00Z' },
          ]
        : [],
    );
    mockOf(api.sources.list).mockResolvedValue([{ id: 7, name: 'gh-app:acme', type: 'github_app' }]);
    mockOf(api.githubApps.syncInstallations)
      .mockResolvedValueOnce({ created: 1, updated: 2, removed: 0, sourcesCreated: 1, truncated: true, installations: [INST] })
      .mockRejectedValueOnce(new Error('GitHub refused the App credentials'));
    const user = userEvent.setup();
    renderWithProviders(<GithubAppsPanel />);
    const card = await screen.findByTestId('github-app-1');
    expect(within(card).getByText('Install').closest('a')).toHaveAttribute('href', APP.installUrl);
    expect(within(card).getByText(/App #4242 · ninedeploy-panel · owned by acme/)).toBeInTheDocument();
    expect(await within(card).findByText('source: gh-app:acme')).toBeInTheDocument();
    expect(within(card).getByText('source #99')).toBeInTheDocument();
    expect(within(card).getByText('no source')).toBeInTheDocument();
    expect(within(card).getByText('installation 555')).toBeInTheDocument();
    expect(within(card).getByText('suspended')).toBeInTheDocument();
    expect(within(card).getByText('removed')).toBeInTheDocument();
    expect(within(card).getByText('all repositories')).toBeInTheDocument();
    const ghes = screen.getByTestId('github-app-2');
    expect(within(ghes).getByText(/App #4242 · https:\/\/ghe.example/)).toBeInTheDocument();
    expect(await within(ghes).findByText(/None yet/)).toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: /Sync/ }));
    expect(await screen.findByText('Installations synced: 1 new, 2 updated, 0 removed (list truncated)')).toBeInTheDocument();
    await waitFor(() => expect(within(card).queryByText('source #99')).toBeNull());
    await user.click(within(card).getByRole('button', { name: /Sync/ }));
    expect(await screen.findByText('Sync failed: GitHub refused the App credentials')).toBeInTheDocument();
  });

  it('a sync without truncation omits the note; installations that fail to load say so', async () => {
    mockOf(api.githubApps.list).mockResolvedValue([APP]);
    mockOf(api.githubApps.installations).mockRejectedValue(new Error('boom'));
    mockOf(api.githubApps.syncInstallations).mockResolvedValue({ created: 0, updated: 1, removed: 1, sourcesCreated: 0, truncated: false, installations: [] });
    const user = userEvent.setup();
    renderWithProviders(<GithubAppsPanel />);
    expect(await screen.findByText('Could not load installations: boom')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Sync/ }));
    expect(await screen.findByText('Installations synced: 0 new, 1 updated, 1 removed')).toBeInTheDocument();
  });

  it('rotates the private key, syncs the webhook and deletes the App', async () => {
    mockOf(api.githubApps.list).mockResolvedValue([APP]);
    mockOf(api.githubApps.rotateKey).mockRejectedValueOnce(new Error('different GitHub App')).mockResolvedValueOnce(APP);
    mockOf(api.githubApps.webhookSync).mockResolvedValueOnce(APP).mockRejectedValueOnce(new Error('panel_origin_local'));
    mockOf(api.githubApps.remove).mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    renderWithProviders(<GithubAppsPanel />);
    const card = await screen.findByTestId('github-app-1');

    await user.click(within(card).getByRole('button', { name: /Rotate key/ }));
    const keyField = within(card).getByLabelText('New private key (.pem)');
    fireEvent.submit(keyField.closest('form')!);
    expect(api.githubApps.rotateKey).not.toHaveBeenCalled();
    fireEvent.change(keyField, { target: { value: ' NEWPEM ' } });
    await user.click(within(card).getByRole('button', { name: 'Replace key' }));
    expect(await screen.findByText('Key rejected: different GitHub App')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Replace key' }));
    await waitFor(() => expect(api.githubApps.rotateKey).toHaveBeenLastCalledWith(1, 'NEWPEM'));
    expect(await screen.findByText('Private key replaced')).toBeInTheDocument();
    expect(within(card).queryByLabelText('New private key (.pem)')).toBeNull();

    await user.click(within(card).getByRole('button', { name: /Webhook sync/ }));
    expect(await screen.findByText('Webhook pointed at this panel')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: /Webhook sync/ }));
    expect(await screen.findByText('Webhook sync failed: panel_origin_local')).toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: `Delete ${APP.name}` }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.githubApps.remove).not.toHaveBeenCalled();
    await user.click(within(card).getByRole('button', { name: `Delete ${APP.name}` }));
    await user.click(screen.getByRole('button', { name: 'Delete App' }));
    expect(await screen.findByText('Could not remove the GitHub App: busy')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: `Delete ${APP.name}` }));
    await user.click(screen.getByRole('button', { name: 'Delete App' }));
    expect(await screen.findByText('GitHub App removed')).toBeInTheDocument();
  });
});

describe('manifestNavigation.submit', () => {
  it('POSTs one hidden `manifest` field to the postUrl', () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    manifestNavigation.submit('https://github.com/settings/apps/new?state=abc', { name: 'NineDeploy', public: false });
    const form = document.body.querySelector('form[action="https://github.com/settings/apps/new?state=abc"]') as HTMLFormElement;
    expect(form).not.toBeNull();
    expect(form.method).toBe('post');
    const field = form.querySelector('input[name="manifest"]') as HTMLInputElement;
    expect(field.type).toBe('hidden');
    expect(JSON.parse(field.value)).toEqual({ name: 'NineDeploy', public: false });
    expect(submit).toHaveBeenCalledTimes(1);
    form.remove();
    submit.mockRestore();
  });
});
