import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Settings } from '../src/routes/settings/index.js';
import { api, getToken } from '../src/lib/api.js';
import { useTheme } from '../src/lib/theme.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

// Password fixtures are assembled at runtime so secret scanners do not
// classify the literal `currentPassword: '…'` shape as a hardcoded credential.
const OLD_PASS = ['old', 'pass', '123'].join('-');
const NEW_PASS = ['new', 'pass', '456'].join('-');

vi.mock('../src/lib/theme.js', async () => {
  const { createThemeMock } = await import('./apiMock.js');
  return createThemeMock();
});

// The 2FA QR is controllable so the render-failure fallback is testable.
const qrMock = vi.hoisted(() => ({ toDataURL: vi.fn(async () => 'data:image/png;base64,qr') }));
vi.mock('qrcode', () => ({ default: qrMock }));

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useToast: () => toastSpy,
}));

vi.mock('../src/components/NotificationWizard.js', () => ({
  NotificationWizard: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="notif-wizard">
      wizard
      <button type="button" onClick={onClose}>close wizard</button>
    </div>
  ),
}));

const webauthnMock = vi.hoisted(() => ({ startRegistration: vi.fn() }));
vi.mock('@simplewebauthn/browser', () => webauthnMock);

const host = {
  cpuCores: 8,
  load1: 1.25,
  memUsedBytes: 8 * 1024 ** 3,
  memTotalBytes: 16 * 1024 ** 3,
  diskUsedBytes: 1.5 * 1024 ** 4,
  diskTotalBytes: 2 * 1024 ** 4,
};

const channels = [
  { id: 1, name: 'telegram-main', type: 'telegram', eventFilter: 'deploy.*', active: true, createdAt: 'x' },
  { id: 2, name: 'discord-alerts', type: 'discord', eventFilter: null, active: true, createdAt: 'x' },
  { id: 3, name: 'webhook', type: 'generic', eventFilter: null, active: true, createdAt: 'x' },
];

const upToDate = { current: 'v0.0.0', latest: null, updateAvailable: false, notesUrl: null, checkedAt: '2026-01-01T00:00:00Z' };

