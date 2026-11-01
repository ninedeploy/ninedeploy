import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ComposeRouteRow } from '../src/routes/service/ComposeRoutesCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});


describe('ComposeRouteRow — free-text service and refusals', () => {
  beforeEach(() => {
    mockOf(api.domains.list).mockReset();
    mockOf(api.domains.composeRoute.get).mockReset();
    mockOf(api.domains.composeRoute.set).mockReset();
    mockOf(api.domains.list).mockResolvedValue([{ id: 12, hostname: 'admin.shop.example.com', path: '/', status: 'active' }] as never);
  });

  it('types a service name when the stack services are unknown and validates the port', async () => {
    mockOf(api.domains.composeRoute.get).mockResolvedValue({ domainId: 12, route: null, services: null } as never);
    mockOf(api.domains.composeRoute.set).mockResolvedValue({ domainId: 12, route: { service: 'worker', port: 9000 }, services: null } as never);
    renderWithProviders(<ComposeRouteRow domainId={12} hostname="admin.shop.example.com" mainService={null} />);
    const name = await screen.findByLabelText('Service for admin.shop.example.com');
    expect(name.tagName).toBe('INPUT');
    expect(name).toHaveAttribute('placeholder', 'Main service');
    await userEvent.type(name, 'worker');
    const save = screen.getByRole('button', { name: 'Save' });
    // a service without a port is not a valid route yet
    expect(save).toBeDisabled();
    const port = screen.getByLabelText('Port for admin.shop.example.com');
    await userEvent.type(port, '70000');
    expect(save).toBeDisabled();
    await userEvent.clear(port);
    await userEvent.type(port, '9000');
    await userEvent.click(save);
    await waitFor(() => expect(api.domains.composeRoute.set).toHaveBeenCalledWith(12, { service: 'worker', port: 9000 }));
    expect(await screen.findByText('admin.shop.example.com routes to worker')).toBeInTheDocument();
  });

  it('shows the refusal when resetting to the main service fails', async () => {
    mockOf(api.domains.composeRoute.get).mockResolvedValue({ domainId: 12, route: { service: 'worker', port: 9000 }, services: null } as never);
    mockOf(api.domains.composeRoute.set).mockRejectedValue(new Error('Service worker is not on the default network'));
    renderWithProviders(<ComposeRouteRow domainId={12} hostname="admin.shop.example.com" mainService={null} />);
    const name = await screen.findByLabelText('Service for admin.shop.example.com');
    await waitFor(() => expect((name as HTMLInputElement).value).toBe('worker'));
    await userEvent.clear(name);
    expect(screen.queryByLabelText('Port for admin.shop.example.com')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.domains.composeRoute.set).toHaveBeenCalledWith(12, null));
    expect(await screen.findByText('Service worker is not on the default network')).toBeInTheDocument();
  });
});
