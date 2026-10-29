import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';
import { FanoutRecoveryCard } from '../src/routes/service/FanoutRecoveryCard.js';
const auth = vi.hoisted(() => ({ operator: true }));
vi.mock('../src/lib/api.js', async () => (await import('./apiMock.js')).createFakeApiModule());
vi.mock('../src/lib/auth.js', async original => ({ ...await original<typeof import('../src/lib/auth.js')>(), useAuth: () => ({ user: { id: 1, isOperator: auth.operator }, loading: false }) }));
const entry = { id: 1, serverId: 5, deploymentId: 9, phase: 'retained', previousRuntimeId: 'web-t5-8', candidateRuntimeId: 'web-t5-9', reason: 'Node routing could not be confirmed', busy: false, attempts: 2, nextAttemptAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-22T23:00:00Z' };
beforeEach(() => { vi.clearAllMocks(); auth.operator = true; mockOf(api.fanout.retryRecovery).mockReset(); mockOf(api.fanout.recovery).mockReset().mockResolvedValue([entry] as never); });
it('renders a readable pending reason and lets an operator retry the actual recovery API', async () => {
  mockOf(api.fanout.retryRecovery).mockResolvedValue({ recovered: 1, held: 0, entries: [] });
  renderWithProviders(<FanoutRecoveryCard serviceId={1} />);
  expect(await screen.findByText(entry.reason)).toBeInTheDocument();
  expect(screen.getByText('Recovery pending')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry recovery' }));
  await waitFor(() => expect(api.fanout.retryRecovery).toHaveBeenCalledWith(1));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Fan-out recovery' })).not.toBeInTheDocument());
});
it('keeps a live deployment protected and hides retry controls from non-operators', async () => {
  mockOf(api.fanout.recovery).mockResolvedValue([{ ...entry, busy: true }] as never);
  const view = renderWithProviders(<FanoutRecoveryCard serviceId={1} />);
  expect(await screen.findByRole('button', { name: 'Retry recovery' })).toBeDisabled(); view.unmount();
  auth.operator = false; renderWithProviders(<FanoutRecoveryCard serviceId={1} />);
  expect(await screen.findByText('Deployment or recovery in progress')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry recovery' })).not.toBeInTheDocument();
});
it('shows a retryable fetch error instead of claiming there is no pending recovery', async () => {
  mockOf(api.fanout.recovery).mockRejectedValue(new Error('HTTP 502'));
  renderWithProviders(<FanoutRecoveryCard serviceId={1} />);
  expect(await screen.findByText('Could not load fan-out recovery')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
});

it('keeps retained generations visible if the recovery request fails', async () => {
  mockOf(api.fanout.retryRecovery).mockRejectedValue(new Error('node offline'));
  renderWithProviders(<FanoutRecoveryCard serviceId={1} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry recovery' }));
  expect(await screen.findByText('Recovery could not be checked; retained runtimes remain protected')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Retained runtimes'));
  expect(screen.getByText('web-t5-8')).toBeInTheDocument();
  expect(screen.getByText('web-t5-9')).toBeInTheDocument();
});

it('allows retrying idle nodes while another node is busy and keeps held results visible', async () => {
  const busy = { ...entry, id: 2, serverId: 6, busy: true, reason: 'Deployment in progress' };
  mockOf(api.fanout.recovery).mockResolvedValue([entry, busy] as never);
  mockOf(api.fanout.retryRecovery).mockResolvedValue({ recovered: 0, held: 1, entries: [{ ...entry, reason: 'Waiting for readiness' }] } as never);
  renderWithProviders(<FanoutRecoveryCard serviceId={1} />);
  expect(await screen.findByText('Node #6')).toBeInTheDocument();
  const retry = screen.getByRole('button', { name: 'Retry recovery' });
  expect(retry).toBeEnabled();
  fireEvent.click(retry);
  expect(await screen.findByText('Waiting for readiness')).toBeInTheDocument();
  expect(screen.getByText('Recovery is still pending — see the reason below')).toBeInTheDocument();
});
