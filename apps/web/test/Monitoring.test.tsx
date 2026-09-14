import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Monitoring } from '../src/routes/Monitoring.js';
import { renderWithProviders } from './helpers.js';

const apiMock = vi.hoisted(() => ({
  api: {
    stats: { snapshot: vi.fn(), metrics: vi.fn() },
    alerts: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    services: { list: vi.fn() },
    servers: { list: vi.fn(), create: vi.fn(), remove: vi.fn(), test: vi.fn(), sshTest: vi.fn(), bootstrapLogs: vi.fn() },
    limits: { setService: vi.fn(), setDatabase: vi.fn() },
  },
}));

vi.mock('../src/lib/api.js', () => apiMock);

const authMock = vi.hoisted(() => ({
  // helpers.tsx wraps rendered routes in AuthProvider, so the mock has to
  // export one — a passthrough is enough since useAuth is stubbed here.
  AuthProvider: ({ children }: { children?: React.ReactNode }) => children,
  useAuth: vi.fn(() => ({ user: { id: 1, isOperator: true } })),
}));

vi.mock('../src/lib/auth.js', () => authMock);

const host = {
  cpuCores: 8,
  load1: 1.5,
  memUsedBytes: 4 * 1024 ** 3,
  memTotalBytes: 16 * 1024 ** 3,
  diskUsedBytes: 100 * 1024 ** 3,
  diskTotalBytes: 200 * 1024 ** 3,
};

const snapshot = {
  host,
  containers: [
    { kind: 'service' as const, refId: 1, refName: 'api', name: 'nd-api', engine: null, cpuPct: 12.5, memMb: 256, memLimitMb: 512 },
    { kind: 'database' as const, refId: 2, refName: 'db', name: 'nd-db', engine: 'postgres', cpuPct: 0.25, memMb: 64, memLimitMb: 0 },
    // 90% of its limit → the critical (rose) memory zone.
    { kind: 'service' as const, refId: 3, refName: 'hot', name: 'nd-hot', engine: null, cpuPct: 5, memMb: 900, memLimitMb: 1000 },
    // 70% of its limit → the warning (amber) memory zone.
    { kind: 'service' as const, refId: 4, refName: 'warm', name: 'nd-warm', engine: null, cpuPct: 5, memMb: 700, memLimitMb: 1000 },
  ],
};

