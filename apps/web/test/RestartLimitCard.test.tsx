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

  it('is only for docker services', () => {
    const { container } = renderWithProviders(<RestartLimitCard svc={{ id: 6, type: 'compose' } as never} />);
    expect(container.textContent).toBe('');
  });
});
