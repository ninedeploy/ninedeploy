import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DigitalOceanCloudCard } from '../src/components/DigitalOceanCloudCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const d = () => api.cloud.digitalocean;
const OPTIONS = {
  regions: [
    { slug: 'fra1', name: 'Frankfurt 1' },
    { slug: 'nyc3', name: 'New York 3' },
  ],
  sizes: [
    { slug: 's-1vcpu-1gb', description: 'Basic', vcpus: 1, memoryGb: 1, diskGb: 25, priceMonthly: 6, regions: ['fra1', 'nyc3'] },
    { slug: 'fra-only', description: 'Frankfurt only', vcpus: 2, memoryGb: 4, diskGb: 80, priceMonthly: 24, regions: ['fra1'] },
  ],
  images: [
    { slug: 'ubuntu-24-04-x64', description: 'Ubuntu 24.04 (LTS) x64', regions: ['fra1', 'nyc3'] },
    { slug: 'debian-fra', description: 'Debian 12 x64', regions: ['fra1'] },
  ],
  sshKeys: [{ id: 7, name: 'laptop', fingerprint: 'aa:bb' }],
};
const configured = () => mockOf(d().status).mockResolvedValue({ configured: true, tokenHint: '…wxyz' } as never);

describe('DigitalOceanCloudCard (G4.3)', () => {
  beforeEach(() => {
    for (const fn of Object.values(d())) mockOf(fn as never).mockReset();
    mockOf(d().servers).mockResolvedValue([] as never);
  });

  it('asks for a token, saves it, and forgets it', async () => {
    mockOf(d().status).mockResolvedValue({ configured: false, tokenHint: null } as never);
    mockOf(d().setToken).mockResolvedValue({ configured: true, tokenHint: '…wxyz' } as never);
    mockOf(d().deleteToken).mockResolvedValue({ configured: false, tokenHint: null } as never);
    renderWithProviders(<DigitalOceanCloudCard />);
    await userEvent.type(await screen.findByLabelText('API token'), 'dop_v1_secret');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(d().setToken).toHaveBeenCalledWith('dop_v1_secret'));
    expect(await screen.findByText('Token …wxyz')).toBeInTheDocument();
    expect(await screen.findByText('No server created from this panel yet.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Forget token' }));
    expect(await screen.findByLabelText('API token')).toBeInTheDocument();
  });

  it('a refused token is reported and nothing is stored', async () => {
    mockOf(d().status).mockResolvedValue({ configured: false, tokenHint: null } as never);
    mockOf(d().setToken).mockRejectedValue(new Error('Unable to authenticate you'));
    renderWithProviders(<DigitalOceanCloudCard />);
    await userEvent.type(await screen.findByLabelText('API token'), 'bad');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(d().setToken).toHaveBeenCalled());
    expect(screen.getByLabelText('API token')).toBeInTheDocument();
  });

  it('creates a droplet: sizes and images follow the region, an unfit choice is cleared', async () => {
    configured();
    mockOf(d().options).mockResolvedValue(OPTIONS as never);
    mockOf(d().createServer).mockResolvedValue({ serverId: 5, providerServerId: 42, ipv4: '203.0.113.9' } as never);
    renderWithProviders(<DigitalOceanCloudCard />);
    await userEvent.click(await screen.findByRole('button', { name: /Create droplet/ }));
    const form = await screen.findByRole('form', { name: 'Create droplet' });
    await userEvent.type(within(form).getByPlaceholderText('edge-1'), 'edge-do');
    const [region, size, image] = within(form).getAllByRole('combobox');
    await userEvent.selectOptions(region!, 'fra1');
    await userEvent.selectOptions(size!, 'fra-only');
    await userEvent.selectOptions(image!, 'debian-fra');
    expect(within(size!).getByRole('option', { name: /fra-only · 2 vCPU, 4 GB RAM, 80 GB, USD 24\/month/ })).toBeInTheDocument();
    // New York offers neither: both are cleared and the form cannot be sent.
    await userEvent.selectOptions(region!, 'nyc3');
    expect(size).toHaveValue('');
    expect(image).toHaveValue('');
    expect(within(form).getByRole('button', { name: 'Create droplet' })).toBeDisabled();
    await userEvent.selectOptions(size!, 's-1vcpu-1gb');
    await userEvent.selectOptions(image!, 'ubuntu-24-04-x64');
    await userEvent.click(within(form).getByRole('checkbox', { name: 'laptop' }));
    await userEvent.click(within(form).getByRole('checkbox', { name: 'laptop' }));
    await userEvent.click(within(form).getByRole('checkbox', { name: 'laptop' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Create droplet' }));
    await waitFor(() =>
      expect(d().createServer).toHaveBeenCalledWith({ name: 'edge-do', region: 'nyc3', size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64', sshKeyIds: [7] }),
    );
    // Sent: the form closes.
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Create droplet' })).not.toBeInTheDocument());
  });

  it('a failed create keeps the form; unreadable options say so', async () => {
    configured();
    mockOf(d().options).mockResolvedValue({ ...OPTIONS, sshKeys: [] } as never);
    mockOf(d().createServer).mockRejectedValue(new Error('quota exceeded'));
    const first = renderWithProviders(<DigitalOceanCloudCard />);
    await userEvent.click(await screen.findByRole('button', { name: /Create droplet/ }));
    const form = await screen.findByRole('form', { name: 'Create droplet' });
    await userEvent.type(within(form).getByPlaceholderText('edge-1'), 'x');
    const [region, size, image] = within(form).getAllByRole('combobox');
    await userEvent.selectOptions(region!, 'fra1');
    await userEvent.selectOptions(size!, 's-1vcpu-1gb');
    await userEvent.selectOptions(image!, 'ubuntu-24-04-x64');
    expect(within(form).queryByRole('checkbox')).not.toBeInTheDocument();
    await userEvent.click(within(form).getByRole('button', { name: 'Create droplet' }));
    await waitFor(() => expect(d().createServer).toHaveBeenCalled());
    expect(screen.getByRole('form', { name: 'Create droplet' })).toBeInTheDocument();
    first.unmount();

    mockOf(d().options).mockRejectedValue(new Error('forbidden'));
    renderWithProviders(<DigitalOceanCloudCard />);
    await userEvent.click(await screen.findByRole('button', { name: /Create droplet/ }));
    expect(await screen.findByText(/Could not read the DigitalOcean account: forbidden/)).toBeInTheDocument();
  });

  it('lists droplets and deletes one after confirming; a refused delete is reported', async () => {
    configured();
    const row = {
      serverId: 5, name: 'edge-do', provider: 'digitalocean', providerServerId: 42, location: 'fra1', serverType: 's-1vcpu-1gb',
      image: 'ubuntu-24-04-x64', ipv4: '203.0.113.9', providerStatus: 'active', nodeStatus: 'online', createdAt: '2026-10-29T10:00:00Z',
    };
    mockOf(d().servers).mockResolvedValue([row, { ...row, serverId: 6, name: 'gone', ipv4: '203.0.113.10', providerStatus: 'deleted', nodeStatus: 'offline' }, { ...row, serverId: 7, name: 'unknown', ipv4: '203.0.113.11', providerStatus: null }] as never);
    mockOf(d().deleteServer).mockResolvedValueOnce({ ok: true } as never).mockRejectedValueOnce(new Error('hosts services'));
    renderWithProviders(<DigitalOceanCloudCard />);
    expect(await screen.findByText('203.0.113.9')).toBeInTheDocument();
    expect(screen.getByText('VM: active')).toBeInTheDocument();
    expect(screen.getByText('VM: deleted')).toBeInTheDocument();
    expect(screen.getByText('VM: —')).toBeInTheDocument();
    expect(screen.getAllByText(/waiting for the agent/)).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Delete edge-do' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete droplet' }));
    await waitFor(() => expect(d().deleteServer).toHaveBeenCalledWith(5));
    await userEvent.click(screen.getByRole('button', { name: 'Delete gone' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete droplet' }));
    await waitFor(() => expect(d().deleteServer).toHaveBeenCalledWith(6));
  });

  it('an unreadable list says so', async () => {
    configured();
    mockOf(d().servers).mockRejectedValue(new Error('boom'));
    renderWithProviders(<DigitalOceanCloudCard />);
    expect(await screen.findByText(/Could not load the servers: boom/)).toBeInTheDocument();
  });
});
