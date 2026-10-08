import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => (await import('./apiMock.js')).createFakeApiModule());
vi.mock('../src/lib/auth.js', async () => (await import('./apiMock.js')).createAuthMock());

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', async () => {
  const actual = await vi.importActual<typeof import('../src/components/Toast.js')>('../src/components/Toast.js');
  return { ...actual, useToast: () => toastSpy };
});

import { api } from '../src/lib/api.js';
import { TrafficAnalyticsCard } from '../src/routes/traefik/TrafficAnalyticsCard.js';
import { ServiceTrafficCard } from '../src/routes/service/ServiceTrafficCard.js';
import { TrafficChart, TrafficScopeTable, errorRate, formatMs } from '../src/components/traffic/TrafficChart.js';

const zero = { requests: 0, status1xx: 0, status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0, statusOther: 0, bytesOut: 0, durationSumMs: 0, durationMaxMs: 0 };
const counters = (over: Partial<typeof zero> = {}) => ({ ...zero, ...over });
const pct = { p50Ms: 12, p95Ms: 1500, p99Ms: null };
const scope = (key: string, over: Record<string, unknown> = {}) => ({
  ...counters({ requests: 10, status2xx: 9, status5xx: 1, bytesOut: 2048 }),
  ...pct,
  scopeKey: key,
  domainId: null,
  serviceId: null,
  host: null,
  ...over,
});
const bucket = (t: string, over: Partial<typeof zero> = {}) => ({ t, ...counters(over) });

const SETTINGS = {
  enabled: false,
  retentionDays: 30,
  status: 'off' as const,
  lastError: null,
  lastIngestAt: null,
  logBytes: 0,
  malformedLines: 0,
  dockerLogDriver: null,
};
const SUMMARY = {
  enabled: true,
  range: '24h' as const,
  granularity: 60 as const,
  totals: { ...counters({ requests: 20, status2xx: 18, status5xx: 2, bytesOut: 4096, durationSumMs: 400 }), ...pct },
  series: [bucket('2026-10-08T10:00:00.000Z', { requests: 5, status2xx: 3, status4xx: 1, status1xx: 1, durationSumMs: 50 }), bucket('2026-10-08T10:01:00.000Z')],
  topDomains: [scope('d:1', { domainId: 1, serviceId: 2, host: 'app.example.com' })],
  panel: scope('panel'),
  custom: null,
};

