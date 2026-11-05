import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, renderWithProviders } from './web-utils.js';

const apiMock = vi.hoisted(() => ({
  api: {
    databases: {
      pitr: {
        get: vi.fn(),
        set: vi.fn(),
        baseBackup: vi.fn(),
        recover: vi.fn(),
        recoveries: vi.fn(),
        recovery: vi.fn(),
      },
    },
  },
}));
vi.mock('../src/lib/api.js', () => apiMock);

import { ToastProvider } from '../src/components/Toast.js';
import { localInputToIso, PitrCard } from '../src/routes/database/PitrCard.js';

const pitr = apiMock.api.databases.pitr;
const db = { id: 7, name: 'main', engine: 'postgres' } as never;
const off = {
  databaseId: 7, available: true, unavailableReason: null, enabled: false, retentionDays: 7, lastBaseBackupAt: null, lastError: null,
  baseBackupRunning: false, recoveryRunning: false, archiving: null, recoverable: [], baseBackups: [], archiveBytes: 0, segmentCount: 0,
};
const on = {
  ...off,
  enabled: true,
  lastBaseBackupAt: '2026-11-05T09:02:30.000Z',
  archiving: { failing: false, archivedCount: 12, lastArchivedAt: '2026-11-05T09:04:00.000Z', failedCount: 0, lastFailedAt: null },
  recoverable: [{ from: '2026-11-05T09:02:30.000Z', to: '2026-11-05T09:04:00.000Z' }],
  baseBackups: [{ label: 'nd-20261105T090200000Z', startedAt: '2026-11-05T09:02:00.000Z', finishedAt: '2026-11-05T09:02:30.000Z', sizeBytes: 1000 }],
  archiveBytes: 81_000,
  segmentCount: 2,
};

function renderCard(row: unknown = db) {
  return renderWithProviders(<PitrCard db={row as never} />, {
    queryClient: createQueryClient(),
    wrapper: (c) => <ToastProvider>{c}</ToastProvider>,
  });
}

beforeEach(() => {
  for (const fn of Object.values(pitr)) fn.mockReset();
  pitr.recoveries.mockResolvedValue([]);
});

describe('localInputToIso', () => {
  it('reads a datetime-local value in this browser zone', () => {
    expect(localInputToIso('2026-11-05T09:30')).toBe(new Date('2026-11-05T09:30').toISOString());
    expect(localInputToIso('2026-11-05T09:30:15')).toBe(new Date('2026-11-05T09:30:15').toISOString());
    expect(localInputToIso('')).toBeNull();
    expect(localInputToIso('2026-13-45T99:99')).toBeNull();
  });
});

