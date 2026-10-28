import { describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NineDeployClient } from '@ninedeploy/sdk';
import { PendingChangesTray } from '../src/routes/service/PendingChangesTray.js';
import { installStaging, isServiceStaged, setServiceStaging } from '../src/lib/pendingStaging.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

describe('installStaging (G5.2)', () => {
  it('routes a staged service’s update to the tray and answers with the unchanged service', async () => {
    const update = vi.fn(async () => ({ id: 1, applied: true }));
    const fake = {
      services: { update, get: vi.fn(async () => ({ id: 1, applied: false })), pending: { stage: vi.fn(async () => ({})) } },
    } as unknown as NineDeployClient;
    installStaging(fake);
    expect(await fake.services.update(1, { port: 1 })).toEqual({ id: 1, applied: true });
    setServiceStaging(1, true);
    expect(isServiceStaged(1)).toBe(true);
    expect(await fake.services.update(1, { port: 2 })).toEqual({ id: 1, applied: false });
    expect(fake.services.pending.stage).toHaveBeenCalledWith(1, { port: 2 });
    expect(update).toHaveBeenCalledTimes(1);
    setServiceStaging(1, false);
  });
});

vi.mock('../src/lib/auth.js', () => ({
  AuthProvider: ({ children }: { children?: unknown }) => children,
  useAuth: () => ({ user: { id: 1, email: 'me@test', name: 'Me', isOperator: true }, loading: false }),
}));

const change = (field: string, stagedByUserId: number, stagedBy: string) => ({ field, current: 3000, next: 8080, masked: false, stagedByUserId, stagedBy });

describe('PendingChangesTray (G5.2)', () => {
  it('lists changes with their stager and applies them with a deploy', async () => {
    mockOf(api.services.pending.get).mockResolvedValue({ serviceId: 5, staging: true, changes: [change('port', 1, 'Me')], updatedAt: '2026-10-28T10:00:00.000Z', updatedBy: null } as never);
    mockOf(api.services.pending.apply).mockResolvedValue({ applied: ['port'], deploymentId: 9 } as never);
    renderWithProviders(<PendingChangesTray serviceId={5} />);
    expect(await screen.findByText('port')).toBeInTheDocument();
    expect(screen.getByText('8080')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Apply and deploy' }));
    await waitFor(() => expect(api.services.pending.apply).toHaveBeenCalledWith(5, { deploy: true, includeOthers: false, version: '2026-10-28T10:00:00.000Z' }));
  });

  it('needs an explicit review before applying changes someone else staged', async () => {
    mockOf(api.services.pending.apply).mockReset();
    mockOf(api.services.pending.get).mockResolvedValue({ serviceId: 5, staging: true, changes: [change('runtimeOptions', 99, 'Mallory')], updatedAt: '2026-10-28T10:00:00.000Z', updatedBy: null } as never);
    mockOf(api.services.pending.apply).mockResolvedValue({ applied: ['runtimeOptions'], deploymentId: null } as never);
    renderWithProviders(<PendingChangesTray serviceId={5} />);
    expect(await screen.findByText('Mallory')).toBeInTheDocument();
    const apply = screen.getByRole('button', { name: 'Apply only' });
    expect(apply).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(apply);
    await waitFor(() => expect(api.services.pending.apply).toHaveBeenCalledWith(5, { deploy: false, includeOthers: true, version: '2026-10-28T10:00:00.000Z' }));
  });

  it.each(['2026-10-28T10:01:00.000Z', '2026-10-28T10:00:00.000Z'])('requires review again if staged content changes (version %s)', async updatedAt => {
    mockOf(api.services.pending.apply).mockReset();
    const first = { serviceId: 5, staging: true, changes: [change('port', 99, 'Mallory')], updatedAt: '2026-10-28T10:00:00.000Z', updatedBy: null };
    mockOf(api.services.pending.get).mockResolvedValue(first as never);
    const { queryClient } = renderWithProviders(<PendingChangesTray serviceId={5} />);
    await screen.findByText('Mallory');
    await userEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Apply only' })).toBeEnabled();

    act(() => queryClient.setQueryData(['pending', 5], {
      ...first, changes: [change('runtimeOptions', 99, 'Mallory')], updatedAt,
    }));
    expect(await screen.findByText('runtimeOptions')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Apply only' })).toBeDisabled();
    expect(api.services.pending.apply).not.toHaveBeenCalled();
  });

  it('keeps pending changes after a failed discard and clears them after a successful retry', async () => {
    const view = { serviceId: 5, staging: true, changes: [change('port', 1, 'Me')], updatedAt: '2026-10-28T10:00:00.000Z', updatedBy: null };
    mockOf(api.services.pending.get).mockResolvedValue(view as never);
    mockOf(api.services.pending.discard).mockReset().mockRejectedValueOnce(new Error('discard denied')).mockResolvedValueOnce({ ...view, changes: [], updatedAt: null } as never);
    renderWithProviders(<PendingChangesTray serviceId={5} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(await screen.findByText('discard denied')).toBeInTheDocument();
    expect(screen.getByText('port')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByText('port')).not.toBeInTheDocument());
    expect(screen.getByText('Pending changes discarded')).toBeInTheDocument();
  });

  it('shows the complete reviewed value and masks sensitive fields', async () => {
    const longValue = `prefix-${'x'.repeat(500)}-suffix`;
    mockOf(api.services.pending.get).mockResolvedValue({ serviceId: 5, staging: true, updatedAt: '2026-10-28T10:00:00.000Z', updatedBy: null,
      changes: [{ ...change('command', 1, 'Me'), current: null, next: longValue },
        { ...change('secret', 1, 'Me'), masked: true, current: 'old-secret', next: 'new-secret' }] } as never);
    renderWithProviders(<PendingChangesTray serviceId={5} />);
    expect(await screen.findByText(longValue)).toBeInTheDocument();
    expect(screen.getAllByText('hidden')).toHaveLength(2);
    expect(screen.queryByText('old-secret')).not.toBeInTheDocument();
    expect(screen.queryByText('new-secret')).not.toBeInTheDocument();
  });
});
