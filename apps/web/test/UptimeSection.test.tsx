import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { MonitorView, StatusPageView } from '@ninedeploy/schemas';
import { UptimeSection, UPTIME_EMPTY_HINT, statusPageUrl } from '../src/components/uptime/UptimeSection.js';
import { api } from '../src/lib/api.js';
import { uptimeApi } from '../src/lib/uptimeApi.js';
import { mockOf, renderWithProviders } from './helpers.js';

/** 0.16.8 Monitoring → Uptime: monitor list, operator actions, status pages. */

vi.mock('../src/lib/api.js', async () => (await import('./apiMock.js')).createFakeApiModule());
vi.mock('../src/lib/uptimeApi.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/uptimeApi.js')>()),
  uptimeApi: (await import('./apiMock.js')).createUptimeApiMock(),
}));
vi.mock('../src/lib/auth.js', async () => (await import('./apiMock.js')).createAuthMock());
const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', async () => {
  const actual = await vi.importActual<typeof import('../src/components/Toast.js')>('../src/components/Toast.js');
  return { ...actual, useToast: () => toastSpy };
});
const copySpy = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/format.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/format.js')>('../src/lib/format.js');
  return { ...actual, copyText: copySpy };
});

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000 + 3_600_000).toISOString();

const UP: MonitorView = {
  id: 1,
  name: 'Website',
  serviceId: 3,
  kind: 'http',
  target: 'https://example.com/',
  method: 'GET',
  expectedStatus: '200-399',
  keyword: null,
  intervalSeconds: 60,
  timeoutSeconds: 10,
  failuresBeforeDown: 2,
  followRedirects: true,
  verifyTls: true,
  enabled: true,
  status: 'up',
  statusSince: null,
  consecutiveFailures: 0,
  lastCheckedAt: new Date().toISOString(),
  lastResponseMs: 87,
  lastStatusCode: 200,
  lastError: null,
  certExpiresAt: inDays(5),
  uptime: { h24: 100, d7: 99.5, d30: 90 },
  createdAt: '2026-10-01T00:00:00Z',
};
const DOWN: MonitorView = {
  ...UP,
  id: 2,
  name: 'Database',
  serviceId: null,
  kind: 'tcp',
  target: 'db.internal:5432',
  status: 'down',
  lastCheckedAt: null,
  lastResponseMs: null,
  lastStatusCode: null,
  lastError: 'connect ECONNREFUSED',
  certExpiresAt: null,
  uptime: { h24: null, d7: null, d30: null },
};
const PAUSED: MonitorView = { ...UP, id: 4, name: 'Old', serviceId: 99, enabled: false, status: 'paused', certExpiresAt: null };
const PAGE: StatusPageView = {
  id: 9,
  slug: 'acme',
  title: 'Acme status',
  description: null,
  notice: null,
  published: true,
  showResponseTimes: true,
  monitorIds: [1],
  path: '/status/acme',
  createdAt: '2026-10-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockOf(uptimeApi.monitors.list).mockResolvedValue([UP, DOWN, PAUSED]);
  mockOf(uptimeApi.monitors.checks).mockResolvedValue([
    { ts: '2', ok: true, responseMs: 90, statusCode: 200, error: null },
    { ts: '1', ok: true, responseMs: 80, statusCode: 200, error: null },
  ]);
  mockOf(uptimeApi.statusPages.list).mockResolvedValue([PAGE, { ...PAGE, id: 10, slug: 'draft', title: 'Draft page', published: false, monitorIds: [1, 2], path: '/status/draft' }]);
  mockOf(api.services.list).mockResolvedValue([{ id: 3, name: 'web' }] as never);
  copySpy.mockResolvedValue(true);
});

