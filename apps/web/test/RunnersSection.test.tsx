import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GithubApp } from '@ninedeploy/sdk';
import { RunnersSection } from '../src/routes/githubApps/RunnersSection.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const app = { id: 4, name: 'NineDeploy', appId: 42 } as GithubApp;
const config = { enabled: false, labels: ['ninedeploy'], maxConcurrent: 2, cpus: 2, memoryMb: 4096, allowPublicRepos: false, repositories: [] };
const status = (over: Record<string, unknown> = {}) => ({
  config,
  image: 'ghcr.io/actions/actions-runner:2.338.2@sha256:abc',
  problems: [],
  pending: [],
  active: [],
  ...over,
});

describe('RunnersSection (G4.5)', () => {
  beforeEach(() => {
    mockOf(api.githubApps.runners).mockReset();
    mockOf(api.githubApps.setRunners).mockReset();
    mockOf(api.githubApps.stopRunner).mockReset().mockResolvedValue(undefined as never);
  });

  it('asks for nothing until opened', async () => {
    mockOf(api.githubApps.runners).mockResolvedValue(status() as never);
    renderWithProviders(<RunnersSection app={app} />);
    expect(api.githubApps.runners).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /Self-hosted Actions runners/ }));
    await waitFor(() => expect(api.githubApps.runners).toHaveBeenCalledWith(4));
  });

  it('saves the settings from the form', async () => {
    mockOf(api.githubApps.runners).mockResolvedValue(status() as never);
    mockOf(api.githubApps.setRunners).mockImplementation(async (_id, c) => status({ config: c }) as never);
    renderWithProviders(<RunnersSection app={app} />);
    await userEvent.click(screen.getByRole('button', { name: /Self-hosted Actions runners/ }));
    const form = await screen.findByRole('form', { name: 'Runner settings' });
    await userEvent.click(within(form).getByRole('switch', { name: 'Run jobs on this panel' }));
    const labels = within(form).getByDisplayValue('ninedeploy');
    await userEvent.clear(labels);
    await userEvent.type(labels, 'ninedeploy, big');
    await userEvent.type(within(form).getByPlaceholderText('acme/api'), 'acme/api');
    const cpus = within(form).getByLabelText(/CPUs per runner/);
    await userEvent.clear(cpus);
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.githubApps.setRunners).toHaveBeenCalledWith(4, {
        enabled: true,
        labels: ['ninedeploy', 'big'],
        maxConcurrent: 2,
        cpus: null,
        memoryMb: 4096,
        allowPublicRepos: false,
        repositories: ['acme/api'],
      }),
    );
  });

  it('shows what is missing, the runners and the waiting jobs, and stops a runner', async () => {
    mockOf(api.githubApps.runners).mockResolvedValue(
      status({
        config: { ...config, enabled: true },
        problems: ['The GitHub App does not subscribe to the "Workflow job" event.'],
        active: [{ name: 'nd-4-77-abcdef', jobId: 77, repo: 'acme/api', state: 'running', startedAt: null }],
        pending: [{ jobId: 78, repo: 'acme/api', jobName: 'test', queuedAt: '2026-10-28T10:00:00Z' }],
      }) as never,
    );
    renderWithProviders(<RunnersSection app={app} />);
    await userEvent.click(screen.getByRole('button', { name: /Self-hosted Actions runners/ }));
    expect(await screen.findByText(/does not subscribe/)).toBeInTheDocument();
    expect(screen.getByText('nd-4-77-abcdef')).toBeInTheDocument();
    expect(screen.getByText('test')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Stop nd-4-77-abcdef' }));
    await waitFor(() => expect(api.githubApps.stopRunner).toHaveBeenCalledWith(4, 'nd-4-77-abcdef'));
  });
});
