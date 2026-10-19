import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { MonitorView } from '@ninedeploy/schemas';
import { MonitorFormModal } from '../src/components/uptime/MonitorFormModal.js';
import { api } from '../src/lib/api.js';
import { uptimeApi } from '../src/lib/uptimeApi.js';
import { mockOf, renderWithProviders } from './helpers.js';

/** 0.16.8 monitor modal: kind-dependent fields, client-side validation, server refusals. */

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

const MONITOR: MonitorView = {
  id: 5,
  name: 'Redis',
  serviceId: null,
  kind: 'tcp',
  target: 'redis:6379',
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
  lastCheckedAt: null,
  lastResponseMs: null,
  lastStatusCode: null,
  lastError: null,
  certExpiresAt: null,
  uptime: { h24: null, d7: null, d30: null },
  createdAt: '2026-10-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockOf(api.services.list).mockResolvedValue([{ id: 3, name: 'web' }] as never);
});

function dialog() {
  return within(screen.getByRole('dialog'));
}

describe('MonitorFormModal', () => {
  it('creates an HTTP monitor with the advanced settings', async () => {
    const onClose = vi.fn();
    mockOf(uptimeApi.monitors.create).mockResolvedValue(MONITOR);
    renderWithProviders(<MonitorFormModal onClose={onClose} />);
    const d = dialog();
    fireEvent.change(d.getByLabelText('Name'), { target: { value: ' Site ' } });
    fireEvent.change(d.getByLabelText('URL'), { target: { value: 'https://example.com/health' } });
    expect(d.getByLabelText('URL')).toHaveAttribute('placeholder', 'https://example.com/health');
    fireEvent.change(d.getByLabelText('Method'), { target: { value: 'GET' } });
    fireEvent.change(d.getByLabelText('Expected status'), { target: { value: '200,204' } });
    fireEvent.change(d.getByLabelText('Keyword (optional)'), { target: { value: 'healthy' } });
    await waitFor(() => expect(d.getByRole('option', { name: 'web' })).toBeInTheDocument());
    fireEvent.change(d.getByLabelText('Service (optional)'), { target: { value: '3' } });
    fireEvent.click(d.getByRole('switch', { name: 'Enabled' }));

    fireEvent.click(d.getByRole('button', { name: /Advanced/ }));
    fireEvent.change(d.getByLabelText('Interval (s)'), { target: { value: '300' } });
    fireEvent.change(d.getByLabelText('Timeout (s)'), { target: { value: '20' } });
    fireEvent.change(d.getByLabelText('Failures before down'), { target: { value: '4' } });
    fireEvent.click(d.getByRole('switch', { name: 'Follow redirects' }));
    fireEvent.click(d.getByRole('switch', { name: 'Verify TLS certificate' }));
    fireEvent.click(d.getByRole('button', { name: /Advanced/ }));
    expect(d.queryByLabelText('Interval (s)')).not.toBeInTheDocument();

    fireEvent.click(d.getByRole('button', { name: 'Create monitor' }));
    await waitFor(() =>
      expect(uptimeApi.monitors.create).toHaveBeenCalledWith({
        name: 'Site',
        serviceId: 3,
        kind: 'http',
        target: 'https://example.com/health',
        method: 'GET',
        expectedStatus: '200,204',
        keyword: 'healthy',
        intervalSeconds: 300,
        timeoutSeconds: 20,
        failuresBeforeDown: 4,
        followRedirects: false,
        verifyTls: false,
        enabled: false,
      }),
    );
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Monitor created', 'success'));
    expect(onClose).toHaveBeenCalled();
  });

  it('switches to a TCP check and hides the HTTP-only fields', async () => {
    renderWithProviders(<MonitorFormModal onClose={vi.fn()} />);
    const d = dialog();
    expect(d.getByRole('button', { name: /HTTP\(S\)/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(d.getByRole('button', { name: /TCP port/ }));
    expect(d.getByRole('button', { name: /TCP port/ })).toHaveAttribute('aria-pressed', 'true');
    expect(d.getByLabelText('Host and port')).toHaveAttribute('placeholder', 'db.example.com:5432');
    expect(d.queryByLabelText('Method')).not.toBeInTheDocument();
    expect(d.queryByLabelText('Keyword (optional)')).not.toBeInTheDocument();
    fireEvent.click(d.getByRole('button', { name: /Advanced/ }));
    expect(d.queryByRole('switch', { name: 'Verify TLS certificate' })).not.toBeInTheDocument();
  });

  it('shows validation errors and opens the advanced section when one is there', async () => {
    renderWithProviders(<MonitorFormModal onClose={vi.fn()} />);
    const d = dialog();
    fireEvent.change(d.getByLabelText('URL'), { target: { value: 'ftp://nope' } });
    fireEvent.click(d.getByRole('button', { name: /Advanced/ }));
    fireEvent.change(d.getByLabelText('Interval (s)'), { target: { value: '5' } });
    fireEvent.click(d.getByRole('button', { name: /Advanced/ }));
    fireEvent.click(d.getByRole('button', { name: 'Create monitor' }));
    expect(await d.findByText('an HTTP target is an http:// or https:// URL')).toBeInTheDocument();
    expect(d.getByLabelText('Interval (s)')).toBeInTheDocument();
    expect(uptimeApi.monitors.create).not.toHaveBeenCalled();

    // Changing kind clears the target and keyword problems.
    fireEvent.click(d.getByRole('button', { name: /TCP port/ }));
    expect(d.queryByText('an HTTP target is an http:// or https:// URL')).not.toBeInTheDocument();
  });

  it("shows the server's refusal", async () => {
    mockOf(uptimeApi.monitors.create).mockRejectedValueOnce(new Error('the target resolves to a private address')).mockRejectedValueOnce(new Error(''));
    renderWithProviders(<MonitorFormModal prefill={{ name: 'x', target: 'http://10.0.0.1/' }} onClose={vi.fn()} />);
    const d = dialog();
    // Enter in a field submits the form.
    fireEvent.submit(d.getByLabelText('Name').closest('form')!);
    expect(await d.findByRole('alert')).toHaveTextContent('the target resolves to a private address');
    expect(toastSpy.toast).toHaveBeenCalledWith('the target resolves to a private address', 'error');
    fireEvent.click(d.getByRole('button', { name: 'Create monitor' }));
    await waitFor(() => expect(d.getByRole('alert')).toHaveTextContent('Could not save the monitor'));
  });

  it('edits an existing monitor with a patch', async () => {
    const onClose = vi.fn();
    mockOf(uptimeApi.monitors.update).mockResolvedValue(MONITOR);
    renderWithProviders(<MonitorFormModal monitor={MONITOR} onClose={onClose} />);
    const d = dialog();
    expect(screen.getByRole('dialog', { name: 'Edit Redis' })).toBeInTheDocument();
    expect(d.getByLabelText('Host and port')).toHaveValue('redis:6379');
    fireEvent.change(d.getByLabelText('Host and port'), { target: { value: 'redis:6380' } });
    fireEvent.click(d.getByRole('button', { name: 'Save monitor' }));
    await waitFor(() => expect(uptimeApi.monitors.update).toHaveBeenCalledWith(5, expect.objectContaining({ kind: 'tcp', target: 'redis:6380', keyword: null })));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Monitor saved', 'success'));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on cancel', () => {
    const onClose = vi.fn();
    renderWithProviders(<MonitorFormModal onClose={onClose} />);
    fireEvent.click(dialog().getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});