describe('PitrCard', () => {
  it('renders nothing, and asks nothing, for another engine', () => {
    renderCard({ id: 8, name: 'm', engine: 'mysql' });
    expect(screen.queryByText('Point-in-time recovery')).not.toBeInTheDocument();
    expect(pitr.get).not.toHaveBeenCalled();
  });

  it('enables with a retention; refuses an out-of-range one', async () => {
    pitr.get.mockResolvedValue(off);
    pitr.set.mockResolvedValue(on);
    renderCard();
    const button = await screen.findByRole('button', { name: 'Enable point-in-time recovery' });
    fireEvent.change(screen.getByLabelText('Keep for (days)'), { target: { value: '40' } });
    expect(button).toBeDisabled();
    expect(screen.getByText('Between 1 and 35 days')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Keep for (days)'), { target: { value: '14' } });
    fireEvent.click(button);
    await waitFor(() => expect(pitr.set).toHaveBeenCalledWith(7, { enabled: true, retentionDays: 14 }));
    expect(await screen.findByText('Point-in-time recovery is on; the first base backup is running')).toBeInTheDocument();
  });

  it('shows why it is unavailable, and a load failure', async () => {
    pitr.get.mockResolvedValue({ ...off, available: false, unavailableReason: 'Point-in-time recovery is available for databases on the panel host, not yet on nodes.' });
    renderCard();
    expect(await screen.findByText(/not yet on nodes/)).toBeInTheDocument();
  });

  it('says when access is missing', async () => {
    pitr.get.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    renderCard();
    expect(await screen.findByText('Point-in-time recovery needs access to this database.')).toBeInTheDocument();
  });

  it('shows the window, archiving health, errors and recoveries, and takes a base backup', async () => {
    pitr.get.mockResolvedValue({ ...on, lastError: 'The last base backup failed; see the panel log.', archiving: { ...on.archiving, failing: true, lastFailedAt: '2026-11-05T09:05:00.000Z' } });
    pitr.recoveries.mockResolvedValue([
      { id: 2, sourceDatabaseId: 7, databaseId: 9, targetTime: '2026-11-05T09:03:00.000Z', status: 'completed', error: null, baseBackup: 'b', recoveredTo: 't', restoreMs: 4200, startedAt: 'x', completedAt: 'y' },
      { id: 1, sourceDatabaseId: 7, databaseId: null, targetTime: null, status: 'failed', error: 'Segment X is missing.', baseBackup: null, recoveredTo: null, restoreMs: null, startedAt: 'x', completedAt: 'y' },
    ]);
    pitr.baseBackup.mockResolvedValue({ started: true });
    renderCard();
    expect(await screen.findByTestId('pitr-window')).toBeInTheDocument();
    expect(screen.getByText('The last base backup failed; see the panel log.')).toBeInTheDocument();
    expect(screen.getByText(/WAL archiving is failing since/)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'database #9' })).toHaveAttribute('href', '/databases/9');
    expect(screen.getByText(/replayed in 4 s/)).toBeInTheDocument();
    expect(screen.getByText('Segment X is missing.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Take base backup' }));
    await waitFor(() => expect(pitr.baseBackup).toHaveBeenCalledWith(7));
    expect(await screen.findByText('Base backup started')).toBeInTheDocument();
  });

  it('saves a new retention and reports a failed change', async () => {
    pitr.get.mockResolvedValue(on);
    pitr.set.mockRejectedValue(new Error('A recovery is using the archive'));
    renderCard();
    fireEvent.change(await screen.findByLabelText('Keep for (days)'), { target: { value: '21' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(pitr.set).toHaveBeenCalledWith(7, { enabled: true, retentionDays: 21 }));
    expect(await screen.findByText('A recovery is using the archive')).toBeInTheDocument();
  });

  it('disables only after typing the confirmation word', async () => {
    pitr.get.mockResolvedValue(on);
    pitr.set.mockResolvedValue(off);
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    const confirm = await screen.findByRole('button', { name: 'Disable and delete the archive' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('disable'), { target: { value: 'disable' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(pitr.set).toHaveBeenCalledWith(7, { enabled: false }));
    expect(await screen.findByText('Point-in-time recovery is off; its archive was deleted')).toBeInTheDocument();
  });

  it('recovers to the latest point or to a picked time, into a new database', async () => {
    pitr.get.mockResolvedValue(on);
    pitr.recover.mockResolvedValue({ recoveryId: 3, databaseId: 10 });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Recover to a point in time…' }));
    expect(screen.getByLabelText('New database name')).toHaveValue('main-restored');
    fireEvent.click(screen.getByRole('button', { name: 'Start recovery' }));
    await waitFor(() => expect(pitr.recover).toHaveBeenCalledWith(7, { name: 'main-restored', targetTime: null }));
    expect(await screen.findByText('Recovery started; the new database appears when it finishes')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Recover to a point in time…' }));
    fireEvent.change(screen.getByLabelText('New database name'), { target: { value: 'before-the-bug' } });
    fireEvent.click(screen.getByLabelText('A point in time (your local time)'));
    const start = screen.getByRole('button', { name: 'Start recovery' });
    expect(start).toBeDisabled();
    expect(screen.getByText(/Recoverable:/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Recover to'), { target: { value: '2026-11-05T09:03:30' } });
    fireEvent.click(start);
    await waitFor(() => expect(pitr.recover).toHaveBeenLastCalledWith(7, { name: 'before-the-bug', targetTime: new Date('2026-11-05T09:03:30').toISOString() }));
  });

  it('keeps the dialog open when the recovery is refused, and closes on cancel', async () => {
    pitr.get.mockResolvedValue(on);
    pitr.recover.mockRejectedValue(new Error('Another point-in-time recovery is running on this panel.'));
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Recover to a point in time…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start recovery' }));
    expect(await screen.findByText('Another point-in-time recovery is running on this panel.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Start recovery' })).not.toBeInTheDocument());
  });

  it('reports a base backup that could not start', async () => {
    pitr.get.mockResolvedValue(on);
    pitr.baseBackup.mockRejectedValue(new Error('A base backup of this database is already running.'));
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Take base backup' }));
    expect(await screen.findByText('A base backup of this database is already running.')).toBeInTheDocument();
  });

  it('offers no recovery while nothing is recoverable', async () => {
    pitr.get.mockResolvedValue({ ...on, recoverable: [], lastBaseBackupAt: null, baseBackupRunning: true });
    renderCard();
    expect(await screen.findByText('Nothing yet: the first base backup has not finished.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recover to a point in time…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Take base backup' })).toBeDisabled();
    expect(screen.getByText('Running…')).toBeInTheDocument();
  });
});
