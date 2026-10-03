import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { Dashboard } from '../src/routes/Dashboard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const dashData = {
  stats: {
    services: 5,
    databases: 2,
    deployments: 12,
    domains: 3,
    webhooks: 1,
    running: 3,
    stopped: 1,
    errored: 1,
    dbRunning: 1,
    containers: 5,
  },
  health: [
    { serviceId: 1, name: 'api', slug: 'api', type: 'docker', status: 'running', healthy: true, responseMs: 42, port: 3000, runtimeId: 'r1', commitSha: 'abc123', lastDeploy: null },
    { serviceId: 2, name: 'slow', slug: 'slow', type: 'docker', status: 'running', healthy: false, responseMs: 900, port: 3001, runtimeId: 'r2', commitSha: null, lastDeploy: null },
    { serviceId: 3, name: 'offline', slug: 'offline', type: 'pm2', status: 'stopped', healthy: false, responseMs: null, port: null, runtimeId: null, commitSha: 'def456', lastDeploy: null },
    { serviceId: 4, name: 'deploying', slug: 'deploying', type: 'docker', status: 'deploying', healthy: false, responseMs: 250, port: null, runtimeId: 'r4', commitSha: null, lastDeploy: null },
  ],
  recentDeploys: [
    { id: 10, serviceId: 1, serviceName: 'api', status: 'running', commitSha: 'abc123', message: null, trigger: 'manual', finishedAt: null, createdAt: '2026-01-01T00:00:00Z' },
    { id: 9, serviceId: 2, serviceName: 'slow', status: 'failed', commitSha: null, message: null, trigger: 'webhook', finishedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' },
    { id: 8, serviceId: 3, serviceName: 'offline', status: 'building', commitSha: 'xyz', message: null, trigger: 'auto', finishedAt: null, createdAt: '2026-01-01T00:00:00Z' },
    { id: 7, serviceId: 4, serviceName: 'deploying', status: 'queued', commitSha: null, message: null, trigger: 'manual', finishedAt: null, createdAt: '2026-01-01T00:00:00Z' },
  ],
};

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

