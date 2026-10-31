import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mock = vi.hoisted(() => ({ runtime: vi.fn(), preparations: vi.fn(), retry: vi.fn() }));
vi.mock('../src/lib/api.js', () => ({ api: { services: { runtimeRecovery: mock.runtime, nodePreparations: mock.preparations, retryRuntimeRecovery: mock.retry } } }));
vi.mock('../src/lib/auth.js', () => ({ useAuth: () => ({ user: { isOperator: true } }) }));
vi.mock('../src/components/Toast.js', () => ({ useToast: () => ({ toast: vi.fn() }) }));
import { PrimaryRecoveryCard } from '../src/routes/service/PrimaryRecoveryCard.js';

afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('shows an unresolved preparation even without a primary recovery record', async () => {
  mock.runtime.mockResolvedValue(null);
  mock.preparations.mockResolvedValue([{ deploymentId: 9, serverId: 4, phase: 'preparing', deploymentStatus: 'failed' }]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><PrimaryRecoveryCard serviceId={1} /></QueryClientProvider>);
  expect(await screen.findByRole('region', { name: 'Node deployment preparation' })).toBeTruthy();
  expect(screen.getByText(/Deployment #9 on node #4/)).toBeTruthy();
  expect(screen.getByText(/this also stops the service/i)).toBeTruthy();
  expect(mock.retry).not.toHaveBeenCalled();
});
it('keeps primary recovery visible if preparation status cannot be loaded', async () => {
  mock.runtime.mockResolvedValue({ id: 1, serverId: 4, busy: false, reason: 'Routing unconfirmed', nextAttemptAt: '2026-10-30T12:00:00Z',
    previousRuntimeId: 'web-8', candidateRuntimeId: 'web-9' });
  mock.preparations.mockRejectedValue(new Error('Unavailable'));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><PrimaryRecoveryCard serviceId={1} /></QueryClientProvider>);
  expect(await screen.findByText('Routing unconfirmed')).toBeTruthy();
  expect(await screen.findByText('Could not load node preparation status')).toBeTruthy();
});
