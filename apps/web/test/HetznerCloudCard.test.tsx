import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HetznerCloudCard } from '../src/components/HetznerCloudCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const h = () => api.cloud.hetzner;
const OPTIONS = {
  locations: [
    { name: 'fsn1', city: 'Falkenstein', country: 'DE' },
    { name: 'ash', city: 'Ashburn', country: 'US' },
  ],
  serverTypes: [
    { name: 'cx22', description: 'CX22', cores: 2, memoryGb: 4, diskGb: 40, architecture: 'x86', locations: ['fsn1'] },
    { name: 'cpx21', description: 'CPX21', cores: 3, memoryGb: 4, diskGb: 80, architecture: 'x86', locations: ['ash', 'fsn1'] },
    { name: 'cax11', description: 'CAX11', cores: 2, memoryGb: 4, diskGb: 40, architecture: 'arm', locations: ['fsn1'] },
  ],
  images: [
    { name: 'ubuntu-24.04', description: 'Ubuntu 24.04', architecture: 'x86' },
    { name: 'ubuntu-24.04', description: 'Ubuntu 24.04 (arm)', architecture: 'arm' },
    { name: 'rocky-9', description: 'Rocky Linux 9', architecture: 'x86' },
  ],
  sshKeys: [{ id: 7, name: 'laptop', fingerprint: 'aa:bb' }],
};

describe('HetznerCloudCard (G4.3)', () => {
  beforeEach(() => {
    for (const fn of Object.values(h())) mockOf(fn as never).mockReset();
    mockOf(h().servers).mockResolvedValue([] as never);
  });

  it('asks for a token, saves it and never shows it back', async () => {
    mockOf(h().status).mockResolvedValue({ configured: false, tokenHint: null } as never);
    mockOf(h().setToken).mockResolvedValue({ configured: true, tokenHint: '…wxyz' } as never);
    renderWithProviders(<HetznerCloudCard />);
    const input = await screen.findByLabelText('API token');
    await userEvent.type(input, 'secret-token-value');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h().setToken).toHaveBeenCalledWith('secret-token-value'));
    expect(await screen.findByText('Token …wxyz')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('secret-token-value')).not.toBeInTheDocument();
  });

  it('creates a server: types follow the location, images the architecture', async () => {
    mockOf(h().status).mockResolvedValue({ configured: true, tokenHint: '…wxyz' } as never);
    mockOf(h().options).mockResolvedValue(OPTIONS as never);
    mockOf(h().createServer).mockResolvedValue({ serverId: 5, providerServerId: 42, ipv4: '203.0.113.9' } as never);
    renderWithProviders(<HetznerCloudCard />);
    await userEvent.click(await screen.findByRole('button', { name: /Create server/ }));
    const form = await screen.findByRole('form', { name: 'Create server' });
    await userEvent.type(within(form).getByPlaceholderText('edge-1'), 'edge-1');
    const [location, type, image] = within(form).getAllByRole('combobox');
    await userEvent.selectOptions(location!, 'ash');
    expect(within(type!).queryByRole('option', { name: /^cx22/ })).not.toBeInTheDocument();
    await userEvent.selectOptions(location!, 'fsn1');
    await userEvent.selectOptions(type!, 'cax11');
    expect(within(image!).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose…', 'Ubuntu 24.04 (arm)']);
    await userEvent.selectOptions(type!, 'cx22');
    await userEvent.selectOptions(image!, 'rocky-9');
    await userEvent.click(within(form).getByRole('checkbox', { name: 'laptop' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Create server' }));
    await waitFor(() =>
      expect(h().createServer).toHaveBeenCalledWith({ name: 'edge-1', location: 'fsn1', serverType: 'cx22', image: 'rocky-9', sshKeyIds: [7] }),
    );
  });

  it('lists created servers and deletes one after confirming', async () => {
    mockOf(h().status).mockResolvedValue({ configured: true, tokenHint: '…wxyz' } as never);
    mockOf(h().servers).mockResolvedValue([
      {
        serverId: 5,
        name: 'edge-1',
        provider: 'hetzner',
        providerServerId: 42,
        location: 'fsn1',
        serverType: 'cx22',
        image: 'rocky-9',
        ipv4: '203.0.113.9',
        providerStatus: 'running',
        nodeStatus: 'offline',
        createdAt: '2026-10-28T10:00:00Z',
      },
    ] as never);
    mockOf(h().deleteServer).mockResolvedValue({ ok: true } as never);
    renderWithProviders(<HetznerCloudCard />);
    expect(await screen.findByText('203.0.113.9')).toBeInTheDocument();
    expect(screen.getByText('VM: running')).toBeInTheDocument();
    expect(screen.getByText(/waiting for the agent/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete edge-1' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete server' }));
    await waitFor(() => expect(h().deleteServer).toHaveBeenCalledWith(5));
  });

  it('clears an incompatible server type when changing location before creating a VM', async () => {
    mockOf(h().status).mockResolvedValue({ configured: true, tokenHint: '…wxyz' } as never);
    mockOf(h().options).mockResolvedValue(OPTIONS as never);
    renderWithProviders(<HetznerCloudCard />);
    await userEvent.click(await screen.findByRole('button', { name: /Create server/ }));
    const form = await screen.findByRole('form', { name: 'Create server' });
    await userEvent.type(within(form).getByPlaceholderText('edge-1'), 'edge-1');
    const [location, type, image] = within(form).getAllByRole('combobox');
    await userEvent.selectOptions(location!, 'fsn1');
    await userEvent.selectOptions(type!, 'cx22');
    await userEvent.selectOptions(image!, 'rocky-9');
    expect(within(form).getByRole('button', { name: 'Create server' })).toBeEnabled();
    await userEvent.selectOptions(location!, 'ash');
    expect(type).toHaveValue('');
    expect(within(form).getByRole('button', { name: 'Create server' })).toBeDisabled();
    expect(h().createServer).not.toHaveBeenCalled();
  });

  it('clears an incompatible image when switching server architecture', async () => {
    mockOf(h().status).mockResolvedValue({ configured: true, tokenHint: '…wxyz' } as never);
    mockOf(h().options).mockResolvedValue(OPTIONS as never);
    renderWithProviders(<HetznerCloudCard />);
    await userEvent.click(await screen.findByRole('button', { name: /Create server/ }));
    const form = await screen.findByRole('form', { name: 'Create server' });
    await userEvent.type(within(form).getByPlaceholderText('edge-1'), 'edge-1');
    const [location, type, image] = within(form).getAllByRole('combobox');
    await userEvent.selectOptions(location!, 'fsn1');
    await userEvent.selectOptions(type!, 'cx22');
    await userEvent.selectOptions(image!, 'rocky-9');
    await userEvent.selectOptions(type!, 'cax11');
    expect(image).toHaveValue('');
    expect(within(form).getByRole('button', { name: 'Create server' })).toBeDisabled();
    expect(h().createServer).not.toHaveBeenCalled();
  });
});