describe('UptimeSection', () => {
  it('lists monitors with state, uptime, errors and certificate expiry', async () => {
    renderWithProviders(<UptimeSection isOperator />);
    const list = await screen.findByRole('list', { name: 'Monitors' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);

    const up = within(rows[0]!);
    expect(up.getByText('UP')).toBeInTheDocument();
    expect(up.getByText('https://example.com/')).toBeInTheDocument();
    expect(up.getByText('87 ms')).toBeInTheDocument();
    expect(up.getByText('100%')).toHaveClass('text-emerald-300');
    expect(up.getByText('99.5%')).toBeInTheDocument();
    expect(up.getByText('90%')).toHaveClass('text-rose-300');
    expect(up.getByText(/checked just now · every 1m · HTTP 200/)).toBeInTheDocument();
    expect(up.getByText('certificate expires in 5 days')).toHaveClass('text-amber-300');
    expect(await screen.findByRole('link', { name: 'web' })).toHaveAttribute('href', '/services/3');

    const down = within(rows[1]!);
    expect(down.getByText('DOWN')).toBeInTheDocument();
    expect(down.getByText('connect ECONNREFUSED')).toBeInTheDocument();
    expect(down.getByText(/not checked yet/)).toBeInTheDocument();
    expect(down.getAllByText('—').length).toBeGreaterThanOrEqual(3);

    expect(within(rows[2]!).getByText('PAUSED')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('service #99')).toBeInTheDocument();
    expect(screen.getByText('1 down')).toBeInTheDocument();
    expect(screen.getByText('1 up')).toBeInTheDocument();
    expect(screen.getByText('3 monitors')).toBeInTheDocument();
    await waitFor(() => expect(uptimeApi.monitors.checks).toHaveBeenCalledWith(1, 24));
  });

  it('shows the empty state, with a create button for operators only', async () => {
    mockOf(uptimeApi.monitors.list).mockResolvedValue([]);
    const { unmount } = renderWithProviders(<UptimeSection isOperator={false} />);
    expect(await screen.findByText(UPTIME_EMPTY_HINT)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New monitor/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Status pages')).not.toBeInTheDocument();
    expect(uptimeApi.statusPages.list).not.toHaveBeenCalled();
    unmount();

    renderWithProviders(<UptimeSection isOperator />);
    fireEvent.click(await screen.findByRole('button', { name: /New monitor/ }));
    expect(screen.getByRole('dialog', { name: 'New monitor' })).toBeInTheDocument();
  });

  it('hides operator actions from members', async () => {
    renderWithProviders(<UptimeSection isOperator={false} />);
    await screen.findByRole('list', { name: 'Monitors' });
    expect(screen.queryByRole('button', { name: /Check Website now/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New monitor/ })).not.toBeInTheDocument();
  });

  it('shows an error card with retry when the list fails', async () => {
    mockOf(uptimeApi.monitors.list).mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<UptimeSection isOperator={false} />);
    expect(await screen.findByText("Couldn't load monitors")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Monitors' })).toBeInTheDocument();
  });

  it('checks now and reports the result', async () => {
    mockOf(uptimeApi.monitors.check)
      .mockResolvedValueOnce({ check: { ts: 'x', ok: true, responseMs: 42, statusCode: 200, error: null }, monitor: UP })
      .mockResolvedValueOnce({ check: { ts: 'x', ok: true, responseMs: null, statusCode: 200, error: null }, monitor: UP })
      .mockResolvedValueOnce({ check: { ts: 'x', ok: false, responseMs: null, statusCode: null, error: 'timeout' }, monitor: DOWN })
      .mockResolvedValueOnce({ check: { ts: 'x', ok: false, responseMs: 10, statusCode: 503, error: null }, monitor: DOWN })
      .mockResolvedValueOnce({ check: { ts: 'x', ok: false, responseMs: null, statusCode: null, error: null }, monitor: DOWN })
      .mockRejectedValueOnce(new Error('not found'))
      .mockRejectedValueOnce(new Error(''));
    renderWithProviders(<UptimeSection isOperator />);
    const button = await screen.findByRole('button', { name: 'Check Website now' });
    const expected: Array<[string, string]> = [
      ['Check passed in 42 ms', 'success'],
      ['Check passed', 'success'],
      ['Check failed: timeout', 'error'],
      ['Check failed: HTTP 503', 'error'],
      ['Check failed: no response', 'error'],
      ['not found', 'error'],
      ['Could not run the check', 'error'],
    ];
    for (const [message, tone] of expected) {
      await waitFor(() => expect(button).not.toBeDisabled());
      fireEvent.click(button);
      await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith(message, tone));
    }
    expect(uptimeApi.monitors.check).toHaveBeenCalledWith(1);
  });

  it('pauses and resumes a monitor', async () => {
    mockOf(uptimeApi.monitors.update).mockResolvedValueOnce(UP).mockResolvedValueOnce(UP).mockRejectedValueOnce(new Error('')).mockRejectedValueOnce(new Error('locked'));
    renderWithProviders(<UptimeSection isOperator />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pause Website' }));
    await waitFor(() => expect(uptimeApi.monitors.update).toHaveBeenCalledWith(1, { enabled: false }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Monitor paused', 'success'));
    fireEvent.click(screen.getByRole('button', { name: 'Resume Old' }));
    await waitFor(() => expect(uptimeApi.monitors.update).toHaveBeenCalledWith(4, { enabled: true }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Monitor resumed', 'success'));
    fireEvent.click(screen.getByRole('button', { name: 'Pause Website' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not update the monitor', 'error'));
    fireEvent.click(screen.getByRole('button', { name: 'Pause Website' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('locked', 'error'));
  });

  it('deletes a monitor after the confirm dialog', async () => {
    mockOf(uptimeApi.monitors.remove).mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('')).mockRejectedValueOnce(new Error('in use'));
    renderWithProviders(<UptimeSection isOperator />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Database' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this monitor?' });
    expect(within(dialog).getByText(/Database and its check history/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(uptimeApi.monitors.remove).toHaveBeenCalledWith(2));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Monitor deleted', 'success'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Database' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not delete the monitor', 'error'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Database' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('in use', 'error'));

    fireEvent.click(screen.getByRole('button', { name: 'Delete Database' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(uptimeApi.monitors.remove).toHaveBeenCalledTimes(3);
  });

  it('opens a monitor for editing', async () => {
    mockOf(uptimeApi.monitors.update).mockResolvedValue(UP);
    renderWithProviders(<UptimeSection isOperator />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Website' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit Website' });
    expect(within(dialog).getByLabelText('URL')).toHaveValue('https://example.com/');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save monitor' }));
    await waitFor(() => expect(uptimeApi.monitors.update).toHaveBeenCalledWith(1, expect.objectContaining({ name: 'Website', serviceId: 3 })));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // With monitors listed, the header carries the create button.
    fireEvent.click(screen.getByRole('button', { name: /New monitor/ }));
    expect(screen.getByRole('dialog', { name: 'New monitor' })).toBeInTheDocument();
  });

  describe('status pages', () => {
    it('lists pages with a published badge, link and copy', async () => {
      copySpy.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      renderWithProviders(<UptimeSection isOperator />);
      const list = await screen.findByRole('list', { name: 'Status pages' });
      const rows = within(list).getAllByRole('listitem');
      expect(within(rows[0]!).getByText('Published')).toBeInTheDocument();
      expect(within(rows[0]!).getByText(/\/status\/acme · 1 monitor$/)).toBeInTheDocument();
      expect(within(rows[1]!).getByText('Draft')).toBeInTheDocument();
      expect(within(rows[1]!).getByText(/2 monitors$/)).toBeInTheDocument();
      const open = within(rows[0]!).getByRole('link', { name: 'Open Acme status' });
      expect(open).toHaveAttribute('href', '/status/acme');
      expect(open).toHaveAttribute('target', '_blank');

      fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Copy link to Acme status' }));
      await waitFor(() => expect(copySpy).toHaveBeenCalledWith('http://localhost/status/acme'));
      await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Link copied', 'success'));
      fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Copy link to Acme status' }));
      await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not copy the link', 'error'));
      expect(statusPageUrl({ path: '/status/x' })).toBe('http://localhost/status/x');
    });

    it('shows the empty and error states', async () => {
      mockOf(uptimeApi.statusPages.list).mockResolvedValueOnce([]);
      const { unmount } = renderWithProviders(<UptimeSection isOperator />);
      expect(await screen.findByText(/No status pages yet/)).toBeInTheDocument();
      unmount();
      mockOf(uptimeApi.statusPages.list).mockRejectedValueOnce(new Error('nope'));
      renderWithProviders(<UptimeSection isOperator />);
      expect(await screen.findByText("Couldn't load status pages")).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('list', { name: 'Status pages' })).toBeInTheDocument();
    });

    it('deletes a page after the confirm dialog', async () => {
      mockOf(uptimeApi.statusPages.remove).mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('')).mockRejectedValueOnce(new Error('gone'));
      renderWithProviders(<UptimeSection isOperator />);
      for (const message of ['Status page deleted', 'Could not delete the status page', 'gone']) {
        fireEvent.click(await screen.findByRole('button', { name: 'Delete Acme status' }));
        const dialog = screen.getByRole('dialog', { name: 'Delete this status page?' });
        expect(within(dialog).getByText(/\/status\/acme stops answering/)).toBeInTheDocument();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith(message, message === 'Status page deleted' ? 'success' : 'error'));
      }
      expect(uptimeApi.statusPages.remove).toHaveBeenCalledWith(9);
    });

    it('opens the editor for a new and an existing page', async () => {
      renderWithProviders(<UptimeSection isOperator />);
      fireEvent.click(await screen.findByRole('button', { name: /New status page/ }));
      expect(screen.getByRole('dialog', { name: 'New status page' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      fireEvent.click(screen.getByRole('button', { name: 'Edit Acme status' }));
      const dialog = screen.getByRole('dialog', { name: 'Edit Acme status' });
      expect(within(dialog).getByLabelText('Slug')).toHaveValue('acme');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});
