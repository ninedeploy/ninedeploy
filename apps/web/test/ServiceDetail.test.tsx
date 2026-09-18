import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { ServiceDetail } from '../src/routes/service/index.js';
import { api, getToken } from '../src/lib/api.js';
import { renderRoute, renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

vi.mock('../src/lib/useDeployLogs.js', () => ({
  useDeployLogs: vi.fn(() => ({ lines: '', open: false })),
}));

// H-3: lifecycle hooks execute on the host, so the API admits admins only and
// the settings form must not offer them to a member. Role is mutable per test.
const authMock = vi.hoisted(() => ({ user: { id: 1, isOperator: true, email: 'a@test', name: 'A' } }));
vi.mock('../src/lib/auth.js', () => ({ AuthProvider: ({ children }: { children?: React.ReactNode }) => children, useAuth: () => authMock }));

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useToast: () => toastSpy,
}));

vi.mock('../src/components/ContainerTerminal.js', () => ({
  ContainerTerminal: ({ serviceId, onClose }: { serviceId: number; onClose: () => void }) => (
    <div data-testid="terminal">
      terminal-{serviceId}
      <button type="button" onClick={onClose}>close terminal</button>
    </div>
  ),
}));

vi.mock('../src/components/EnvCard.js', () => ({
  EnvCard: () => <div data-testid="env-card">env</div>,
}));

vi.mock('../src/components/AttachmentsCard.js', () => ({
  AttachmentsCard: () => <div data-testid="attachments-card">attachments</div>,
}));

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ nodes, edges, nodeTypes, children }: { nodes: Array<{ id: string; type: string; data: unknown }>; edges: unknown[]; nodeTypes?: Record<string, React.ComponentType<{ id: string; data: unknown }>>; children: React.ReactNode }) => (
    <div data-testid="react-flow" data-nodes={nodes.length} data-edges={edges.length}>
      {nodes.map((n) => {
        const NodeComp = nodeTypes?.[n.type];
        return NodeComp ? <NodeComp key={n.id} id={n.id} data={n.data} /> : null;
      })}
      {children}
    </div>
  ),
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <div data-testid="flow-provider">{children}</div>,
  Background: () => <div data-testid="background" />,
  Controls: () => <div data-testid="controls" />,
  Handle: () => <div data-testid="handle" />,
  // Invoke the color callback for every node type so its branches are exercised.
  MiniMap: ({ nodeColor }: { nodeColor?: (n: { type?: string }) => string }) => (
    <div data-testid="minimap">
      {['svcMain', 'svcDb', 'svcGateway', 'svcStorage', 'svcDomain', 'other'].map((t) => nodeColor?.({ type: t })).filter(Boolean).join(',')}
    </div>
  ),
  BackgroundVariant: { Dots: 'dots' },
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));

const service = {
  id: 1,
  name: 'api',
  slug: 'api',
  type: 'docker',
  branch: 'main',
  sourceId: 3,
  sourceName: 'github-app',
  port: 3000,
  repoUrl: 'https://github.com/x/y',
  autoUrl: 'api.nd.local',
  status: 'running',
  runtimeId: 'nd-api',
  cpuShares: 1024,
  cpuLimitMilli: 0,
  memLimitMb: 512,
  healthPath: '/',
  build: {
    buildPack: 'auto',
    baseDir: '/',
    installCmd: 'npm ci',
    buildCmd: 'npm run build',
    startCmd: 'npm start',
    dockerfilePath: null,
  },
};

