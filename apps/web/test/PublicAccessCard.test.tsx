import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, createQueryClient } from './web-utils.js';

const apiMock = vi.hoisted(() => ({
  api: {
    databases: {
      credentials: vi.fn(),
      publicAccess: { get: vi.fn(), set: vi.fn(), disable: vi.fn() },
    },
  },
}));
vi.mock('../src/lib/api.js', () => apiMock);

const authMock = vi.hoisted(() => ({ user: { id: 1, isOperator: true } as { id: number; isOperator: boolean } }));
vi.mock('../src/lib/auth.js', () => ({
  AuthProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useAuth: vi.fn(() => ({ user: authMock.user, loading: false })),
}));

import { ToastProvider } from '../src/components/Toast.js';
import { analyzeAllowlistEntry, PublicAccessCard } from '../src/routes/database/PublicAccessCard.js';

const off = {
  supported: true, configured: false, enabled: false, port: null, tlsMode: 'none', tlsHostname: null,
  ipAllowlist: [], status: 'off', lastError: null, appliedAt: null, publicHost: null,
};
const running = {
  ...off, configured: true, enabled: true, port: 15432, ipAllowlist: ['203.0.113.0/24'], status: 'running',
  appliedAt: '2026-10-08T10:00:00.000Z', publicHost: 'panel.example.com',
};

const db = { id: 7, name: 'main', engine: 'postgres' } as never;

function renderCard(database = db, queryClient = createQueryClient()) {
  return renderWithProviders(<PublicAccessCard db={database} />, { queryClient, wrapper: (c) => <ToastProvider>{c}</ToastProvider> });
}

describe('analyzeAllowlistEntry', () => {
  it('accepts hosts and ranges, and refuses garbage, /0, bad prefixes and mapped IPv6', () => {
    expect(analyzeAllowlistEntry('  ')).toEqual({ error: null, warnings: [] });
    expect(analyzeAllowlistEntry('203.0.113.7')).toEqual({ error: null, warnings: [] });
    expect(analyzeAllowlistEntry('2001:db8::/48')).toEqual({ error: null, warnings: [] });
    expect(analyzeAllowlistEntry('nope').error).toMatch(/not an IP address/);
    expect(analyzeAllowlistEntry('1.2.3.4/8/9').error).toMatch(/one address/);
    expect(analyzeAllowlistEntry('0.0.0.0/0').error).toMatch(/whole internet/);
    expect(analyzeAllowlistEntry('::/0').error).toMatch(/whole internet/);
    expect(analyzeAllowlistEntry('1.2.3.4/33').error).toMatch(/between 1 and 32/);
    expect(analyzeAllowlistEntry('1.2.3.4/x').error).toMatch(/between 1 and 32/);
    expect(analyzeAllowlistEntry('::ffff:1.2.3.4').error).toMatch(/IPv4-mapped/);
    expect(analyzeAllowlistEntry('gg::1').error).toMatch(/not an IP/);
    expect(analyzeAllowlistEntry('1:2:3:4:5:6:7:8:9').error).toMatch(/not an IP/);
  });

  it('warns on broad, private, loopback and link-local ranges', () => {
    expect(analyzeAllowlistEntry('198.51.0.0/8').warnings).toEqual(['/8 is a very broad range']);
    expect(analyzeAllowlistEntry('2001:db8::/32').warnings).toEqual(['/32 is a very broad range']);
    for (const p of ['10.0.0.0/16', '172.20.0.0/16', '192.168.1.0/24']) expect(analyzeAllowlistEntry(p).warnings[0]).toMatch(/Private range/);
    expect(analyzeAllowlistEntry('172.32.0.1').warnings).toEqual([]);
    expect(analyzeAllowlistEntry('127.0.0.1').warnings[0]).toMatch(/Loopback/);
    expect(analyzeAllowlistEntry('169.254.0.0/16').warnings[0]).toMatch(/Link-local/);
    expect(analyzeAllowlistEntry('::1').warnings[0]).toMatch(/Loopback/);
    expect(analyzeAllowlistEntry('fd12::/64').warnings[0]).toMatch(/unique-local/);
    expect(analyzeAllowlistEntry('fe80::/64').warnings[0]).toMatch(/Link-local/);
  });
});

