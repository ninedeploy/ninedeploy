import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, createQueryClient } from './web-utils.js';

const apiMock = vi.hoisted(() => ({
  api: {
    databases: {
      pgbouncerStatus: vi.fn(),
      enablePgbouncer: vi.fn(),
      disablePgbouncer: vi.fn(),
    },
  },
}));
vi.mock('../src/lib/api.js', () => apiMock);

vi.mock('../src/lib/auth.js', () => ({
  AuthProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useAuth: vi.fn(() => ({ user: { id: 1, isOperator: true }, loading: false })),
}));

import { ToastProvider } from '../src/components/Toast.js';
import { PgbouncerCard } from '../src/routes/database/PgbouncerCard.js';

const on = {
  enabled: true,
  containerName: 'nd-pgbouncer-7',
  port: 6432,
  running: true,
  poolMode: 'transaction',
  pooledConnectionString: 'postgres://nine:secret@nd-pgbouncer-7:6432/app',
};
const db = { id: 7, name: 'main', engine: 'postgres' } as never;
const { databases } = apiMock.api;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function renderCard() {
  return renderWithProviders(<PgbouncerCard db={db} />, {
    queryClient: createQueryClient(),
    wrapper: (c) => <ToastProvider>{c}</ToastProvider>,
  });
}

beforeEach(() => {
  for (const fn of Object.values(databases)) fn.mockReset();
});
afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});

describe('PgbouncerCard: copy and failed disable', () => {
  it('copies the pooled connection URL to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    databases.pgbouncerStatus.mockResolvedValue(on);
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy pooled connection URL' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(on.pooledConnectionString));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('reports a failed disable and keeps the sidecar shown', async () => {
    databases.pgbouncerStatus.mockResolvedValue(on);
    databases.disablePgbouncer.mockRejectedValue(new Error('Admin access required'));
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Disable PgBouncer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(databases.disablePgbouncer).toHaveBeenCalledWith(7));
    expect(await screen.findByText('Admin access required')).toBeInTheDocument();
    expect(screen.getByTestId('pgbouncer-url')).toBeInTheDocument();
  });

  it('falls back to a generic message when the disable error is not an Error', async () => {
    databases.pgbouncerStatus.mockResolvedValue(on);
    databases.disablePgbouncer.mockRejectedValue('boom');
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Disable PgBouncer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    expect(await screen.findByText('Could not disable PgBouncer')).toBeInTheDocument();
  });
});