it('shows an error card with retry when the dashboard query fails', async () => {
    mockOf(api.dashboard.get).mockRejectedValue(new Error('boom'));
    renderWithProviders(<Dashboard />);
    expect(await screen.findByText(/Couldn't load the dashboard/)).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(api.dashboard.get).toHaveBeenCalledTimes(2);
  });

    it('shows skeleton while loading', () => {
    mockOf(api.dashboard.get).mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Dashboard />);
    // 5 skeletons + the top fetch bar
      expect(document.querySelectorAll('.animate-pulse').length).toBe(7);
  });

  it('returns null when dashboard data is missing', async () => {
    mockOf(api.dashboard.get).mockResolvedValue(null as never);
    const { container } = renderWithProviders(<Dashboard />);
    // wait for the query to settle (loading skeleton disappears)
    await waitFor(() => expect(container.querySelector('.animate-pulse')).toBeNull());
    expect(container.querySelector('.nd-fade')).toBeNull();
  });

  it('renders the operational banner, stats and health grid', async () => {
    mockOf(api.dashboard.get).mockResolvedValue(dashData as never);
    renderWithProviders(<Dashboard />);
    // 3 running + 1 unhealthy running -> attention banner
    await screen.findByText('1 service need attention');
    expect(screen.getByText(/3 running · 1 stopped · 1 errored · 5 containers · 1 databases/)).toBeInTheDocument();
    // stat cards
    expect(screen.getAllByText('5').length).toBeGreaterThan(0);
    expect(screen.getByText('12')).toBeInTheDocument();
    // health: healthy running (green), unhealthy running (rose), stopped (slate), deploying (amber)
    expect(screen.getByText('healthy')).toBeInTheDocument();
    expect(screen.getByText('unhealthy')).toBeInTheDocument();
    expect(screen.getAllByText('stopped').length).toBeGreaterThan(0);
    expect(screen.getAllByText('deploying').length).toBeGreaterThan(0);
    // responseMs tones: <100 emerald, >=500 rose, mid amber
    expect(screen.getByText('42ms')).toBeInTheDocument();
    expect(screen.getByText('900ms')).toBeInTheDocument();
    expect(screen.getByText('250ms')).toBeInTheDocument();
    // commit sha fallback rendered inside "type · sha" text nodes
    expect(screen.getAllByText(/· —/).length).toBeGreaterThan(0);
    // links to services
    expect(screen.getAllByRole('link', { name: /api/ })[0]).toHaveAttribute('href', '/services/1');
    // recent deploys
    expect(screen.getByText(/^#10/)).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(screen.getByText('building')).toBeInTheDocument();
    expect(screen.getByText('queued')).toBeInTheDocument();
  });

  it('renders the all-healthy banner when nothing needs attention', async () => {
    mockOf(api.dashboard.get).mockResolvedValue({
      ...dashData,
      health: [dashData.health[0]!],
    } as never);
    renderWithProviders(<Dashboard />);
    await screen.findByText('All systems operational');
  });

  it('renders the attention banner when services are unhealthy', async () => {
    mockOf(api.dashboard.get).mockResolvedValue({
      ...dashData,
      health: [dashData.health[1]!],
    } as never);
    renderWithProviders(<Dashboard />);
    await screen.findByText('1 service need attention');
  });

  it('pluralizes the attention banner', async () => {
    mockOf(api.dashboard.get).mockResolvedValue({
      ...dashData,
      health: [dashData.health[1]!, { ...dashData.health[1]!, serviceId: 9, name: 'api2' }],
    } as never);
    renderWithProviders(<Dashboard />);
    await screen.findByText('2 services need attention');
  });

  it('renders the empty health state with a hub link', async () => {
    mockOf(api.dashboard.get).mockResolvedValue({ ...dashData, health: [], recentDeploys: [] } as never);
    renderWithProviders(<Dashboard />);
    await screen.findByText(/No services yet/);
    expect(screen.getByText('No deployments yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Hub' })).toHaveAttribute('href', '/hub');
  });

  it('imports a service bundle and redirects', async () => {
    mockOf(api.dashboard.get).mockResolvedValue(dashData as never);
    mockOf(api.services.importBundle).mockResolvedValue({ ok: true, serviceId: 77, slug: 'x', message: 'ok' } as never);
    renderWithProviders(<Dashboard />);
    await screen.findByText('1 service need attention');
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    const file = new File([JSON.stringify({ name: 'x' })], 'bundle.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(api.services.importBundle).toHaveBeenCalledWith({ name: 'x' }));
    // jsdom navigation is a no-op; the import button stays disabled/importing
    await waitFor(() => expect(screen.getByRole('button', { name: /Importing/ })).toBeInTheDocument());
  });

  it('handles a broken import bundle', async () => {
    mockOf(api.dashboard.get).mockResolvedValue(dashData as never);
    renderWithProviders(<Dashboard />);
    await screen.findByText('1 service need attention');
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['not-json'], 'bundle.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Import service/ })).toBeEnabled());
  });

  it('ignores a change event without a selected file', async () => {
    mockOf(api.dashboard.get).mockResolvedValue(dashData as never);
    renderWithProviders(<Dashboard />);
    await screen.findByText('1 service need attention');
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [] } });
    expect(api.services.importBundle).not.toHaveBeenCalled();
  });

  it('opens the file picker from the import button', async () => {
    mockOf(api.dashboard.get).mockResolvedValue(dashData as never);
    renderWithProviders(<Dashboard />);
    fireEvent.click(await screen.findByRole('button', { name: /Import service/ }));
    expect(api.services.importBundle).not.toHaveBeenCalled();
  });

  it('renders unknown deploy statuses with the default badge tone', async () => {
    mockOf(api.dashboard.get).mockResolvedValue({
      ...dashData,
      recentDeploys: [{ ...dashData.recentDeploys[0]!, status: 'cancelled', id: 99 }],
    } as never);
    renderWithProviders(<Dashboard />);
    expect(await screen.findByText('cancelled')).toBeInTheDocument();
  });

  it('triggers demo creation on button click', async () => {
    mockOf(api.dashboard.get).mockResolvedValue(dashData as never);
    let resolveSeed!: (val: any) => void;
    mockOf(api.demo.seed).mockReturnValue(
      new Promise((resolve) => {
        resolveSeed = resolve;
      }),
    );

    renderWithProviders(<Dashboard />);
    const seedBtn = await screen.findByRole('button', { name: /Load Next.js Demo/i });
    fireEvent.click(seedBtn);

    // Pending state renders 'Creating Demo…'
    expect(await screen.findByRole('button', { name: /Creating Demo…/i })).toBeInTheDocument();

    resolveSeed({
      ok: true,
      projectId: 1,
      projectName: 'Next.js Demo',
      services: [{ id: 1, name: 'Next.js Demo', type: 'docker', status: 'idle', port: 3000 }],
      database: null,
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Load Next.js Demo/i })).toBeInTheDocument();
    });
  });

  it('handles demo creation failure', async () => {
    mockOf(api.dashboard.get).mockResolvedValue(dashData as never);
    mockOf(api.demo.seed).mockRejectedValue(new Error('seed failed'));

    renderWithProviders(<Dashboard />);
    const seedBtn = await screen.findByRole('button', { name: /Load Next.js Demo/i });
    fireEvent.click(seedBtn);

    await waitFor(() => {
      expect(api.demo.seed).toHaveBeenCalledTimes(1);
    });
  });

  it('shows critical telemetry bars and live per-container stats', async () => {
    mockOf(api.dashboard.get).mockResolvedValue({ ...dashData, health: [dashData.health[0]!] } as never);
    mockOf(api.stats.snapshot).mockResolvedValue({
      host: { load1: 9, cpuCores: 2, memUsedBytes: 90, memTotalBytes: 100, diskUsedBytes: 90, diskTotalBytes: 100 },
      // The first entry misses (wrong ref/kind); the second matches the service.
      containers: [
        { refId: 999, kind: 'database', cpuPct: 1, memMb: 1 },
        { refId: 1, kind: 'service', cpuPct: 12.34, memMb: 56.78 },
      ],
    } as never);
    renderWithProviders(<Dashboard />);

    expect(await screen.findByText(/All systems operational/)).toBeInTheDocument();
    expect(screen.getByText('12.3%')).toBeInTheDocument();
    expect(screen.getByText('56.8 MiB')).toBeInTheDocument();
    // Memory and disk both cross the 85% critical threshold.
    expect(screen.getAllByText('90%').length).toBe(2);
  });

  it('shows amber telemetry zones and a null load average', async () => {
    mockOf(api.dashboard.get).mockResolvedValue({ ...dashData, health: [] } as never);
    mockOf(api.stats.snapshot).mockResolvedValue({
      host: { load1: null, cpuCores: 2, memUsedBytes: 70, memTotalBytes: 100, diskUsedBytes: 75, diskTotalBytes: 100 },
      containers: [],
    } as never);
    renderWithProviders(<Dashboard />);

    expect(await screen.findByText('0.00 loadavg')).toBeInTheDocument();
    expect(screen.getByText('70%')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
  });

  it('renders zero percentages when the host reports no totals', async () => {
    mockOf(api.dashboard.get).mockResolvedValue({ ...dashData, health: [] } as never);
    mockOf(api.stats.snapshot).mockResolvedValue({
      host: { load1: 0.5, cpuCores: 2, memUsedBytes: 0, memTotalBytes: 0, diskUsedBytes: 0, diskTotalBytes: 0 },
      containers: [],
    } as never);
    renderWithProviders(<Dashboard />);

    await screen.findByText(/No services yet/);
    expect(screen.getAllByText('0%').length).toBe(2);
  });
});
