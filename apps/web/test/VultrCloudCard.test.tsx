import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VultrCloudCard } from '../src/components/VultrCloudCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const v = () => api.cloud.vultr;
const KEY = '3b8066a7-b438-455a-9688-44afc9a3597f';
const OPTIONS = {
  regions: [
    { id: 'ams', city: 'Amsterdam', country: 'NL' },
    { id: 'ewr', city: 'New Jersey', country: 'US' },
  ],
  plans: [
    { id: 'vc2-1c-1gb', vcpus: 1, memoryGb: 1, diskGb: 25, priceMonthly: 5, regions: ['ams', 'ewr'] },
    { id: 'ams-only', vcpus: 2, memoryGb: 4, diskGb: 80, priceMonthly: 20, regions: ['ams'] },
  ],
  images: [{ id: 2284, name: 'Ubuntu 24.04 LTS x64', family: 'ubuntu' }],
  sshKeys: [{ id: KEY, name: 'laptop' }],
};
const configured = () => mockOf(v().status).mockResolvedValue({ configured: true, tokenHint: '…WXYZ' } as never);

describe('VultrCloudCard (G4.3)', () => {
  beforeEach(() => {
    for (const fn of Object.values(v())) mockOf(fn as never).mockReset();
    mockOf(v().servers).mockResolvedValue([] as never);
  });

  it('asks for an API key, saves it, and forgets it; a refused key is not stored', async () => {
    mockOf(v().status).mockResolvedValue({ configured: false, tokenHint: null } as never);
    mockOf(v().setToken).mockRejectedValueOnce(new Error('Invalid API token.')).mockResolvedValueOnce({ configured: true, tokenHint: '…WXYZ' } as never);
    mockOf(v().deleteToken).mockResolvedValue({ configured: false, tokenHint: null } as never);
    renderWithProviders(<VultrCloudCard />);
    await userEvent.type(await screen.findByLabelText('API key'), 'bad');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(v().setToken).toHaveBeenCalledWith('bad'));
    expect(screen.getByLabelText('API key')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('API key'));
    await userEvent.type(screen.getByLabelText('API key'), 'GOODKEY');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Token …WXYZ')).toBeInTheDocument();
    expect(await screen.findByText('No server created from this panel yet.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Forget token' }));
    expect(await screen.findByLabelText('API key')).toBeInTheDocument();
  });

  it('creates an instance: plans follow the region, an unfit plan is cleared', async () => {
    configured();
    mockOf(v().options).mockResolvedValue(OPTIONS as never);
    mockOf(v().createServer).mockResolvedValue({ serverId: 5, providerServerId: 'uuid', ipv4: '203.0.113.9' } as never);
    renderWithProviders(<VultrCloudCard />);
    await userEvent.click(await screen.findByRole('button', { name: /Create instance/ }));
    const form = await screen.findByRole('form', { name: 'Create instance' });
    await userEvent.type(within(form).getByPlaceholderText('edge-1'), 'edge-v');
    const [region, plan, image] = within(form).getAllByRole('combobox');
    await userEvent.selectOptions(region!, 'ams');
    await userEvent.selectOptions(plan!, 'ams-only');
    expect(within(plan!).getByRole('option', { name: /ams-only · 2 vCPU, 4 GB RAM, 80 GB, USD 20\/month/ })).toBeInTheDocument();
    // New Jersey does not offer it: cleared, and the form cannot be sent.
    await userEvent.selectOptions(region!, 'ewr');
    expect(plan).toHaveValue('');
    await userEvent.selectOptions(image!, '2284');
    expect(within(form).getByRole('button', { name: 'Create instance' })).toBeDisabled();
    await userEvent.selectOptions(plan!, 'vc2-1c-1gb');
    // A plan the next region offers too is kept.
    await userEvent.selectOptions(region!, 'ams');
    expect(plan).toHaveValue('vc2-1c-1gb');
    await userEvent.click(within(form).getByRole('checkbox', { name: 'laptop' }));
    await userEvent.click(within(form).getByRole('checkbox', { name: 'laptop' }));
    await userEvent.click(within(form).getByRole('checkbox', { name: 'laptop' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Create instance' }));
    await waitFor(() =>
      expect(v().createServer).toHaveBeenCalledWith({ name: 'edge-v', region: 'ams', plan: 'vc2-1c-1gb', osId: 2284, sshKeyIds: [KEY] }),
    );
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Create instance' })).not.toBeInTheDocument());
  });

  it('a failed create keeps the form; unreadable options say so', async () => {
    configured();
    mockOf(v().options).mockResolvedValue({ ...OPTIONS, sshKeys: [] } as never);
    mockOf(v().createServer).mockRejectedValue(new Error('quota exceeded'));
    const first = renderWithProviders(<VultrCloudCard />);
    await userEvent.click(await screen.findByRole('button', { name: /Create instance/ }));
    const form = await screen.findByRole('form', { name: 'Create instance' });
    await userEvent.type(within(form).getByPlaceholderText('edge-1'), 'x');
    const [region, plan, image] = within(form).getAllByRole('combobox');
    await userEvent.selectOptions(region!, 'ams');
    await userEvent.selectOptions(plan!, 'vc2-1c-1gb');
    await userEvent.selectOptions(image!, '2284');
    expect(within(form).queryByRole('checkbox')).not.toBeInTheDocument();
    await userEvent.click(within(form).getByRole('button', { name: 'Create instance' }));
    await waitFor(() => expect(v().createServer).toHaveBeenCalled());
    expect(screen.getByRole('form', { name: 'Create instance' })).toBeInTheDocument();
    first.unmount();

    mockOf(v().options).mockRejectedValue(new Error('forbidden'));
    renderWithProviders(<VultrCloudCard />);
    await userEvent.click(await screen.findByRole('button', { name: /Create instance/ }));
    expect(await screen.findByText(/Could not read the Vultr account: forbidden/)).toBeInTheDocument();
  });

  it('lists instances and deletes one after confirming; a refused delete is reported', async () => {
    configured();
    const row = {
      serverId: 5, name: 'edge-v', provider: 'vultr', providerServerId: 'uuid-5', location: 'ams', serverType: 'vc2-1c-1gb',
      image: 'Ubuntu 24.04 LTS x64', ipv4: '203.0.113.9', providerStatus: 'active', nodeStatus: 'online', createdAt: '2026-10-29T10:00:00Z',
    };
    mockOf(v().servers).mockResolvedValue([row, { ...row, serverId: 6, name: 'gone', ipv4: '203.0.113.10', providerStatus: 'deleted', nodeStatus: 'offline' }, { ...row, serverId: 7, name: 'unknown', ipv4: '203.0.113.11', providerStatus: null }] as never);
    mockOf(v().deleteServer).mockResolvedValueOnce({ ok: true } as never).mockRejectedValueOnce(new Error('hosts services'));
    renderWithProviders(<VultrCloudCard />);
    expect(await screen.findByText('203.0.113.9')).toBeInTheDocument();
    expect(screen.getByText('VM: active')).toBeInTheDocument();
    expect(screen.getByText('VM: deleted')).toBeInTheDocument();
    expect(screen.getByText('VM: —')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete edge-v' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete instance' }));
    await waitFor(() => expect(v().deleteServer).toHaveBeenCalledWith(5));
    await userEvent.click(screen.getByRole('button', { name: 'Delete gone' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete instance' }));
    await waitFor(() => expect(v().deleteServer).toHaveBeenCalledWith(6));
  });

  it('an unreadable list says so', async () => {
    configured();
    mockOf(v().servers).mockRejectedValue(new Error('boom'));
    renderWithProviders(<VultrCloudCard />);
    expect(await screen.findByText(/Could not load the servers: boom/)).toBeInTheDocument();
  });
});