const deploys = [
  { id: 5, serviceId: 1, status: 'running', commitSha: 'abcdef1234', message: null, trigger: 'manual', finishedAt: null, createdAt: '2026-01-01T00:00:00Z' },
  { id: 4, serviceId: 1, status: 'failed', commitSha: null, message: null, trigger: 'webhook', finishedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' },
];

const domains = [
  { id: 1, hostname: 'app.example.com', path: '/', serviceId: 1, serviceName: 'api', port: 3000, container: 'nd-api', ssl: true, redirectWww: false, headers: '[]', status: 'active' },
];

const webhooks = [
  { id: 1, serviceId: 1, branch: 'main', url: 'https://hook.example.com/1', secret: 's3cret', watchPaths: 'apps/api/**', createdAt: 'x' },
];

describe('ServiceDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.user = { id: 1, isOperator: true, email: 'a@test', name: 'A' };
    toastSpy.toast.mockClear();
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('fetch', vi.fn());
    URL.createObjectURL = vi.fn(() => 'blob:export');
    URL.revokeObjectURL = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    mockOf(api.services.get).mockResolvedValue(service as never);
    mockOf(api.deploys.list).mockResolvedValue(deploys as never);
    mockOf(api.domains.list).mockResolvedValue(domains as never);
    mockOf(api.webhooks.list).mockResolvedValue(webhooks as never);
    mockOf(api.services.exportUrl).mockReturnValue('/v1/services/1/export');
    mockOf(api.stats.metrics).mockResolvedValue({
      kind: 'cpu',
      points: [
        { ts: '2026-01-01T00:00:00Z', value: 10 },
        { ts: '2026-01-01T00:00:30Z', value: 40 },
        { ts: '2026-01-01T00:01:00Z', value: 25 },
      ],
    } as never);
    mockOf(api.volumes.list).mockResolvedValue([] as never);
    mockOf(api.activity.list).mockResolvedValue([] as never);
  });

  const openTab = async (label: string) => {
    // Tab labels carry suffixes ("Activity Logs", "Network & Domains",
    // "Danger Zone", …) — match on the leading word the tests use.
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    fireEvent.click(await screen.findByRole('tab', { name: new RegExp(`^${escaped}(\\s|$)`) }));
  };

  it('shows skeleton while the service loads', () => {
    mockOf(api.services.get).mockReturnValue(new Promise(() => {}));
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    expect(document.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('renders the repository analysis card and refreshes it', async () => {
    mockOf(api.insights.get).mockResolvedValue({
      framework: {
        id: 'next', name: 'Next.js', emoji: '▲', category: 'ssr', port: 3000,
        installCmd: 'pnpm install', buildCmd: 'pnpm build', startCmd: 'pnpm start',
        env: [{ key: 'NODE_ENV', value: 'production' }], notes: [],
      },
      language: 'TypeScript',
      packageManager: 'pnpm',
      nodeVersion: '22',
      frameworkVersion: '15.1.0',
      scripts: { build: 'next build' },
      dependencyCount: 40,
      devDependencyCount: 9,
      hasDockerfile: true,
      hasComposeFile: false,
      monorepo: true,
      detectedFiles: ['package.json'],
      workspacePackages: [],
      baseDir: '/',
      commitSha: 'abcdef1234567890abcdef',
      analyzedAt: '2026-01-02T03:04:05Z',
    } as never);
    mockOf(api.insights.refresh).mockResolvedValue({} as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });

    // The overview card surfaces the analysis summary.
    expect(await screen.findByText('Repository Contents')).toBeInTheDocument();
    expect(screen.getByText('Next.js')).toBeInTheDocument();
    expect(screen.getAllByText('ssr').length).toBeGreaterThan(0);
    expect(screen.getByText('Dockerfile')).toBeInTheDocument();
    expect(screen.getByText('monorepo')).toBeInTheDocument();
    expect(screen.getByText('40 prod · 9 dev')).toBeInTheDocument();
    expect(screen.getByText('next build')).toBeInTheDocument();
    expect(screen.getByText('abcdef123456')).toBeInTheDocument();

    // Re-analyze round-trips through the refresh endpoint.
    fireEvent.click(screen.getByRole('button', { name: 'Re-analyze' }));
    await waitFor(() => expect(api.insights.refresh).toHaveBeenCalledWith(1));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Repository analysis updated', 'success'));

    // Failures surface the server message; a non-Error falls back.
    mockOf(api.insights.refresh).mockRejectedValueOnce(new Error('clone failed') as never);
    fireEvent.click(screen.getByRole('button', { name: 'Re-analyze' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('clone failed', 'error'));
  });

  it('jumps the log panel to a clicked pipeline stage', async () => {
    mockOf((await import('../src/lib/useDeployLogs.js')).useDeployLogs).mockReturnValue({
      lines: 'booting\n##[stage:BUILD:success] image built\nserving',
      open: true,
    });
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Deploys');

    // Clicking a stage whose marker exists scrolls the <pre> to it.
    const buildChip = await screen.findByRole('button', { name: /Build: image built/ });
    fireEvent.click(buildChip);
    // Clicking a stage without a marker is a no-op (no crash, no scroll).
    fireEvent.click(screen.getByRole('button', { name: /^Cleanup/ }));
    expect(screen.queryByText('Connecting…')).not.toBeInTheDocument();
  });

  it('clones the service and reports clone failures', async () => {
    mockOf(api.services.clone).mockResolvedValueOnce({ id: 9, name: 'api-clone' } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await screen.findByRole('heading', { name: 'api' });

    fireEvent.click(screen.getByTitle('Clone service configuration and environment variables'));
    await waitFor(() => expect(api.services.clone).toHaveBeenCalledWith(1));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Service cloned: api-clone', 'success'));

    // Failure path toasts. The button is disabled while the mutation is
    // pending and React Query clears that a tick after the success toast, so
    // wait for it to come back before clicking — otherwise the second click
    // lands on a disabled button under load and the test flakes.
    const cloneButton = () => screen.getByTitle('Clone service configuration and environment variables');
    await waitFor(() => expect(cloneButton()).not.toBeDisabled());
    mockOf(api.services.clone).mockRejectedValueOnce(new Error('x') as never);
    fireEvent.click(cloneButton());
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Clone failed', 'error'));
  });

  it('reports deploy trigger failures with and without a message', async () => {
    // Round 1: Error instance → the message rides along on the toast.
    mockOf(api.deploys.trigger).mockRejectedValueOnce(new Error('registry unreachable') as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    fireEvent.click(await screen.findByRole('button', { name: 'Deploy' }));
    // Running service → the redeploy confirmation gates the trigger.
    fireEvent.click(screen.getByRole('button', { name: 'Redeploy' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Deploy failed: registry unreachable', 'error'));

    // Round 2: plain string rejection → generic toast. Fresh render so the
    // once-queue and the dialog state start clean.
    mockOf(api.deploys.trigger).mockRejectedValueOnce('boom' as never);
    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Redeploy' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Deploy failed', 'error'));
  });

  it('asks for confirmation before redeploying a running service', async () => {
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    fireEvent.click(await screen.findByRole('button', { name: 'Deploy' }));

    // The dialog gates the trigger for a LIVE service...
    expect(await screen.findByText(/Redeploy "api"/)).toBeInTheDocument();
    expect(api.deploys.trigger).not.toHaveBeenCalled();

    // Cancel closes it without queueing anything.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText(/Redeploy "api"/)).not.toBeInTheDocument());
    expect(api.deploys.trigger).not.toHaveBeenCalled();

    // ...and confirming through the dialog queues the build.
    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Redeploy' }));
    await waitFor(() => expect(api.deploys.trigger).toHaveBeenCalledWith(1));
  });

  it('lets an admin re-attach or clear the Git credential from settings', async () => {
    const user = userEvent.setup();
    mockOf(api.sources.list).mockResolvedValue([
      { id: 3, name: 'github-app', type: 'github' },
    ] as never);
    mockOf(api.services.get).mockResolvedValue({ ...service, sourceId: 3, sourceName: 'github-app' } as never);
    mockOf(api.services.update).mockResolvedValue({} as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Settings');
    await screen.findByText('Service settings');

    // The attached credential is selected and visible in the dropdown.
    const credSelect = await screen.findByDisplayValue('github-app (github)');
    await user.selectOptions(credSelect, '');
    await user.click(screen.getByRole('button', { name: /save settings/i }));
    // Clearing sends an explicit null (not an omission).
    await waitFor(() =>
      expect(api.services.update).toHaveBeenCalledWith(1, expect.objectContaining({ sourceId: null })));
  });

  it('renders the manifest tab, refreshes it and switches subtabs', async () => {
    mockOf(api.containers.compose).mockResolvedValue({ yaml: 'services:\n  api:\n    image: nginx' } as never);
    mockOf(api.containers.inspect).mockResolvedValue({
      state: { status: 'running' },
      traefikTags: { 'traefik.enable': 'true' },
      raw: { Id: 'abc' },
    } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await screen.findByRole('heading', { name: 'api' });

    await openTab('Manifest');
    expect(await screen.findByText(/image: nginx/)).toBeInTheDocument();
    expect(screen.getByText('RUNNING')).toBeInTheDocument();

    // Subtabs switch the rendered manifest.
    fireEvent.click(screen.getByRole('button', { name: /traefik/i }));
    expect(screen.getAllByText(/traefik/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /inspect/i }));
    fireEvent.click(screen.getByRole('button', { name: /compose/i }));

    // Refresh refetches both manifests.
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.containers.compose).toHaveBeenCalledTimes(2));
  });

  it('shows the empty repository analysis state and its loading state', async () => {    mockOf(api.insights.get).mockResolvedValue(null as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    expect(await screen.findByText('Repository Contents')).toBeInTheDocument();
    expect(screen.getByText(/No analysis yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Analyze now' })).toBeInTheDocument();

    // While loading, the card says so.
    mockOf(api.insights.get).mockReturnValue(new Promise(() => {}) as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    expect(await screen.findByText('Loading analysis…')).toBeInTheDocument();
  });

  it('renders service header with status, auto URL and deploy actions', async () => {
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await screen.findByRole('heading', { name: 'api' });
    expect(screen.getAllByText('running').length).toBeGreaterThan(0);
    expect(screen.getByText('docker')).toBeInTheDocument();
    expect(screen.getByText(': 3000')).toBeInTheDocument();
    expect(screen.getByText('https://github.com/x/y')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'api.nd.local' })).toHaveAttribute('href', 'http://api.nd.local');
    // running -> restart + stop buttons
    expect(screen.getByRole('button', { name: /Restart/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Stop/ })).toBeInTheDocument();
    // runtimeId present -> logs and exec buttons (exact match: the sidebar
    // "Terminal & Exec" tab would also match /Exec/)
    expect(screen.getByRole('button', { name: /Runtime logs/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exec' })).toBeInTheDocument();
    // metrics + runtime info on the overview tab
    expect(await screen.findByText('Live Resource Telemetry')).toBeInTheDocument();
    expect(screen.getByText('Runtime Container')).toBeInTheDocument();
    // The attached Git credential is surfaced by name on the runtime info card.
    expect(screen.getAllByText('github-app').length).toBeGreaterThan(0);
    // deployments + the live log live under the Deploys tab (active = latest)
    await openTab('Deploys');
    expect(await screen.findByText(/Deployment #5/)).toBeInTheDocument();
    // commitSha fallback: deploy #4 has null commitSha -> '—'
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    // cards live under the Environment tab
    await openTab('Environment');
    expect(screen.getByTestId('env-card')).toBeInTheDocument();
    expect(screen.getByTestId('attachments-card')).toBeInTheDocument();
  });

  it('triggers a deploy and shows pending state', async () => {
    mockOf(api.deploys.trigger).mockResolvedValue({ deploymentId: 9 } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    // Exact match: the sidebar "Deploys" tab would also match /Deploy/.
    fireEvent.click(await screen.findByRole('button', { name: 'Deploy' }));
    // Running service → the redeploy confirmation gates the trigger.
    fireEvent.click(screen.getByRole('button', { name: 'Redeploy' }));
    await waitFor(() => expect(api.deploys.trigger).toHaveBeenCalledWith(1));
  });

  it('shows the pending label while a deploy is being triggered', async () => {
    mockOf(api.deploys.trigger).mockReturnValue(new Promise(() => {}) as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    fireEvent.click(await screen.findByRole('button', { name: 'Deploy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Redeploy' }));
    expect(await screen.findByText('Triggering…')).toBeInTheDocument();
  });

  it('polls faster while the service is deploying', async () => {
    mockOf(api.services.get).mockResolvedValue({ ...service, status: 'deploying' } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await screen.findByRole('heading', { name: 'api' });
    expect(screen.getAllByText('deploying').length).toBeGreaterThan(0);
  });

  it('runs lifecycle actions (restart/stop for running, start for stopped)', async () => {
    mockOf(api.services.restart).mockResolvedValue({ ok: true, status: 'running' } as never);
    mockOf(api.services.stop).mockResolvedValue({ ok: true, status: 'stopped' } as never);
    const first = renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    fireEvent.click(await screen.findByRole('button', { name: /Restart/ }));
    await waitFor(() => expect(api.services.restart).toHaveBeenCalledWith(1));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Service restarted', 'success'));
    fireEvent.click(screen.getByRole('button', { name: /Stop/ }));
    await waitFor(() => expect(api.services.stop).toHaveBeenCalledWith(1));
    // source interpolates `${action}ed` -> "stoped"
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Service stoped', 'success'));
    first.unmount();

    // stopped service -> start action
    mockOf(api.services.get).mockResolvedValue({ ...service, status: 'stopped', autoUrl: null, runtimeId: null } as never);
    mockOf(api.services.start).mockResolvedValue({ ok: true, status: 'running' } as never);
    const { unmount } = renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await screen.findByRole('button', { name: /Start/ });
    fireEvent.click(screen.getByRole('button', { name: /Start/ }));
    await waitFor(() => expect(api.services.start).toHaveBeenCalledWith(1));
    // no restart/stop when stopped; no logs/exec buttons without runtimeId
    expect(screen.queryByRole('button', { name: /Restart/ })).not.toBeInTheDocument();
    unmount();
  });

  it('reports lifecycle failure via toast', async () => {
    mockOf(api.services.restart).mockRejectedValue(new Error('nope'));
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    fireEvent.click(await screen.findByRole('button', { name: /Restart/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Action failed', 'error'));
  });

  it('toggles runtime logs and shows their content', async () => {
    mockOf(api.services.logs).mockResolvedValue({ lines: 'line one\nline two' } as never);
    const user = userEvent.setup();
    mockOf((await import('../src/lib/useDeployLogs.js')).useDeployLogs).mockReturnValue({ lines: 'deploy log line', open: true });
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await user.click(await screen.findByRole('button', { name: /Runtime logs/ }));
    await screen.findByText((_content, el) => el?.textContent === 'line one\nline two');
    // toggle to hide
    await user.click(screen.getByRole('button', { name: /Hide logs/ }));
    expect(screen.queryByText('line one')).not.toBeInTheDocument();
  });

  it('shows the empty runtime logs placeholder', async () => {
    mockOf(api.services.logs).mockResolvedValue({ lines: '' } as never);
    const user = userEvent.setup();
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await user.click(await screen.findByRole('button', { name: /Runtime logs/ }));
    await screen.findByText('No logs yet.');
  });

  it('shows the deploy log panel open with lines and auto-scrolls', async () => {
    // Key the mock on the deploymentId so `lines` changes exactly when the
    // active deploy is selected: the auto-scroll effect (deps [content, ref])
    // only re-runs when content changes, which is when the <pre> mounts.
    mockOf((await import('../src/lib/useDeployLogs.js')).useDeployLogs).mockImplementation(
      (_svc: number | null, depId: number | null) =>
        depId == null ? { lines: '', open: false } : { lines: 'line one\nline two', open: true },
    );
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Deploys');
    await screen.findByText((_content, el) => el?.textContent === 'line one\nline two');
    expect(screen.queryByText('Connecting…')).not.toBeInTheDocument();
  });

  it('renders an empty log panel when open with no lines', async () => {
    mockOf((await import('../src/lib/useDeployLogs.js')).useDeployLogs).mockReturnValue({ lines: '', open: true });
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Deploys');
    // open=true with empty lines renders '' instead of 'Connecting…'
    await screen.findByText(/Deployment #5/);
    expect(screen.queryByText('Connecting…')).not.toBeInTheDocument();
  });

  it('opens and closes the exec terminal', async () => {
    const user = userEvent.setup();
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await user.click(await screen.findByRole('button', { name: 'Exec' }));
    expect(screen.getByTestId('terminal')).toHaveTextContent('terminal-1');
    await user.click(screen.getByRole('button', { name: 'close terminal' }));
    expect(screen.queryByTestId('terminal')).not.toBeInTheDocument();
  });

  it('exports the service and reports failures', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['x']) } as Response);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    fireEvent.click(await screen.findByRole('button', { name: /Export/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/v1/services/1/export', expect.anything()));
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(`Bearer ${getToken()}`);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Service exported', 'success'));

    fetchMock.mockResolvedValueOnce({ ok: false } as Response);
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Export failed', 'error'));
  });

  it('exports with fallback token and filename when missing', async () => {
    mockOf(getToken).mockReturnValue(null);
    mockOf(api.services.get).mockResolvedValue({ ...service, slug: null } as never);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['x']) } as Response);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    fireEvent.click(await screen.findByRole('button', { name: /Export/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(null);
  });

  it('adds and removes domains on the service', async () => {
    const user = userEvent.setup();
    mockOf(api.domains.create).mockResolvedValue({ id: 2, hostname: 'new.example.com' } as never);
    mockOf(api.domains.remove).mockResolvedValue(undefined as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Network');
    await screen.findByText('app.example.com');
    await user.type(screen.getByPlaceholderText('app.example.com'), 'new.example.com');
    await user.click(screen.getByRole('button', { name: /Add/ }));
    await waitFor(() => expect(api.domains.create).toHaveBeenCalledWith(1, { hostname: 'new.example.com' }));
    fireEvent.click(screen.getByTitle('Remove domain'));
    await waitFor(() => expect(api.domains.remove).toHaveBeenCalledWith(1, 1));
  });

  it('does not add an empty domain', async () => {
    const user = userEvent.setup();
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Network');
    const addButton = await screen.findByRole('button', { name: /Add/ });
    expect(addButton).toBeDisabled();
    await user.type(screen.getByPlaceholderText('app.example.com'), '   ');
    expect(addButton).toBeDisabled();
    // submitting the form with a blank hostname does not call create
    fireEvent.submit(addButton.closest('form')!);
    expect(api.domains.create).not.toHaveBeenCalled();
  });

  it('shows domain empty state and creates webhooks with revealed secret', async () => {
    const user = userEvent.setup();
    // user-event installs its own clipboard polyfill; re-mock after setup
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mockOf(api.domains.list).mockResolvedValue([] as never);
    mockOf(api.webhooks.list).mockResolvedValue([] as never);
    mockOf(api.webhooks.create).mockResolvedValue({ id: 3, url: 'https://hook.example.com/3', secret: 'newsecret', branch: 'main' } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Network');
    await screen.findByText('No domains attached.');
    await openTab('Environment');
    expect(await screen.findByText('No webhooks. Create one and add it to GitHub/GitLab.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /New/ }));
    await waitFor(() => expect(api.webhooks.create).toHaveBeenCalledWith(1, undefined));
    expect(await screen.findByText('Copy these now — the secret is shown only once.')).toBeInTheDocument();
    expect(screen.getByText('https://hook.example.com/3')).toBeInTheDocument();
    expect(screen.getByText('newsecret')).toBeInTheDocument();
    // copy the URL from the revealed row
    const urlRow = screen.getByText('https://hook.example.com/3').closest('div')!;
    const urlCopyButton = urlRow.querySelector('button')!;
    fireEvent.click(urlCopyButton);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://hook.example.com/3'));
    expect(urlCopyButton.querySelector('.lucide-check')).not.toBeNull();
    // copy the secret from its row (covers the secret copy handler)
    const secretRow = screen.getByText('newsecret').closest('div')!;
    const secretCopyButton = secretRow.querySelector('button')!;
    fireEvent.click(secretCopyButton);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('newsecret'));
    // the copied indicator resets after the 1500ms timeout
    await waitFor(() => expect(secretCopyButton.querySelector('.lucide-check')).toBeNull(), { timeout: 2500 });
    // dismiss the revealed box
    await user.click(screen.getByRole('button', { name: /saved it/ }));
    expect(screen.queryByText('newsecret')).not.toBeInTheDocument();
  });

  it('removes a webhook and copies its url', async () => {
    const user = userEvent.setup();
    // user-event installs its own clipboard polyfill; re-mock after setup
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mockOf(api.webhooks.remove).mockResolvedValue(undefined as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Environment');
    await screen.findAllByText('main');
    fireEvent.click(screen.getByTitle('Remove webhook'));
    await waitFor(() => expect(api.webhooks.remove).toHaveBeenCalledWith(1, 1));
    // copy url button on the webhook row
    const copyButton = screen.getByTitle('https://hook.example.com/1');
    await user.click(copyButton);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://hook.example.com/1'));
  });

  it('cancels an in-flight deployment from the deployments list', async () => {
    mockOf(api.deploys.list).mockResolvedValue([
      { ...deploys[0], status: 'building' },
      ...deploys.slice(1),
    ] as never);
    mockOf(api.deploys.cancel).mockResolvedValue({ ok: true, status: 'cancelled' } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Deploys');
    fireEvent.click(await screen.findByTitle('Cancel deployment #5'));
    await waitFor(() => expect(api.deploys.cancel).toHaveBeenCalledWith(1, 5));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Deployment cancelled', 'info'));
  });

  it('shows a watch-path badge on webhooks and sends watch paths on create', async () => {
    const user = userEvent.setup();
    mockOf(api.webhooks.create).mockResolvedValue({ id: 4, url: 'https://hook.example.com/4', secret: 's4', branch: 'main' } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Environment');
    expect(await screen.findByText(/watch: 1 path/)).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/Watch paths/), 'apps/api/**');
    fireEvent.click(screen.getByRole('button', { name: /New/ }));
    await waitFor(() => expect(api.webhooks.create).toHaveBeenCalledWith(1, { watchPaths: 'apps/api/**' }));
  });

  it('creates a webhook without watch paths when the field is empty', async () => {
    mockOf(api.webhooks.create).mockResolvedValue({ id: 5, url: 'https://hook.example.com/5', secret: 's5', branch: 'main' } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Environment');
    await screen.findAllByText('main');
    fireEvent.click(screen.getByRole('button', { name: /New/ }));
    await waitFor(() => expect(api.webhooks.create).toHaveBeenCalledWith(1, undefined));
  });

  /**
   * Removing a deployment from history. There was no delete path anywhere
   * before: the log FILE aged out at 30 days while the row never did, so the
   * older half of this list showed builds whose logs had already been swept.
   */
  it('removes a finished deployment from history', async () => {
    mockOf(api.deploys.remove).mockResolvedValue({ ok: true, id: 4 } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Deploys');
    fireEvent.click(await screen.findByTitle('Remove deployment #4 from history'));
    await waitFor(() => expect(api.deploys.remove).toHaveBeenCalledWith(1, 4));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Deployment removed', 'info'));
  });

  it('clears the log panel when the removed deployment is the selected one', async () => {
    // Otherwise the output panel stays pointed at a deployment that no longer
    // exists, and its log socket reconnects to a 404.
    mockOf(api.deploys.remove).mockResolvedValue({ ok: true, id: 4 } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Deploys');
    // Select #4 first, then remove it.
    fireEvent.click(await screen.findByText('#4'));
    await screen.findByText(/Deployment #4/);
    fireEvent.click(await screen.findByTitle('Remove deployment #4 from history'));
    await waitFor(() => expect(api.deploys.remove).toHaveBeenCalledWith(1, 4));
    // The panel stops describing #4. (The page then falls back to the newest
    // deployment; what matters is that it does not stay on the removed one.)
    await waitFor(() => expect(screen.queryByText(/Deployment #4 ·/)).not.toBeInTheDocument());
  });

  it('offers no remove button for the deployment serving traffic or an in-flight one', async () => {
    // #5 is `running` — the row that records what is live, carries the digest a
    // rollback re-deploys, and is refused by the server.
    mockOf(api.deploys.list).mockResolvedValue([
      { ...deploys[0], status: 'running' },
      { ...deploys[1], status: 'building' },
    ] as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Deploys');
    await screen.findByTitle('Cancel deployment #4');
    expect(screen.queryByTitle(/Remove deployment/)).not.toBeInTheDocument();
  });

  it('surfaces the server reason when a remove is refused', async () => {
    mockOf(api.deploys.remove).mockRejectedValue(
      new Error('This deployment is the version currently serving traffic and cannot be removed') as never,
    );
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Deploys');
    fireEvent.click(await screen.findByTitle('Remove deployment #4 from history'));
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith(
        'This deployment is the version currently serving traffic and cannot be removed',
        'error',
      ),
    );
  });

  it('falls back to a generic message when the remove rejection is not an Error', async () => {
    mockOf(api.deploys.remove).mockRejectedValue('boom' as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Deploys');
    fireEvent.click(await screen.findByTitle('Remove deployment #4 from history'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Remove failed', 'error'));
  });

  it('reports cancel failures via toast', async () => {
    mockOf(api.deploys.list).mockResolvedValue([{ ...deploys[0], status: 'queued' }] as never);
    mockOf(api.deploys.cancel).mockRejectedValue(new Error('x') as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Deploys');
    fireEvent.click(await screen.findByTitle('Cancel deployment #5'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Cancel failed', 'error'));
  });

  it('toggles the www→apex redirect from the network tab', async () => {
    mockOf(api.domains.update).mockResolvedValue(domains[0] as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Network');
    const wwwBadge = await screen.findByText('www');
    expect(wwwBadge).toHaveAttribute('title', 'Redirect www. to the apex host — click to enable');
    fireEvent.click(wwwBadge);
    await waitFor(() => expect(api.domains.update).toHaveBeenCalledWith(1, 1, { redirectWww: true }));
    mockOf(api.domains.update).mockRejectedValue(new Error('x') as never);
    fireEvent.click(screen.getByText('www'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not toggle the www redirect', 'error'));
  });

  it('creates a webhook via the watch-paths form submit', async () => {
    mockOf(api.webhooks.create).mockResolvedValue({ id: 6, url: 'https://hook.example.com/6', secret: 's6', branch: 'main' } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Environment');
    const input = await screen.findByPlaceholderText(/Watch paths/);
    fireEvent.change(input, { target: { value: 'apps/web/**' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(api.webhooks.create).toHaveBeenCalledWith(1, { watchPaths: 'apps/web/**' }));
  });

  it('shows an active www badge for domains with the redirect enabled', async () => {
    mockOf(api.domains.list).mockResolvedValue([
      { ...domains[0], redirectWww: true },
    ] as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Network');
    const badge = await screen.findByText('www');
    expect(badge).toHaveAttribute('title', 'www→apex redirect on — click to disable');
  });

  it('configures domain security middlewares from the security drawer', async () => {
    mockOf(api.domains.update).mockResolvedValue({ ...domains[0], basicAuth: 'admin:secret' } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Network');
    const secBtn = await screen.findByText('Security');
    fireEvent.click(secBtn);
    const authInput = screen.getByPlaceholderText(/admin:password/);
    const ipInput = screen.getByPlaceholderText(/192.168.1.0/);
    const avgInput = screen.getByPlaceholderText(/50 \(0 = disabled\)/);
    const burstInput = screen.getByPlaceholderText(/100/);

    fireEvent.change(authInput, { target: { value: 'admin:secret' } });
    fireEvent.change(ipInput, { target: { value: '10.0.0.0/8' } });
    fireEvent.change(avgInput, { target: { value: '50' } });
    fireEvent.change(burstInput, { target: { value: '100' } });

    const saveBtn = screen.getByText('Save Security Settings');
    fireEvent.click(saveBtn);
    await waitFor(() =>
      expect(api.domains.update).toHaveBeenCalledWith(1, 1, {
        basicAuth: 'admin:secret',
        ipAllowlist: '10.0.0.0/8',
        rateLimitAverage: 50,
        rateLimitBurst: 100,
      }),
    );

    // Cancel closes drawer
    fireEvent.click(secBtn);
    const cancelBtn = screen.getByText('Cancel');
    fireEvent.click(cancelBtn);
    expect(screen.queryByText('Save Security Settings')).not.toBeInTheDocument();

    // Error handling
    mockOf(api.domains.update).mockRejectedValueOnce(new Error('fail'));
    fireEvent.click(secBtn);
    fireEvent.click(screen.getByText('Save Security Settings'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not update domain security settings', 'error'));
  });

  it('renders domains with pre-configured active security settings and allows clearing them', async () => {
    mockOf(api.domains.list).mockResolvedValue([
      {
        ...domains[0],
        basicAuth: 'admin:secret',
        ipAllowlist: '1.2.3.4/32',
        rateLimitAverage: 10,
        rateLimitBurst: 20,
      },
    ] as never);
    mockOf(api.domains.update).mockResolvedValue({ ...domains[0], basicAuth: null } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Network');
    const secBtn = await screen.findByText('Security');
    expect(secBtn.className).toContain('text-amber-300');

    fireEvent.click(secBtn);
    const authInput = screen.getByPlaceholderText(/admin:password/);
    const ipInput = screen.getByPlaceholderText(/192.168.1.0/);
    const avgInput = screen.getByPlaceholderText(/50 \(0 = disabled\)/);
    const burstInput = screen.getByPlaceholderText(/100/);

    fireEvent.change(authInput, { target: { value: '' } });
    fireEvent.change(ipInput, { target: { value: '' } });
    fireEvent.change(avgInput, { target: { value: '' } });
    fireEvent.change(burstInput, { target: { value: '' } });

    fireEvent.click(screen.getByText('Save Security Settings'));
    await waitFor(() =>
      expect(api.domains.update).toHaveBeenCalledWith(1, 1, {
        basicAuth: null,
        ipAllowlist: null,
        rateLimitAverage: null,
        rateLimitBurst: null,
      }),
    );
  });

  it('manages scheduled jobs from the config tab', async () => {
    mockOf(api.jobs.list).mockResolvedValue([
      { id: 3, name: 'nightly', cron: '0 3 * * *', kind: 'deploy', command: '', enabled: true, lastRunAt: null },
      { id: 4, name: 'cleanup', cron: '*/10 * * * *', kind: 'exec', command: 'rm -rf /tmp/*', enabled: false, lastRunAt: '2026-01-01T00:00:00Z' },
    ] as never);
    mockOf(api.jobs.create).mockResolvedValue({ id: 5 } as never);
    mockOf(api.jobs.run).mockResolvedValue({ ok: true } as never);
    mockOf(api.jobs.update).mockResolvedValue({ ok: true } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Environment');
    expect(await screen.findByText('nightly')).toBeInTheDocument();
    expect(screen.getByText('0 3 * * *')).toBeInTheDocument();
    expect(screen.getByText('rm -rf /tmp/*')).toBeInTheDocument();

    // Create an exec job: pick the custom preset, then hand-write the cron.
    fireEvent.change(screen.getByPlaceholderText('nightly-rebuild'), { target: { value: 'purge' } });
    fireEvent.change(screen.getByLabelText('Schedule preset'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '15 2 * * *' } });
    fireEvent.change(screen.getByLabelText('Job action'), { target: { value: 'exec' } });
    fireEvent.change(screen.getByPlaceholderText(/pg_dump/), { target: { value: 'echo done' } });
    fireEvent.click(screen.getByRole('button', { name: /Add job/ }));
    await waitFor(() =>
      expect(api.jobs.create).toHaveBeenCalledWith(1, { name: 'purge', cron: '15 2 * * *', kind: 'exec', command: 'echo done' }));

    // Run now, toggle, delete.
    fireEvent.click(screen.getAllByText('run')[0]!);
    await waitFor(() => expect(api.jobs.run).toHaveBeenCalledWith(1, 3));
    fireEvent.click(screen.getByText('on'));
    await waitFor(() => expect(api.jobs.update).toHaveBeenCalledWith(1, 3, { enabled: false }));
    fireEvent.click(screen.getAllByTitle('Delete job')[0]!);
    await waitFor(() => expect(api.jobs.remove).toHaveBeenCalledWith(1, 3));
  });

  it('creates a daily job straight from a ready-made preset', async () => {
    mockOf(api.jobs.create).mockResolvedValue({ id: 6 } as never);
    mockOf(api.jobs.list).mockResolvedValue([] as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Environment');
    expect(await screen.findByText('No scheduled jobs.')).toBeInTheDocument();

    // Default preset is Daily · 03:00 — only a name is needed.
    fireEvent.change(screen.getByPlaceholderText('nightly-rebuild'), { target: { value: 'nightly' } });
    expect(await screen.findByText(/next /)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Time of day'), { target: { value: '04:30' } });
    fireEvent.click(screen.getByRole('button', { name: /Add job/ }));
    await waitFor(() =>
      expect(api.jobs.create).toHaveBeenCalledWith(1, { name: 'nightly', cron: '30 4 * * *', kind: 'deploy', command: undefined }));
  });

  it('reports job action failures', async () => {
    mockOf(api.jobs.list).mockResolvedValue([
      { id: 3, name: 'nightly', cron: '0 3 * * *', kind: 'deploy', command: '', enabled: true, lastRunAt: null },
    ] as never);
    mockOf(api.jobs.run).mockRejectedValue(new Error('x') as never);
    mockOf(api.jobs.create).mockRejectedValue(new Error('y') as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Environment');
    fireEvent.click(await screen.findByText('run'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Job run failed', 'error'));
    fireEvent.change(screen.getByPlaceholderText('nightly-rebuild'), { target: { value: 'z' } });
    fireEvent.change(screen.getByLabelText('Schedule preset'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '* * * * *' } });
    fireEvent.click(screen.getByRole('button', { name: /Add job/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not create the job', 'error'));
  });

  it('ignores job form submits with incomplete inputs', async () => {
    mockOf(api.jobs.list).mockResolvedValue([] as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Environment');
    expect(await screen.findByText('No scheduled jobs.')).toBeInTheDocument();
    fireEvent.submit(screen.getByPlaceholderText('nightly-rebuild').closest('form')!);
    expect(api.jobs.create).not.toHaveBeenCalled();
  });

  it('shows the error state instead of skeletons on failure', async () => {
    mockOf(api.services.get).mockRejectedValue(new Error('404'));
    renderRoute(<ServiceDetail />, { path: '/services/:id', initialEntries: ['/services/1'] });
    expect(await screen.findByText(/Couldn't load this service/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    expect(api.services.get).toHaveBeenCalled();
  });

  it('deletes the service from the danger zone after typing the name', async () => {
    const user = userEvent.setup();
    mockOf(api.services.remove).mockResolvedValue(undefined as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', initialEntries: ['/services/1'] });
    await openTab('Danger');
    await screen.findByText('Danger zone');

    // Button stays disabled until the exact name is typed.
    const del = screen.getByRole('button', { name: /Delete service/i });
    expect(del).toBeDisabled();
    await user.type(screen.getByLabelText('Confirm service name'), service.name);
    expect(del).toBeEnabled();
    await user.click(del);
    await waitFor(() => expect(api.services.remove).toHaveBeenCalledWith(service.id));
  });

  it('shows the deleting state while removal is in flight', async () => {
    const user = userEvent.setup();
    mockOf(api.services.remove).mockReturnValue(new Promise(() => {}) as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', initialEntries: ['/services/1'] });
    await openTab('Danger');
    await screen.findByText('Danger zone');
    await user.type(screen.getByLabelText('Confirm service name'), service.name);
    fireEvent.click(screen.getByRole('button', { name: /Delete service/i }));
    expect(await screen.findByText('Deleting…')).toBeInTheDocument();
  });

  it('keeps the delete button disabled for a mismatched name', async () => {
    const user = userEvent.setup();
    renderRoute(<ServiceDetail />, { path: '/services/:id', initialEntries: ['/services/1'] });
    await openTab('Danger');
    await screen.findByText('Danger zone');
    await user.type(screen.getByLabelText('Confirm service name'), 'wrong-name');
    expect(screen.getByRole('button', { name: /Delete service/i })).toBeDisabled();
  });

  it('reports rollback, delete, domain and webhook failures via toasts', async () => {
    mockOf(api.deploys.list).mockResolvedValue([
      { id: 11, serviceId: 1, status: 'running', commitSha: 'abc1234', imageDigest: null, message: null, author: null, trigger: 'user', logPath: null, startedAt: null, finishedAt: null, createdAt: '2026-01-02T00:00:00Z' },
      { id: 10, serviceId: 1, status: 'running', commitSha: 'def5678', imageDigest: null, message: null, author: null, trigger: 'user', logPath: null, startedAt: null, finishedAt: null, createdAt: '2026-01-01T00:00:00Z' },
    ] as never);
    mockOf(api.deploys.rollback).mockRejectedValue(new Error('x'));
    mockOf(api.services.remove).mockRejectedValue(new Error('x'));
    mockOf(api.domains.create).mockRejectedValue(new Error('x'));
    mockOf(api.domains.remove).mockRejectedValue(new Error('x'));
    mockOf(api.webhooks.create).mockRejectedValue(new Error('x'));
    mockOf(api.webhooks.remove).mockRejectedValue(new Error('x'));
    const user = userEvent.setup();
    renderRoute(<ServiceDetail />, { path: '/services/:id', initialEntries: ['/services/1'] });

    // Rollback failure (deploys tab).
    await openTab('Deploys');
    fireEvent.click(await screen.findByTitle('Rollback to #10'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Rollback failed', 'error'));

    // Domain add/remove failures (network tab).
    await openTab('Network');
    await user.type(screen.getByPlaceholderText('app.example.com'), 'x.example.com');
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not add the domain', 'error'));
    fireEvent.click(screen.getByTitle('Remove domain'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not remove the domain', 'error'));

    // Webhook create/remove failures (config tab).
    await openTab('Environment');
    fireEvent.click(screen.getByRole('button', { name: /New/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not create the webhook', 'error'));
    fireEvent.click(screen.getByTitle('Remove webhook'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not remove the webhook', 'error'));

    // Danger zone delete failure (own tab now).
    await openTab('Danger');
    await user.type(await screen.findByLabelText('Confirm service name'), service.name);
    fireEvent.click(screen.getByRole('button', { name: /Delete service/i }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Delete failed', 'error'));
  });

  it('offers rollback on an older succeeded deployment', async () => {
    mockOf(api.deploys.list).mockResolvedValue([
      { id: 11, serviceId: 1, status: 'running', commitSha: 'abc1234', imageDigest: null, message: null, author: null, trigger: 'user', logPath: null, startedAt: null, finishedAt: null, createdAt: '2026-01-02T00:00:00Z' },
      { id: 10, serviceId: 1, status: 'running', commitSha: 'def5678', imageDigest: null, message: null, author: null, trigger: 'user', logPath: null, startedAt: null, finishedAt: null, createdAt: '2026-01-01T00:00:00Z' },
      { id: 9, serviceId: 1, status: 'failed', commitSha: 'bad0000', imageDigest: null, message: null, author: null, trigger: 'user', logPath: null, startedAt: null, finishedAt: null, createdAt: '2025-12-31T00:00:00Z' },
    ] as never);
    mockOf(api.deploys.rollback).mockResolvedValue({ deploymentId: 12 } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', initialEntries: ['/services/1'] });
    await openTab('Deploys');
    const rb = await screen.findByTitle('Rollback to #10');
    fireEvent.click(rb);
    await waitFor(() => expect(api.deploys.rollback).toHaveBeenCalledWith(service.id, 10));
    // Failed deploys never offer rollback.
    expect(screen.queryByTitle('Rollback to #9')).not.toBeInTheDocument();
  });

  it('selects a deployment row when clicked', async () => {
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Deploys');
    // active deploy auto-selects the latest (#5); click row #4 to select it
    const row4 = await screen.findByText('#4');
    fireEvent.click(row4.closest('button')!);
    // the log panel header now shows the selected deployment
    await screen.findByText(/Deployment #4/);
  });

  it('shows deployment metadata (message, author, trigger, duration)', async () => {
    mockOf(api.deploys.list).mockResolvedValue([
      {
        id: 7, serviceId: 1, status: 'running', commitSha: 'abcdef1', message: 'fix: resize sparkline',
        author: 'ersin', trigger: 'webhook', startedAt: '2026-01-01T00:00:00Z',
        finishedAt: '2026-01-01T00:01:30Z', createdAt: '2026-01-01T00:00:00Z',
      },
    ] as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Deploys');
    const row = await screen.findByText(/fix: resize sparkline/);
    expect(row.textContent).toContain('webhook');
    expect(row.textContent).toContain('ersin');
    expect(row.textContent).toContain('90s');
  });

  it('rolls back to an earlier running deployment', async () => {
    mockOf(api.deploys.rollback).mockResolvedValue({ deploymentId: 7 } as never);
    const deploysWithOld = [
      { ...deploys[0], status: 'running' },
      { ...deploys[1], status: 'running', id: 4 },
    ];
    mockOf(api.deploys.list).mockResolvedValue(deploysWithOld as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Deploys');
    await screen.findByText('#5');
    fireEvent.click(await screen.findByTitle('Rollback to #4'));
    await waitFor(() => expect(api.deploys.rollback).toHaveBeenCalledWith(1, 4));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Rollback started', 'info'));
  });

  it('shows deployment list empty and loading states', async () => {
    mockOf(api.deploys.list).mockReturnValue(new Promise(() => {}) as never);
    const { unmount } = renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Deploys');
    await screen.findByText('Deployments');
    expect(screen.getByText('Trigger a deploy to see live logs.')).toBeInTheDocument();
    unmount();

    mockOf(api.deploys.list).mockResolvedValue([] as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Deploys');
    await screen.findByText('No deployments yet.');
  });

  it('invalidates the service when an in-flight deploy becomes terminal', async () => {
    // first list returns an in-flight deploy, second returns terminal
    mockOf(api.deploys.list).mockResolvedValueOnce([{ ...deploys[0], status: 'building' }] as never);
    const { queryClient } = renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Deploys');
    await screen.findByText('#5');
    expect(screen.getAllByText('building').length).toBeGreaterThan(0);
    // now the deploy finishes
    mockOf(api.deploys.list).mockResolvedValue([{ ...deploys[0], status: 'running' }] as never);
    await act(async () => {
      queryClient.setQueryData(['deploys', 1], [{ ...deploys[0], status: 'running' }]);
      await queryClient.refetchQueries({ queryKey: ['deploys', 1] });
    });
    // the transition effect invalidates the service query -> refetch
    // (initial fetch may be deduped across the header + runtime-info observers)
    await waitFor(() => expect(mockOf(api.services.get).mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('saves service settings and build config from the settings tab', async () => {
    const user = userEvent.setup();
    mockOf(api.services.update).mockResolvedValue(service as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Settings');
    await screen.findByText('Service settings');
    // fields are prefilled from the service
    expect((screen.getByDisplayValue('api') as HTMLInputElement).value).toBe('api');
    expect((screen.getByDisplayValue('npm run build') as HTMLInputElement).value).toBe('npm run build');
    // edit name + start command, clear the port (optional field), and save
    const nameInput = screen.getByDisplayValue('api');
    await user.clear(nameInput);
    await user.type(nameInput, 'api-v2');
    const portInput = screen.getByDisplayValue('3000');
    await user.clear(portInput);
    await user.click(screen.getByRole('button', { name: /Save settings/ }));
    await waitFor(() =>
      expect(api.services.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          name: 'api-v2',
          repoUrl: 'https://github.com/x/y',
          port: undefined,
          build: expect.objectContaining({ buildPack: 'auto', startCmd: 'npm start' }),
        }),
      ),
    );
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Settings saved — redeploy to apply', 'success'));
  });

  it('r205: an emptied build command is sent as a clear, not dropped', async () => {
    const user = userEvent.setup();
    mockOf(api.services.update).mockResolvedValue(service as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Settings');
    await screen.findByText('Service settings');
    await user.clear(screen.getByDisplayValue('npm run build'));
    await user.click(screen.getByRole('button', { name: /Save settings/ }));
    await waitFor(() =>
      expect(api.services.update).toHaveBeenCalledWith(1, expect.objectContaining({ build: expect.objectContaining({ buildCmd: '' }) })),
    );
  });

  it('reports settings save failures', async () => {
    mockOf(api.services.update).mockRejectedValue(new Error('x'));
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Settings');
    fireEvent.click(await screen.findByRole('button', { name: /Save settings/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not save settings', 'error'));
  });

  it('saves resource limits from the settings tab', async () => {
    const user = userEvent.setup();
    // Fresh object per fetch so the post-save invalidation produces a new
    // reference (react-query structural sharing keeps identical objects).
    mockOf(api.services.get).mockImplementation(async () => ({ ...service }) as never);
    mockOf(api.limits.setService).mockResolvedValue({ cpuShares: 2048, cpuLimitMilli: 0, memLimitMb: 1024, liveApplied: false } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Settings');
    const cpuInput = await screen.findByDisplayValue('1024');
    await user.clear(cpuInput);
    await user.type(cpuInput, '2048');
    const memInput = screen.getByDisplayValue('512');
    await user.clear(memInput);
    await user.type(memInput, '1024');
    await user.click(screen.getByRole('button', { name: /Save limits/ }));
    await waitFor(() => expect(api.limits.setService).toHaveBeenCalledWith(1, { cpuShares: 2048, cpuLimitMilli: null, memLimitMb: 1024 }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Limits saved — applied on next deploy', 'success'));
  });

  it('saves PR preview environments settings and handles field changes', async () => {
    const user = userEvent.setup();
    mockOf(api.services.get).mockResolvedValue({
      ...service,
      previewDeploymentsEnabled: true,
      previewDomainPattern: 'preview-{{pr}}.example.com',
      previewMaxActive: 3,
      previewAutoDestroyOnClose: true,
    } as never);
    mockOf(api.services.update).mockResolvedValue({ ...service } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Settings');
    await screen.findByText('Ephemeral PR / MR Preview Deployments');
    
    const patternInput = screen.getByDisplayValue('preview-{{pr}}.example.com');
    fireEvent.change(patternInput, { target: { value: 'pr-{{pr}}.domain.io' } });

    const maxActiveInput = screen.getByDisplayValue('3');
    await user.clear(maxActiveInput);
    await user.type(maxActiveInput, '10');

    const autoDestroyCheckbox = screen.getByLabelText(/Auto-destroy ephemeral preview/i);
    await user.click(autoDestroyCheckbox);

    await user.click(screen.getByRole('button', { name: /Save PR preview settings/ }));
    await waitFor(() =>
      expect(api.services.update).toHaveBeenCalledWith(1, {
        previewDeploymentsEnabled: true,
        previewAutoDestroyOnClose: false,
        previewDomainPattern: 'pr-{{pr}}.domain.io',
        previewMaxActive: 10,
      }),
    );
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('PR Preview settings saved', 'success'));
  });

  it('reports PR preview save failures via toast and tests toggle and empty field fallbacks', async () => {
    const user = userEvent.setup();
    let resolveUpdate: (val: unknown) => void = () => {};
    mockOf(api.services.get).mockResolvedValue({
      ...service,
      previewDeploymentsEnabled: true,
      previewDomainPattern: 'preview-{{pr}}.example.com',
      previewMaxActive: 3,
    } as never);
    mockOf(api.services.update).mockImplementation(() => new Promise((resolve) => {
      resolveUpdate = resolve;
    }));

    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Settings');
    await screen.findByText('Ephemeral PR / MR Preview Deployments');

    // Clear pattern and maxActive to test empty fallbacks
    const patternInput = screen.getByDisplayValue('preview-{{pr}}.example.com');
    fireEvent.change(patternInput, { target: { value: '' } });
    const maxActiveInput = screen.getByDisplayValue('3');
    await user.clear(maxActiveInput);

    const saveBtn = screen.getByRole('button', { name: /Save PR preview settings/ });
    await user.click(saveBtn);
    expect(screen.getByText('Saving…')).toBeInTheDocument();

    expect(api.services.update).toHaveBeenCalledWith(1, {
      previewDeploymentsEnabled: true,
      previewAutoDestroyOnClose: true,
      previewDomainPattern: null,
      previewMaxActive: 5,
    });

    resolveUpdate(service);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('PR Preview settings saved', 'success'));

    // Toggle off and test error toast
    const toggle = screen.getAllByRole('checkbox')[0]!;
    await user.click(toggle);
    mockOf(api.services.update).mockRejectedValueOnce(new Error('err'));
    await user.click(screen.getByRole('button', { name: /Save PR preview settings/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not save PR preview settings', 'error'));
  });

  it('toggles per-domain SSL from the network tab', async () => {
    mockOf(api.domains.setSsl).mockResolvedValue({ id: 1, ssl: false } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Network');
    const sslBadge = await screen.findByText('HTTPS');
    fireEvent.click(sslBadge);
    await waitFor(() => expect(api.domains.setSsl).toHaveBeenCalledWith(1, false));
    mockOf(api.domains.setSsl).mockRejectedValue(new Error('x'));
    fireEvent.click(screen.getByText('HTTPS'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not toggle SSL', 'error'));
  });

  it('renders plain-HTTP domains with a path and offers enabling SSL', async () => {
    mockOf(api.domains.list).mockResolvedValue([
      { ...domains[0], ssl: false, path: '/api' },
    ] as never);
    mockOf(api.domains.setSsl).mockResolvedValue({ id: 1, ssl: true } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Network');
    const badge = await screen.findByText('HTTP');
    expect(badge).toHaveAttribute('title', 'HTTPS off — click to issue a certificate');
    expect(screen.getByRole('link', { name: /app\.example\.com/ })).toHaveAttribute('href', 'http://app.example.com/api');
    expect(screen.getByText('/api')).toBeInTheDocument();
    fireEvent.click(badge);
    await waitFor(() => expect(api.domains.setSsl).toHaveBeenCalledWith(1, true));
  });

  it('defaults limit inputs to empty for a service without limits', async () => {
    mockOf(api.services.get).mockResolvedValue({ ...service, cpuShares: 0, memLimitMb: 0 } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Settings');
    await screen.findByText('Resource limits');
    const inputs = document.querySelectorAll<HTMLInputElement>('input.w-44');
    // CPU cap + CPU shares + memory (limits card) and the replicas field
    // (scaling card — docker services always render it, defaulting to 1).
    expect(inputs).toHaveLength(4);
    expect(inputs[0]).toHaveValue('');
    expect(inputs[1]).toHaveValue('');
    expect(inputs[2]).toHaveValue('');
    expect(inputs[3]).toHaveValue('1');
  });

  it('renders an undeployed service with all-optional fields missing', async () => {
    mockOf(api.services.get).mockResolvedValue({
      ...service,
      runtimeId: null, commitSha: null, image: 'nginx:latest', repoUrl: null, port: null, healthPath: null,
      volumeMount: null, cpuShares: 0, memLimitMb: 0, build: null,
    } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    // Overview: runtime card shows the not-deployed / fallback values.
    expect(await screen.findByText('not deployed')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText('unlimited').length).toBe(2);
    expect(screen.getAllByText('nginx:latest').length).toBeGreaterThanOrEqual(2);
    // Settings: build config defaults when no build row exists.
    await openTab('Settings');
    expect((await screen.findByDisplayValue('auto') as HTMLSelectElement).value).toBe('auto');
    expect(screen.getByDisplayValue('/')).toBeInTheDocument();
  });

  it('clears limits to unlimited (null) when the inputs are emptied', async () => {
    mockOf(api.limits.setService).mockResolvedValue({ cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0, liveApplied: false } as never);
    const user = userEvent.setup();
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Settings');
    await screen.findByText('Resource limits');
    const inputs = document.querySelectorAll<HTMLInputElement>('input.w-44');
    await user.clear(inputs[0]!);
    await user.clear(inputs[1]!);
    await user.clear(inputs[2]!);
    await user.click(screen.getByRole('button', { name: /Save limits/ }));
    // Empty inputs mean "no limit": the API receives null, not zero.
    await waitFor(() => expect(api.limits.setService).toHaveBeenCalledWith(1, { cpuShares: null, cpuLimitMilli: null, memLimitMb: null }));
  });

  it('toasts when the replicas save fails and keeps the field editable', async () => {
    const user = userEvent.setup();
    const api = (await import('../src/lib/api.js')).api as unknown as {
      services: { get: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    };
    api.services.get = vi.fn().mockResolvedValue({ ...service });
    api.services.update = vi.fn().mockRejectedValue(new Error('boom'));
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Settings');
    await screen.findByText('Scaling');
    const replicasInput = document.querySelectorAll<HTMLInputElement>('input.w-44')[3]!;
    await user.clear(replicasInput);
    await user.type(replicasInput, '2');
    await user.click(screen.getByRole('button', { name: /Save replicas/ }));
    await waitFor(() => expect(api.services.update).toHaveBeenCalled());
    // The card did not crash and the field kept the edit.
    expect(screen.getByText('Scaling')).toBeInTheDocument();
    expect(replicasInput).toHaveValue('2');
  });

  it('shows the pm2 limits hint without CPU fields for host processes', async () => {
    mockOf(api.services.get).mockResolvedValue({ ...service, type: 'pm2', runtimeId: 'web' } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Settings');
    await screen.findByText('Resource limits');
    expect(screen.getByText(/PM2 processes run on the host/)).toBeInTheDocument();
    expect(screen.queryByText(/CPU limit cores/)).not.toBeInTheDocument();
  });

  it('saves replicas from the scaling card and hides it for pm2 services', async () => {
    const user = userEvent.setup();
    const api = (await import('../src/lib/api.js')).api as unknown as {
      services: { get: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    };
    api.services.update = vi.fn().mockResolvedValue({ ...service });
    const first = renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Settings');
    await screen.findByText('Scaling');
    // Field does not label-associate — address the replicas input by position
    // (4th w-44 input on the settings tab, after cap/shares/mem).
    const replicasInput = document.querySelectorAll<HTMLInputElement>('input.w-44')[3]!;
    await user.clear(replicasInput);
    await user.type(replicasInput, '3');
    await user.click(screen.getByRole('button', { name: /Save replicas/ }));
    await waitFor(() => expect(api.services.update).toHaveBeenCalledWith(1, { replicas: 3 }));

    // pm2 services have no container replicas — the card must not render.
    first.unmount();
    mockOf(api.services.get).mockResolvedValue({ ...service, type: 'pm2', runtimeId: 'web' } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Settings');
    await waitFor(() => expect(screen.queryByText('Scaling')).not.toBeInTheDocument());
  });

  it('shows the settings saving label while in flight', async () => {
    mockOf(api.services.update).mockReturnValue(new Promise(() => {}) as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Settings');
    fireEvent.click(await screen.findByRole('button', { name: /Save settings/ }));
    expect(await screen.findByText('Saving…')).toBeInTheDocument();
  });

  it('shows the service-filtered activity trail (server-side ?entity=)', async () => {
    mockOf(api.activity.list).mockResolvedValue({
      entries: [
        { id: 1, userId: 1, action: 'service.update', entity: 'api', meta: null, ts: '2026-01-01T00:00:00Z' },
        { id: 3, userId: 1, action: 'service.stop', entity: 'api', meta: null, ts: '2026-01-01T00:02:00Z' },
      ],
      nextCursor: null,
    } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Activity');
    // the page asks the server to filter by the service's entity name
    await waitFor(() => expect(api.activity.list).toHaveBeenCalledWith({ entity: 'api' }));
    expect(await screen.findByText('service.update')).toBeInTheDocument();
    expect(screen.getByText('service.stop')).toBeInTheDocument();
  });

  it('shows the activity empty state', async () => {
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Activity');
    expect(await screen.findByText('No recorded activity for this service yet.')).toBeInTheDocument();
  });

  it('surfaces the data volume in the danger zone when it exists', async () => {
    mockOf(api.volumes.list).mockResolvedValue([
      { name: 'nd-svc-api-data', sizeBytes: 5 * 1024 * 1024, owner: { kind: 'service', name: 'api' }, inUse: true },
    ] as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Danger');
    await screen.findByText('Danger zone');
    expect(await screen.findByText(/nd-svc-api-data/)).toBeInTheDocument();
    expect(screen.getByText(/5\.2 MB/)).toBeInTheDocument();
  });

  it('reports limit save failures and shows the saving state', async () => {
    mockOf(api.limits.setService).mockRejectedValue(new Error('x'));
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Settings');
    fireEvent.click(await screen.findByRole('button', { name: /Save limits/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not save limits', 'error'));
  });

  it('shows the limits saving label while in flight', async () => {
    mockOf(api.limits.setService).mockReturnValue(new Promise(() => {}) as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Settings');
    fireEvent.click(await screen.findByRole('button', { name: /Save limits/ }));
    expect(await screen.findByText('Saving…')).toBeInTheDocument();
  });

  it('exports the bundle from the activity tab and reports failures', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['x']) } as Response);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Activity');
    fireEvent.click(await screen.findByRole('button', { name: /Export bundle/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/v1/services/1/export', expect.anything()));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Service exported', 'success'));

    fetchMock.mockResolvedValueOnce({ ok: false } as Response);
    fireEvent.click(screen.getByRole('button', { name: /Export bundle/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Export failed', 'error'));
  });

  it('shows the activity loading skeleton while the audit feed loads', async () => {
    mockOf(api.activity.list).mockReturnValue(new Promise(() => {}) as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Activity');
    expect(document.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('redirects /services/abc to /services when the id is not a positive integer', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/services/:id" element={<ServiceDetail />} />
        <Route path="/services" element={<div data-testid="services-list">list</div>} />
      </Routes>,
      { initialEntries: ['/services/abc'] },
    );
    expect(await screen.findByTestId('services-list')).toBeInTheDocument();
  });

  it('shows the config diff card states for the active deployment', async () => {
    // Loading state: the diff query never settles while the card is open.
    mockOf(api.deploys.configDiff).mockReturnValueOnce(new Promise(() => {}) as never);
    const first = renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Deploys');
    fireEvent.click(await screen.findByText('Config diff vs previous deploy'));
    expect(document.querySelector('.animate-pulse')).not.toBeNull();
    first.unmount();

    // First recorded deployment — nothing to compare against.
    mockOf(api.deploys.configDiff).mockResolvedValueOnce({ previousDeploymentId: null, changed: false, diff: '' } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Deploys');
    fireEvent.click(await screen.findByText('Config diff vs previous deploy'));
    expect(await screen.findByText('First recorded deployment — nothing to compare against.')).toBeInTheDocument();
  });

  it('renders an unchanged and a changed config diff', async () => {
    // Unchanged vs previous deploy.
    mockOf(api.deploys.configDiff).mockResolvedValueOnce({ previousDeploymentId: 4, changed: false, diff: '' } as never);
    const first = renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Deploys');
    fireEvent.click(await screen.findByText('Config diff vs previous deploy'));
    expect(await screen.findByText('No changes against #4 — same build config and env keys.')).toBeInTheDocument();
    first.unmount();

    // Changed: the diff lines render with add/remove colouring.
    mockOf(api.deploys.configDiff).mockResolvedValueOnce({
      previousDeploymentId: 4,
      changed: true,
      diff: '+ startCmd: npm start\n- startCmd: node index.js\n  builder: nixpacks',
    } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Deploys');
    fireEvent.click(await screen.findByText('Config diff vs previous deploy'));
    expect(await screen.findByText('+ startCmd: npm start')).toBeInTheDocument();
    expect(screen.getByText('- startCmd: node index.js')).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.textContent === '  builder: nixpacks')).toBeInTheDocument();
  });

  it('shows the config diff no-snapshot state', async () => {
    mockOf(api.deploys.configDiff).mockResolvedValueOnce(null as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Deploys');
    fireEvent.click(await screen.findByText('Config diff vs previous deploy'));
    expect(await screen.findByText('No snapshot.')).toBeInTheDocument();
  });

  it('formats data volume sizes and in-use states across unit ranges', async () => {
    const cases: Array<{ sizeBytes: number; expected: RegExp; inUse: boolean }> = [
      { sizeBytes: 0, expected: /exists \(0 B\)/, inUse: false },
      { sizeBytes: 500, expected: /exists \(500 B\)/, inUse: false },
      { sizeBytes: 3 * 1024 * 1024 * 1024, expected: /exists \(3\.2 GB\)/, inUse: false },
    ];
    for (const c of cases) {
      mockOf(api.volumes.list).mockResolvedValue([
        { name: 'nd-svc-api-data', sizeBytes: c.sizeBytes, owner: { kind: 'service', name: 'api' }, inUse: c.inUse },
      ] as never);
      const { unmount } = renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
      await openTab('Danger');
      expect(await screen.findByText(c.expected)).toBeInTheDocument();
      // inUse=false -> the '· in use' suffix is omitted
      expect(screen.queryByText(/· in use/)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('publishes, changes and disables direct host port mapping', async () => {
    const user = userEvent.setup();
    mockOf(api.services.get).mockResolvedValue({
      id: 1,
      name: 'api',
      slug: 'api',
      port: 3000,
      publishedPort: null,
      status: 'running',
    } as never);
    mockOf(api.services.update).mockResolvedValue({ id: 1, publishedPort: 8080 } as never);

    const { unmount } = renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Network');

    // Invalid port validation
    const portInput = await screen.findByPlaceholderText('e.g. 8080 or 3000');
    fireEvent.change(portInput, { target: { value: '70000' } });
    fireEvent.submit(portInput.closest('form')!);
    expect(api.services.update).not.toHaveBeenCalled();

    // Valid port publish
    fireEvent.change(portInput, { target: { value: '8080' } });
    fireEvent.submit(portInput.closest('form')!);
    await waitFor(() => expect(api.services.update).toHaveBeenCalledWith(1, { publishedPort: 8080 }));
    unmount();

    // With publishedPort already active
    mockOf(api.services.get).mockResolvedValue({
      id: 1,
      name: 'api',
      slug: 'api',
      port: 3000,
      publishedPort: 8080,
      status: 'running',
    } as never);

    const { unmount: unmount2 } = renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Network');
    expect(await screen.findByText('Published on :8080')).toBeInTheDocument();
    expect(screen.getByText(/http:\/\/.*:8080/)).toBeInTheDocument();

    // Change port and cancel
    await user.click(screen.getByRole('button', { name: /Change Port/i }));
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Cancel/i }));

    // Disable published port
    await user.click(screen.getByRole('button', { name: /Disable/i }));
    await waitFor(() => expect(api.services.update).toHaveBeenCalledWith(1, { publishedPort: null }));
    unmount2();
  });

  it('edits the internal container port from the Network tab for Traefik routing', async () => {
    mockOf(api.services.get).mockResolvedValue({
      id: 1,
      name: 'next-app',
      slug: 'next-app',
      port: null,
      publishedPort: null,
      status: 'running',
    } as never);
    mockOf(api.services.update).mockResolvedValue({ id: 1, port: 4173 } as never);

    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Network');

    const input = await screen.findByRole('textbox', { name: 'Internal container port' });
    expect(input).toHaveValue('3000');
    fireEvent.change(input, { target: { value: '4173' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(api.services.update).toHaveBeenCalledWith(1, { port: 4173 }));
  });

  it('handles direct host port update errors', async () => {
    mockOf(api.services.get).mockResolvedValue({
      id: 1,
      name: 'api',
      slug: 'api',
      port: 3000,
      publishedPort: null,
      status: 'running',
    } as never);
    mockOf(api.services.update).mockRejectedValue(new Error('fail') as never);

    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Network');

    const portInput = await screen.findByPlaceholderText('e.g. 8080 or 3000');
    fireEvent.change(portInput, { target: { value: '8080' } });
    fireEvent.submit(portInput.closest('form')!);
    await waitFor(() => expect(api.services.update).toHaveBeenCalledWith(1, { publishedPort: 8080 }));
  });

  it('renders the published port as the legacy container-port fallback and shows Saving... while pending', async () => {
    let resolveUpdate!: (val: any) => void;
    mockOf(api.services.get).mockResolvedValue({
      id: 1,
      name: 'api',
      slug: 'api',
      port: null,
      publishedPort: 8080,
      status: 'running',
    } as never);
    mockOf(api.services.update).mockReturnValue(
      new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
    );

    const { unmount } = renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Network');
    expect(await screen.findByText('→ :8080')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Change Port/i }));
    const portInput = screen.getByPlaceholderText('e.g. 8080 or 3000');
    fireEvent.change(portInput, { target: { value: '9000' } });
    fireEvent.submit(portInput.closest('form')!);

    expect(await screen.findByRole('button', { name: /Saving…/i })).toBeInTheDocument();
    resolveUpdate({ id: 1, publishedPort: 9000 });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Saving…/i })).not.toBeInTheDocument();
    });
    unmount();
  });

  it('renders the Architecture tab with interactive ReactFlow graph and attached components', async () => {
    mockOf(api.attachments.list).mockResolvedValue([
      { id: 1, databaseId: 5, envAlias: 'DATABASE_URL', database: { name: 'main-db', engine: 'postgres', status: 'running' } },
    ] as never);
    mockOf(api.env.list).mockResolvedValue([
      { id: 1, key: 'PORT', value: '3000', isSecret: false },
      { id: 2, key: 'JWT_SECRET', value: 'secret', isSecret: true },
    ] as never);

    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Architecture');

    expect(await screen.findByText(/Full Application Architecture & System Topology/i)).toBeInTheDocument();
    expect(await screen.findByTestId('react-flow')).toBeInTheDocument();
    expect(screen.getByText('Traefik Ingress')).toBeInTheDocument();
    expect(screen.getByText('DATABASE_URL')).toBeInTheDocument();
    expect(screen.getByText(/Dual-Vault Store/i)).toBeInTheDocument();
  });

  it('renders the Files tab with live container file browser and slug fallback', async () => {
    mockOf(api.containers.listFiles).mockResolvedValue({
      path: '/',
      entries: [{ name: 'server.js', type: 'file', sizeBytes: 1024, mode: '0644', modifiedAt: null }],
    } as never);

    const { unmount } = renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('File Browser');

    expect(await screen.findByText('server.js')).toBeInTheDocument();
    expect(screen.getByText('nd-api')).toBeInTheDocument();
    unmount();

    // Slug fallback when runtimeId is null
    mockOf(api.services.get).mockResolvedValueOnce({ ...service, runtimeId: null } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('File Browser');
    expect(await screen.findByText('nd-svc-api')).toBeInTheDocument();
  });

  it('shows the live-following log header and ignores stage clicks without lines', async () => {
    mockOf((await import('../src/lib/useDeployLogs.js')).useDeployLogs).mockReturnValue({
      lines: '##[stage:BUILD:running] compiling\nlog line',
      open: true,
    });
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Deploys');
    expect(await screen.findByText('Following live output')).toBeInTheDocument();
    // Clicking a stage with no matching marker is a safe no-op.
    const stage = await screen.findByRole('button', { name: /^Cleanup:/ });
    fireEvent.click(stage);
    expect(stage).toBeInTheDocument();
  });

  it('returns early from stage clicks when the log stream has no lines', async () => {
    mockOf((await import('../src/lib/useDeployLogs.js')).useDeployLogs).mockReturnValue({
      lines: '',
      open: true,
    });
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Deploys');
    // A stage button exists (a deployment is selected) but there is nothing
    // to scroll to yet.
    const stage = await screen.findByRole('button', { name: /^Prepare:/ });
    fireEvent.click(stage);
    expect(stage).toBeInTheDocument();
  });

  it('renders live cpu/memory with the container limit from the snapshot', async () => {
    mockOf(api.stats.snapshot).mockResolvedValue({
      host: null,
      containers: [
        // A non-matching row first so the find callback checks both fields.
        { kind: 'database', refId: 1, refName: 'db', name: 'nd-db-x', cpuPct: 9, memMb: 99, memLimitMb: 0 },
        { kind: 'service', refId: 1, refName: 'api', name: 'nd-api', cpuPct: 17.25, memMb: 220, memLimitMb: 512 },
      ],
    } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    expect(await screen.findByText('17.3%')).toBeInTheDocument();
    expect(screen.getByText('220.0 / 512 MiB')).toBeInTheDocument();
  });

  it('reports non-Error analysis refresh failures', async () => {
    mockOf(api.insights.get).mockResolvedValue(null as never);
    mockOf(api.insights.refresh).mockRejectedValueOnce('boom' as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    fireEvent.click(await screen.findByRole('button', { name: 'Analyze now' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Analysis failed', 'error'));
  });

  it('renders sparse analysis facts with compose and no commit metadata', async () => {
    mockOf(api.insights.get).mockResolvedValue({
      framework: { id: 'node', name: 'Node.js', emoji: '⬢', category: 'runtime', port: 4000, installCmd: 'npm i', buildCmd: null, startCmd: 'node .', env: [], notes: [] },
      language: 'JavaScript',
      packageManager: null,
      nodeVersion: null,
      frameworkVersion: '24',
      scripts: {},
      dependencyCount: 1,
      devDependencyCount: 0,
      hasDockerfile: false,
      hasComposeFile: true,
      monorepo: false,
      detectedFiles: [],
      workspacePackages: undefined,
      baseDir: '/',
      commitSha: null,
      analyzedAt: '2026-01-02T03:04:05Z',
    } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    expect(await screen.findByText('Node.js')).toBeInTheDocument();
    expect(screen.getByText('compose')).toBeInTheDocument();
  });

  it('shows the clone pending label while cloning', async () => {
    const hold = { resolve: (_v: unknown) => {} } as { resolve: (v: unknown) => void };
    // `Once`, not a sticky implementation: `vi.clearAllMocks()` in beforeEach
    // clears calls but keeps implementations, so a permanent never-resolving
    // clone would leak into every later test in this file.
    mockOf(api.services.clone).mockImplementationOnce(
      () => new Promise((res) => { hold.resolve = res; }) as never,
    );
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await screen.findByRole('heading', { name: 'api' });
    fireEvent.click(screen.getByTitle('Clone service configuration and environment variables'));
    expect(await screen.findByText('Cloning…')).toBeInTheDocument();
    hold.resolve({ id: 9, name: 'api-clone' });
    await waitFor(() => expect(screen.queryByText('Cloning…')).not.toBeInTheDocument());
  });

  it('opens tabs from the URL query and gates the terminal on a runtime container', async () => {
    // The terminal tab renders its fallback without a running container.
    mockOf(api.services.get).mockResolvedValue({ ...service, runtimeId: null } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1?tab=terminal' });
    expect(await screen.findByText('Container is not deployed')).toBeInTheDocument();

    // A deep link straight to the framework tab mounts it.
    mockOf(api.services.get).mockResolvedValue(service as never);
    mockOf(api.insights.get).mockResolvedValue(null as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1?tab=framework' });
    expect(await screen.findByText('This repository has not been analyzed yet')).toBeInTheDocument();
  });

  it('saves the internal container port, shows pending and failure states', async () => {
    const user = userEvent.setup();
    mockOf(api.services.update).mockResolvedValue({ ok: true } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Network');

    const port = screen.getByLabelText('Internal container port');
    await user.clear(port);
    await user.type(port, '8080');
    fireEvent.click(screen.getByRole('button', { name: 'Save Port' }));
    await waitFor(() =>
      expect(api.services.update).toHaveBeenCalledWith(1, { port: 8080 }));
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith('Container port :8080 saved — Traefik routing updated', 'success'));

    // An invalid port shows the inline hint and blocks submission.
    await user.clear(port);
    await user.type(port, '99999');
    expect(screen.getByText('Enter a port from 1 to 65535.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Port' })).toBeDisabled();

    // A rejected save surfaces the failure toast.
    await user.clear(port);
    await user.type(port, '3001');
    mockOf(api.services.update).mockRejectedValueOnce(new Error('conflict') as never);
    fireEvent.click(screen.getByRole('button', { name: 'Save Port' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not update the container port', 'error'));
  });

  it('shows the saving label while a port update is in flight', async () => {
    const user = userEvent.setup();
    mockOf(api.services.update).mockReturnValue(new Promise(() => {}) as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Network');

    const port = screen.getByLabelText('Internal container port');
    await user.clear(port);
    await user.type(port, '8081');
    fireEvent.click(screen.getByRole('button', { name: 'Save Port' }));
    expect(await screen.findByText('Saving…')).toBeInTheDocument();
  });

  it('shows zero live usage for an online service without container stats', async () => {
    mockOf(api.stats.snapshot).mockResolvedValue({ host: null, containers: [] } as never);
    mockOf(api.stats.metrics).mockResolvedValue({ kind: 'cpu', points: [] } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    // Online but unmeasured: the live chips fall back to zeros (the memory
    // chip pairs the zero with the configured limit).
    expect(await screen.findByText('0.0%')).toBeInTheDocument();
    expect(screen.getByText('0.0 / 512 MiB')).toBeInTheDocument();
  });

  it('mounts the volumes tab from the service page', async () => {
    mockOf(api.volumes.list).mockResolvedValue([] as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    await openTab('Volumes');
    await waitFor(() => expect(api.volumes.list).toHaveBeenCalled());
  });

  it('renders overview facts for a committed repo without a named credential', async () => {
    mockOf(api.services.get).mockResolvedValue({
      ...service,
      commitSha: 'fedcba9876543',
      sourceName: null,
    } as never);
    mockOf(api.insights.get).mockResolvedValue(null as never);
    mockOf(api.stats.snapshot).mockResolvedValue({ host: null, containers: [] } as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    expect(await screen.findByText('fedcba987654')).toBeInTheDocument(); // 12-char commit
    // A repo without a named credential shows the public fallback.
    expect(screen.getAllByText('public / none').length).toBeGreaterThan(0);
  });

  it('shows offline memory and the analyzing label for a stopped service', async () => {
    mockOf(api.services.get).mockResolvedValue({
      ...service,
      status: 'stopped',
      memLimitMb: 0,
    } as never);
    mockOf(api.stats.snapshot).mockResolvedValue({ host: null, containers: [] } as never);
    mockOf(api.stats.metrics).mockResolvedValue({ kind: 'cpu', points: [] } as never);
    mockOf(api.insights.get).mockReturnValue(new Promise(() => {}) as never);
    mockOf(api.insights.refresh).mockReturnValue(new Promise(() => {}) as never);
    renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
    // No live stats for a stopped service: the overview shows the offline
    // placeholders, and a held refresh shows the pending label.
    expect((await screen.findAllByText('Offline')).length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze now' }));
    expect(await screen.findByText('Analyzing…')).toBeInTheDocument();
  });

  /**
   * The Compose File tab is mounted only for a service that stores an inline
   * stack. This asserts the WIRING (tab list + rendered panel + `?tab=`
   * fallback), not the editor itself — that lives in ComposeTab.test.tsx.
   */
  describe('Compose File tab', () => {
    const stackService = {
      ...service,
      type: 'compose',
      repoUrl: null,
      composeService: 'web',
      composeContent: 'services:\n  web:\n    image: nginx:alpine\n',
    };

    it('is hidden for a service with no inline stack', async () => {
      renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });
      await screen.findByText('api');
      expect(screen.queryByRole('tab', { name: /compose file/i })).not.toBeInTheDocument();
    });

    it('is offered — and renders the editor — for an inline stack', async () => {
      mockOf(api.services.get).mockResolvedValue(stackService as never);
      renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1' });

      const tab = await screen.findByRole('tab', { name: /compose file/i });
      fireEvent.click(tab);
      expect(await screen.findByLabelText('Compose file editor')).toHaveValue(stackService.composeContent);
    });

    it('falls back to Overview when ?tab=compose names a tab this service does not have', async () => {
      // A deep link copied between services must not land on a blank panel.
      renderRoute(<ServiceDetail />, { path: '/services/:id', route: '/services/1?tab=compose' });
      await screen.findByText('api');
      expect(screen.queryByLabelText('Compose file editor')).not.toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /overview/i })).toHaveAttribute('aria-selected', 'true');
    });
  });

});
