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
const config = { enabled: true, labels: ['ninedeploy'], maxConcurrent: 2, cpus: null, memoryMb: null, allowPublicRepos: false, repositories: ['acme/api'], serverId: 9 };
const status = (over: Record<string, unknown> = {}) => ({
  config,
  image: 'ghcr.io/actions/actions-runner:2.338.2@sha256:abc',
  problems: [],
  pending: [],
  active: [],
  ...over,
});
const SERVERS = [
  { id: 9, name: 'edge-1' },
  { id: 11, name: 'edge-2' },
];

async function openSection() {
  renderWithProviders(<RunnersSection app={app} />);
  await userEvent.click(screen.getByRole('button', { name: /Self-hosted Actions runners/ }));
}

describe('RunnersSection (coverage)', () => {
  beforeEach(() => {
    mockOf(api.githubApps.runners).mockReset();
    mockOf(api.githubApps.setRunners).mockReset();
    mockOf(api.githubApps.stopRunner).mockReset();
    mockOf(api.servers.list).mockReset().mockResolvedValue(SERVERS as never);
  });

  it('collapses again when the header is clicked a second time', async () => {
    mockOf(api.githubApps.runners).mockResolvedValue(status() as never);
    await openSection();
    const header = screen.getByRole('button', { name: /Self-hosted Actions runners/ });
    expect(await screen.findByRole('form', { name: 'Runner settings' })).toBeInTheDocument();
    expect(header).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('form', { name: 'Runner settings' })).not.toBeInTheDocument();
  });

  it('saves the node, limits, concurrency and public-repo switch, and toasts success', async () => {
    mockOf(api.githubApps.runners).mockResolvedValue(status() as never);
    mockOf(api.githubApps.setRunners).mockImplementation(async (_id, c) => status({ config: c }) as never);
    await openSection();
    const form = await screen.findByRole('form', { name: 'Runner settings' });
    // A config with a node and no limits loads as empty limit fields and the node selected.
    const runOn = within(form).getByRole('combobox', { name: 'Run on' });
    await within(form).findByRole('option', { name: 'edge-2' });
    expect(runOn).toHaveValue('9');
    expect(within(form).getByLabelText(/CPUs per runner/)).toHaveValue('');
    await userEvent.selectOptions(runOn, '11');
    const max = within(form).getByLabelText('Runners at once');
    await userEvent.clear(max);
    await userEvent.type(max, '4');
    await userEvent.type(within(form).getByLabelText(/CPUs per runner/), '1.5');
    await userEvent.type(within(form).getByLabelText(/Memory per runner/), '2048');
    await userEvent.click(within(form).getByRole('switch', { name: 'Allow public repositories' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.githubApps.setRunners).toHaveBeenCalledWith(4, {
        enabled: true,
        labels: ['ninedeploy'],
        maxConcurrent: 4,
        cpus: 1.5,
        memoryMb: 2048,
        allowPublicRepos: true,
        repositories: ['acme/api'],
        serverId: 11,
      }),
    );
    expect(await screen.findByText('Runner settings saved')).toBeInTheDocument();
  });

  it('runs on the panel host again when the node is cleared', async () => {
    mockOf(api.githubApps.runners).mockResolvedValue(status() as never);
    mockOf(api.githubApps.setRunners).mockImplementation(async (_id, c) => status({ config: c }) as never);
    await openSection();
    const form = await screen.findByRole('form', { name: 'Runner settings' });
    await userEvent.selectOptions(within(form).getByRole('combobox', { name: 'Run on' }), '');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.githubApps.setRunners).toHaveBeenCalledWith(4, expect.objectContaining({ serverId: null })));
  });

  it('keeps the form and explains a rejected save', async () => {
    mockOf(api.githubApps.runners).mockResolvedValue(status() as never);
    mockOf(api.githubApps.setRunners).mockRejectedValue(new Error('labels must not be empty'));
    await openSection();
    const form = await screen.findByRole('form', { name: 'Runner settings' });
    const labels = within(form).getByDisplayValue('ninedeploy');
    await userEvent.clear(labels);
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Could not save the runner settings: labels must not be empty')).toBeInTheDocument();
    expect(api.githubApps.setRunners).toHaveBeenCalledWith(4, expect.objectContaining({ labels: [] }));
    expect(labels).toHaveValue('');
  });

  it('names the node a runner is on, and explains a failed stop', async () => {
    mockOf(api.githubApps.runners).mockResolvedValue(
      status({
        active: [
          { name: 'nd-4-1-aaa', jobId: 1, repo: 'acme/api', state: 'starting', startedAt: null, serverId: 9 },
          { name: 'nd-4-2-bbb', jobId: 2, repo: null, state: 'running', startedAt: null, serverId: 99 },
        ],
        pending: [{ jobId: 3, repo: 'acme/web', jobName: null, queuedAt: '2026-10-28T10:00:00Z' }],
      }) as never,
    );
    mockOf(api.githubApps.stopRunner).mockRejectedValue(new Error('container is gone'));
    await openSection();
    expect(await screen.findByText('edge-1', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('node #99')).toBeInTheDocument();
    expect(screen.getByText('job #3')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Stop nd-4-2-bbb' }));
    expect(await screen.findByText('Could not stop the runner: container is gone')).toBeInTheDocument();
    expect(api.githubApps.stopRunner).toHaveBeenCalledWith(4, 'nd-4-2-bbb');
  });

  it('reloads the runners after a stop', async () => {
    mockOf(api.githubApps.runners)
      .mockResolvedValueOnce(status({ active: [{ name: 'nd-4-1-aaa', jobId: 1, repo: 'acme/api', state: 'running', startedAt: null }] }) as never)
      .mockResolvedValue(status() as never);
    mockOf(api.githubApps.stopRunner).mockResolvedValue(undefined as never);
    await openSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Stop nd-4-1-aaa' }));
    expect(await screen.findByText('No runner is running and no job is waiting.')).toBeInTheDocument();
    expect(api.githubApps.runners).toHaveBeenCalledTimes(2);
  });

  it('says why the runners could not be loaded', async () => {
    mockOf(api.githubApps.runners).mockRejectedValue(new Error('docker unreachable'));
    await openSection();
    expect(await screen.findByText('Could not load the runners: docker unreachable')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Runner settings' })).not.toBeInTheDocument();
  });
});
