import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MaintenanceCard } from '../src/routes/service/MaintenanceCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

describe('MaintenanceCard (G2.2)', () => {
  it('turns maintenance on with the bypass list', async () => {
    mockOf(api.services.maintenance.set).mockResolvedValue({ maintenance: { title: 'Down for maintenance', message: '', retryAfterSeconds: 300, bypass: ['203.0.113.7'] }, since: '2026-10-28T10:00:00.000Z' } as never);
    renderWithProviders(<MaintenanceCard svc={{ id: 5, type: 'docker', serverId: null } as never} />);
    await userEvent.type(await screen.findByLabelText('Bypass addresses'), '203.0.113.7');
    await userEvent.click(screen.getByRole('switch', { name: 'Maintenance mode' }));
    await waitFor(() =>
      expect(api.services.maintenance.set).toHaveBeenCalledWith(5, { title: 'Down for maintenance', message: 'We will be back shortly.', bypass: ['203.0.113.7'] }),
    );
  });

  it('saves a custom 502 page', async () => {
    mockOf(api.services.errorPages.set).mockResolvedValue({ pages: { '502': '<h1>x</h1>' } } as never);
    renderWithProviders(<MaintenanceCard svc={{ id: 5, type: 'docker', serverId: null } as never} />);
    await userEvent.type(await screen.findByLabelText('HTML for 502'), '<h1>x</h1>');
    await userEvent.click(screen.getByRole('button', { name: 'Save error pages' }));
    await waitFor(() => expect(api.services.errorPages.set).toHaveBeenCalledWith(5, { '502': '<h1>x</h1>' }));
  });

  it('is hidden for a service on a node', () => {
    const { container } = renderWithProviders(<MaintenanceCard svc={{ id: 6, type: 'docker', serverId: 2 } as never} />);
    expect(container.textContent).toBe('');
  });
});
