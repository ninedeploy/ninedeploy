import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';
import { SwarmRecoveryCard } from '../src/routes/service/SwarmRecoveryCard.js';

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});
vi.mock('../src/lib/auth.js', async (original) => ({
  ...(await original<typeof import('../src/lib/auth.js')>()),
  useAuth: () => ({ user: { id: 1, isOperator: true }, loading: false }),
}));

const entry = {
  id: 1,
  serverId: null,
  desiredRuntimeId: 'web-9',
  interrupted: true,
  deploymentId: 9,
  phase: 'routing',
  previousRuntimeId: 'web-t5-8',
  candidateRuntimeId: 'web-t5-9',
  reason: null,
  busy: false,
  attempts: 1,
  nextAttemptAt: '2026-10-23T00:00:00Z',
  updatedAt: '2026-10-22T23:00:00Z',
};

beforeEach(() => {
  mockOf(api.services.swarmRecovery).mockReset();
  mockOf(api.services.retrySwarmRecovery).mockReset();
  mockOf(api.services.swarmRecovery).mockResolvedValue(entry as never);
});

it('keeps the card and says the service stays protected when the retry fails', async () => {
  mockOf(api.services.retrySwarmRecovery).mockRejectedValue(new Error('manager unreachable'));
  renderWithProviders(<SwarmRecoveryCard serviceId={3} />);
  expect(await screen.findByText('Confirming traffic')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry recovery' }));
  await waitFor(() => expect(api.services.retrySwarmRecovery).toHaveBeenCalledWith(3));
  expect(await screen.findByText('Swarm recovery could not be confirmed; the service remains protected')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Swarm runtime recovery' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Retry recovery' })).toBeEnabled();
});

it('recovers from a failed load when the user retries', async () => {
  mockOf(api.services.swarmRecovery).mockReset();
  mockOf(api.services.swarmRecovery).mockRejectedValueOnce(new Error('HTTP 502')).mockResolvedValue(entry as never);
  renderWithProviders(<SwarmRecoveryCard serviceId={3} />);
  expect(await screen.findByText('Could not load Swarm recovery')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Confirming traffic')).toBeInTheDocument();
  expect(api.services.swarmRecovery).toHaveBeenCalledTimes(2);
  expect(api.services.swarmRecovery).toHaveBeenCalledWith(3);
});

it('reports a still-pending recovery with its new reason', async () => {
  mockOf(api.services.retrySwarmRecovery).mockResolvedValue({
    recovered: 0,
    held: 1,
    entry: { ...entry, phase: 'retained', reason: 'Tasks not ready' },
  } as never);
  renderWithProviders(<SwarmRecoveryCard serviceId={3} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry recovery' }));
  expect(await screen.findByText('Swarm recovery is still pending — see the reason below')).toBeInTheDocument();
  expect(await screen.findByText('Tasks not ready')).toBeInTheDocument();
  expect(screen.getByText('Waiting for review')).toBeInTheDocument();
});
