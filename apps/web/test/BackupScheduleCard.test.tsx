import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from './web-utils.js';

const apiMock = vi.hoisted(() => ({
  api: {
    backups: { getPolicy: vi.fn(), setPolicy: vi.fn() },
    backupDestinations: { list: vi.fn() },
  },
}));
vi.mock('../src/lib/api.js', () => apiMock);

const authMock = vi.hoisted(() => ({ user: { id: 1, isOperator: false } as { id: number; isOperator: boolean } }));
vi.mock('../src/lib/auth.js', () => ({
  AuthProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useAuth: vi.fn(() => ({ user: authMock.user, loading: false })),
}));

import { ToastProvider } from '../src/components/Toast.js';
import { BackupScheduleCard } from '../src/routes/database/BackupScheduleCard.js';

const builtIn = {
  databaseId: 7, configured: false, enabled: true, cron: null, retainCount: 7,
  retainRemoteCount: null, destinationId: null, localOnly: false, nextRunAt: null, updatedAt: null,
};

function renderCard() {
  return renderWithProviders(<BackupScheduleCard dbId={7} />, { wrapper: (c) => <ToastProvider>{c}</ToastProvider> });
}

describe('BackupScheduleCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.user = { id: 1, isOperator: false };
    apiMock.api.backups.getPolicy.mockResolvedValue(builtIn);
    apiMock.api.backups.setPolicy.mockImplementation(async (_id: number, input: Record<string, unknown>) => ({
      ...builtIn, ...input, configured: true, nextRunAt: '2026-10-08T06:00:00.000Z',
    }));
    apiMock.api.backupDestinations.list.mockResolvedValue([{ id: 3, name: 'R2', bucket: 'nd-backups' }]);
  });

  it('shows the built-in schedule for a database without a policy', async () => {
    renderCard();
    expect(await screen.findByTestId('backup-schedule-status')).toHaveTextContent('Built-in: daily, 7 kept');
    expect(apiMock.api.backups.getPolicy).toHaveBeenCalledWith(7);
    // Members never call the operator-only destination list.
    expect(apiMock.api.backupDestinations.list).not.toHaveBeenCalled();
  });

  it('saves a preset schedule with the retention count', async () => {
    renderCard();
    const schedule = await screen.findByLabelText('Schedule');
    fireEvent.change(schedule, { target: { value: '6h' } });
    fireEvent.change(screen.getByLabelText('Keep (local)'), { target: { value: '14' } });
    fireEvent.click(screen.getByRole('button', { name: /Save schedule/ }));
    await waitFor(() =>
      expect(apiMock.api.backups.setPolicy).toHaveBeenCalledWith(7, {
        enabled: true, cron: '0 */6 * * *', retainCount: 14, retainRemoteCount: null, destinationId: null, localOnly: false,
      }),
    );
    await waitFor(() => expect(screen.getByTestId('backup-schedule-status')).toHaveTextContent('Next run'));
  });

  it('validates a custom cron and the retention bounds before saving', async () => {
    renderCard();
    fireEvent.change(await screen.findByLabelText('Schedule'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '* * * * * *' } });
    expect(screen.getByText(/Expected 5 fields/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save schedule/ })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '30 2 * * 1-5' } });
    fireEvent.change(screen.getByLabelText('Keep (local)'), { target: { value: '0' } });
    expect(screen.getByRole('button', { name: /Save schedule/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Keep (local)'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'local' } });
    // Remote retention means nothing for a local-only policy.
    expect(screen.queryByLabelText('Keep (remote)')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Save schedule/ }));
    await waitFor(() =>
      expect(apiMock.api.backups.setPolicy).toHaveBeenCalledWith(7, expect.objectContaining({
        cron: '30 2 * * 1-5', retainCount: 30, localOnly: true, destinationId: null, retainRemoteCount: null,
      })),
    );
  });

  it('operators pick a specific destination and a remote retention count', async () => {
    authMock.user = { id: 1, isOperator: true };
    renderCard();
    await screen.findByRole('option', { name: 'R2 (nd-backups)' });
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'dest-3' } });
    fireEvent.change(screen.getByLabelText('Keep (remote)'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: /Save schedule/ }));
    await waitFor(() =>
      expect(apiMock.api.backups.setPolicy).toHaveBeenCalledWith(7, expect.objectContaining({ destinationId: 3, retainRemoteCount: 60, localOnly: false })),
    );
  });

  it('loads a saved custom policy into the form and keeps an operator-chosen destination for a member', async () => {
    apiMock.api.backups.getPolicy.mockResolvedValue({
      ...builtIn, configured: true, enabled: false, cron: '15 4 * * 1', retainCount: 21, destinationId: 9,
    });
    renderCard();
    expect(await screen.findByTestId('backup-schedule-status')).toHaveTextContent('Scheduled backups off');
    expect(screen.getByLabelText('Cron expression')).toHaveValue('15 4 * * 1');
    expect(screen.getByLabelText('Destination')).toHaveValue('dest-9');
    expect(screen.getByRole('option', { name: /Destination #9/ })).toBeInTheDocument();
  });

  it('reports a server refusal', async () => {
    apiMock.api.backups.setPolicy.mockRejectedValue(new Error('Choosing a specific backup destination requires instance operator access'));
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /Save schedule/ }));
    expect(await screen.findByText(/requires instance operator access/)).toBeInTheDocument();
  });

  it('shows an error when the policy cannot be read', async () => {
    apiMock.api.backups.getPolicy.mockRejectedValue(new Error('boom'));
    renderCard();
    expect(await screen.findByText('Could not load the backup schedule.')).toBeInTheDocument();
  });
});
