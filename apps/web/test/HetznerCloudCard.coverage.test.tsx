import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HetznerCloudCard } from '../src/components/HetznerCloudCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const h = () => api.cloud.hetzner;
const OPTIONS = {
  locations: [{ name: 'fsn1', city: 'Falkenstein', country: 'DE' }],
  serverTypes: [{ name: 'cx22', description: 'CX22', cores: 2, memoryGb: 4, diskGb: 40, architecture: 'x86', locations: ['fsn1'] }],
  images: [{ name: 'rocky-9', description: 'Rocky Linux 9', architecture: 'x86' }],
  sshKeys: [
    { id: 7, name: 'laptop', fingerprint: 'aa:bb' },
    { id: 8, name: 'ci', fingerprint: 'cc:dd' },
  ],
};
const SERVER = {
  serverId: 5,
  name: 'edge-1',
  provider: 'hetzner',
  providerServerId: 42,
  location: 'fsn1',
  serverType: 'cx22',
  image: 'rocky-9',
  ipv4: '203.0.113.9',
  providerStatus: 'running',
  nodeStatus: 'online',
  createdAt: '2026-10-28T10:00:00Z',
};

describe('HetznerCloudCard error paths and token removal', () => {
  beforeEach(() => {
    for (const fn of Object.values(h())) mockOf(fn as never).mockReset();
    mockOf(h().servers).mockResolvedValue([] as never);
  });

  it('reports a refused token and keeps the form', async () => {
    mockOf(h().status).mockResolvedValue({ configured: false, tokenHint: null } as never);
    mockOf(h().setToken).mockRejectedValue(new Error('token lacks write access'));
    renderWithProviders(<HetznerCloudCard />);
    await userEvent.type(await screen.findByLabelText('API token'), '  bad-token  ');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h().setToken).toHaveBeenCalledWith('bad-token'));
    expect(await screen.findByText('Token refused: token lacks write access')).toBeInTheDocument();
    expect(screen.getByLabelText('API token')).toBeInTheDocument();
  });

  it('forgets the token and asks for a new one', async () => {
    mockOf(h().status).mockResolvedValue({ configured: true, tokenHint: '…wxyz' } as never);
    mockOf(h().deleteToken).mockResolvedValue({ configured: false, tokenHint: null } as never);
    renderWithProviders(<HetznerCloudCard />);
    await userEvent.click(await screen.findByRole('button', { name: 'Forget token' }));
    await waitFor(() => expect(h().deleteToken).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText('API token')).toBeInTheDocument();
    expect(screen.queryByText('Token …wxyz')).not.toBeInTheDocument();
  });

  it('shows why a server could not be deleted', async () => {
    mockOf(h().status).mockResolvedValue({ configured: true, tokenHint: '…wxyz' } as never);
    mockOf(h().servers).mockResolvedValue([SERVER] as never);
    mockOf(h().deleteServer).mockRejectedValue(new Error('node hosts services'));
    renderWithProviders(<HetznerCloudCard />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete edge-1' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete server' }));
    await waitFor(() => expect(h().deleteServer).toHaveBeenCalledWith(5));
    expect(await screen.findByText('Could not delete the server: node hosts services')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.9')).toBeInTheDocument();
  });

  it('sends only the SSH keys still ticked and reports a failed creation', async () => {
    mockOf(h().status).mockResolvedValue({ configured: true, tokenHint: '…wxyz' } as never);
    mockOf(h().options).mockResolvedValue(OPTIONS as never);
    mockOf(h().createServer).mockRejectedValue('quota exceeded');
    renderWithProviders(<HetznerCloudCard />);
    await userEvent.click(await screen.findByRole('button', { name: /Create server/ }));
    const form = await screen.findByRole('form', { name: 'Create server' });
    await userEvent.type(within(form).getByPlaceholderText('edge-1'), 'edge-2');
    const [location, type, image] = within(form).getAllByRole('combobox');
    await userEvent.selectOptions(location!, 'fsn1');
    await userEvent.selectOptions(type!, 'cx22');
    await userEvent.selectOptions(image!, 'rocky-9');
    await userEvent.click(within(form).getByRole('checkbox', { name: 'laptop' }));
    await userEvent.click(within(form).getByRole('checkbox', { name: 'ci' }));
    await userEvent.click(within(form).getByRole('checkbox', { name: 'laptop' }));
    expect(within(form).getByRole('checkbox', { name: 'laptop' })).not.toBeChecked();
    await userEvent.click(within(form).getByRole('button', { name: 'Create server' }));
    await waitFor(() =>
      expect(h().createServer).toHaveBeenCalledWith({ name: 'edge-2', location: 'fsn1', serverType: 'cx22', image: 'rocky-9', sshKeyIds: [8] }),
    );
    expect(await screen.findByText('Could not create the server: quota exceeded')).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Create server' })).toBeInTheDocument();
  });
});
