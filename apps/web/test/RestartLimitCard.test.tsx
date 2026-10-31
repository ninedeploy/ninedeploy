import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RestartLimitCard } from '../src/routes/service/RestartLimitCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

describe('RestartLimitCard (G1.3)', () => {
  it('turns the limit on with its values', async () => {
    mockOf(api.services.restartLimit.get).mockResolvedValue({ limit: null, recentRestarts: 0, trippedAt: null } as never);
    mockOf(api.services.restartLimit.set).mockResolvedValue({ limit: { maxRestarts: 5, windowMinutes: 10 }, recentRestarts: 0, trippedAt: null } as never);
    renderWithProviders(<RestartLimitCard svc={{ id: 5, type: 'docker' } as never} />);
    await userEvent.click(await screen.findByRole('switch', { name: 'Restart-loop limit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.services.restartLimit.set).toHaveBeenCalledWith(5, { maxRestarts: 5, windowMinutes: 10 }));
  });

  it('is only for docker and PM2 services', () => {
    const { container } = renderWithProviders(<RestartLimitCard svc={{ id: 6, type: 'compose' } as never} />);
    expect(container.textContent).toBe('');
  });

  it('offers the limit on a PM2 service', async () => {
    mockOf(api.services.restartLimit.get).mockResolvedValue({ limit: null, recentRestarts: 0, trippedAt: null } as never);
    renderWithProviders(<RestartLimitCard svc={{ id: 7, type: 'pm2' } as never} />);
    expect(await screen.findByRole('switch', { name: 'Restart-loop limit' })).toBeInTheDocument();
    expect(api.services.restartLimit.get).toHaveBeenCalledWith(7);
  });

  it('rejects invalid restart thresholds and saves a valid window', async () => {
    mockOf(api.services.restartLimit.get).mockResolvedValue({ limit: null, recentRestarts: 0, trippedAt: null } as never);
    mockOf(api.services.restartLimit.set).mockResolvedValue({ limit: { maxRestarts: 3, windowMinutes: 30 }, recentRestarts: 0, trippedAt: null } as never);
    renderWithProviders(<RestartLimitCard svc={{ id: 5, type: 'docker' } as never} />);
    await userEvent.click(await screen.findByRole('switch', { name: 'Restart-loop limit' }));
    const restarts = screen.getByLabelText('Restarts');
    const minutes = screen.getByLabelText('Within (minutes)');
    await userEvent.clear(restarts);
    await userEvent.type(restarts, '1');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.clear(restarts);
    await userEvent.type(restarts, '3');
    await userEvent.clear(minutes);
    await userEvent.type(minutes, '1441');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.clear(minutes);
    await userEvent.type(minutes, '30');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.services.restartLimit.set).toHaveBeenCalledWith(5, { maxRestarts: 3, windowMinutes: 30 }));
  });

  it('surfaces a rejected attempt to disable a previously active limit', async () => {
    mockOf(api.services.restartLimit.get).mockResolvedValue({ limit: { maxRestarts: 5, windowMinutes: 10 }, recentRestarts: 2, trippedAt: null } as never);
    mockOf(api.services.restartLimit.set).mockRejectedValue(new Error('permission denied'));
    renderWithProviders(<RestartLimitCard svc={{ id: 5, type: 'docker' } as never} />);
    const toggle = await screen.findByRole('switch', { name: 'Restart-loop limit' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('permission denied')).toBeInTheDocument();
    expect(api.services.restartLimit.set).toHaveBeenCalledWith(5, null);
    expect(screen.getByText('2 restarts in the window now')).toBeInTheDocument();
  });
});
