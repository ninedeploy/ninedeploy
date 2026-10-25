import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { ServiceLifecycleCommand } from '@ninedeploy/sdk';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';
import { NodeLifecycleCard } from '../src/routes/service/NodeLifecycleCard.js';
vi.mock('../src/lib/api.js', async () => (await import('./apiMock.js')).createFakeApiModule());
const toast = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', async original => ({ ...await original<typeof import('../src/components/Toast.js')>(), useToast: () => toast }));
const command: ServiceLifecycleCommand = { id: 7, action: 'start', phase: 'readiness', busy: false, current: true, retryable: true,
  reason: 'Application readiness unconfirmed', attempts: 1, createdAt: '2026-10-25T12:00:00Z', updatedAt: '2026-10-25T12:00:00Z', nextAttemptAt: '2026-10-25T12:02:00Z' };
beforeEach(() => vi.clearAllMocks());
it('refreshes an absent retry receipt without claiming that a runtime command was queued', async () => {
  mockOf(api.services.retryLifecycle).mockResolvedValue({ ok: true, pending: true, command: null });
  renderWithProviders(<NodeLifecycleCard serviceId={1} command={command} />);
  fireEvent.click(screen.getByRole('button', { name: 'Retry runtime command' }));
  await waitFor(() => expect(api.services.retryLifecycle).toHaveBeenCalledWith(1));
  expect(toast.toast).not.toHaveBeenCalled();
});
it('does not attach a delayed retry receipt to a different service after navigation', async () => {
  let answer!: (value: unknown) => void;
  mockOf(api.services.retryLifecycle).mockReturnValue(new Promise(resolve => { answer = resolve; }) as never);
  function Fixture() {
    const [id, setId] = useState(1);
    return <><button type="button" onClick={() => setId(2)}>Other service</button><NodeLifecycleCard serviceId={id} command={{ ...command, id: id === 1 ? 7 : 9 }} /></>;
  }
  const view = renderWithProviders(<Fixture />);
  fireEvent.click(screen.getByRole('button', { name: 'Retry runtime command' }));
  await waitFor(() => expect(api.services.retryLifecycle).toHaveBeenCalledWith(1));
  fireEvent.click(screen.getByRole('button', { name: 'Other service' }));
  await act(async () => answer({ ok: true, pending: true, command }));
  expect(view.queryClient.getQueryData(['service-lifecycle', 1])).toEqual({ command });
  expect(view.queryClient.getQueryData(['service-lifecycle', 2])).toBeUndefined();
  expect(toast.toast).not.toHaveBeenCalled();
});

it.each(['completed', 'newer'] as const)('does not replace a %s cached command with a delayed retry receipt', async state => {
  let answer!: (value: unknown) => void;
  mockOf(api.services.retryLifecycle).mockReturnValue(new Promise(resolve => { answer = resolve; }) as never);
  const view = renderWithProviders(<NodeLifecycleCard serviceId={1} command={command} />);
  fireEvent.click(screen.getByRole('button', { name: 'Retry runtime command' }));
  await waitFor(() => expect(api.services.retryLifecycle).toHaveBeenCalledWith(1));
  const known = state === 'completed' ? { ...command, phase: 'completed' as const } : { ...command, id: 8, action: 'stop' as const };
  view.queryClient.setQueryData(['service-lifecycle', 1], { command: known });
  await act(async () => answer({ ok: true, pending: true, command }));
  expect(view.queryClient.getQueryData(['service-lifecycle', 1])).toEqual({ command: known });
  expect(toast.toast).not.toHaveBeenCalled();
});
it('shows pending readiness and retries the same public command', async () => {
  mockOf(api.services.retryLifecycle).mockResolvedValue({ ok: true, pending: true, command });
  renderWithProviders(<NodeLifecycleCard serviceId={1} command={command} />);
  expect(screen.getByText('Start requested')).toBeInTheDocument(); expect(screen.getByText(command.reason!)).toBeInTheDocument();
  expect(screen.queryByText('Service started')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry runtime command' }));
  await waitFor(() => expect(api.services.retryLifecycle).toHaveBeenCalledWith(1));
  await waitFor(() => expect(toast.toast).toHaveBeenCalledWith('Runtime command queued for another check', 'info'));
});
it('retains an owner-disabled retry error without claiming execution succeeded', async () => {
  mockOf(api.services.retryLifecycle).mockRejectedValue(new Error('The node owner disabled ordered lifecycle'));
  renderWithProviders(<NodeLifecycleCard serviceId={1} command={{ ...command, action: 'stop' }} />);
  expect(screen.getByText(/Stop is pending until traffic removal/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry runtime command' }));
  await waitFor(() => expect(toast.toast).toHaveBeenCalledWith('The node owner disabled ordered lifecycle', 'error'));
});
it('hides execution controls from viewers and superseded runtimes', () => {
  const view = renderWithProviders(<NodeLifecycleCard serviceId={1} command={{ ...command, retryable: false, busy: true }} />);
  expect(screen.getByText('Checking runtime state…')).toBeInTheDocument(); expect(screen.queryByRole('button')).not.toBeInTheDocument();
  view.unmount(); renderWithProviders(<NodeLifecycleCard serviceId={1} command={{ ...command, action: 'restart', current: false }} />);
  expect(screen.getByText('Runtime command superseded')).toBeInTheDocument(); expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it('removes the pending card only when a command is completed or absent', () => {
  const view = renderWithProviders(<NodeLifecycleCard serviceId={1} command={{ ...command, phase: 'completed' }} />);
  expect(screen.queryByRole('region')).not.toBeInTheDocument(); view.unmount();
  renderWithProviders(<NodeLifecycleCard serviceId={1} command={null} />); expect(screen.queryByRole('region')).not.toBeInTheDocument();
});
