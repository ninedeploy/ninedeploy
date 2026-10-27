import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const authMock = vi.hoisted(() => ({ user: { id: 1, isOperator: true } as { id: number; isOperator: boolean } }));
vi.mock('../src/lib/auth.js', () => ({
  AuthProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useAuth: vi.fn(() => ({ user: authMock.user, loading: false })),
}));

import { ToastProvider } from '../src/components/Toast.js';
import { PgbouncerCard } from '../src/routes/database/PgbouncerCard.js';

const off = { enabled: false, containerName: null, port: 6432, running: false, poolMode: null, pooledConnectionString: null };
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

function renderCard() {
  return renderWithProviders(<PgbouncerCard db={db} />, {
    queryClient: createQueryClient(),
    wrapper: (c) => <ToastProvider>{c}</ToastProvider>,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.user = { id: 1, isOperator: true };
});

// G1.5: the first web control for the G-32 PgBouncer routes.
describe('PgbouncerCard', () => {
  it('enables the sidecar with the default port, then shows the pooled URL', async () => {
    databases.pgbouncerStatus.mockResolvedValueOnce(off).mockResolvedValue(on);
    databases.enablePgbouncer.mockResolvedValue(on);
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Enable PgBouncer' }));
    await waitFor(() => expect(databases.enablePgbouncer).toHaveBeenCalledWith(7, {}));
    expect(await screen.findByTestId('pgbouncer-url')).toHaveTextContent('postgres://nine:secret@nd-pgbouncer-7:6432/app');
    expect(screen.getByText('transaction')).toBeInTheDocument();
    expect(await screen.findByText('PgBouncer enabled')).toBeInTheDocument();
  });

  it('sends a custom port and refuses one out of range', async () => {
    databases.pgbouncerStatus.mockResolvedValue(off);
    databases.enablePgbouncer.mockResolvedValue({ ...on, port: 7432 });
    renderCard();
    const field = await screen.findByPlaceholderText('6432');
    fireEvent.change(field, { target: { value: '80' } });
    expect(screen.getByText('A port between 1024 and 65535')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable PgBouncer' })).toBeDisabled();
    fireEvent.change(field, { target: { value: '7432' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enable PgBouncer' }));
    await waitFor(() => expect(databases.enablePgbouncer).toHaveBeenCalledWith(7, { port: 7432 }));
  });

  it('disables after a confirmation', async () => {
    databases.pgbouncerStatus.mockResolvedValueOnce(on).mockResolvedValue(off);
    databases.disablePgbouncer.mockResolvedValue(off);
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Disable PgBouncer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(databases.disablePgbouncer).toHaveBeenCalledWith(7));
    expect(await screen.findByRole('button', { name: 'Enable PgBouncer' })).toBeInTheDocument();
  });

  it('says so when the sidecar is enabled but not running', async () => {
    databases.pgbouncerStatus.mockResolvedValue({ ...on, running: false, pooledConnectionString: null });
    renderCard();
    expect(await screen.findByText(/enabled but not running/)).toBeInTheDocument();
    expect(screen.getByText('error')).toBeInTheDocument();
  });

  it('reports a failed enable', async () => {
    databases.pgbouncerStatus.mockResolvedValue(off);
    databases.enablePgbouncer.mockRejectedValue(new Error('Admin access required'));
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Enable PgBouncer' }));
    expect(await screen.findByText('Admin access required')).toBeInTheDocument();
  });

  it('shows the state but no controls to a non-operator', async () => {
    authMock.user = { id: 2, isOperator: false };
    databases.pgbouncerStatus.mockResolvedValueOnce(off);
    const { unmount } = renderCard();
    expect(await screen.findByText(/Only an instance operator can turn it on/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable PgBouncer' })).toBeNull();
    unmount();
    databases.pgbouncerStatus.mockResolvedValue(on);
    renderCard();
    expect(await screen.findByTestId('pgbouncer-url')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disable PgBouncer' })).toBeNull();
  });

  it('explains a 403 on the status read', async () => {
    databases.pgbouncerStatus.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    renderCard();
    expect(await screen.findByText('PgBouncer settings need access to this database.')).toBeInTheDocument();
  });
});
