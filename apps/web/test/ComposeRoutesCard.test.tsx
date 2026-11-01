import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NetworkTab } from '../src/routes/service/NetworkTab.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

describe('Compose routes in Network → Domains (G2.1)', () => {
  it('routes a domain of the stack to another service and port from its own row', async () => {
    mockOf(api.domains.list).mockResolvedValue([{ id: 12, hostname: 'admin.shop.example.com', path: '/', status: 'active', ssl: true }] as never);
    mockOf(api.domains.composeRoute.get).mockResolvedValue({ domainId: 12, route: null, services: ['web', 'admin-ui'] } as never);
    mockOf(api.domains.composeRoute.set).mockResolvedValue({ domainId: 12, route: { service: 'admin-ui', port: 8080 }, services: ['web', 'admin-ui'] } as never);
    renderWithProviders(<NetworkTab serviceId={5} svc={{ id: 5, type: 'compose', composeService: 'web', port: 80 } as never} />);
    expect(await screen.findByText(/Each domain routes to the main service/)).toBeInTheDocument();
    await userEvent.selectOptions(await screen.findByLabelText('Service for admin.shop.example.com'), 'admin-ui');
    await userEvent.type(screen.getByLabelText('Port for admin.shop.example.com'), '8080');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.domains.composeRoute.set).toHaveBeenCalledWith(12, { service: 'admin-ui', port: 8080 }));
  });

  it('offers Save only once the choice differs from what is stored', async () => {
    mockOf(api.domains.list).mockResolvedValue([{ id: 13, hostname: 'shop.example.com', path: '/', status: 'active', ssl: true }] as never);
    mockOf(api.domains.composeRoute.get).mockResolvedValue({ domainId: 13, route: { service: 'web', port: 3000 }, services: ['web', 'admin-ui'] } as never);
    renderWithProviders(<NetworkTab serviceId={5} svc={{ id: 5, type: 'compose', composeService: 'web', port: 80 } as never} />);
    const select = await screen.findByLabelText('Service for shop.example.com');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    await userEvent.selectOptions(select, '');
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('is only for compose stacks', async () => {
    mockOf(api.domains.list).mockResolvedValue([{ id: 14, hostname: 'app.example.com', path: '/', status: 'active', ssl: true }] as never);
    renderWithProviders(<NetworkTab serviceId={6} svc={{ id: 6, type: 'docker', port: 3000 } as never} />);
    expect(await screen.findByText('app.example.com')).toBeInTheDocument();
    expect(screen.queryByLabelText('Service for app.example.com')).not.toBeInTheDocument();
    expect(api.domains.composeRoute.get).not.toHaveBeenCalledWith(14);
  });
});