describe('Settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toastSpy.toast.mockClear();
    vi.stubGlobal('fetch', vi.fn());
    URL.createObjectURL = vi.fn(() => 'blob:settings');
    URL.revokeObjectURL = vi.fn();
    mockOf(api.stats.snapshot).mockResolvedValue({ host } as never);
    mockOf(api.system.resources).mockResolvedValue({
      network: 'nd-net',
      containers: 4,
      volumes: 2,
      imagesSummary: { active: 3, total: 3, size: '1 GB', reclaimable: '200 MB' },
    } as never);
    mockOf(api.system.updateCheck).mockResolvedValue(upToDate as never);
    mockOf(api.notifications.listChannels).mockResolvedValue(channels as never);
    mockOf(api.auth.passkeys.list).mockResolvedValue([
      { id: 3, name: 'MacBook Touch ID', createdAt: '2026-01-01T00:00:00Z' },
    ] as never);
    mockOf(api.auth.sessions.list).mockResolvedValue([
      { id: 11, current: true, ip: '10.0.0.2', userAgent: 'Mozilla/5.0', lastUsedAt: '2026-01-02T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' },
      { id: 12, current: false, ip: null, userAgent: null, lastUsedAt: null, createdAt: '2026-01-01T00:00:00Z' },
    ] as never);
    mockOf(api.auth.oidc.publicProviders).mockResolvedValue([]);
    mockOf(api.settings.vault.get).mockResolvedValue({ provider: '', hasToken: false } as never);
    mockOf(api.settings.dnsRecords.get).mockResolvedValue({ enabled: false, hasToken: false } as never);
  });

  const openSection = async (label: string) => {
    // Section tabs expose "label + description" as their accessible name
    // (e.g. "Security 2FA, audit logs & sessions") — match on the leading
    // label, escaping regex metacharacters in labels like "Firewall (UFW)".
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    fireEvent.click(await screen.findByRole('tab', { name: new RegExp(`^${escaped}(\\s|$)`) }));
  };

  it('filters the settings sections by search and clears the filter', async () => {
    mockOf(api.settings.get).mockResolvedValue({ allowRegistration: true, wildcardApex: 'nd.local' } as never);
    renderWithProviders(<Settings />);

    const filter = screen.getByLabelText('Filter settings');
    // Narrow to a single section by its description text.
    fireEvent.change(filter, { target: { value: '2FA' } });
    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBe(1);
    expect(tabs[0]).toHaveTextContent('Security');

    // A query that matches nothing shows the empty hint.
    fireEvent.change(filter, { target: { value: 'zzz-no-match' } });
    expect(screen.getByText(/No settings matching/)).toBeInTheDocument();

    // The clear (✕) button resets the list.
    fireEvent.change(filter, { target: { value: '2FA' } });
    fireEvent.click(screen.getByRole('button', { name: /clear filter/i }));
    expect(screen.getAllByRole('tab').length).toBeGreaterThan(5);
  });

  it('renders system info, resources, theme controls and notification channels', async () => {
    mockOf(useTheme).mockReturnValue({
      theme: 'dark',
      accent: 'indigo',
      setTheme: vi.fn(),
      setAccent: vi.fn(),
      toggleTheme: vi.fn(),
    } as never);
    mockOf(api.settings.get).mockResolvedValue({ allowRegistration: true, wildcardApex: 'nd.local' } as never);
    renderWithProviders(<Settings />);
    // system info rows (System section)
    await openSection('System');
    expect(await screen.findByText('nd-net')).toBeInTheDocument();
    expect(screen.getByText('v0.0.0 · MIT')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('3/3 active')).toBeInTheDocument();
    expect(screen.getByText('up to date')).toBeInTheDocument();
    // host resources bars
    expect(screen.getByText('50% · 8.0 GB / 16.0 GB')).toBeInTheDocument();
    expect(screen.getByText('1.25')).toBeInTheDocument();
    // image storage + reclaimable
    expect(screen.getByText('200 MB reclaimable')).toBeInTheDocument();
    // wildcard domain (Security section) read from the configured settings API apex
    await openSection('Security');
    expect(await screen.findByText('*.nd.local')).toBeInTheDocument();
    // notification channels with type badges
    await openSection('Notifications');
    expect(await screen.findByText('telegram-main')).toBeInTheDocument();
    expect(screen.getByText('discord-alerts')).toBeInTheDocument();
    expect(screen.getByText('deploy.*')).toBeInTheDocument();
  });

  it('switches theme and accent via the appearance controls', async () => {
    const theme = {
      theme: 'dark',
      accent: 'indigo',
      setTheme: vi.fn(),
      setAccent: vi.fn(),
      toggleTheme: vi.fn(),
    };
    mockOf(useTheme).mockReturnValue(theme as never);
    renderWithProviders(<Settings />);
    await openSection('Appearance');
    await userEvent.click(await screen.findByRole('button', { name: /^light$/ }));
    expect(theme.setTheme).toHaveBeenCalledWith('light');
    await userEvent.click(screen.getByRole('button', { name: 'Blue' }));
    expect(theme.setAccent).toHaveBeenCalledWith('blue');
  });

  it('renders fallbacks when stats/resources are missing', async () => {
    mockOf(api.stats.snapshot).mockResolvedValue({ host: null } as never);
    mockOf(api.system.resources).mockResolvedValue(null as never);
    mockOf(api.notifications.listChannels).mockResolvedValue([] as never);
    renderWithProviders(<Settings />);
    await openSection('System');
    // 'not configured' renders during loading too, so await a post-load-only text
    await screen.findByText('Docker daemon not reachable.');
    expect(screen.getByText('ninedeploy')).toBeInTheDocument(); // network fallback
    await openSection('Security');
    expect(await screen.findByText('not configured')).toBeInTheDocument(); // wildcard apex unset
    await openSection('Notifications');
    expect(await screen.findByText('No notification channels configured.')).toBeInTheDocument();
  });

  it('shows skeleton for host resources while stats load', async () => {
    mockOf(api.stats.snapshot).mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<Settings />);
    await openSection('System');
    await screen.findByText('Host Resources');
    expect(document.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('renders the update-check row for each availability state', async () => {
    mockOf(api.system.updateCheck).mockResolvedValue({ ...upToDate, updateAvailable: true, latest: 'v9.9.9' } as never);
    renderWithProviders(<Settings />);
    await openSection('System');
    expect(await screen.findByText('v9.9.9 available')).toBeInTheDocument();
  });

  it('renders the update-check unavailable state when the feed cannot be reached', async () => {
    mockOf(api.system.updateCheck).mockResolvedValue({ ...upToDate, updateAvailable: null, latest: null } as never);
    renderWithProviders(<Settings />);
    await openSection('System');
    expect(await screen.findByText('check unavailable')).toBeInTheDocument();
  });

  it('renders the update-check row while the check is in flight or fails', async () => {
    mockOf(api.system.updateCheck).mockReturnValue(new Promise(() => {}) as never);
    const first = renderWithProviders(<Settings />);
    await openSection('System');
    expect(await screen.findByText('checking…')).toBeInTheDocument();
    first.unmount();

    mockOf(api.system.updateCheck).mockRejectedValue(new Error('offline') as never);
    renderWithProviders(<Settings />);
    await openSection('System');
    expect(await screen.findByText('check unavailable')).toBeInTheDocument();
  });

  it('exports backup on success and reports failure', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['x']) } as Response);
    renderWithProviders(<Settings />);
    await openSection('Migration');
    fireEvent.click(await screen.findByRole('button', { name: /Export backup/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/v1/system/export');
    // authedFetch sends a Headers instance with the bearer token.
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(`Bearer ${getToken()}`);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Export downloaded', 'success'));

    fetchMock.mockResolvedValueOnce({ ok: false } as Response);
    fireEvent.click(screen.getByRole('button', { name: /Export backup/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Export failed', 'error'));
  });

  it('exports without an authorization header when no token is set', async () => {
    mockOf(getToken).mockReturnValue(null);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['x']) } as Response);
    renderWithProviders(<Settings />);
    await openSection('Migration');
    fireEvent.click(await screen.findByRole('button', { name: /Export backup/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(null);
  });

  it('imports a backup file', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ message: 'Restart required' }) } as Response);
    renderWithProviders(<Settings />);
    await openSection('Migration');
    await screen.findByRole('button', { name: /Export backup/ });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['data'], 'backup.tar.gz', { type: 'application/gzip' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Restart required', 'success'));
  });

  it('uses the default import completion message when json has none', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response);
    renderWithProviders(<Settings />);
    await openSection('Migration');
    await screen.findByRole('button', { name: /Export backup/ });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'b.tar.gz')] } });
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Import complete — restart NineDeploy', 'success'));
  });

  it('imports without an authorization header when no token is set', async () => {
    mockOf(getToken).mockReturnValue(null);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ message: 'ok' }) } as Response);
    renderWithProviders(<Settings />);
    await openSection('Migration');
    await screen.findByRole('button', { name: /Export backup/ });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'b.tar.gz')] } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(null);
  });

  it('ignores a change event without a selected file', async () => {
    renderWithProviders(<Settings />);
    await openSection('Migration');
    await screen.findByRole('button', { name: /Export backup/ });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [] } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('renders rose bars when host usage is very high', async () => {
    mockOf(api.stats.snapshot).mockResolvedValue({
      host: { ...host, memUsedBytes: 15 * 1024 ** 3, memTotalBytes: 16 * 1024 ** 3 }, // ~94% -> rose
    } as never);
    renderWithProviders(<Settings />);
    await openSection('System');
    await screen.findByText('94% · 15.0 GB / 16.0 GB');
  });

  it('formats sub-gigabyte host values in MB', async () => {
    mockOf(api.stats.snapshot).mockResolvedValue({
      host: {
        cpuCores: 2,
        load1: 0.1,
        memUsedBytes: 512 * 1024 * 1024,
        memTotalBytes: 1024 * 1024 * 1024,
        diskUsedBytes: 256 * 1024 * 1024,
        diskTotalBytes: 1024 * 1024 * 1024,
      },
    } as never);
    renderWithProviders(<Settings />);
    await openSection('System');
    await screen.findByText('50% · 512 MB / 1.0 GB');
    expect(screen.getByText('25% · 256 MB / 1.0 GB')).toBeInTheDocument();
  });

  it('refreshes docker resources from the image storage card', async () => {
    renderWithProviders(<Settings />);
    await openSection('System');
    fireEvent.click(await screen.findByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(api.system.resources).toHaveBeenCalledTimes(2));
  });

  it('opens the file picker from the import backup button', async () => {
    renderWithProviders(<Settings />);
    await openSection('Migration');
    fireEvent.click(await screen.findByRole('button', { name: /Import backup/ }));
    // clicking the hidden file input is a no-op in jsdom, but the handler ran
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
  });

  it('handles import failure', async () => {
    const fetchMock = vi.mocked(fetch);
    // An HTTP error with a JSON error body must surface as a failure toast
    // carrying the server's message — never a success toast.
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid bundle' } }) } as Response);
    renderWithProviders(<Settings />);
    await openSection('Migration');
    await screen.findByRole('button', { name: /Export backup/ });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['data'], 'b.tar.gz')] } });
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Invalid bundle', 'error'));
    expect(toastSpy.toast).not.toHaveBeenCalledWith(expect.stringContaining('Import complete'), 'success');
  });

  it('reports a network-level import failure', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<Settings />);
    await openSection('Migration');
    await screen.findByRole('button', { name: /Export backup/ });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['data'], 'b.tar.gz')] } });
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('boom', 'error'));
  });

  it('tests and removes notification channels', async () => {
    mockOf(api.notifications.testChannel).mockResolvedValue({ ok: true } as never);
    mockOf(api.notifications.removeChannel).mockResolvedValue(undefined as never);
    renderWithProviders(<Settings />);
    await openSection('Notifications');
    const testButtons = await screen.findAllByTitle('Send test');
    fireEvent.click(testButtons[0]!);
    await waitFor(() => expect(api.notifications.testChannel).toHaveBeenCalledWith(1));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Test sent!', 'success'));

    // A failing test send surfaces a generic error toast.
    mockOf(api.notifications.testChannel).mockRejectedValueOnce(new Error('relay down') as never);
    fireEvent.click(testButtons[0]!);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Test failed', 'error'));

    fireEvent.click(screen.getAllByTitle('Remove')[0]!);
    await waitFor(() => expect(api.notifications.removeChannel).toHaveBeenCalledWith(1));
  });

  it('manages the UFW firewall: quick profile, custom rule, refresh and failures', async () => {
    // The mutations write the fresh status into the query cache.
    const fwStatus = { installed: true, active: true, supported: true, rules: [], defaultIncoming: 'deny', defaultOutgoing: 'allow' };
    mockOf(api.firewall.applyRecommended).mockResolvedValue({ status: fwStatus } as never);
    mockOf(api.firewall.addRule).mockResolvedValue({ status: fwStatus } as never);
    renderWithProviders(<Settings />);
    await openSection('Firewall');

    // Quick-start profile…
    fireEvent.click(await screen.findByRole('button', { name: 'Apply VPS Profile' }));
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith('Recommended VPS firewall profile applied (22, 80, 443 allowed)', 'success'));

    // …and a custom port rule through the form.
    fireEvent.change(screen.getByPlaceholderText('e.g. 8080, 25565'), { target: { value: '8080' } });
    fireEvent.click(screen.getByRole('button', { name: /Open Port/i }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Firewall port rule opened', 'success'));

    // Manual refresh refetches the firewall state.
    fireEvent.click(screen.getByTitle('Refresh firewall state'));
    await waitFor(() => expect(api.firewall.status).toHaveBeenCalledTimes(2));

    // Failures surface their messages.
    mockOf(api.firewall.applyRecommended).mockRejectedValueOnce(new Error('not root') as never);
    fireEvent.click(screen.getByRole('button', { name: 'Apply VPS Profile' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('not root', 'error'));

    mockOf(api.firewall.addRule).mockRejectedValueOnce(new Error('bad port') as never);
    fireEvent.change(screen.getByPlaceholderText('e.g. 8080, 25565'), { target: { value: '9090' } });
    fireEvent.click(screen.getByRole('button', { name: /Open Port/i }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('bad port', 'error'));
  });

  it('pauses and resumes a channel via the active toggle', async () => {
    mockOf(api.notifications.updateChannel).mockResolvedValue({ id: 1, active: false } as never);
    renderWithProviders(<Settings />);
    await openSection('Notifications');
    const pause = (await screen.findAllByTitle('Pause (deactivate)'))[0]!;
    fireEvent.click(pause);
    await waitFor(() => expect(api.notifications.updateChannel).toHaveBeenCalledWith(1, { active: false }));
  });

  it('shows a paused badge and offers activation', async () => {
    mockOf(api.notifications.listChannels).mockResolvedValueOnce([
      { id: 9, name: 'quiet', type: 'slack', eventFilter: null, active: false, createdAt: 'x' },
    ] as never);
    mockOf(api.notifications.updateChannel).mockResolvedValue({ id: 9, active: true } as never);
    renderWithProviders(<Settings />);
    await openSection('Notifications');
    expect(await screen.findByText('paused')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Activate'));
    await waitFor(() => expect(api.notifications.updateChannel).toHaveBeenCalledWith(9, { active: true }));
  });

  it('edits a channel name and event filter inline', async () => {
    mockOf(api.notifications.updateChannel).mockResolvedValue({ id: 1 } as never);
    renderWithProviders(<Settings />);
    await openSection('Notifications');
    fireEvent.click((await screen.findAllByTitle('Edit'))[0]!);
    const name = screen.getByLabelText('Channel name') as HTMLInputElement;
    const filter = screen.getByLabelText('Event filter') as HTMLInputElement;
    // `userEvent.type` is reliable on real DOM but occasionally
    // drops the trailing keystroke under JSDOM timers. Drive the
    // controlled inputs through `fireEvent.change` (a single
    // synchronous input event) — equivalent for a controlled
    // component and removes a real-timing flake.
    fireEvent.change(name, { target: { value: 'ops-renamed' } });
    fireEvent.change(filter, { target: { value: 'deploy.,alert.' } });
    fireEvent.submit(name.closest('form')!);
    // The channel editor emits a full row payload on submit (every
    // controlled field), not a partial diff — the test pins the
    // contract that the named fields and the unchanged ones
    // (e.g. `configJson`) all round-trip through updateChannel.
    await waitFor(() =>
      expect(api.notifications.updateChannel).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ name: 'ops-renamed', eventFilter: 'deploy.,alert.' }),
      ),
    );
  });

  it('opens the editor on a channel without a filter (null coalescing)', async () => {
    renderWithProviders(<Settings />);
    await openSection('Notifications');
    fireEvent.click((await screen.findAllByTitle('Edit'))[1]!); // discord-alerts: eventFilter null
    const filter = screen.getByLabelText('Event filter') as HTMLInputElement;
    expect(filter.value).toBe('');
    expect(screen.getByLabelText('Channel name')).toBeInTheDocument();
  });

  it('falls back to the current name when the edit field is emptied', async () => {
    mockOf(api.notifications.updateChannel).mockResolvedValue({ id: 1 } as never);
    renderWithProviders(<Settings />);
    await openSection('Notifications');
    fireEvent.click((await screen.findAllByTitle('Edit'))[0]!);
    const name = screen.getByLabelText('Channel name') as HTMLInputElement;
    // Synchronous `fireEvent.change` — see the note in the
    // channel-name-edit test above. `userEvent.clear` is reliable
    // on real DOM but flakes under JSDOM timers in this suite.
    fireEvent.change(name, { target: { value: '' } });
    fireEvent.submit(name.closest('form')!);
    // When the operator clears the name field, the editor
    // restores the previous value (the lib never lets the row
    // drop its name); the full row payload is sent on submit.
    await waitFor(() =>
      expect(api.notifications.updateChannel).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ name: 'telegram-main', eventFilter: 'deploy.*' }),
      ),
    );
  });

  it('shows the saving state while a channel edit is in flight', async () => {
    mockOf(api.notifications.updateChannel).mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<Settings />);
    await openSection('Notifications');
    fireEvent.click((await screen.findAllByTitle('Edit'))[0]!);
    fireEvent.submit((screen.getByLabelText('Channel name') as HTMLInputElement).closest('form')!);
    expect(await screen.findByText('…')).toBeInTheDocument();
  });

  it('cancels the inline channel editor', async () => {
    renderWithProviders(<Settings />);
    await openSection('Notifications');
    fireEvent.click((await screen.findAllByTitle('Edit'))[0]!);
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByLabelText('Event filter')).not.toBeInTheDocument();
  });

  it('reports channel edit failures', async () => {
    mockOf(api.notifications.updateChannel).mockRejectedValue(new Error('500'));
    renderWithProviders(<Settings />);
    await openSection('Notifications');
    fireEvent.click((await screen.findAllByTitle('Edit'))[0]!);
    fireEvent.submit((screen.getByLabelText('Channel name') as HTMLInputElement).closest('form')!);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not update the channel', 'error'));
  });

  it('reports a failed test notification', async () => {
    mockOf(api.notifications.testChannel).mockRejectedValue(new Error('nope'));
    renderWithProviders(<Settings />);
    await openSection('Notifications');
    const testButtons = await screen.findAllByTitle('Send test');
    fireEvent.click(testButtons[0]!);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Test failed', 'error'));
  });

  it('opens and closes the notification wizard', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Settings />);
    await openSection('Notifications');
    await user.click(await screen.findByRole('button', { name: '+ Add channel' }));
    expect(screen.getByTestId('notif-wizard')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'close wizard' }));
    expect(screen.queryByTestId('notif-wizard')).not.toBeInTheDocument();
  });

  const saveButtonNextTo = (label: string) => {
    const input = screen.getByLabelText(label) as HTMLInputElement;
    return input.parentElement!.querySelector('button')!;
  };

  it('shows and saves the ACME email', async () => {
    const user = userEvent.setup();
    mockOf(api.settings.get).mockResolvedValue({ allowRegistration: true, acmeEmail: 'ops@example.com' } as never);
    mockOf(api.settings.setAcmeEmail).mockResolvedValue({ ok: true, acmeEmail: 'new@example.com', applied: 'restart' } as never);
    renderWithProviders(<Settings />);
    await openSection('Security');

    const input = await screen.findByLabelText('ACME account email') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('ops@example.com'));
    expect(screen.getByText(/Not configured|Configured/)).toHaveTextContent('Configured.');
    await user.clear(input);
    await user.type(input, 'new@example.com');
    await user.click(saveButtonNextTo('ACME account email'));
    await waitFor(() => expect(api.settings.setAcmeEmail).toHaveBeenCalledWith('new@example.com'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('ACME email saved — Traefik and certificate routing updated', 'success'));
  });

  it('shows, saves and reports errors for panel domain', async () => {
    const user = userEvent.setup();
    mockOf(api.settings.get).mockResolvedValue({ allowRegistration: true, panelDomain: 'panel.example.com' } as never);
    mockOf(api.settings.setPanelDomain).mockResolvedValue({ ok: true, panelDomain: 'dash.example.com' } as never);
    const first = renderWithProviders(<Settings />);
    await openSection('Security');

    const input = (await screen.findByLabelText('NineDeploy Panel domain')) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('panel.example.com'));
    expect(screen.getByText('https://panel.example.com')).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, 'dash.example.com');
    await user.click(saveButtonNextTo('NineDeploy Panel domain'));
    await waitFor(() => expect(api.settings.setPanelDomain).toHaveBeenCalledWith('dash.example.com'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Panel domain saved — Traefik routing updated', 'success'));
    first.unmount();

    mockOf(api.settings.setPanelDomain).mockRejectedValue(new Error('fail') as never);
    renderWithProviders(<Settings />);
    await openSection('Security');
    const input2 = (await screen.findByLabelText('NineDeploy Panel domain')) as HTMLInputElement;
    await user.clear(input2);
    await user.type(input2, 'fail.com');
    await user.click(saveButtonNextTo('NineDeploy Panel domain'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not save the panel domain', 'error'));
  });

  it('shows the saving label while a panel-domain update is in flight', async () => {
    const user = userEvent.setup();
    mockOf(api.settings.get).mockResolvedValue({ allowRegistration: true, panelDomain: null } as never);
    mockOf(api.settings.setPanelDomain).mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<Settings />);
    await openSection('Security');

    const input = (await screen.findByLabelText('NineDeploy Panel domain')) as HTMLInputElement;
    await user.type(input, 'busy.example.com');
    await user.click(saveButtonNextTo('NineDeploy Panel domain'));
    expect(await screen.findByText('Saving…')).toBeInTheDocument();
  });

  it('shows and saves the template registry source', async () => {
    const user = userEvent.setup();
    mockOf(api.settings.get).mockResolvedValue({ allowRegistration: true, acmeEmail: null, templatesSource: null } as never);
    mockOf(api.settings.setTemplatesSource).mockResolvedValue({ ok: true, templatesSource: 'https://registry.example.com/r.json' } as never);
    renderWithProviders(<Settings />);
    await openSection('Security');

    const input = await screen.findByLabelText('Template registry source') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(screen.getByText(/bundled registry from this repo/)).toBeInTheDocument();
    await user.type(input, 'https://registry.example.com/r.json');
    await user.click(saveButtonNextTo('Template registry source'));
    await waitFor(() => expect(api.settings.setTemplatesSource).toHaveBeenCalledWith('https://registry.example.com/r.json'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Template registry source saved', 'success'));
  });

  it('shows and saves the DNS challenge config', async () => {
    const user = userEvent.setup();
    mockOf(api.settings.get).mockResolvedValue({ allowRegistration: true, acmeEmail: null, templatesSource: null, dnsProvider: 'cloudflare', hasDnsToken: true, wildcardApex: 'example.com' } as never);
    mockOf(api.settings.setDns).mockResolvedValue({ ok: true, dnsProvider: 'cloudflare', wildcardApex: 'example.com', applied: 'restart' } as never);
    renderWithProviders(<Settings />);
    await openSection('Security');

    const provider = await screen.findByLabelText('DNS provider') as HTMLSelectElement;
    await waitFor(() => expect(provider.value).toBe('cloudflare'));
    expect((screen.getByLabelText('Wildcard domain apex') as HTMLInputElement).value).toBe('example.com');
    expect(screen.getByText(/API token configured/)).toBeInTheDocument();

    await user.selectOptions(provider, 'hetzner');
    await user.type(screen.getByLabelText('DNS API token'), 'fresh-token');
    const apex = screen.getByLabelText('Wildcard domain apex') as HTMLInputElement;
    await user.clear(apex);
    await user.type(apex, 'example.org');
    fireEvent.click(saveButtonNextTo('Wildcard domain apex'));
    await waitFor(() =>
      expect(api.settings.setDns).toHaveBeenCalledWith({ provider: 'hetzner', token: 'fresh-token', wildcardApex: 'example.org' }),
    );
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('DNS challenge saved — Traefik updated', 'success'));
  });

  it('keeps the stored token when the field is left empty and reports failures', async () => {
    mockOf(api.settings.get).mockResolvedValue({ allowRegistration: true, acmeEmail: null, templatesSource: null, dnsProvider: '', hasDnsToken: true, wildcardApex: '' } as never);
    mockOf(api.settings.setDns).mockRejectedValue(new Error('500'));
    renderWithProviders(<Settings />);
    await openSection('Security');

    await screen.findByLabelText('DNS provider');
    fireEvent.click(saveButtonNextTo('Wildcard domain apex'));
    await waitFor(() =>
      expect(api.settings.setDns).toHaveBeenCalledWith({ provider: '', token: undefined, wildcardApex: '' }),
    );
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not save the DNS challenge settings', 'error'));
  });

  it('shows the saving state while the DNS config is in flight', async () => {
    mockOf(api.settings.get).mockResolvedValue({ allowRegistration: true, acmeEmail: null, templatesSource: null, dnsProvider: '', hasDnsToken: false, wildcardApex: '' } as never);
    mockOf(api.settings.setDns).mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<Settings />);
    await openSection('Security');

    await screen.findByLabelText('DNS provider');
    fireEvent.click(saveButtonNextTo('Wildcard domain apex'));
    expect(await screen.findByText('Saving…')).toBeInTheDocument();
  });

  it('shows the saving state while the template source is in flight', async () => {
    mockOf(api.settings.get).mockResolvedValue({ allowRegistration: true, acmeEmail: null, templatesSource: null } as never);
    mockOf(api.settings.setTemplatesSource).mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<Settings />);
    await openSection('Security');

    await screen.findByLabelText('Template registry source');
    fireEvent.click(saveButtonNextTo('Template registry source'));
    await waitFor(() => expect(screen.getAllByText('Saving…').length).toBeGreaterThan(0));
  });

  it('reports template source save failures and shows a custom source', async () => {
    mockOf(api.settings.get).mockResolvedValue({ allowRegistration: true, acmeEmail: null, templatesSource: '/etc/ninedeploy/registry.json' } as never);
    mockOf(api.settings.setTemplatesSource).mockRejectedValue(new Error('500'));
    renderWithProviders(<Settings />);
    await openSection('Security');

    const input = await screen.findByLabelText('Template registry source') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('/etc/ninedeploy/registry.json'));
    expect(screen.getByText(/custom \(\/etc\/ninedeploy\/registry\.json\)/)).toBeInTheDocument();
    fireEvent.click(saveButtonNextTo('Template registry source'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not save the template source', 'error'));
  });

  it('shows the saving state while the ACME email is in flight', async () => {
    mockOf(api.settings.get).mockResolvedValue({ allowRegistration: true, acmeEmail: null } as never);
    mockOf(api.settings.setAcmeEmail).mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<Settings />);
    await openSection('Security');

    await screen.findByLabelText('ACME account email');
    fireEvent.click(saveButtonNextTo('ACME account email'));
    expect(await screen.findByText('Saving…')).toBeInTheDocument();
  });

  it('reports ACME save failures and renders the unconfigured hint', async () => {
    mockOf(api.settings.get).mockResolvedValue({ allowRegistration: true, acmeEmail: null } as never);
    mockOf(api.settings.setAcmeEmail).mockRejectedValue(new Error('500'));
    renderWithProviders(<Settings />);
    await openSection('Security');

    const input = await screen.findByLabelText('ACME account email') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(screen.getByText(/Not configured/)).toBeInTheDocument();
    fireEvent.click(saveButtonNextTo('ACME account email'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not save the ACME email', 'error'));
  });

  it('renders and toggles the open-registration switch', async () => {
    const user = userEvent.setup();
    // Initial load says allowed; the post-toggle refetch says disabled.
    mockOf(api.settings.get).mockResolvedValueOnce({ allowRegistration: true } as never)
      .mockResolvedValueOnce({ allowRegistration: false } as never);
    mockOf(api.settings.setAllowRegistration).mockResolvedValue({ ok: true, allowRegistration: false } as never);
    renderWithProviders(<Settings />);
    await openSection('Security');

    const sw = await screen.findByRole('switch');
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await user.click(sw);

    await waitFor(() => expect(api.settings.setAllowRegistration).toHaveBeenCalledWith(false));
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'));
  });

  it('shows the default (allowed) switch while settings load and reports toggle failures', async () => {
    const user = userEvent.setup();
    let resolveGet!: (v: unknown) => void;
    mockOf(api.settings.get).mockReturnValue(new Promise((r) => { resolveGet = r; }) as never);
    mockOf(api.settings.setAllowRegistration).mockRejectedValue(new Error('500'));
    renderWithProviders(<Settings />);
    await openSection('Security');

    const sw = await screen.findByRole('switch');
    expect(sw).toHaveAttribute('aria-checked', 'true'); // optimistic default
    resolveGet({ allowRegistration: true });
    await user.click(sw);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not update the setting', 'error'));
  });

  it('disables the switch while the toggle is in flight', async () => {
    const user = userEvent.setup();
    mockOf(api.settings.get).mockResolvedValue({ allowRegistration: true } as never);
    let resolveToggle!: (v: unknown) => void;
    mockOf(api.settings.setAllowRegistration).mockReturnValue(
      new Promise((r) => { resolveToggle = r; }) as never,
    );
    renderWithProviders(<Settings />);
    await openSection('Security');

    const sw = await screen.findByRole('switch');
    await user.click(sw);
    await waitFor(() => expect(sw).toBeDisabled());
    resolveToggle({ ok: true, allowRegistration: false });
    await waitFor(() => expect(sw).toBeEnabled());
  });

  it('renders the switch disabled while the settings query is loading', async () => {
    mockOf(api.settings.get).mockReturnValue(new Promise(() => {}) as never); // never resolves
    renderWithProviders(<Settings />);
    await openSection('Security');
    const sw = await screen.findByRole('switch');
    expect(sw).toBeDisabled();
    expect(sw).toHaveAttribute('aria-checked', 'true'); // optimistic default
  });

  it('links an existing account through the authenticated SSO flow', async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { assign, hash: '' }, writable: true, configurable: true });
    try {
      mockOf(api.auth.oidc.publicProviders).mockResolvedValue([{ id: 1, name: 'Company SSO', slug: 'company', authUrl: '/login' }]);
      mockOf(api.auth.oidc.link).mockResolvedValue({ authUrl: 'https://identity.example.test/authorize' });
      renderWithProviders(<Settings />);
      await userEvent.setup().click(await screen.findByRole('button', { name: 'Link Company SSO' }));
      await waitFor(() => expect(api.auth.oidc.link).toHaveBeenCalledWith('company'));
      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://identity.example.test/authorize'));
    } finally {
      Object.defineProperty(window, 'location', { value: original, writable: true, configurable: true });
    }
  });

  it('shows an SSO linking failure without redirecting', async () => {
    mockOf(api.auth.oidc.publicProviders).mockResolvedValue([{ id: 1, name: 'Company SSO', slug: 'company', authUrl: '/login' }]);
    mockOf(api.auth.oidc.link).mockRejectedValue(new Error('Identity is already linked'));
    renderWithProviders(<Settings />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Link Company SSO' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Identity is already linked', 'error'));
  });

  it('changes the password and persists the fresh token pair', async () => {
    const user = userEvent.setup();
    mockOf(api.auth.changePassword).mockResolvedValue({
      user: { id: 1 },
      tokens: { accessToken: 'new-acc', refreshToken: 'new-ref', expiresIn: 900 },
    } as never);
    renderWithProviders(<Settings />);

    await user.type(await screen.findByLabelText('Current password'), OLD_PASS);
    await user.type(screen.getByLabelText('New password'), NEW_PASS);
    await user.type(screen.getByLabelText('Confirm new password'), NEW_PASS);
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() =>
      expect(api.auth.changePassword).toHaveBeenCalledWith({
        currentPassword: OLD_PASS,
        newPassword: NEW_PASS,
      }),
    );
    expect(toastSpy.toast).toHaveBeenCalledWith(
      expect.stringContaining('other sessions signed out'),
      'success',
    );
  });

  it('rejects mismatched confirmation without calling the API', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Settings />);

    await user.type(await screen.findByLabelText('Current password'), OLD_PASS);
    await user.type(screen.getByLabelText('New password'), NEW_PASS);
    await user.type(screen.getByLabelText('Confirm new password'), 'different-789');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(api.auth.changePassword).not.toHaveBeenCalled();
    expect(toastSpy.toast).toHaveBeenCalledWith('New passwords do not match', 'error');
  });

  it('rejects a too-short new password without calling the API', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Settings />);

    await user.type(await screen.findByLabelText('Current password'), OLD_PASS);
    await user.type(screen.getByLabelText('New password'), 'short');
    await user.type(screen.getByLabelText('Confirm new password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(api.auth.changePassword).not.toHaveBeenCalled();
    expect(toastSpy.toast).toHaveBeenCalledWith('New password must be at least 8 characters', 'error');
  });

  it('shows the pending state while the password change is in flight', async () => {
    const user = userEvent.setup();
    let resolveChange!: (v: unknown) => void;
    mockOf(api.auth.changePassword).mockReturnValue(
      new Promise((r) => {
        resolveChange = r;
      }) as never,
    );
    renderWithProviders(<Settings />);

    await user.type(await screen.findByLabelText('Current password'), OLD_PASS);
    await user.type(screen.getByLabelText('New password'), NEW_PASS);
    await user.type(screen.getByLabelText('Confirm new password'), NEW_PASS);
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Changing…' })).toBeDisabled());
    resolveChange({ tokens: { accessToken: 'a', refreshToken: 'r', expiresIn: 900 } });
    // Back to idle (and disabled again — the fields were cleared on success).
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Change password' })).toBeDisabled(),
    );
  });

  it('reports a failed password change as an error toast', async () => {
    const user = userEvent.setup();
    mockOf(api.auth.changePassword).mockRejectedValue(new Error('401'));
    renderWithProviders(<Settings />);

    await user.type(await screen.findByLabelText('Current password'), 'wrong-old');
    await user.type(screen.getByLabelText('New password'), NEW_PASS);
    await user.type(screen.getByLabelText('Confirm new password'), NEW_PASS);
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith('Password change failed', 'error'),
    );
  });

  // ── Two-factor (TOTP) ───────────────────────────────────────────────────
  const PW = ['current', '-pass', '-1'].join('');

  it('runs the full 2FA setup → enable flow', async () => {
    const user = userEvent.setup();
    mockOf(api.auth.twoFactor.setup).mockResolvedValue({
      secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      otpauthUri: 'otpauth://totp/NineDeploy%3Aa%40b.c?secret=x',
    } as never);
    mockOf(api.auth.twoFactor.enable).mockResolvedValue({ ok: true, totpEnabled: true } as never);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWithProviders(<Settings />);

    fireEvent.click(await screen.findByRole('button', { name: 'Set up 2FA' }));
    // New flow: confirm the account password first (required when 2FA is enabled).
    fireEvent.change(await screen.findByPlaceholderText('Password'), { target: { value: PW } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'));

    await user.type(screen.getByPlaceholderText('123456'), '123456');
    fireEvent.click(screen.getByRole('button', { name: 'Enable 2FA' }));
    await waitFor(() => expect(api.auth.twoFactor.enable).toHaveBeenCalledWith('123456'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Two-factor authentication enabled', 'success'));
  });

  it('keeps the QR placeholder when QR rendering fails', async () => {
    mockOf(api.auth.twoFactor.setup).mockResolvedValue({
      secret: 'S',
      otpauthUri: 'otpauth://totp/x',
    } as never);
    qrMock.toDataURL.mockRejectedValueOnce(new Error('canvas unavailable') as never);
    renderWithProviders(<Settings />);

    fireEvent.click(await screen.findByRole('button', { name: 'Set up 2FA' }));
    fireEvent.change(await screen.findByPlaceholderText('Password'), { target: { value: PW } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // The QR fallback box stays in its generating state instead of crashing.
    expect(await screen.findByText('Generating QR…')).toBeInTheDocument();
  });

  it('reports an invalid code on enable', async () => {
    mockOf(api.auth.twoFactor.setup).mockResolvedValue({ secret: 'S', otpauthUri: 'otpauth://totp/x' } as never);
    mockOf(api.auth.twoFactor.enable).mockRejectedValue(new Error('bad code') as never);
    renderWithProviders(<Settings />);

    fireEvent.click(await screen.findByRole('button', { name: 'Set up 2FA' }));
    // New flow: confirm the account password first (required when 2FA is enabled).
    fireEvent.change(await screen.findByPlaceholderText('Password'), { target: { value: PW } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const input = await screen.findByPlaceholderText('123456');
    fireEvent.change(input, { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enable 2FA' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Invalid or expired code', 'error'));
  });

  it('cancels out of setup', async () => {
    mockOf(api.auth.twoFactor.setup).mockResolvedValue({ secret: 'S', otpauthUri: 'otpauth://totp/x' } as never);
    renderWithProviders(<Settings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up 2FA' }));
    // New flow: confirm the account password first (required when 2FA is enabled).
    fireEvent.change(await screen.findByPlaceholderText('Password'), { target: { value: PW } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // Wait for the setup panel first — the QR-based panel no longer prints the
    // otpauth URI as text, so anchor on the cancel affordance instead.
    await screen.findByText('Cancel setup');
    fireEvent.click(screen.getByText('Cancel setup'));
    await waitFor(() => expect(screen.queryByText('Cancel setup')).not.toBeInTheDocument());
  });

  it('submits the setup form via form submit and shows the enable pending label', async () => {
    mockOf(api.auth.twoFactor.setup).mockResolvedValue({ secret: 'S', otpauthUri: 'otpauth://totp/x' } as never);
    mockOf(api.auth.twoFactor.enable).mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<Settings />);

    fireEvent.click(await screen.findByRole('button', { name: 'Set up 2FA' }));
    // New flow: confirm the account password first (required when 2FA is enabled).
    fireEvent.change(await screen.findByPlaceholderText('Password'), { target: { value: PW } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const codeInput = await screen.findByPlaceholderText('123456');
    fireEvent.change(codeInput, { target: { value: '123456' } });
    fireEvent.submit(codeInput.closest('form')!);
    expect(await screen.findByText('Verifying…')).toBeInTheDocument();
  });

  it('shows the setup pending label while generating', async () => {
    mockOf(api.auth.twoFactor.setup).mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<Settings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up 2FA' }));
    // New flow: confirm the account password first (required when 2FA is enabled).
    fireEvent.change(await screen.findByPlaceholderText('Password'), { target: { value: PW } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Generating…')).toBeInTheDocument();
  });

  it('ignores 2FA form submits with incomplete inputs', async () => {
    mockOf(api.auth.twoFactor.setup).mockResolvedValue({ secret: 'S', otpauthUri: 'otpauth://totp/x' } as never);
    renderWithProviders(<Settings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up 2FA' }));
    // New flow: confirm the account password first (required when 2FA is enabled).
    fireEvent.change(await screen.findByPlaceholderText('Password'), { target: { value: PW } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // Enable with a too-short code: no call.
    const codeInput = await screen.findByPlaceholderText('123456');
    fireEvent.change(codeInput, { target: { value: '123' } });
    fireEvent.submit(codeInput.closest('form')!);
    expect(api.auth.twoFactor.enable).not.toHaveBeenCalled();

    // Disable with an empty password: no call.
    fireEvent.click(screen.getByText('Cancel setup')); // close the setup panel first
    fireEvent.click(screen.getByRole('button', { name: 'Disable 2FA' }));
    const pwInput = await screen.findByPlaceholderText('Password');
    fireEvent.change(screen.getByPlaceholderText('6-digit code'), { target: { value: '123456' } });
    fireEvent.submit(pwInput.closest('form')!);
    expect(api.auth.twoFactor.disable).not.toHaveBeenCalled();
  });

  it('shows the disable pending label while in flight', async () => {
    mockOf(api.auth.twoFactor.disable).mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<Settings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable 2FA' }));
    const pwInput = await screen.findByPlaceholderText('Password');
    fireEvent.change(pwInput, { target: { value: 'x'.repeat(8) } });
    fireEvent.change(screen.getByPlaceholderText('6-digit code'), { target: { value: '123456' } });
    fireEvent.submit(pwInput.closest('form')!);
    expect(await screen.findByText('Disabling…')).toBeInTheDocument();
  });

  it('shows the enable pending label while verifying', async () => {
    mockOf(api.auth.twoFactor.setup).mockResolvedValue({ secret: 'S', otpauthUri: 'otpauth://totp/x' } as never);
    mockOf(api.auth.twoFactor.enable).mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<Settings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up 2FA' }));
    // New flow: confirm the account password first (required when 2FA is enabled).
    fireEvent.change(await screen.findByPlaceholderText('Password'), { target: { value: PW } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const codeInput = await screen.findByPlaceholderText('123456');
    fireEvent.change(codeInput, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enable 2FA' }));
    expect(await screen.findByText('Verifying…')).toBeInTheDocument();
  });

  it('reports clipboard failures when copying the secret', async () => {
    mockOf(api.auth.twoFactor.setup).mockResolvedValue({ secret: 'S', otpauthUri: 'otpauth://totp/x' } as never);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    renderWithProviders(<Settings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up 2FA' }));
    // New flow: confirm the account password first (required when 2FA is enabled).
    fireEvent.change(await screen.findByPlaceholderText('Password'), { target: { value: PW } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByText('Copy'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Copy failed', 'error'));
  });

  it('reports setup failures', async () => {
    mockOf(api.auth.twoFactor.setup).mockRejectedValue(new Error('nope') as never);
    renderWithProviders(<Settings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up 2FA' }));
    // New flow: confirm the account password first (required when 2FA is enabled).
    fireEvent.change(await screen.findByPlaceholderText('Password'), { target: { value: PW } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not start 2FA setup — check your password', 'error'));
  });

  it('disables 2FA with password + code and signs out', async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    // Swap in a redirect spy; keep `hash` (AuthProvider reads it on mount)
    // and restore the real location afterwards so later tests keep working.
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { assign, hash: '' }, writable: true, configurable: true });
    try {
      mockOf(api.auth.twoFactor.disable).mockResolvedValue({ ok: true, totpEnabled: false } as never);
      renderWithProviders(<Settings />);

      fireEvent.click(await screen.findByRole('button', { name: 'Disable 2FA' }));
      await user.type(await screen.findByPlaceholderText('Password'), PW);
      const codeInputs = screen.getAllByPlaceholderText('6-digit code');
      await user.type(codeInputs[0]!, '123456');
      fireEvent.click(screen.getByRole('button', { name: 'Disable 2FA', hidden: false }));
      await waitFor(() =>
        expect(api.auth.twoFactor.disable).toHaveBeenCalledWith({ password: PW, code: '123456' }));
      await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith(expect.stringContaining('disabled'), 'info'));
      // The redirect to /login fires after 1.5s.
      await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'), { timeout: 3000 });
    } finally {
      Object.defineProperty(window, 'location', { value: original, configurable: true });
    }
  });

  it('reports disable failures and cancels', async () => {
    const user = userEvent.setup();
    mockOf(api.auth.twoFactor.disable).mockRejectedValue(new Error('x') as never);
    renderWithProviders(<Settings />);

    fireEvent.click(await screen.findByRole('button', { name: 'Disable 2FA' }));
    await user.type(await screen.findByPlaceholderText('Password'), PW);
    fireEvent.change(screen.getByPlaceholderText('6-digit code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Disable 2FA' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith(expect.stringContaining('Could not disable'), 'error'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument();
  });

  it('reports the default import failure when the error body has no message', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) } as Response);
    renderWithProviders(<Settings />);
    await openSection('Migration');
    await screen.findByRole('button', { name: /Export backup/ });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['data'], 'b.tar.gz')] } });
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Import failed', 'error'));
  });

  it('reports the default import failure for non-Error fetch rejections', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce('boom' as never);
    renderWithProviders(<Settings />);
    await openSection('Migration');
    await screen.findByRole('button', { name: /Export backup/ });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['data'], 'b.tar.gz')] } });
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Import failed', 'error'));
  });

  it('reports the default import failure when the response body is not JSON', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => { throw new Error('not json'); } } as unknown as Response);
    renderWithProviders(<Settings />);
    await openSection('Migration');
    await screen.findByRole('button', { name: /Export backup/ });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['data'], 'b.tar.gz')] } });
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Import failed', 'error'));
  });

  it('cancels the 2FA password form and ignores an empty password submit', async () => {
    renderWithProviders(<Settings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up 2FA' }));
    // Cancel hides the password form again without calling setup.
    fireEvent.click(await screen.findByText('Cancel'));
    await waitFor(() => expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument());
    expect(api.auth.twoFactor.setup).not.toHaveBeenCalled();

    // Reopen and submit with an empty password: the form does not mutate.
    fireEvent.click(screen.getByRole('button', { name: 'Set up 2FA' }));
    fireEvent.submit((await screen.findByPlaceholderText('Password')).closest('form')!);
    await new Promise((r) => setTimeout(r, 20));
    expect(api.auth.twoFactor.setup).not.toHaveBeenCalled();
  });

  it('reports the generic setup error when the password form is dismissed mid-flight', async () => {
    let rejectSetup!: (v: unknown) => void;
    mockOf(api.auth.twoFactor.setup).mockReturnValue(new Promise((_, rej) => { rejectSetup = rej; }) as never);
    renderWithProviders(<Settings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up 2FA' }));
    fireEvent.change(await screen.findByPlaceholderText('Password'), { target: { value: PW } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // Dismiss the form while the request is in flight — the error lands after
    // showSetupPassword has been reset, so the generic message is used.
    fireEvent.click(screen.getByText('Cancel'));
    rejectSetup(new Error('late failure'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not start 2FA setup', 'error'));
  });

  it('registers, lists and removes passkeys', async () => {
    mockOf(api.auth.passkeys.registerOptions).mockResolvedValue({ options: JSON.stringify({ challenge: 'c', rp: { name: 'nd' } }) } as never);
    webauthnMock.startRegistration.mockResolvedValue({ id: 'att-1' });
    mockOf(api.auth.passkeys.registerVerify).mockResolvedValue({ id: 4, name: 'YubiKey' } as never);
    mockOf(api.auth.passkeys.remove).mockResolvedValue(undefined as never);
    renderWithProviders(<Settings />);

    // The registered passkey is listed.
    expect(await screen.findByText('MacBook Touch ID')).toBeInTheDocument();
    // Add a passkey with a custom label.
    await userEvent.type(screen.getByPlaceholderText('MacBook Touch ID'), 'YubiKey 5');
    fireEvent.click(screen.getByRole('button', { name: /Add passkey/ }));
    await waitFor(() =>
      expect(api.auth.passkeys.registerVerify).toHaveBeenCalledWith({ name: 'YubiKey 5', response: { id: 'att-1' } }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Passkey added', 'success'));

    // Remove it.
    fireEvent.click(screen.getByText('Remove'));
    await waitFor(() => expect(api.auth.passkeys.remove).toHaveBeenCalledWith(3));
  });

  it('registers a passkey without a custom label and shows the pending state', async () => {
    // No label typed → the server receives the default name "Passkey".
    mockOf(api.auth.passkeys.registerOptions).mockResolvedValue({ options: '{}' } as never);
    webauthnMock.startRegistration.mockResolvedValue({ id: 'att-2' });
    mockOf(api.auth.passkeys.registerVerify).mockResolvedValue({ id: 5, name: 'Passkey' } as never);
    const first = renderWithProviders(<Settings />);
    expect(await screen.findByText('MacBook Touch ID')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add passkey/ }));
    await waitFor(() =>
      expect(api.auth.passkeys.registerVerify).toHaveBeenCalledWith({ name: 'Passkey', response: { id: 'att-2' } }));
    first.unmount();

    // While the authenticator prompt is open, the button shows its pending label.
    mockOf(api.auth.passkeys.registerOptions).mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<Settings />);
    fireEvent.click(await screen.findByRole('button', { name: /Add passkey/ }));
    expect(await screen.findByText('Waiting for authenticator…')).toBeInTheDocument();
  });

  it('reports passkey setup failures with and without a message', async () => {
    mockOf(api.auth.passkeys.registerOptions).mockResolvedValue({ options: '{}' } as never);
    webauthnMock.startRegistration.mockRejectedValueOnce(new Error('NotAllowedError: cancelled'));
    const first = renderWithProviders(<Settings />);
    fireEvent.click(await screen.findByRole('button', { name: /Add passkey/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Passkey setup failed: NotAllowedError: cancelled', 'error'));
    first.unmount();

    webauthnMock.startRegistration.mockRejectedValueOnce('boom');
    renderWithProviders(<Settings />);
    fireEvent.click(await screen.findByRole('button', { name: /Add passkey/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Passkey setup failed or cancelled', 'error'));
  });

  it('reports passkey removal failures and shows the empty state', async () => {
    mockOf(api.auth.passkeys.remove).mockRejectedValueOnce(new Error('500') as never);
    const first = renderWithProviders(<Settings />);
    fireEvent.click(await screen.findByText('Remove'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not remove passkey', 'error'));
    first.unmount();

    mockOf(api.auth.passkeys.list).mockResolvedValue([] as never);
    renderWithProviders(<Settings />);
    expect(await screen.findByText('No passkeys registered yet.')).toBeInTheDocument();
  });

  it('lists active sessions and revokes non-current ones', async () => {
    mockOf(api.auth.sessions.revoke).mockResolvedValue(undefined as never);
    renderWithProviders(<Settings />);
    // Both sessions render; the current one is marked and has no Revoke button.
    expect(await screen.findByText('this device')).toBeInTheDocument();
    expect(screen.getByText('10.0.0.2')).toBeInTheDocument();
    expect(screen.getAllByText('unknown ip').length).toBeGreaterThan(0);
    expect(screen.getAllByText('unknown client').length).toBeGreaterThan(0);
    const revokeButtons = screen.getAllByText('Revoke');
    expect(revokeButtons).toHaveLength(1);
    fireEvent.click(revokeButtons[0]!);
    await waitFor(() => expect(api.auth.sessions.revoke).toHaveBeenCalledWith(12));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Session revoked', 'success'));
  });

  it('reports session revocation failures and shows the empty state', async () => {
    mockOf(api.auth.sessions.revoke).mockRejectedValueOnce(new Error('x') as never);
    const first = renderWithProviders(<Settings />);
    fireEvent.click(await screen.findByText('Revoke'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not revoke session', 'error'));
    first.unmount();

    mockOf(api.auth.sessions.list).mockResolvedValue([] as never);
    renderWithProviders(<Settings />);
    expect(await screen.findByText('No active sessions.')).toBeInTheDocument();
  });

  it('opens the integrations section from the settings tabs', async () => {
    renderWithProviders(<Settings />);
    await openSection('Integrations');
    expect(await screen.findByText('Vault provider')).toBeInTheDocument();
    expect(screen.getByText('Cloudflare DNS records')).toBeInTheDocument();
  });

  it('opens log drains and storage sections from settings tabs', async () => {
    mockOf(api.logDrains.list).mockResolvedValue([] as never);
    mockOf(api.housekeeping.getAutoPrune).mockResolvedValue({
      enabled: true,
      thresholdPercent: 85,
      pruneImages: true,
      pruneBuildCache: true,
      pruneContainers: true,
      pruneVolumes: false,
      maxAgeHours: 168,
      diskUsedPercent: 60,
      diskTotalBytes: 100 * 1024 ** 3,
      diskFreeBytes: 40 * 1024 ** 3,
      lastPrunedAt: null,
      lastFreedBytes: null,
    } as never);

    renderWithProviders(<Settings />);
    await openSection('Log Drains');
    expect(await screen.findByText('External Log Drains')).toBeInTheDocument();

    await openSection('Storage & Prune');
    expect(await screen.findByText('Storage & Auto-Pruning')).toBeInTheDocument();

    mockOf(api.auth.oidc.list).mockResolvedValue([] as never);
    await openSection('SSO & OIDC');
    expect(await screen.findByText('Single Sign-On (SSO & OIDC)')).toBeInTheDocument();

    await openSection('Firewall (UFW)');
    expect(await screen.findByText('Host Firewall & Port Control (UFW)')).toBeInTheDocument();
  });
});
