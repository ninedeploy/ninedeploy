import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, createQueryClient } from './web-utils.js';
import { mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => (await import('./apiMock.js')).createFakeApiModule());

import { api } from '../src/lib/api.js';
import { ToastProvider } from '../src/components/Toast.js';
import { EgressIpCard } from '../src/routes/settings/EgressIpCard.js';

const render = () =>
  renderWithProviders(<EgressIpCard />, { queryClient: createQueryClient(), wrapper: (c) => <ToastProvider>{c}</ToastProvider> });

const rule = { selector: { projectId: 3, sourceCidr: '172.20.0.0/16' }, ip: '203.0.113.9', createdAt: '2026-10-27T00:00:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
  mockOf(api.projects.list).mockResolvedValue([{ id: 3, name: 'shop' }] as never);
  mockOf(api.hostIps.list).mockResolvedValue({
    detected: true,
    addresses: [
      { ip: '203.0.113.9', family: 4, iface: 'eth0', detected: true, label: 'egress', primary: false, dedicatedTo: null },
      { ip: '2001:db8::1', family: 6, iface: 'eth0', detected: true, label: null, primary: false, dedicatedTo: null },
    ],
  } as never);
});

// G1.5: the first web control for the G-15 egress routes.
describe('EgressIpCard', () => {
  it('sets an outgoing IP for a project from the host IPv4 addresses', async () => {
    mockOf(api.egress.list).mockResolvedValue({ drivers: [{ name: 'iptables', rules: [] }] });
    mockOf(api.egress.set).mockResolvedValue({ ok: true, driver: 'iptables', rule } as never);
    render();
    expect(await screen.findByText(/No project has its own outgoing IP/)).toBeInTheDocument();
    await screen.findByRole('option', { name: 'shop' });
    expect(screen.queryByRole('option', { name: /2001:db8::1/ })).toBeNull();
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Outgoing IP'), { target: { value: '203.0.113.9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set outgoing IP' }));
    await waitFor(() => expect(api.egress.set).toHaveBeenCalledWith({ projectId: 3, ip: '203.0.113.9' }));
    expect(await screen.findByText('Outgoing IP set')).toBeInTheDocument();
  });

  it('shows a refusal the route answers with ok: false', async () => {
    mockOf(api.egress.set).mockResolvedValue({ ok: false, error: 'No source network for project 3' } as never);
    render();
    await screen.findByRole('option', { name: 'shop' });
    await screen.findByRole('option', { name: /203\.0\.113\.9/ });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Outgoing IP'), { target: { value: '203.0.113.9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set outgoing IP' }));
    expect(await screen.findByText('No source network for project 3')).toBeInTheDocument();
  });

  it('lists rules and removes one on its driver after confirming', async () => {
    mockOf(api.egress.list).mockResolvedValue({ drivers: [{ name: 'iptables', rules: [rule] }] });
    mockOf(api.egress.clear).mockResolvedValue({ ok: true, driver: 'iptables' });
    render();
    expect(await screen.findByText('from 172.20.0.0/16')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove the outgoing IP of shop' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.egress.clear).toHaveBeenCalledWith(3, 'iptables'));
    expect(await screen.findByText('Outgoing IP removed')).toBeInTheDocument();
  });

  it('says when no driver is registered', async () => {
    mockOf(api.egress.list).mockResolvedValue({ drivers: [] });
    render();
    expect(await screen.findByText('No egress IP driver is registered on this panel.')).toBeInTheDocument();
  });
});