describe('Monitoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.useAuth.mockReturnValue({ user: { id: 1, isOperator: true } });
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    apiMock.api.stats.metrics.mockResolvedValue({ points: [] } as never);
    apiMock.api.alerts.list.mockResolvedValue([] as never);
    apiMock.api.services.list.mockResolvedValue([] as never);
    apiMock.api.servers.list.mockResolvedValue([] as never);
  });

  it('renders host overview with percentages', async () => {
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    renderWithProviders(<Monitoring />);
    await screen.findByText('8 cores');
    expect(screen.getByText(/load avg: 1\.50/)).toBeInTheDocument();
    // mem 4/16 GB = 25%
    expect(screen.getByText('25%')).toBeInTheDocument();
    // disk 100/200 = 50%
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('4.3 GB / 17.2 GB')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument(); // workloads

    // The DevOps table view falls back to generic kinds for engine-less rows.
    fireEvent.click(screen.getByTitle('DevOps Matrix Table View'));
    expect(await screen.findAllByText('Service')).toHaveLength(3);
    expect(screen.getAllByText('postgres').length).toBeGreaterThan(0);
    expect(screen.getAllByText('900 MB').length).toBeGreaterThan(0);
    // The memory-limit column shows the configured ceiling (and '—' when unset).
    expect(screen.getAllByText('1000 MB').length).toBeGreaterThan(0);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('selects the local node and resets the type filter from the cluster bar', async () => {
    apiMock.api.servers.list.mockResolvedValue([
      { id: 2, name: 'node-a', host: '10.0.0.2', port: 2375, status: 'online' },
    ] as never);
    renderWithProviders(<Monitoring />);
    // The cluster bar only renders once a remote node exists.
    fireEvent.click(await screen.findByRole('button', { name: /Local Host \(Primary\)/ }));
    // The "All" filter restores the unfiltered container list.
    fireEvent.click(screen.getAllByRole('button', { name: 'All' })[0]!);
  });

  it('shows an error card with retry when the stats query fails', async () => {
    apiMock.api.stats.snapshot.mockRejectedValue(new Error('no stats') as never);
    renderWithProviders(<Monitoring />);
    expect(await screen.findByText("Couldn't load metrics")).toBeInTheDocument();
    expect(screen.getByText('no stats')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]!);
    await waitFor(() => expect(apiMock.api.stats.snapshot).toHaveBeenCalledTimes(2));
  });

  it('shows skeleton while loading and empty state when no containers', async () => {
    const never = new Promise(() => {});
    apiMock.api.stats.snapshot.mockReturnValueOnce(never as never);
    const { unmount } = renderWithProviders(<Monitoring />);
    expect(document.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    unmount();

    apiMock.api.stats.snapshot.mockResolvedValue({ host: null, containers: [] } as never);
    renderWithProviders(<Monitoring />);
    expect(await screen.findByText('No workloads found')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0); // cpu/mem/disk values
  });

  it('formats sub-gigabyte and zero byte host values', async () => {
    apiMock.api.stats.snapshot.mockResolvedValue({
      host: {
        cpuCores: 2,
        load1: 0.5,
        memUsedBytes: 512 * 1024 * 1024, // < 1GB -> MB
        memTotalBytes: 1024 * 1024 * 1024,
        diskUsedBytes: 0, // -> '0 B'
        diskTotalBytes: 200 * 1024 ** 3,
      },
      containers: [],
    } as never);
    renderWithProviders(<Monitoring />);
    await screen.findByText('536.9 MB / 1.1 GB');
    // diskUsedBytes is 0 → formatBytes renders '0 B' as the used portion.
    expect(screen.getByText(/0 B\s*\/\s*/)).toBeInTheDocument();
  });

  it('renders container cards with cpu/mem and limits form for services', async () => {
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    apiMock.api.stats.metrics.mockResolvedValue({ points: [{ value: 50 }, { value: 80 }] } as never);
    apiMock.api.limits.setService.mockResolvedValue({ cpuShares: 512, memLimitMb: 1024 } as never);
    renderWithProviders(<Monitoring />);
    expect((await screen.findAllByText('api')).length).toBeGreaterThan(0);
    expect(screen.getAllByText((_, el) => el?.textContent === '12.50%').length).toBeGreaterThan(0);
    expect(screen.getAllByText((_, el) => el?.textContent?.startsWith('256MB') === true).length).toBeGreaterThan(0);
    expect(screen.getAllByText('/ 512').length).toBeGreaterThan(0);
    // database card
    expect(screen.getAllByText('db').length).toBeGreaterThan(0);
    expect(screen.getAllByText('postgres').length).toBeGreaterThan(0);
    // service sparkline renders an svg
    expect(document.querySelectorAll('svg').length).toBeGreaterThan(0);
    // limits form for service — mem is prefilled with the current limit (512)
    const cpuInput = screen.getAllByPlaceholderText('cpu shares')[0]!;
    const memInput = screen.getAllByPlaceholderText('mem MB')[0]!;
    expect(memInput).toHaveValue('512');
    await userEvent.type(cpuInput, '512');
    await userEvent.clear(memInput);
    await userEvent.type(memInput, '1024');
    fireEvent.submit(cpuInput.closest('form')!);
    await waitFor(() => expect(apiMock.api.limits.setService).toHaveBeenCalledWith(1, { cpuShares: 512, cpuLimitMilli: null, memLimitMb: 1024 }));
  });

  it('submits zero limits when the fields are emptied', async () => {
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    apiMock.api.limits.setService.mockResolvedValue({ cpuShares: null, memLimitMb: null } as never);
    renderWithProviders(<Monitoring />);
    expect((await screen.findAllByText('api')).length).toBeGreaterThan(0);
    const cpuInput = screen.getAllByPlaceholderText('cpu shares')[0]!;
    await userEvent.clear(screen.getAllByPlaceholderText('mem MB')[0]!);
    fireEvent.submit(cpuInput.closest('form')!);
    await waitFor(() => expect(apiMock.api.limits.setService).toHaveBeenCalledWith(1, { cpuShares: null, cpuLimitMilli: null, memLimitMb: null }));
  });

  it('shows the pending state while limits are being saved', async () => {
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    apiMock.api.limits.setService.mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<Monitoring />);
    expect((await screen.findAllByText('api')).length).toBeGreaterThan(0);
    const cpuInput = screen.getAllByPlaceholderText('cpu shares')[0]!;
    await userEvent.type(cpuInput, '256');
    fireEvent.submit(cpuInput.closest('form')!);
    expect(await screen.findByText('Saving…')).toBeInTheDocument();
  });

  it('toasts on alert rule create/delete and limit-save failures', async () => {
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    apiMock.api.alerts.list.mockResolvedValue([] as never);
    apiMock.api.alerts.create.mockRejectedValue(new Error('bad rule') as never);
    const first = renderWithProviders(<Monitoring />);
    await screen.findByPlaceholderText('rule name');
    await userEvent.type(screen.getByPlaceholderText('rule name'), 'broken');
    fireEvent.submit(screen.getByPlaceholderText('rule name').closest('form')!);
    await waitFor(() => expect(apiMock.api.alerts.create).toHaveBeenCalled());
    first.unmount();

    apiMock.api.alerts.list.mockResolvedValue([
      { id: 7, serviceId: null, name: 'stale', metric: 'cpu', operator: '>', threshold: 50, durationWindows: 1, enabled: true, status: 'ok', lastValue: 10, firedAt: null, createdAt: 'x' },
    ] as never);
    apiMock.api.alerts.remove.mockRejectedValue(new Error('nope') as never);
    const second = renderWithProviders(<Monitoring />);
    await screen.findByText('stale');
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(apiMock.api.alerts.remove).toHaveBeenCalledWith(7));
    second.unmount();

    apiMock.api.limits.setService.mockRejectedValue(new Error('denied') as never);
    renderWithProviders(<Monitoring />);
    expect((await screen.findAllByText('api')).length).toBeGreaterThan(0);
    fireEvent.submit(screen.getAllByPlaceholderText('cpu shares')[0]!.closest('form')!);
    await waitFor(() => expect(apiMock.api.limits.setService).toHaveBeenCalled());
  });

  it('saves database limits and covers bar tones', async () => {
    const highHost = {
      ...host,
      memUsedBytes: 15 * 1024 ** 3, // 93% -> rose
      diskUsedBytes: 140 * 1024 ** 3, // 70% -> amber
    };
    apiMock.api.stats.snapshot.mockResolvedValue({ host: highHost, containers: [snapshot.containers[1]] } as never);
    apiMock.api.limits.setDatabase.mockResolvedValue({ cpuShares: null, memLimitMb: 128 } as never);
    renderWithProviders(<Monitoring />);
    expect((await screen.findAllByText('db')).length).toBeGreaterThan(0);
    const memInput = screen.getAllByPlaceholderText('mem MB')[0]!;
    await userEvent.type(memInput, '128');
    fireEvent.submit(memInput.closest('form')!);
    await waitFor(() => expect(apiMock.api.limits.setDatabase).toHaveBeenCalledWith(2, { cpuShares: null, cpuLimitMilli: null, memLimitMb: 128 }));
  });

  it('shows an empty state when no alert rules exist', async () => {
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    apiMock.api.alerts.list.mockResolvedValue([] as never);
    renderWithProviders(<Monitoring />);
    await screen.findByText(/No alert rules yet/);
  });

  it('lists alert rules with status and current values', async () => {
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    apiMock.api.alerts.list.mockResolvedValue([
      { id: 1, serviceId: null, name: 'high-cpu', metric: 'cpu', operator: '>', threshold: 80, durationWindows: 2, enabled: true, status: 'firing', lastValue: 93, firedAt: '2026-08-27T00:00:00Z', lastEvaluatedAt: new Date().toISOString(), createdAt: 'x' },
      { id: 2, serviceId: null, name: 'low-mem', metric: 'memory', operator: '<', threshold: 100, durationWindows: 1, enabled: true, status: 'ok', lastValue: null, firedAt: null, lastEvaluatedAt: new Date(Date.now() - 10 * 60_000).toISOString(), createdAt: 'x' },
    ] as never);
    renderWithProviders(<Monitoring />);
    await screen.findByText('high-cpu');
    // Conditions carry their unit so thresholds are unambiguous.
    expect(screen.getByText(/cpu > 80%/)).toBeInTheDocument();
    expect(screen.getByText(/memory < 100 MiB/)).toBeInTheDocument();
    // Current value is rendered with its unit; the firing rule also stamps its fire time.
    expect(screen.getAllByText((_, el) => el?.textContent === '93%').length).toBeGreaterThan(0);
    expect(screen.getByText(/· fired/)).toBeInTheDocument();
    expect(screen.getByText(/· checked 10m ago/)).toBeInTheDocument();
    // Header chips summarise live state counts.
    expect(screen.getByText('1 firing')).toBeInTheDocument();
    expect(screen.getByText('2 rules')).toBeInTheDocument();
  });

  it('pauses and resumes a rule through the enabled toggle', async () => {
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    apiMock.api.alerts.list.mockResolvedValue([
      { id: 7, serviceId: null, name: 'stale', metric: 'cpu', operator: '>', threshold: 50, durationWindows: 1, enabled: true, status: 'ok', lastValue: 10, firedAt: null, lastEvaluatedAt: null, createdAt: 'x' },
      { id: 8, serviceId: null, name: 'parked', metric: 'memory', operator: '>', threshold: 512, durationWindows: 2, enabled: false, status: 'ok', lastValue: null, firedAt: null, lastEvaluatedAt: null, createdAt: 'x' },
    ] as never);
    apiMock.api.alerts.update.mockResolvedValue({ id: 7 } as never);
    renderWithProviders(<Monitoring />);
    await screen.findByText('stale');
    // Disabled rules surface as PAUSED rather than reusing deploy statuses;
    // rules the collector has not sampled yet say so explicitly.
    expect(screen.getByText('PAUSED')).toBeInTheDocument();
    expect(screen.getAllByText(/not evaluated yet/).length).toBe(2);
    fireEvent.click(screen.getByTitle('Pause this rule'));
    await waitFor(() => expect(apiMock.api.alerts.update).toHaveBeenCalledWith(7, { enabled: false }));
    fireEvent.click(screen.getByTitle('Re-enable this rule'));
    await waitFor(() => expect(apiMock.api.alerts.update).toHaveBeenCalledWith(8, { enabled: true }));
  });

  it('creates an alert rule from the admin form', async () => {
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    apiMock.api.alerts.list.mockResolvedValue([] as never);
    apiMock.api.alerts.create.mockResolvedValue({ id: 1 } as never);
    renderWithProviders(<Monitoring />);
    await screen.findByPlaceholderText('rule name');
    await userEvent.type(screen.getByPlaceholderText('rule name'), 'disk-pressure');
    await userEvent.clear(screen.getByPlaceholderText(/threshold/));
    await userEvent.type(screen.getByPlaceholderText(/threshold/), '95');
    fireEvent.submit(screen.getByPlaceholderText('rule name').closest('form')!);
    await waitFor(() =>
      expect(apiMock.api.alerts.create).toHaveBeenCalledWith({ name: 'disk-pressure', metric: 'cpu', operator: '>', threshold: 95, serviceId: null, durationWindows: 2 }),
    );
  });

  it('deletes an alert rule', async () => {
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    apiMock.api.alerts.list.mockResolvedValue([
      { id: 7, serviceId: null, name: 'stale', metric: 'cpu', operator: '>', threshold: 50, durationWindows: 1, enabled: true, status: 'ok', lastValue: 10, firedAt: null, createdAt: 'x' },
    ] as never);
    apiMock.api.alerts.remove.mockResolvedValue(undefined as never);
    renderWithProviders(<Monitoring />);
    await screen.findByText('stale');
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(apiMock.api.alerts.remove).toHaveBeenCalledWith(7));
  });

  it('scopes a rule to a service and sets the window count', async () => {
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    apiMock.api.alerts.list.mockResolvedValue([] as never);
    apiMock.api.alerts.create.mockResolvedValue({ id: 3 } as never);
    apiMock.api.services.list.mockResolvedValue([{ id: 4, name: 'api', slug: 'api', type: 'docker', status: 'running' }] as never);
    renderWithProviders(<Monitoring />);
    await screen.findByPlaceholderText('rule name');
    await userEvent.type(screen.getByPlaceholderText('rule name'), 'svc-cpu');
    await userEvent.selectOptions(screen.getByDisplayValue('host-wide'), '4');
    await userEvent.clear(screen.getByPlaceholderText('windows'));
    await userEvent.type(screen.getByPlaceholderText('windows'), '5');
    fireEvent.submit(screen.getByPlaceholderText('rule name').closest('form')!);
    await waitFor(() =>
      expect(apiMock.api.alerts.create).toHaveBeenCalledWith({ name: 'svc-cpu', metric: 'cpu', operator: '>', threshold: 80, serviceId: 4, durationWindows: 5 }),
    );
  });

  it('rejects an unparsable threshold instead of silently submitting zero', async () => {
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    apiMock.api.alerts.list.mockResolvedValue([] as never);
    apiMock.api.alerts.create.mockResolvedValue({ id: 6 } as never);
    renderWithProviders(<Monitoring />);
    await screen.findByPlaceholderText('rule name');
    await userEvent.type(screen.getByPlaceholderText('rule name'), 'any-threshold');
    // A number input cannot hold non-numeric junk; an empty threshold must
    // block submission rather than create a threshold:0 rule that fires at once.
    await userEvent.clear(screen.getByPlaceholderText(/threshold/));
    fireEvent.submit(screen.getByPlaceholderText('rule name').closest('form')!);
    await waitFor(() => expect(apiMock.api.alerts.create).not.toHaveBeenCalled());
    expect(screen.getByText(/needs a name and a numeric threshold/)).toBeInTheDocument();
    // Filling a numeric threshold unlocks the form.
    await userEvent.type(screen.getByPlaceholderText(/threshold/), '10');
    fireEvent.submit(screen.getByPlaceholderText('rule name').closest('form')!);
    await waitFor(() => expect(apiMock.api.alerts.create).toHaveBeenCalledWith(expect.objectContaining({ threshold: 10 })));
  });

  it('falls back to one window for a non-numeric window count', async () => {
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    apiMock.api.alerts.list.mockResolvedValue([] as never);
    apiMock.api.alerts.create.mockResolvedValue({ id: 5 } as never);
    renderWithProviders(<Monitoring />);
    await screen.findByPlaceholderText('rule name');
    await userEvent.type(screen.getByPlaceholderText('rule name'), 'quick');
    await userEvent.clear(screen.getByPlaceholderText('windows'));
    await userEvent.type(screen.getByPlaceholderText('windows'), 'soon');
    fireEvent.submit(screen.getByPlaceholderText('rule name').closest('form')!);
    await waitFor(() =>
      expect(apiMock.api.alerts.create).toHaveBeenCalledWith(expect.objectContaining({ durationWindows: 1 })),
    );
  });

  it('forces cert-expiry rules host-wide and parses the window count', async () => {
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    apiMock.api.alerts.list.mockResolvedValue([] as never);
    apiMock.api.alerts.create.mockResolvedValue({ id: 4 } as never);
    renderWithProviders(<Monitoring />);
    await screen.findByPlaceholderText('rule name');
    await userEvent.type(screen.getByPlaceholderText('rule name'), 'cert-renew');
    await userEvent.selectOptions(screen.getByDisplayValue('cpu %'), 'cert-expiry');
    // The scope select is disabled for cert-expiry — must submit host-wide.
    fireEvent.submit(screen.getByPlaceholderText('rule name').closest('form')!);
    await waitFor(() =>
      expect(apiMock.api.alerts.create).toHaveBeenCalledWith(expect.objectContaining({ metric: 'cert-expiry', serviceId: null, durationWindows: 2 })),
    );
  });

  it('creates an alert rule with a custom metric and operator', async () => {
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    apiMock.api.alerts.list.mockResolvedValue([] as never);
    apiMock.api.alerts.create.mockResolvedValue({ id: 2 } as never);
    renderWithProviders(<Monitoring />);
    await screen.findByPlaceholderText('rule name');
    await userEvent.type(screen.getByPlaceholderText('rule name'), 'cert-renew');
    await userEvent.selectOptions(screen.getByDisplayValue('cpu %'), 'cert-expiry');
    // Switching to cert-expiry presets a sane operator/threshold (< 14 days).
    expect(screen.getByDisplayValue('<')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/threshold/)).toHaveValue(14);
    await userEvent.clear(screen.getByPlaceholderText(/threshold/));
    await userEvent.type(screen.getByPlaceholderText(/threshold/), '14');
    fireEvent.submit(screen.getByPlaceholderText('rule name').closest('form')!);
    await waitFor(() =>
      expect(apiMock.api.alerts.create).toHaveBeenCalledWith({ name: 'cert-renew', metric: 'cert-expiry', operator: '<', threshold: 14, serviceId: null, durationWindows: 2 }),
    );
  });

  it('covers breaching status, missing current values, and load errors', async () => {
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    apiMock.api.alerts.list.mockResolvedValue([
      { id: 3, serviceId: null, name: 'warming', metric: 'memory', operator: '>', threshold: 512, durationWindows: 3, enabled: true, status: 'breaching', lastValue: null, firedAt: null, lastEvaluatedAt: null, createdAt: 'x' },
    ] as never);
    renderWithProviders(<Monitoring />);
    await screen.findByText('warming');
    // Breaching gets its own amber pill (no borrowed deploy statuses).
    expect(screen.getByText('BREACHING')).toBeInTheDocument();
    // The un-sampled rule shows a dash for its current value.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders an error card with retry when the rules query fails', async () => {
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    apiMock.api.alerts.list.mockRejectedValue(new Error('boom') as never);
    renderWithProviders(<Monitoring />);
    expect(await screen.findByText("Couldn't load alert rules")).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(apiMock.api.alerts.list).toHaveBeenCalledTimes(2));
  });

  it('does not submit when the name is empty', async () => {
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    apiMock.api.alerts.list.mockResolvedValue([] as never);
    renderWithProviders(<Monitoring />);
    await screen.findByPlaceholderText('rule name');
    fireEvent.submit(screen.getByPlaceholderText('rule name').closest('form')!);
    await new Promise((r) => setTimeout(r, 20));
    expect(apiMock.api.alerts.create).not.toHaveBeenCalled();
  });

  it('shows the pending state while a rule is being created', async () => {
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    apiMock.api.alerts.list.mockResolvedValue([] as never);
    apiMock.api.alerts.create.mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<Monitoring />);
    await screen.findByPlaceholderText('rule name');
    await userEvent.type(screen.getByPlaceholderText('rule name'), 'slow');
    fireEvent.submit(screen.getByPlaceholderText('rule name').closest('form')!);
    expect(await screen.findByText('…')).toBeInTheDocument();
  });

  it('hides the create form from members', async () => {
    authMock.useAuth.mockReturnValue({ user: { id: 2, isOperator: false } });
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    apiMock.api.alerts.list.mockResolvedValue([] as never);
    renderWithProviders(<Monitoring />);
    await screen.findByText(/No alert rules yet/);
    expect(screen.queryByPlaceholderText('rule name')).not.toBeInTheDocument();
  });

  it('filters workloads by search query and category tabs', async () => {
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    renderWithProviders(<Monitoring />);
    expect((await screen.findAllByText('api')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('db').length).toBeGreaterThan(0);

    // Filter by Services tab
    fireEvent.click(screen.getByRole('button', { name: 'Services' }));
    expect(screen.getAllByText('api').length).toBeGreaterThan(0);

    // Filter by Databases tab
    fireEvent.click(screen.getByRole('button', { name: 'Databases' }));
    expect(screen.getAllByText('db').length).toBeGreaterThan(0);

    // Filter by Hot tab
    fireEvent.click(screen.getByRole('button', { name: /Hot/i }));
    // Search input filtering
    const searchInput = screen.getByPlaceholderText('Search workloads…');
    fireEvent.change(searchInput, { target: { value: 'non-existent' } });
    expect(await screen.findByText('No workloads found')).toBeInTheDocument();
  });

  it('toggles between Card Grid and DevOps Matrix Table views', async () => {
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    renderWithProviders(<Monitoring />);
    expect((await screen.findAllByText('api')).length).toBeGreaterThan(0);

    // Switch to table view
    const tableBtn = screen.getByTitle('DevOps Matrix Table View');
    fireEvent.click(tableBtn);
    expect(await screen.findByText('Workload')).toBeInTheDocument();
    expect(screen.getAllByText('CPU Load').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Detail').length).toBeGreaterThan(0);

    // Switch back to grid view
    const gridBtn = screen.getByTitle('Card Grid View');
    fireEvent.click(gridBtn);
    expect((await screen.findAllByText('api')).length).toBeGreaterThan(0);
  });

  it('renders cluster nodes selector when remote servers exist', async () => {
    apiMock.api.stats.snapshot.mockResolvedValue(snapshot as never);
    apiMock.api.servers.list.mockResolvedValue([
      { id: 10, name: 'vps-eu-1', host: '195.201.45.10', port: 4600, status: 'online', lastSeenAt: new Date().toISOString() },
      { id: 11, name: 'edge-us-2', host: '154.23.11.2', port: 4600, status: 'error', lastSeenAt: null },
    ] as never);

    renderWithProviders(<Monitoring />);
    expect(await screen.findByText('Cluster Nodes & Remote Agents')).toBeInTheDocument();
    expect(screen.getByText('2/3 Nodes Online')).toBeInTheDocument();
    expect(screen.getByText('Local Host (Primary)')).toBeInTheDocument();
    expect(screen.getByText('vps-eu-1')).toBeInTheDocument();
    expect(screen.getByText('edge-us-2')).toBeInTheDocument();

    // Select remote server
    fireEvent.click(screen.getByText('vps-eu-1'));
    expect(screen.getByText('Node CPU (Telemetry)')).toBeInTheDocument();
    expect(screen.getByText('Node Memory')).toBeInTheDocument();
  });
});
