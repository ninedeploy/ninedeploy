import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HostIpsCard } from '../src/routes/settings/HostIpsCard.js';
import { api } from '../src/lib/api.js';
import { mockOf, renderWithProviders } from './helpers.js';

/** 0.16.1 Settings → Security → IP addresses: label, primary, dedicate, forget; host unreadable; errors. */

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});
vi.mock('../src/lib/auth.js', async () => {
  const { createAuthMock } = await import('./apiMock.js');
  return createAuthMock();
});
const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', async () => {
  const actual = await vi.importActual<typeof import('../src/components/Toast.js')>('../src/components/Toast.js');
  return { ...actual, useToast: () => toastSpy };
});

const main = { ip: '203.0.113.7', family: 4 as const, iface: 'eth0', detected: true, label: 'main', primary: true, dedicatedTo: null };
const spare = { ip: '203.0.113.8', family: 4 as const, iface: 'eth0', detected: true, label: null, primary: false, dedicatedTo: null };
const gone = { ip: '198.51.100.9', family: 4 as const, iface: null, detected: false, label: 'gone', primary: false, dedicatedTo: { id: 9, name: 'legacy' } };

beforeEach(() => {
  vi.clearAllMocks();
  mockOf(api.hostIps.list).mockResolvedValue({ detected: true, addresses: [main, spare, gone] });
  mockOf(api.services.list).mockResolvedValue([
    { id: 5, name: 'voice', type: 'docker', serverId: null },
    { id: 6, name: 'edge', type: 'docker', serverId: 2 },
    { id: 7, name: 'stack', type: 'compose', serverId: null },
  ] as never);
  mockOf(api.hostIps.set).mockResolvedValue(null);
  mockOf(api.hostIps.remove).mockResolvedValue({ ok: true });
});

describe('HostIpsCard', () => {
  it('lists the addresses with their interface and primary mark; only panel-host docker services can be picked', async () => {
    renderWithProviders(<HostIpsCard />);
    expect(await screen.findByText('203.0.113.7')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.7').parentElement).toHaveTextContent('primary');
    // Only a detected address can become primary.
    expect(screen.getAllByRole('button', { name: 'Make primary' }).map((b) => (b as HTMLButtonElement).disabled)).toEqual([false, true]);
    expect(screen.getByText('not detected')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('203.0.113.8 dedicated to').querySelectorAll('option')).toHaveLength(2));
    expect(screen.getByLabelText('203.0.113.8 dedicated to')).toHaveTextContent('Dedicated to voice');
    // A dedication to a service no longer listed stays visible.
    expect(screen.getByLabelText('198.51.100.9 dedicated to')).toHaveValue('9');
  });

  it('saves a label and a dedication, and makes an address primary', async () => {
    renderWithProviders(<HostIpsCard />);
    const label = await screen.findByLabelText('203.0.113.8 label');
    const saveButtons = () => screen.getAllByRole('button', { name: 'Save' });
    expect(saveButtons()[1]).toBeDisabled();
    fireEvent.change(label, { target: { value: ' voip ' } });
    await waitFor(() => expect(screen.getByLabelText('203.0.113.8 dedicated to').querySelectorAll('option')).toHaveLength(2));
    fireEvent.change(screen.getByLabelText('203.0.113.8 dedicated to'), { target: { value: '5' } });
    fireEvent.click(saveButtons()[1]!);
    await waitFor(() => expect(api.hostIps.set).toHaveBeenCalledWith('203.0.113.8', { label: 'voip', serviceId: 5 }));
    expect(toastSpy.toast).toHaveBeenCalledWith('203.0.113.8 saved', 'success');

    fireEvent.click(screen.getAllByRole('button', { name: 'Make primary' })[0]!);
    await waitFor(() => expect(api.hostIps.set).toHaveBeenCalledWith('203.0.113.8', { primary: true }));
    expect(toastSpy.toast).toHaveBeenCalledWith('203.0.113.8 is the primary address', 'success');
  });

  it('shares an address again and forgets one that is gone', async () => {
    renderWithProviders(<HostIpsCard />);
    fireEvent.change(await screen.findByLabelText('198.51.100.9 dedicated to'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('198.51.100.9 label'), { target: { value: '' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[2]!);
    await waitFor(() => expect(api.hostIps.set).toHaveBeenCalledWith('198.51.100.9', { label: null, serviceId: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(api.hostIps.remove).toHaveBeenCalledWith('198.51.100.9'));
    expect(toastSpy.toast).toHaveBeenCalledWith('198.51.100.9 forgotten', 'success');
  });

  it("shows the server's reason when a save fails", async () => {
    mockOf(api.hostIps.set).mockRejectedValue(new Error('Service "game" publishes ports on 203.0.113.8'));
    renderWithProviders(<HostIpsCard />);
    fireEvent.change(await screen.findByLabelText('203.0.113.8 label'), { target: { value: 'x' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[1]!);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Service "game" publishes ports on 203.0.113.8', 'error'));
    mockOf(api.hostIps.remove).mockRejectedValue(new Error(''));
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not save the address', 'error'));
  });

  it('says when the host could not be read, or has no address', async () => {
    mockOf(api.hostIps.list).mockResolvedValue({ detected: false, addresses: [] });
    renderWithProviders(<HostIpsCard />);
    expect(await screen.findByText(/interfaces could not be read/)).toBeInTheDocument();
    expect(screen.getByText('No public or LAN address found.')).toBeInTheDocument();
  });

  it('offers a retry when the list fails', async () => {
    mockOf(api.hostIps.list).mockRejectedValue(new Error('boom'));
    renderWithProviders(<HostIpsCard />);
    expect(await screen.findByText("Couldn't load the host's addresses")).toBeInTheDocument();
  });
});
