import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';
import { PrimaryRecoveryCard } from '../src/routes/service/PrimaryRecoveryCard.js';
const auth = vi.hoisted(() => ({ operator: true }));
vi.mock('../src/lib/api.js', async () => (await import('./apiMock.js')).createFakeApiModule());
vi.mock('../src/lib/auth.js', async original => ({ ...await original<typeof import('../src/lib/auth.js')>(), useAuth: () => ({ user: { id: 1, isOperator: auth.operator }, loading: false }) }));
const entry = { id: 1, serverId: null, desiredRuntimeId: 'web-9', interrupted: true, deploymentId: 9, phase: 'retained', previousRuntimeId: 'web-t5-8', candidateRuntimeId: 'web-t5-9', reason: 'Node routing could not be confirmed', busy: false, attempts: 2, nextAttemptAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-22T23:00:00Z' };
beforeEach(() => { vi.clearAllMocks(); auth.operator = true; mockOf(api.services.retryRuntimeRecovery).mockReset(); mockOf(api.services.runtimeRecovery).mockReset().mockResolvedValue(entry as never); });
it('renders a readable pending reason and lets an operator retry the actual recovery API', async () => {
  mockOf(api.services.retryRuntimeRecovery).mockResolvedValue({ recovered: 1, held: 0, entry: null });
  renderWithProviders(<PrimaryRecoveryCard serviceId={1} />);
  expect(await screen.findByText(entry.reason)).toBeInTheDocument();
  expect(screen.getByText('Recovery pending')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry recovery' }));
  await waitFor(() => expect(api.services.retryRuntimeRecovery).toHaveBeenCalledWith(1));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Primary runtime recovery' })).not.toBeInTheDocument());
});
it('keeps a live deployment protected and hides retry controls from non-operators', async () => {
  mockOf(api.services.runtimeRecovery).mockResolvedValue({ ...entry, busy: true } as never);
  const view = renderWithProviders(<PrimaryRecoveryCard serviceId={1} />);
  expect(await screen.findByRole('button', { name: 'Retry recovery' })).toBeDisabled(); view.unmount();
  auth.operator = false; renderWithProviders(<PrimaryRecoveryCard serviceId={1} />);
  expect(await screen.findByText('Deployment or recovery in progress')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry recovery' })).not.toBeInTheDocument();
});
it('shows a retryable fetch error instead of claiming there is no pending recovery', async () => {
  mockOf(api.services.runtimeRecovery).mockRejectedValue(new Error('HTTP 502'));
  renderWithProviders(<PrimaryRecoveryCard serviceId={1} />);
  expect(await screen.findByText('Could not load primary runtime recovery')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
});

it('keeps both runtimes visible when a retry cannot contact the node', async () => {
  mockOf(api.services.retryRuntimeRecovery).mockRejectedValue(new Error('node offline'));
  renderWithProviders(<PrimaryRecoveryCard serviceId={1} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry recovery' }));
  expect(await screen.findByText('Recovery could not be checked; retained runtimes remain protected')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Retained runtimes'));
  expect(screen.getByText('web-t5-8')).toBeInTheDocument();
  expect(screen.getByText('web-t5-9')).toBeInTheDocument();
  expect(screen.getByText(entry.reason)).toBeInTheDocument();
});

it('shows an updated hold reason when a retry has not completed', async () => {
  mockOf(api.services.retryRuntimeRecovery).mockResolvedValue({ recovered: 0, held: 1, entry: { ...entry, reason: 'Waiting for readiness' } } as never);
  renderWithProviders(<PrimaryRecoveryCard serviceId={1} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry recovery' }));
  expect(await screen.findByText('Waiting for readiness')).toBeInTheDocument();
  expect(screen.getByText('Recovery is still pending — see the reason below')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Primary runtime recovery' })).toBeInTheDocument();
});
