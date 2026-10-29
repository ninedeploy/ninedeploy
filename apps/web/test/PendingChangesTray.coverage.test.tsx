import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PendingChangesTray } from '../src/routes/service/PendingChangesTray.js';
import { isServiceStaged } from '../src/lib/pendingStaging.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

vi.mock('../src/lib/auth.js', () => ({
  AuthProvider: ({ children }: { children?: unknown }) => children,
  useAuth: () => ({ user: { id: 1, email: 'me@test', name: 'Me', isOperator: true }, loading: false }),
}));

const empty = (staging: boolean) => ({ serviceId: 7, staging, changes: [], version: 'v1', updatedAt: null, updatedBy: null });

describe('PendingChangesTray — staging switch and failed apply', () => {
  beforeEach(() => {
    for (const fn of Object.values(api.services.pending)) mockOf(fn as never).mockReset();
  });

  it('turns staging on, which routes later edits of this service to the tray', async () => {
    // The server reports staging on from then on.
    mockOf(api.services.pending.get).mockResolvedValueOnce(empty(false) as never).mockResolvedValue(empty(true) as never);
    mockOf(api.services.pending.setStaging).mockResolvedValue(empty(true) as never);
    renderWithProviders(<PendingChangesTray serviceId={7} />);
    const toggle = await screen.findByRole('switch', { name: 'Stage edits before applying' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(isServiceStaged(7)).toBe(false);
    await userEvent.click(toggle);
    await waitFor(() => expect(api.services.pending.setStaging).toHaveBeenCalledWith(7, true));
    expect(await screen.findByText('Edits below collect here instead of applying at once. Review them, then apply them together.')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(isServiceStaged(7)).toBe(true));
  });

  it('shows why staging could not be turned off and keeps it on', async () => {
    mockOf(api.services.pending.get).mockResolvedValue(empty(true) as never);
    mockOf(api.services.pending.setStaging).mockRejectedValue(new Error('Staging is required on this lane'));
    renderWithProviders(<PendingChangesTray serviceId={7} />);
    const toggle = await screen.findByRole('switch', { name: 'Stage edits before applying' });
    await userEvent.click(toggle);
    expect(await screen.findByText('Staging is required on this lane')).toBeInTheDocument();
    expect(api.services.pending.setStaging).toHaveBeenCalledWith(7, false);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('reports a failed apply and reloads the tray', async () => {
    const view = { ...empty(true), changes: [{ field: 'port', current: 3000, next: 8080, masked: false, stagedByUserId: 1, stagedBy: 'Me' }] };
    mockOf(api.services.pending.get).mockResolvedValue(view as never);
    mockOf(api.services.pending.apply).mockRejectedValue(new Error('the tray changed since you reviewed it'));
    renderWithProviders(<PendingChangesTray serviceId={7} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Apply only' }));
    expect(await screen.findByText('Could not apply the changes: the tray changed since you reviewed it')).toBeInTheDocument();
    expect(api.services.pending.apply).toHaveBeenCalledWith(7, { deploy: false, includeOthers: false, version: 'v1' });
    // the failure refetches the tray so the reviewer sees its current content
    await waitFor(() => expect(mockOf(api.services.pending.get).mock.calls.length).toBeGreaterThan(1));
    expect(screen.getByText('port')).toBeInTheDocument();
  });
});
