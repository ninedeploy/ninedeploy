import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GitPollCard } from '../src/routes/service/GitPollCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const repo = { id: 5, type: 'docker', repoUrl: 'https://git.example.com/acme/web.git' } as never;
const off = { supported: true, poll: null, lastSha: null, lastPolledAt: null, lastError: null, lastDeploymentId: null };
const on = { supported: true, poll: { intervalSeconds: 900 }, lastSha: null, lastPolledAt: null, lastError: null, lastDeploymentId: null };

describe('GitPollCard (X2)', () => {
  it('turns polling on with the interval chosen from the menu', async () => {
    mockOf(api.services.gitPoll.get).mockResolvedValue(off);
    mockOf(api.services.gitPoll.set).mockResolvedValue(on);
    renderWithProviders(<GitPollCard svc={repo} />);
    await userEvent.click(await screen.findByRole('switch', { name: 'Git polling' }));
    expect(api.services.gitPoll.get).toHaveBeenCalledWith(5);
    await userEvent.selectOptions(screen.getByLabelText('Interval'), '900');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.services.gitPoll.set).toHaveBeenCalledWith(5, { intervalSeconds: 900 }));
    // A value outside the menu's stays selectable, so saving does not change it.
    expect(screen.getByRole('option', { name: 'Every 15 minutes' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Every 24 hours' })).toBeInTheDocument();
  });

  it('turns polling off', async () => {
    mockOf(api.services.gitPoll.get).mockResolvedValue({ ...on, lastPolledAt: '2026-11-27T10:00:00Z', lastSha: 'a'.repeat(40), lastDeploymentId: 12 });
    mockOf(api.services.gitPoll.set).mockResolvedValue(off);
    renderWithProviders(<GitPollCard svc={repo} />);
    const toggle = await screen.findByRole('switch', { name: 'Git polling' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByLabelText('Interval')).toHaveValue('900');
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.services.gitPoll.set).toHaveBeenCalledWith(5, null));
  });

  it('shows the last check, the commit it found and the deployment it queued, with the commit cut to seven', async () => {
    mockOf(api.services.gitPoll.get).mockResolvedValue({ ...on, lastPolledAt: '2026-11-27T10:00:00Z', lastSha: 'b'.repeat(40), lastDeploymentId: 12 });
    renderWithProviders(<GitPollCard svc={repo} />);
    await screen.findByRole('switch', { name: 'Git polling' });
    const status = screen.getByText(/Last checked/).textContent!;
    expect(status).toContain('queued deployment #12');
    expect(status).toContain('bbbbbbb');
    expect(status).not.toContain('b'.repeat(8));
    expect(screen.queryByText(/The last check failed/)).toBeNull();
  });

  it('names the last failure, to retry on the next interval', async () => {
    mockOf(api.services.gitPoll.get).mockResolvedValue({ ...on, lastPolledAt: '2026-11-27T10:00:00Z', lastError: 'git ls-remote failed for https://git.example.com/acme/web.git: Authentication failed' });
    renderWithProviders(<GitPollCard svc={repo} />);
    expect(await screen.findByText('The last check failed: git ls-remote failed for https://git.example.com/acme/web.git: Authentication failed')).toHaveClass('text-rose-400');
  });

  it('is not for a service that deploys an image, or one the server says cannot poll', async () => {
    const image = renderWithProviders(<GitPollCard svc={{ id: 5, type: 'docker', image: 'nginx:latest' } as never} />);
    expect(image.container.textContent).toBe('');
    expect(api.services.gitPoll.get).not.toHaveBeenCalled();
    mockOf(api.services.gitPoll.get).mockResolvedValue({ ...off, supported: false });
    const unsupported = renderWithProviders(<GitPollCard svc={repo} />);
    await waitFor(() => expect(api.services.gitPoll.get).toHaveBeenCalledWith(5));
    expect(unsupported.container.textContent).toBe('');
  });

  it('surfaces a rejected save', async () => {
    mockOf(api.services.gitPoll.get).mockResolvedValue(off);
    mockOf(api.services.gitPoll.set).mockRejectedValue(new Error('This service has no Git repository to poll: it deploys an image.'));
    renderWithProviders(<GitPollCard svc={repo} />);
    await userEvent.click(await screen.findByRole('switch', { name: 'Git polling' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('This service has no Git repository to poll: it deploys an image.')).toBeInTheDocument();
  });
});
