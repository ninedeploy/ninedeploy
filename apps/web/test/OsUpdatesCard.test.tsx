import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OsUpdatesCard } from '../src/components/OsUpdatesCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const status = (over: Record<string, unknown> = {}) => ({
  os: { id: 'ubuntu', version: '24.04', name: 'Ubuntu 24.04.5 LTS' },
  packageManager: 'apt',
  updates: [
    { name: 'tzdata', version: '2026b', from: '2026a', security: false },
    { name: 'openssl', version: '3.0.15', from: '3.0.14', security: true },
  ],
  updatesTruncated: false,
  securityCount: 1,
  autoUpdates: { installed: false, enabled: false },
  rebootRequired: true,
  rebootPackages: ['linux-image-6.8.0-90-generic'],
  warnings: [],
  checkedAt: '2026-10-28T09:00:00Z',
  ...over,
});

describe('OsUpdatesCard (G4.2)', () => {
  beforeEach(() => {
    mockOf(api.osUpdates.get).mockReset();
    mockOf(api.osUpdates.setAuto).mockReset();
  });

  it('reads nothing until asked, then lists security updates first and the pending reboot', async () => {
    mockOf(api.osUpdates.get).mockResolvedValue(status() as never);
    renderWithProviders(<OsUpdatesCard serverId={7} />);
    expect(api.osUpdates.get).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Check updates' }));
    expect(await screen.findByText('2 pending updates, 1 of them security updates')).toBeInTheDocument();
    expect(api.osUpdates.get).toHaveBeenCalledWith(7);
    expect(screen.getByText('Reboot required')).toBeInTheDocument();
    expect(screen.getByText(/linux-image-6\.8\.0-90-generic/)).toBeInTheDocument();
    expect(screen.getByText(/NineDeploy never reboots the host/)).toBeInTheDocument();
    const names = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(names[0]).toContain('openssl');
  });

  it('turns automatic security updates on and refreshes the package lists', async () => {
    mockOf(api.osUpdates.get).mockImplementation(async (_id, opts) => status(opts?.refresh ? { securityCount: 0, updates: [] } : {}) as never);
    mockOf(api.osUpdates.setAuto).mockResolvedValue(status({ autoUpdates: { installed: true, enabled: true } }) as never);
    renderWithProviders(<OsUpdatesCard serverId={null} />);
    await userEvent.click(screen.getByRole('button', { name: 'Check updates' }));
    const toggle = await screen.findByRole('switch', { name: 'Install security updates automatically' });
    await userEvent.click(toggle);
    await waitFor(() => expect(api.osUpdates.setAuto).toHaveBeenCalledWith(null, true));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Install security updates automatically' }).getAttribute('aria-checked')).toBe('true'));
    await userEvent.click(screen.getByRole('button', { name: /Refresh package lists/ }));
    await waitFor(() => expect(api.osUpdates.get).toHaveBeenCalledWith(null, { refresh: true }));
    expect(await screen.findByText('No pending updates.')).toBeInTheDocument();
  });

  it('says when a host cannot be managed, and shows a read failure', async () => {
    mockOf(api.osUpdates.get).mockResolvedValueOnce(status({ packageManager: 'unsupported', updates: [], securityCount: 0, rebootRequired: null }) as never);
    const { unmount } = renderWithProviders(<OsUpdatesCard serverId={1} />);
    await userEvent.click(screen.getByRole('button', { name: 'Check updates' }));
    expect(await screen.findByText(/neither apt nor dnf/)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    unmount();

    mockOf(api.osUpdates.get).mockRejectedValueOnce(new Error('node_agent_outdated'));
    renderWithProviders(<OsUpdatesCard serverId={2} />);
    await userEvent.click(screen.getByRole('button', { name: 'Check updates' }));
    expect(await screen.findByText(/Could not read the host: node_agent_outdated/)).toBeInTheDocument();
  });

  it('reports failed changes and refreshes without showing an unconfirmed state', async () => {
    mockOf(api.osUpdates.get).mockImplementation(async (_id, opts) => {
      if (opts?.refresh) throw new Error('refresh denied');
      return status() as never;
    });
    mockOf(api.osUpdates.setAuto).mockRejectedValue(new Error('policy denied'));
    renderWithProviders(<OsUpdatesCard serverId={7} />);
    await userEvent.click(screen.getByRole('button', { name: 'Check updates' }));
    const toggle = await screen.findByRole('switch', { name: 'Install security updates automatically' });
    await userEvent.click(toggle);
    expect(await screen.findByText('Could not change automatic updates: policy denied')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh package lists' }));
    expect(await screen.findByText('Could not refresh the package lists: refresh denied')).toBeInTheDocument();
    expect(screen.getByText('2 pending updates, 1 of them security updates')).toBeInTheDocument();
  });

  it('lets operators inspect a long security update list and collapse it again', async () => {
    const updates = Array.from({ length: 16 }, (_, i) => ({ name: `pkg-${String(i).padStart(2, '0')}`, version: '2', from: '1', security: i === 15 }));
    mockOf(api.osUpdates.get).mockResolvedValue(status({ updates, securityCount: 1, updatesTruncated: true, rebootRequired: null }) as never);
    renderWithProviders(<OsUpdatesCard serverId={7} />);
    await userEvent.click(screen.getByRole('button', { name: 'Check updates' }));
    expect(await screen.findByText('pkg-15')).toBeInTheDocument();
    expect(screen.getByText(/\(list cut short\)/)).toBeInTheDocument();
    expect(screen.getByText('This host cannot tell whether a reboot is pending.')).toBeInTheDocument();
    expect(screen.queryByText('pkg-14')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show all 16' }));
    expect(screen.getByText('pkg-14')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.queryByText('pkg-14')).not.toBeInTheDocument();
  });
});