describe('PublicAccessCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.user = { id: 1, isOperator: true };
    apiMock.api.databases.publicAccess.get.mockResolvedValue(off);
    apiMock.api.databases.publicAccess.set.mockImplementation(async (_id: number, input: Record<string, unknown>) => ({
      ...running, port: input.port, ipAllowlist: input.ipAllowlist, tlsMode: input.tlsMode, tlsHostname: input.tlsHostname ?? null,
    }));
    apiMock.api.databases.publicAccess.disable.mockResolvedValue({ ok: true });
  });

  it('always shows the root-credential warning and enables with a port and an allow-list', async () => {
    renderCard();
    expect(await screen.findByRole('note')).toHaveTextContent(/root/);
    expect(screen.queryByLabelText('Public port')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Public access' }));
    const enable = screen.getByRole('button', { name: /Enable/ });
    expect(enable).toBeDisabled();
    expect(screen.getByText(/never means “everyone”/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Public port'), { target: { value: '443' } });
    expect(screen.getByText('A port between 1024 and 65535')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Public port'), { target: { value: '15432' } });
    fireEvent.change(screen.getByLabelText('Allowed source 1'), { target: { value: '0.0.0.0/0' } });
    expect(screen.getByText(/whole internet/)).toBeInTheDocument();
    expect(enable).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Allowed source 1'), { target: { value: '203.0.113.0/24' } });
    fireEvent.click(screen.getByRole('button', { name: /Add source/ }));
    fireEvent.change(screen.getByLabelText('Allowed source 2'), { target: { value: '10.0.0.0/8' } });
    expect(screen.getByText(/very broad range/)).toBeInTheDocument();
    expect(screen.getByText(/Private range/)).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Remove source 2'));
    expect(screen.queryByLabelText('Allowed source 2')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('TLS'), { target: { value: 'terminate' } });
    fireEvent.change(screen.getByLabelText('TLS hostname'), { target: { value: 'db.example.com' } });
    fireEvent.click(enable);
    await waitFor(() =>
      expect(apiMock.api.databases.publicAccess.set).toHaveBeenCalledWith(7, {
        enabled: true, port: 15432, ipAllowlist: ['203.0.113.0/24'], tlsMode: 'terminate', tlsHostname: 'db.example.com',
      }),
    );
    expect(await screen.findByText('Public access applied')).toBeInTheDocument();
    expect(await screen.findByTestId('public-endpoint')).toHaveTextContent('panel.example.com:15432');
    expect(screen.getByText(/over TLS/)).toBeInTheDocument();
  });

  it('keeps one empty row when the last source is removed, and omits a blank TLS hostname', async () => {
    apiMock.api.databases.publicAccess.get.mockResolvedValue(running);
    renderCard();
    fireEvent.click(await screen.findByTitle('Remove source 1'));
    expect(screen.getByLabelText('Allowed source 1')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Allowed source 1'), { target: { value: '198.51.100.4' } });
    fireEvent.click(screen.getByRole('button', { name: /Save and apply/ }));
    await waitFor(() =>
      expect(apiMock.api.databases.publicAccess.set).toHaveBeenCalledWith(7, { enabled: true, port: 15432, ipAllowlist: ['198.51.100.4'], tlsMode: 'none' }),
    );
  });

  it('reports a sidecar error returned by a save, and a refused save', async () => {
    apiMock.api.databases.publicAccess.get.mockResolvedValue(running);
    apiMock.api.databases.publicAccess.set.mockResolvedValueOnce({ ...running, status: 'error', lastError: 'port is already allocated' });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /Save and apply/ }));
    expect(await screen.findByText(/Saved, but the sidecar reported: port is already allocated/)).toBeInTheDocument();
    expect(screen.getByText('Last error: port is already allocated')).toBeInTheDocument();

    apiMock.api.databases.publicAccess.set.mockResolvedValueOnce({ ...running, status: 'error', lastError: null });
    fireEvent.click(screen.getByRole('button', { name: /Save and apply/ }));
    expect(await screen.findByText(/sidecar reported: an error/)).toBeInTheDocument();

    apiMock.api.databases.publicAccess.set.mockRejectedValueOnce(new Error('port 15432 is in use'));
    fireEvent.click(screen.getByRole('button', { name: /Save and apply/ }));
    expect(await screen.findByText('port 15432 is in use')).toBeInTheDocument();
    apiMock.api.databases.publicAccess.set.mockRejectedValueOnce('boom');
    fireEvent.click(screen.getByRole('button', { name: /Save and apply/ }));
    expect(await screen.findByText('Could not apply public access')).toBeInTheDocument();
  });

  it('disables after a confirmation, and reports a failed disable', async () => {
    apiMock.api.databases.publicAccess.get.mockResolvedValue(running);
    renderCard();
    fireEvent.click(await screen.findByRole('switch', { name: 'Public access' }));
    fireEvent.click(screen.getByRole('button', { name: /Disable public access/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(apiMock.api.databases.publicAccess.disable).toHaveBeenCalledWith(7));
    expect(await screen.findByText('Public access disabled')).toBeInTheDocument();

    apiMock.api.databases.publicAccess.disable.mockRejectedValueOnce(new Error('docker unavailable'));
    fireEvent.click(await screen.findByRole('button', { name: /Disable public access/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disable' }));
    expect(await screen.findByText('docker unavailable')).toBeInTheDocument();
    apiMock.api.databases.publicAccess.disable.mockRejectedValueOnce(42);
    fireEvent.click(await screen.findByRole('button', { name: /Disable public access/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disable' }));
    expect(await screen.findByText('Could not disable public access')).toBeInTheDocument();
  });

  it('offers no TLS termination for mysql', async () => {
    renderCard({ id: 7, name: 'm', engine: 'mysql' } as never);
    fireEvent.click(await screen.findByRole('switch', { name: 'Public access' }));
    expect(screen.getByRole('option', { name: /Terminate/ })).toBeDisabled();
    expect(screen.getByText(/negotiate TLS themselves/)).toBeInTheDocument();
  });

  it('shows the masked public connection string from the cached credentials and copies it whole', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    apiMock.api.databases.publicAccess.get.mockResolvedValue(running);
    const qc = createQueryClient();
    const full = 'postgres://nine:s3cret@panel.example.com:15432/app';
    qc.setQueryData(['database-credentials', 7], { password: 's3cret', publicConnectionString: full });
    renderCard(db, qc);
    expect(await screen.findByText('postgres://nine:••••••@panel.example.com:15432/app')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Copy public connection string'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(full));
    // The card never fetches the credentials itself.
    expect(apiMock.api.databases.credentials).not.toHaveBeenCalled();
  });

  it('shows a connection string unmasked when there is no password', async () => {
    apiMock.api.databases.publicAccess.get.mockResolvedValue(running);
    const qc = createQueryClient();
    qc.setQueryData(['database-credentials', 7], { password: '', publicConnectionString: 'redis://panel.example.com:16379' });
    renderCard(db, qc);
    expect(await screen.findByText('redis://panel.example.com:16379')).toBeInTheDocument();
  });

  it('gives a database admin a read-only view', async () => {
    authMock.user = { id: 2, isOperator: false };
    apiMock.api.databases.publicAccess.get.mockResolvedValue({ ...running, tlsMode: 'terminate', tlsHostname: 'db.example.com' });
    renderCard();
    const view = await screen.findByTestId('public-access-readonly');
    expect(view).toHaveTextContent('Enabled');
    expect(view).toHaveTextContent('Terminate (db.example.com)');
    expect(view).toHaveTextContent('203.0.113.0/24');
    expect(view).toHaveTextContent('Only an instance operator');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('read-only view covers the unconfigured, disabled and plain-TLS shapes', async () => {
    authMock.user = { id: 2, isOperator: false };
    renderCard();
    expect(await screen.findByText('Public access is not configured.')).toBeInTheDocument();
  });

  it('read-only view of a disabled configuration', async () => {
    authMock.user = { id: 2, isOperator: false };
    apiMock.api.databases.publicAccess.get.mockResolvedValue({ ...running, enabled: false, port: null, tlsMode: 'terminate', status: 'off' });
    renderCard();
    const view = await screen.findByTestId('public-access-readonly');
    expect(view).toHaveTextContent('Disabled');
    expect(view).toHaveTextContent('—');
    expect(view).toHaveTextContent(/TLSTerminate/);
    authMock.user = { id: 2, isOperator: false };
  });

  it('read-only view with plain TLS', async () => {
    authMock.user = { id: 2, isOperator: false };
    apiMock.api.databases.publicAccess.get.mockResolvedValue(running);
    renderCard();
    expect(await screen.findByTestId('public-access-readonly')).toHaveTextContent(/TLSNone/);
  });

  it('explains an engine that cannot be exposed', async () => {
    apiMock.api.databases.publicAccess.get.mockResolvedValue({ ...off, supported: false });
    renderCard({ id: 7, name: 'c', engine: 'clickhouse' } as never);
    expect(await screen.findByText(/cannot be exposed through a TCP port/)).toBeInTheDocument();
  });

  it('shows a muted note on 403 and an error otherwise', async () => {
    apiMock.api.databases.publicAccess.get.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    renderCard();
    expect(await screen.findByText(/need admin rights/)).toBeInTheDocument();
  });

  it('reports a load failure', async () => {
    apiMock.api.databases.publicAccess.get.mockRejectedValue(new Error('boom'));
    renderCard();
    expect(await screen.findByText('Could not load the public access settings.')).toBeInTheDocument();
  });
});
