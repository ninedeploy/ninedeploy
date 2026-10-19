import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { MonitorView } from '@ninedeploy/schemas';
import { ServiceUptimeCard } from '../src/components/uptime/ServiceUptimeCard.js';
import { api } from '../src/lib/api.js';
import { useAuth } from '../src/lib/auth.js';
import { uptimeApi } from '../src/lib/uptimeApi.js';
import { mockOf, renderWithProviders } from './helpers.js';

/** 0.16.8 Service → Overview uptime card: visibility by role, list, prefilled "Add monitor". */

vi.mock('../src/lib/api.js', async () => (await import('./apiMock.js')).createFakeApiModule());
vi.mock('../src/lib/uptimeApi.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/uptimeApi.js')>()),
  uptimeApi: (await import('./apiMock.js')).createUptimeApiMock(),
}));
vi.mock('../src/lib/auth.js', async () => (await import('./apiMock.js')).createAuthMock());
vi.mock('../src/components/Toast.js', async () => {
  const actual = await vi.importActual<typeof import('../src/components/Toast.js')>('../src/components/Toast.js');
  return { ...actual, useToast: () => ({ toast: vi.fn() }) };
});

const MONITOR: MonitorView = {
  id: 1,
  name: 'api health',
  serviceId: 3,
  kind: 'http',
  target: 'https://api.example.com/health',
  method: 'GET',
  expectedStatus: '200-399',
  keyword: null,
  intervalSeconds: 60,
  timeoutSeconds: 10,
  failuresBeforeDown: 2,
  followRedirects: true,
  verifyTls: true,
  enabled: true,
  status: 'down',
  statusSince: null,
  consecutiveFailures: 3,
  lastCheckedAt: new Date().toISOString(),
  lastResponseMs: 1500,
  lastStatusCode: 503,
  lastError: 'HTTP 503',
  certExpiresAt: null,
  uptime: { h24: 97.25, d7: 99, d30: 99 },
  createdAt: '2026-10-01T00:00:00Z',
};
const SVC = { name: 'api', autoUrl: 'api.nd.local' };

function asRole(isOperator: boolean) {
  mockOf(useAuth).mockReturnValue({ user: { id: 1, isOperator }, loading: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  asRole(true);
  mockOf(uptimeApi.monitors.list).mockResolvedValue([MONITOR]);
  mockOf(api.domains.list).mockResolvedValue([{ id: 1, hostname: 'api.example.com', path: '/', ssl: true }] as never);
  mockOf(api.services.list).mockResolvedValue([{ id: 3, name: 'api' }] as never);
});

describe('ServiceUptimeCard', () => {
  it("lists the service's monitors with state and 24h uptime", async () => {
    asRole(false);
    renderWithProviders(<ServiceUptimeCard serviceId={3} svc={SVC} />);
    const list = await screen.findByRole('list', { name: 'Service monitors' });
    expect(uptimeApi.monitors.list).toHaveBeenCalledWith(3);
    const row = within(list).getByRole('listitem');
    expect(within(row).getByText('DOWN')).toBeInTheDocument();
    expect(within(row).getByText('api health')).toBeInTheDocument();
    expect(within(row).getByText('97.25%')).toHaveClass('text-amber-300');
    expect(within(row).getByText(/1\.5 s · just now/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All monitors' })).toHaveAttribute('href', '/monitoring');
    expect(screen.queryByRole('button', { name: /Add monitor/ })).not.toBeInTheDocument();
  });

  it('stays hidden for a member when the service has no monitors, or the list fails', async () => {
    asRole(false);
    mockOf(uptimeApi.monitors.list).mockResolvedValue([]);
    const { unmount } = renderWithProviders(<ServiceUptimeCard serviceId={3} svc={SVC} />);
    await waitFor(() => expect(uptimeApi.monitors.list).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Uptime')).not.toBeInTheDocument());
    unmount();

    asRole(true);
    mockOf(uptimeApi.monitors.list).mockRejectedValue(new Error('404'));
    renderWithProviders(<ServiceUptimeCard serviceId={3} svc={SVC} />);
    // Operators see the card while it loads; a failed list removes it.
    expect(screen.getByText('Uptime')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Uptime')).not.toBeInTheDocument());
  });

  it('offers operators an empty card while loading and with no monitors', async () => {
    mockOf(uptimeApi.monitors.list).mockResolvedValue([]);
    renderWithProviders(<ServiceUptimeCard serviceId={3} svc={{ name: 'api' }} />);
    expect(screen.getByText('Loading monitors…')).toBeInTheDocument();
    expect(await screen.findByText(/No monitors for this service/)).toBeInTheDocument();
  });

  it("prefills a new monitor with the service and its first domain's URL", async () => {
    renderWithProviders(<ServiceUptimeCard serviceId={3} svc={SVC} />);
    fireEvent.click(await screen.findByRole('button', { name: /Add monitor/ }));
    const dialog = within(await screen.findByRole('dialog', { name: 'New monitor' }));
    expect(api.domains.list).toHaveBeenCalledWith(3);
    expect(dialog.getByLabelText('Name')).toHaveValue('api');
    expect(dialog.getByLabelText('URL')).toHaveValue('https://api.example.com/');
    await waitFor(() => expect(dialog.getByLabelText('Service (optional)')).toHaveValue('3'));
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('falls back to the auto URL when the domains cannot be read', async () => {
    mockOf(api.domains.list).mockRejectedValue(new Error('forbidden'));
    renderWithProviders(<ServiceUptimeCard serviceId={3} svc={SVC} />);
    fireEvent.click(await screen.findByRole('button', { name: /Add monitor/ }));
    const dialog = within(await screen.findByRole('dialog', { name: 'New monitor' }));
    expect(dialog.getByLabelText('URL')).toHaveValue('http://api.nd.local/');
  });
});
