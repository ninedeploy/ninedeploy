import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommitStatusCard } from '../src/routes/service/CommitStatusCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const svc = { id: 5, slug: 'api', type: 'docker' } as never;

describe('CommitStatusCard', () => {
  it('stays hidden for a service whose source cannot report', async () => {
    mockOf(api.services.commitStatus.get).mockReset().mockResolvedValue({ enabled: false, provider: null, unavailable: 'no source' } as never);
    const { container } = renderWithProviders(<CommitStatusCard svc={svc} />);
    await waitFor(() => expect(api.services.commitStatus.get).toHaveBeenCalledWith(5));
    expect(container.textContent).toBe('');
  });

  it('turns GitLab commit statuses on', async () => {
    mockOf(api.services.commitStatus.get).mockReset().mockResolvedValue({ enabled: false, provider: 'gitlab', unavailable: null } as never);
    mockOf(api.services.commitStatus.set).mockReset().mockResolvedValue({ enabled: true, provider: 'gitlab', unavailable: null } as never);
    renderWithProviders(<CommitStatusCard svc={svc} />);
    expect(await screen.findByText('Commit statuses on GitLab')).toBeTruthy();
    await userEvent.click(screen.getByRole('switch', { name: 'Commit statuses on GitLab' }));
    await waitFor(() => expect(api.services.commitStatus.set).toHaveBeenCalledWith(5, true));
    expect(await screen.findByText('Commit statuses on')).toBeTruthy();
  });

  it('cannot be turned on while the service cannot report, and says why', async () => {
    mockOf(api.services.commitStatus.get).mockReset().mockResolvedValue({ enabled: false, provider: 'bitbucket', unavailable: 'Bitbucket statuses are for bitbucket.org repositories' } as never);
    renderWithProviders(<CommitStatusCard svc={svc} />);
    expect(await screen.findByText('Bitbucket statuses are for bitbucket.org repositories')).toBeTruthy();
    expect((screen.getByRole('switch', { name: 'Commit statuses on Bitbucket' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
