import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BackupReplicasCard } from '../src/routes/database/BackupReplicasCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});
const auth = vi.hoisted(() => ({ isOperator: true }));
vi.mock('../src/lib/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth.js')>()),
  useAuth: () => ({ user: { id: 1, isOperator: auth.isOperator } }),
}));

describe('BackupReplicasCard (G3.3)', () => {
  it('lets an operator add a replica destination with its retention', async () => {
    auth.isOperator = true;
    mockOf(api.backupDestinations.list).mockResolvedValue([{ id: 2, name: 'eu', bucket: 'b', endpoint: '', region: '', prefix: '', active: false, createdAt: '' }] as never);
    mockOf(api.backups.replicas.set).mockResolvedValue({ databaseId: 3, replicas: [{ destinationId: 2, retainCount: 7, copies: 0, lastCopyAt: null, lastError: null }] } as never);
    renderWithProviders(<BackupReplicasCard dbId={3} />);
    await userEvent.click(await screen.findByRole('button', { name: /Add replica/ }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'eu (b)' })).toBeTruthy());
    await userEvent.selectOptions(screen.getByLabelText('Destination'), '2');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.backups.replicas.set).toHaveBeenCalledWith(3, [{ destinationId: 2, retainCount: 7 }]));
  });

  it('is hidden from a non-operator when no replica is set', async () => {
    auth.isOperator = false;
    const { container } = renderWithProviders(<BackupReplicasCard dbId={3} />);
    await waitFor(() => expect(api.backups.replicas.get).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
