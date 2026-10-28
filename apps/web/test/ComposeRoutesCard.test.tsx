import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ComposeRoutesCard } from '../src/routes/service/ComposeRoutesCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

describe('ComposeRoutesCard (G2.1)', () => {
  it('routes a domain of the stack to another service and port', async () => {
    mockOf(api.domains.list).mockResolvedValue([{ id: 12, hostname: 'admin.shop.example.com', path: '/', status: 'active' }] as never);
    mockOf(api.domains.composeRoute.get).mockResolvedValue({ domainId: 12, route: null, services: ['web', 'admin-ui'] } as never);
    mockOf(api.domains.composeRoute.set).mockResolvedValue({ domainId: 12, route: { service: 'admin-ui', port: 8080 }, services: ['web', 'admin-ui'] } as never);
    renderWithProviders(<ComposeRoutesCard svc={{ id: 5, type: 'compose', composeService: 'web' } as never} />);
    await userEvent.selectOptions(await screen.findByLabelText('Service for admin.shop.example.com'), 'admin-ui');
    await userEvent.type(screen.getByLabelText('Port for admin.shop.example.com'), '8080');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.domains.composeRoute.set).toHaveBeenCalledWith(12, { service: 'admin-ui', port: 8080 }));
  });

  it('is only for compose stacks', () => {
    const { container } = renderWithProviders(<ComposeRoutesCard svc={{ id: 6, type: 'docker' } as never} />);
    expect(container.textContent).toBe('');
  });
});
