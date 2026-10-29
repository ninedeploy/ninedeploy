import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Domains } from '../src/routes/Domains.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  const mod = createFakeApiModule();
  // The shared fake has no domains.verify; the Manage panel's Verify needs it.
  Object.assign(mod.api.domains, { verify: vi.fn(), dnsCheck: vi.fn() });
  return mod;
});

const verify = () => (api.domains as unknown as { verify: ReturnType<typeof vi.fn> }).verify;

const active = { id: 1, hostname: 'app.example.com', path: '/', serviceId: 5, serviceName: 'app', port: 3000, container: 'nd-app', ssl: true, status: 'active', certExpiresAt: null };
const pending = { id: 4, hostname: 'claimed.example.org', path: '/', serviceId: 5, serviceName: 'app', port: 3000, container: 'nd-app', ssl: false, status: 'pending', certExpiresAt: null };

async function chooseService() {
  await screen.findByRole('option', { name: 'app' });
  fireEvent.change(screen.getByLabelText('Service'), { target: { value: '5' } });
}

describe('Domains — manage panel, add form and refusals', () => {
  beforeEach(() => {
    for (const fn of [api.domains.all, api.domains.list, api.domains.create, api.domains.generate, api.services.list, verify()]) mockOf(fn as never).mockReset();
    mockOf(api.services.list).mockResolvedValue([{ id: 5, name: 'app' }] as never);
  });

  it('opens and closes the Manage panel of a row', async () => {
    mockOf(api.domains.all).mockResolvedValue([active] as never);
    mockOf(api.domains.list).mockResolvedValue([{ id: 1, serviceId: 5, hostname: 'app.example.com', path: '/', ssl: true, redirectWww: false, headers: '[]', status: 'active' }] as never);
    renderWithProviders(<Domains />);
    const manage = await screen.findByRole('button', { name: /Manage/ });
    expect(manage).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(manage);
    expect(manage).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('button', { name: 'Check DNS' })).toBeInTheDocument();
    expect(api.domains.list).toHaveBeenCalledWith(5);
    // Manage opens without the hostname editor.
    expect(screen.queryByLabelText('New hostname')).not.toBeInTheDocument();
    fireEvent.click(manage);
    expect(manage).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Check DNS' })).not.toBeInTheDocument();
  });

  it('a failed Verify under Manage shows the TXT record to publish', async () => {
    mockOf(api.domains.all).mockResolvedValue([pending] as never);
    mockOf(api.domains.list).mockResolvedValue([{ id: 4, serviceId: 5, hostname: 'claimed.example.org', path: '/', ssl: false, redirectWww: false, status: 'pending' }] as never);
    verify().mockResolvedValue({
      verified: false,
      error: 'TXT record not found',
      verification: { recordName: '_ninedeploy-challenge.claimed.example.org', recordType: 'TXT', recordValue: 'nd-verify-xyz' },
    });
    renderWithProviders(<Domains />);
    fireEvent.click(await screen.findByRole('button', { name: /Manage/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(verify()).toHaveBeenCalledWith(5, 4));
    expect(await screen.findByText('nd-verify-xyz')).toBeInTheDocument();
    expect(screen.getByText('_ninedeploy-challenge.claimed.example.org')).toBeInTheDocument();
    expect(screen.getByText('TXT record not found')).toBeInTheDocument();
  });

  it("moves a pasted URL's path into the path field on blur and normalises a typed path", async () => {
    mockOf(api.domains.all).mockResolvedValue([] as never);
    mockOf(api.domains.create).mockResolvedValue({ id: 7, hostname: 'shop.example.com', path: '/v2', status: 'active', verification: null } as never);
    renderWithProviders(<Domains />);
    await chooseService();
    const host = screen.getByLabelText('Domain');
    const path = screen.getByLabelText('Path');
    fireEvent.change(host, { target: { value: 'https://Shop.Example.com/store/' } });
    fireEvent.blur(host);
    expect(host).toHaveValue('shop.example.com');
    expect(path).toHaveValue('/store');
    // A typed path replaces the carried one and is normalised on blur.
    fireEvent.change(path, { target: { value: 'v2//' } });
    fireEvent.blur(path);
    expect(path).toHaveValue('/v2');
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    await waitFor(() => expect(api.domains.create).toHaveBeenCalledWith(5, { hostname: 'shop.example.com', path: '/v2' }));
    expect(await screen.findByText('shop.example.com is routed to the service')).toBeInTheDocument();
    expect(host).toHaveValue('');
    expect(path).toHaveValue('');
  });

  it("shows the server's reason, or a generic message, when an add is refused", async () => {
    mockOf(api.domains.all).mockResolvedValue([] as never);
    mockOf(api.domains.create).mockRejectedValueOnce(new Error('taken.example.com is routed to another service')).mockRejectedValueOnce(new Error(''));
    renderWithProviders(<Domains />);
    await chooseService();
    fireEvent.change(screen.getByLabelText('Domain'), { target: { value: 'taken.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    expect(await screen.findByText('taken.example.com is routed to another service')).toBeInTheDocument();
    // The hostname stays for a corrected retry.
    expect(screen.getByLabelText('Domain')).toHaveValue('taken.example.com');
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    expect(await screen.findByText('Could not add the domain')).toBeInTheDocument();
    expect(api.domains.create).toHaveBeenCalledTimes(2);
  });

  it("shows why the automatic URL could not be generated", async () => {
    mockOf(api.domains.all).mockResolvedValue([] as never);
    mockOf(api.domains.generate).mockRejectedValue(new Error('Automatic URLs are off'));
    renderWithProviders(<Domains />);
    const generate = screen.getByRole('button', { name: /Generate URL/ });
    expect(generate).toBeDisabled();
    await chooseService();
    fireEvent.click(generate);
    await waitFor(() => expect(api.domains.generate).toHaveBeenCalledWith(5));
    expect(await screen.findByText('Automatic URLs are off')).toBeInTheDocument();
  });
});
