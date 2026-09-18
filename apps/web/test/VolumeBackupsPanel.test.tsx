import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { VolumeBackupsPanel } from '../src/components/VolumeBackupsPanel.js';
import { api, getToken } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const backup = (over: Record<string, unknown> = {}) => ({
  id: 1,
  databaseId: null,
  scope: 'volume',
  status: 'completed',
  sizeBytes: 1536,
  hasRemoteCopy: false,
  createdAt: '2026-02-03T04:05:06.000Z',
  ...over,
});

describe('VolumeBackupsPanel', () => {
  it('shows the empty state and triggers a manual backup', async () => {
    mockOf(api.volumeBackups.list).mockResolvedValue([] as never);
    mockOf(api.volumeBackups.create).mockResolvedValue(backup() as never);
    renderWithProviders(<VolumeBackupsPanel volumeName="nd-svc-web-data" />);

    expect(await screen.findByText('No backups yet')).toBeInTheDocument();
    expect(screen.getByText('Volume Backups (0)')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('trigger-backup-button'));
    await waitFor(() =>
      expect(api.volumeBackups.create).toHaveBeenCalledWith('nd-svc-web-data', { label: 'manual' }),
    );
  });

  it('names snapshots with an optional label and shows the name on the row', async () => {
    mockOf(api.volumeBackups.list).mockResolvedValue([
      backup({ id: 9, label: 'pre-upgrade' }),
    ] as never);
    mockOf(api.volumeBackups.create).mockResolvedValue(backup({ id: 10, label: 'pre-upgrade' }) as never);
    renderWithProviders(<VolumeBackupsPanel volumeName="nd-svc-web-data" />);

    // Existing rows display their snapshot name instead of only a timestamp.
    await screen.findByTestId('backup-row-9');
    expect(screen.getByText('pre-upgrade')).toBeInTheDocument();

    // Typing a label names THIS snapshot; empty input stays "manual".
    const input = screen.getByLabelText('Snapshot label') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'pre-deploy' } });
    fireEvent.click(screen.getByTestId('trigger-backup-button'));
    await waitFor(() =>
      expect(api.volumeBackups.create).toHaveBeenCalledWith('nd-svc-web-data', { label: 'pre-deploy' }),
    );
    expect(input.value).toBe('');
  });

  it('surfaces a failed manual backup', async () => {
    mockOf(api.volumeBackups.list).mockResolvedValue([] as never);
    mockOf(api.volumeBackups.create).mockRejectedValue(new Error('no space left') as never);
    renderWithProviders(<VolumeBackupsPanel volumeName="nd-svc-web-data" />);

    await screen.findByText('No backups yet');
    fireEvent.click(screen.getByTestId('trigger-backup-button'));
    expect(await screen.findByText(/Backup failed: no space left/)).toBeInTheDocument();
  });

  it('renders each backup with its size, status and download link', async () => {
    mockOf(api.volumeBackups.list).mockResolvedValue([
      backup({ id: 1, status: 'completed', hasRemoteCopy: true }),
      backup({ id: 2, status: 'failed', sizeBytes: 0 }),
      // An unknown status falls back to the neutral badge styling.
      backup({ id: 3, status: 'archived' }),
    ] as never);
    renderWithProviders(<VolumeBackupsPanel volumeName="nd-svc-web-data" />);

    expect(await screen.findByTestId('backup-row-1')).toBeInTheDocument();
    expect(screen.getByText('Volume Backups (3)')).toBeInTheDocument();
    expect(screen.getAllByText('2026-02-03 04:05')).toHaveLength(3);
    expect(screen.getByText('Off-site')).toBeInTheDocument();
    expect(screen.getByText('archived')).toBeInTheDocument();
  });

  it('r202: downloads with the session bearer instead of a bare link', async () => {
    mockOf(api.volumeBackups.list).mockResolvedValue([backup({ id: 2 })] as never);
    vi.stubGlobal('fetch', vi.fn());
    URL.createObjectURL = vi.fn(() => 'blob:vol');
    URL.revokeObjectURL = vi.fn();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['tar']) } as Response);
    renderWithProviders(<VolumeBackupsPanel volumeName="nd-svc-web-data" />);
    fireEvent.click(await screen.findByTestId('download-backup-2'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/v1/volumes/nd-svc-web-data/backups/2/download');
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(`Bearer ${getToken()}`);
    expect(URL.createObjectURL).toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce({ ok: false } as Response);
    fireEvent.click(screen.getByTestId('download-backup-2'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('requires a confirmation before restoring, and lets it be cancelled', async () => {
    mockOf(api.volumeBackups.list).mockResolvedValue([backup({ id: 4 })] as never);
    mockOf(api.volumeBackups.restore).mockResolvedValue({ ok: true } as never);
    renderWithProviders(<VolumeBackupsPanel volumeName="nd-svc-web-data" />);

    fireEvent.click(await screen.findByTestId('restore-button-4'));
    // Cancelling puts the row back without touching the volume.
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(api.volumeBackups.restore).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('restore-button-4'));
    fireEvent.click(screen.getByTestId('confirm-restore-4'));
    await waitFor(() => expect(api.volumeBackups.restore).toHaveBeenCalledWith('nd-svc-web-data', 4));
  });

  it('shows the loading placeholder while the list is in flight', async () => {
    let release!: (v: unknown) => void;
    mockOf(api.volumeBackups.list).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }) as never,
    );
    renderWithProviders(<VolumeBackupsPanel volumeName="nd-svc-web-data" />);

    expect(await screen.findByText('Loading backups…')).toBeInTheDocument();
    release([]);
    expect(await screen.findByText('No backups yet')).toBeInTheDocument();
  });
});