describe('Traefik → Traffic analytics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enables analytics after the restart warning and shows the instance summary', async () => {
    mockOf(api.traffic.settings.get).mockResolvedValue(SETTINGS);
    mockOf(api.traffic.settings.set).mockResolvedValue({ ...SETTINGS, enabled: true, status: 'running', lastIngestAt: '2026-10-08T10:00:00.000Z', dockerLogDriver: 'json-file' });
    mockOf(api.traffic.summary).mockResolvedValue(SUMMARY);
    renderWithProviders(<TrafficAnalyticsCard />);
    expect(await screen.findByText('off')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Traffic analytics' }));
    expect(screen.getByText(/recreates the Traefik container once/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.traffic.settings.set).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('switch', { name: 'Traffic analytics' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enable and restart Traefik' }));
    await waitFor(() => expect(api.traffic.settings.set).toHaveBeenCalledWith({ enabled: true }));
    expect(await screen.findByText('app.example.com')).toBeInTheDocument();
    expect(screen.getByText('panel')).toBeInTheDocument();
    expect(screen.getByText('json-file')).toBeInTheDocument();
    expect(api.traffic.summary).toHaveBeenCalledWith({ range: '24h' });
    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    await waitFor(() => expect(api.traffic.summary).toHaveBeenCalledWith({ range: '7d' }));
  });

  it('re-reads the settings when the answer is lost to the proxy restart', async () => {
    mockOf(api.traffic.settings.get).mockResolvedValueOnce({ ...SETTINGS, enabled: true, status: 'running' }).mockResolvedValue(SETTINGS);
    mockOf(api.traffic.summary).mockResolvedValue({ ...SUMMARY, series: [], topDomains: [], panel: null });
    mockOf(api.traffic.settings.set).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderWithProviders(<TrafficAnalyticsCard />);
    expect(await screen.findByText('No domain traffic in this range.')).toBeInTheDocument();
    expect(screen.getByText('No requests in this range yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Traffic analytics' }));
    expect(screen.getByText(/raw log is deleted/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disable and restart Traefik' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith(expect.stringMatching(/re-reading the settings/), 'info'));
    await waitFor(() => expect(api.traffic.settings.get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Traffic analytics' })).toHaveAttribute('aria-checked', 'false'));
  });

  it('shows a refused recreate (502) and saves the retention', async () => {
    mockOf(api.traffic.settings.get).mockResolvedValue({ ...SETTINGS, lastError: 'tail failed', status: 'error', logBytes: 1024, malformedLines: 2 });
    mockOf(api.traffic.settings.set)
      .mockRejectedValueOnce(Object.assign(new Error('Traefik could not be recreated; analytics stays off'), { status: 502 }))
      .mockResolvedValueOnce({ ...SETTINGS, retentionDays: 90 });
    renderWithProviders(<TrafficAnalyticsCard />);
    expect(await screen.findByText('tail failed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Traffic analytics' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enable and restart Traefik' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Traefik could not be recreated; analytics stays off', 'error'));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.submit(save.closest('form')!);
    fireEvent.change(screen.getByLabelText('Keep hourly rows (days)'), { target: { value: '90' } });
    fireEvent.click(save);
    await waitFor(() => expect(api.traffic.settings.set).toHaveBeenLastCalledWith({ retentionDays: 90 }));
    await waitFor(() => expect(screen.getByLabelText('Keep hourly rows (days)')).toHaveValue(90));
  });

  it('shows load errors for the settings and the summary', async () => {
    mockOf(api.traffic.settings.get).mockRejectedValueOnce(new Error('down')).mockResolvedValue({ ...SETTINGS, enabled: true });
    mockOf(api.traffic.summary).mockRejectedValueOnce(new Error('no summary')).mockResolvedValue(SUMMARY);
    renderWithProviders(<TrafficAnalyticsCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText("Couldn't load the traffic summary")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('app.example.com')).toBeInTheDocument();
  });
});

describe('service traffic card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOf(api.traffic.service).mockResolvedValue({ ...SUMMARY, enabled: false, series: [], domains: [] });
  });

  it('says when analytics is off', async () => {
    renderWithProviders(<ServiceTrafficCard serviceId={3} />);
    expect(await screen.findByText(/Traffic analytics is off/)).toBeInTheDocument();
    expect(api.traffic.service).toHaveBeenCalledWith(3, { range: '24h' });
  });

  it('draws the series and the domains, and changes range', async () => {
    mockOf(api.traffic.service).mockResolvedValue({ ...SUMMARY, domains: [scope('d:1', { host: 'svc.example.com' })] });
    renderWithProviders(<ServiceTrafficCard serviceId={3} />);
    expect(await screen.findByText('svc.example.com')).toBeInTheDocument();
    expect(screen.getAllByText('10.0%')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '1h' }));
    await waitFor(() => expect(api.traffic.service).toHaveBeenCalledWith(3, { range: '1h' }));
  });

  it('shows an error with retry', async () => {
    mockOf(api.traffic.service).mockRejectedValueOnce(new Error('forbidden'));
    renderWithProviders(<ServiceTrafficCard serviceId={3} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/Traffic analytics is off/)).toBeInTheDocument();
  });
});

describe('traffic chart helpers', () => {
  it('formats latency and the 5xx rate', () => {
    expect(formatMs(null)).toBe('—');
    expect(formatMs(12.4)).toBe('12ms');
    expect(formatMs(2500)).toBe('2.50s');
    expect(errorRate(counters())).toBe('—');
    expect(errorRate(counters({ requests: 4, status5xx: 1 }))).toBe('25.0%');
  });

  it('draws one bar group per bucket and a latency line from two buckets on', () => {
    const { container, rerender } = render(<TrafficChart series={[bucket('2026-10-08T10:00:00.000Z', { requests: 2, status2xx: 1, statusOther: 1, durationSumMs: 20 })]} />);
    expect(container.querySelectorAll('rect')).toHaveLength(2);
    expect(container.querySelector('path')).toBeNull();
    rerender(<TrafficChart series={SUMMARY.series} />);
    expect(container.querySelector('path')).not.toBeNull();
    expect(screen.getByText(/peak 5 req\/bucket/)).toBeInTheDocument();
  });

  it('labels the panel, custom and other buckets', () => {
    render(<TrafficScopeTable rows={[scope('custom'), scope('other')]} empty="none" />);
    expect(screen.getByText('custom routes')).toBeInTheDocument();
    expect(screen.getByText('other')).toBeInTheDocument();
  });
});
