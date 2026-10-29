import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BackupReplicasCard } from '../src/routes/database/BackupReplicasCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});
vi.mock('../src/lib/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth.js')>()),
  useAuth: () => ({ user: { id: 1, isOperator: true } }),
}));

const DESTS = [
  { id: 2, name: 'eu', bucket: 'b', endpoint: '', region: '', prefix: '', active: true, createdAt: '' },
  { id: 3, name: 'us', bucket: 'c', endpoint: '', region: '', prefix: '', active: true, createdAt: '' },
];
const VIEW = {
  databaseId: 7,
  replicas: [
    { destinationId: 2, retainCount: 7, copies: 3, lastCopyAt: null, lastError: 'S3 timeout' },
    { destinationId: 3, retainCount: 5, copies: 1, lastCopyAt: null, lastError: null },
  ],
};

describe('BackupReplicasCard editing', () => {
  beforeEach(() => {
    mockOf(api.backupDestinations.list).mockReset().mockResolvedValue(DESTS as never);
    mockOf(api.backups.replicas.get).mockReset().mockResolvedValue(VIEW as never);
    mockOf(api.backups.replicas.set).mockReset();
  });

  it('removes a replica, edits a retention and reports a refused save', async () => {
    mockOf(api.backups.replicas.set).mockRejectedValue(new Error('destination 2 is inactive'));
    renderWithProviders(<BackupReplicasCard dbId={7} />);
    expect(await screen.findByText(/S3 timeout/)).toBeInTheDocument();
    const removes = screen.getAllByRole('button', { name: 'Remove replica' });
    expect(removes).toHaveLength(2);
    await userEvent.click(removes[1]!);
    expect(screen.getAllByRole('button', { name: 'Remove replica' })).toHaveLength(1);

    const copies = screen.getByLabelText('Copies kept');
    await userEvent.clear(copies);
    await userEvent.type(copies, '0');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.clear(copies);
    await userEvent.type(copies, '30');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.backups.replicas.set).toHaveBeenCalledWith(7, [{ destinationId: 2, retainCount: 30 }]));
    expect(await screen.findByText('destination 2 is inactive')).toBeInTheDocument();
  });
});
