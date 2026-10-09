import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from './web-utils.js';

/**
 * Multi-node, Service → Settings: "Build on" (target, panel, a build server),
 * the push registry picker with its repository, the image transfer history,
 * the "Orchestrator: Swarm" switch with the server's refusal reason inline,
 * and the Swarm tasks card. An older panel's service response has no
 * `placement`: both cards stay hidden.
 */

const apiMock = vi.hoisted(() => ({
  api: {
    services: {
      get: vi.fn(),
      update: vi.fn(),
      placement: { get: vi.fn(), set: vi.fn() },
      imageTransfers: vi.fn(),
      swarm: vi.fn(),
      github: { get: vi.fn() },
    },
    servers: { list: vi.fn() },
    sources: { list: vi.fn() },
    swarm: { get: vi.fn() },
    limits: { setService: vi.fn() },
    environments: { list: vi.fn() },
    serviceTags: { get: vi.fn() },
    fanout: { get: vi.fn(), set: vi.fn() },
  },
}));
vi.mock('../src/lib/api.js', () => apiMock);

const authState = vi.hoisted(() => ({ user: { id: 1, isOperator: true } as { id: number; isOperator: boolean } }));
vi.mock('../src/lib/auth.js', () => ({
  AuthProvider: ({ children }: { children?: React.ReactNode }) => children,
  useAuth: () => ({ user: authState.user }),
}));

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useToast: () => toastSpy,
}));

import { BuildPlacementCard, OrchestratorCard } from '../src/routes/service/PlacementCards.js';
import { SettingsTab } from '../src/routes/service/SettingsTab.js';

const api = apiMock.api;

const DEFAULT_PLACEMENT = { buildOn: null, buildServerId: null, pushRegistrySourceId: null, pushRepository: null, orchestrator: null };

const svc = (over: Record<string, unknown> = {}) =>
  ({
    id: 5,
    name: 'api',
    slug: 'api',
    type: 'docker',
    status: 'running',
    serverId: 3,
    image: null,
    repoUrl: 'https://github.com/x/y',
    composeContent: null,
    placement: DEFAULT_PLACEMENT,
    ...over,
  }) as never;

const nodes = [
  { id: 3, name: 'edge-1', host: '10.0.0.5', port: 4600, status: 'online', lastSeenAt: null, isBuildServer: false },
  { id: 4, name: 'builder', host: '10.0.0.6', port: 4600, status: 'online', lastSeenAt: null, isBuildServer: true },
  { id: 6, name: 'builder-2', host: '10.0.0.7', port: 4600, status: 'offline', lastSeenAt: null, isBuildServer: true },
  { id: 7, name: 'waiting', host: '10.0.0.8', port: 4600, status: 'pending', lastSeenAt: null, isBuildServer: true },
];

const transfer = (over: Record<string, unknown> = {}) => ({
  id: 1,
  deploymentId: 9,
  serviceId: 5,
  sourceServerId: null,
  targetServerId: 3,
  method: 'stream',
  imageRef: 'nd/api:abc',
  imageId: 'sha256:1',
  bytes: 5 * 1024 * 1024,
  sha256: 'abc',
  status: 'completed',
  error: null,
  startedAt: '2026-10-09T10:00:00.000Z',
  finishedAt: '2026-10-09T10:00:04.000Z',
  durationMs: 4200,
  ...over,
});

const refusal = (message: string, code: string) => Object.assign(new Error(message), { code });

describe('BuildPlacementCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: 1, isOperator: true };
    api.servers.list.mockResolvedValue(nodes);
    api.sources.list.mockResolvedValue([
      { id: 11, name: 'ghcr', type: 'registry', hasToken: true, hasDeployKey: false },
      { id: 12, name: 'gh', type: 'github', hasToken: true, hasDeployKey: false },
    ]);
    api.services.imageTransfers.mockResolvedValue([]);
    api.services.placement.set.mockResolvedValue(DEFAULT_PLACEMENT);
  });

  it('is hidden on an older panel (no placement in the service response)', () => {
    const { container } = renderWithProviders(<BuildPlacementCard svc={svc({ placement: undefined })} />);
    expect(container).toBeEmptyDOMElement();
    expect(api.services.imageTransfers).not.toHaveBeenCalled();
  });

  it('builds on a build server: only registered build servers are offered, and the save sends the full placement', async () => {
    renderWithProviders(<BuildPlacementCard svc={svc()} />);
    fireEvent.change(screen.getByLabelText('Build on'), { target: { value: 'server' } });
    const picker = await screen.findByLabelText('Build server');
    await waitFor(() => expect(within(picker).getAllByRole('option')).toHaveLength(3));
    expect(within(picker).getByText('builder-2 — offline')).toBeInTheDocument();
    expect(within(picker).queryByText(/waiting/)).toBeNull();
    const save = screen.getByRole('button', { name: 'Save placement' });
    expect(save).toBeDisabled(); // no build server chosen yet
    fireEvent.change(picker, { target: { value: '4' } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(api.services.placement.set).toHaveBeenCalledWith(5, { buildOn: 'server', buildServerId: 4, pushRegistrySourceId: null, pushRepository: null }),
    );
    expect(toastSpy.toast).toHaveBeenCalledWith('Build placement saved — applied on the next deploy', 'success');
  });

  it('points to the Servers page when no node is a build server', async () => {
    api.servers.list.mockResolvedValue([nodes[0]]);
    renderWithProviders(<BuildPlacementCard svc={svc()} />);
    fireEvent.change(screen.getByLabelText('Build on'), { target: { value: 'server' } });
    expect(await screen.findByText(/No node is a build server yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Servers page' })).toHaveAttribute('href', '/servers');
  });

  it('pushes through a registry: only registry sources, a valid repository, and back to the panel relay', async () => {
    renderWithProviders(<BuildPlacementCard svc={svc()} />);
    fireEvent.change(screen.getByLabelText('Build on'), { target: { value: 'panel' } });
    const registry = screen.getByLabelText('Push registry');
    await waitFor(() => expect(within(registry).getAllByRole('option')).toHaveLength(2));
    fireEvent.change(registry, { target: { value: '11' } });
    const save = screen.getByRole('button', { name: 'Save placement' });
    expect(save).toBeDisabled(); // a registry needs a repository
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'Team/App:latest' } });
    expect(screen.getByText(/A repository path such as team\/app/)).toBeInTheDocument();
    expect(save).toBeDisabled();
    fireEvent.submit(save.closest('form')!);
    expect(api.services.placement.set).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'team/app' } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(api.services.placement.set).toHaveBeenCalledWith(5, { buildOn: 'panel', buildServerId: null, pushRegistrySourceId: 11, pushRepository: 'team/app' }),
    );
  });

  it('starts from the stored placement and saves "target" as the 0.15 default (null)', async () => {
    renderWithProviders(
      <BuildPlacementCard svc={svc({ placement: { ...DEFAULT_PLACEMENT, buildOn: 'server', buildServerId: 4, pushRegistrySourceId: 11, pushRepository: 'team/app' } })} />,
    );
    expect(screen.getByLabelText('Build on')).toHaveValue('server');
    expect(screen.getByLabelText('Repository')).toHaveValue('team/app');
    fireEvent.change(screen.getByLabelText('Build on'), { target: { value: 'target' } });
    fireEvent.change(screen.getByLabelText('Push registry'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save placement' }));
    await waitFor(() =>
      expect(api.services.placement.set).toHaveBeenCalledWith(5, { buildOn: null, buildServerId: null, pushRegistrySourceId: null, pushRepository: null }),
    );
  });

  it("shows the server's refusal inline, with the agent-update hint", async () => {
    api.services.placement.set.mockRejectedValue(refusal('The agent on node edge-1 cannot receive an image: update it.', 'node_agent_outdated'));
    renderWithProviders(<BuildPlacementCard svc={svc()} />);
    fireEvent.change(screen.getByLabelText('Build on'), { target: { value: 'panel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save placement' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('cannot receive an image');
    expect(alert).toHaveTextContent('Update the agent on that node');
    api.services.placement.set.mockRejectedValue('weird');
    fireEvent.click(screen.getByRole('button', { name: 'Save placement' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not save the build placement'));
  });

  it('lists the last 20 transfers with route, bytes, duration and errors', async () => {
    api.services.imageTransfers.mockResolvedValue([
      transfer(),
      transfer({ id: 2, sourceServerId: 4, targetServerId: 99, method: 'registry', status: 'failed', error: 'digest mismatch', durationMs: 650, bytes: 0 }),
      transfer({ id: 3, status: 'running', durationMs: null, finishedAt: null }),
    ]);
    renderWithProviders(<BuildPlacementCard svc={svc()} />);
    expect(await screen.findByText('digest mismatch')).toBeInTheDocument();
    expect(api.services.imageTransfers).toHaveBeenCalledWith(5, { limit: 20 });
    expect(screen.getAllByText('panel host → edge-1')).toHaveLength(2);
    expect(screen.getByText('builder → node #99')).toBeInTheDocument();
    expect(screen.getByText('4.2 s')).toBeInTheDocument();
    expect(screen.getByText('650 ms')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('transfer history: empty and failed states', async () => {
    renderWithProviders(<BuildPlacementCard svc={svc()} />);
    expect(await screen.findByText(/No image has moved/)).toBeInTheDocument();
    api.services.imageTransfers.mockRejectedValue(new Error('boom'));
    const second = renderWithProviders(<BuildPlacementCard svc={svc({ id: 6 })} />);
    expect(await second.findByText('Could not load the image transfers')).toBeInTheDocument();
  });

  it('a compose stack or PM2 app builds where it runs: explained, no form, no transfers', () => {
    renderWithProviders(<BuildPlacementCard svc={svc({ composeContent: 'services: {}' })} />);
    expect(screen.getByText(/A compose stack builds where it runs/)).toBeInTheDocument();
    renderWithProviders(<BuildPlacementCard svc={svc({ id: 8, type: 'pm2' })} />);
    expect(screen.getByText(/A pm2 service builds where it runs/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Build on')).toBeNull();
    expect(api.services.imageTransfers).not.toHaveBeenCalled();
  });

  it('a member sees the placement read-only, and never lists servers or sources', async () => {
    authState.user = { id: 2, isOperator: false };
    renderWithProviders(
      <BuildPlacementCard svc={svc({ placement: { ...DEFAULT_PLACEMENT, buildOn: 'server', buildServerId: 4, pushRegistrySourceId: 11, pushRepository: 'team/app' } })} />,
    );
    expect(screen.getByText('A build server: node #4')).toBeInTheDocument();
    expect(screen.getByText('team/app')).toBeInTheDocument();
    expect(screen.queryByLabelText('Build on')).toBeNull();
    expect(api.servers.list).not.toHaveBeenCalled();
    expect(api.sources.list).not.toHaveBeenCalled();
    renderWithProviders(<BuildPlacementCard svc={svc({ id: 9 })} />);
    expect(screen.getByText('Where the service runs')).toBeInTheDocument();
  });
});

describe('OrchestratorCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: 1, isOperator: true };
    api.swarm.get.mockResolvedValue({ enabled: true, localState: 'active', controlAvailable: true, managerAddr: '10.0.0.2:2377', nodes: [] });
    api.services.placement.set.mockResolvedValue({ ...DEFAULT_PLACEMENT, orchestrator: 'swarm' });
  });

  it('is hidden on an older panel', () => {
    const { container } = renderWithProviders(<OrchestratorCard svc={svc({ placement: undefined })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("switches to Swarm, and shows the server's refusal reason inline", async () => {
    api.services.placement.set.mockRejectedValueOnce(
      refusal('The service is pinned to a node; on Swarm the cluster places the replicas itself.', 'swarm_unsupported'),
    );
    renderWithProviders(<OrchestratorCard svc={svc()} />);
    const toggle = screen.getByRole('switch', { name: 'Orchestrator: Swarm' });
    fireEvent.click(toggle);
    await waitFor(() => expect(api.services.placement.set).toHaveBeenCalledWith(5, { orchestrator: 'swarm' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('pinned to a node');
    fireEvent.click(toggle);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Runs on Swarm from the next deploy', 'success'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('says when Swarm is not enabled, and links Settings → Swarm from a swarm_disabled refusal', async () => {
    api.swarm.get.mockResolvedValue({ enabled: false, localState: 'inactive', controlAvailable: false, managerAddr: null, nodes: [] });
    api.services.placement.set.mockRejectedValueOnce(refusal('Swarm is not enabled on this panel.', 'swarm_disabled'));
    renderWithProviders(<OrchestratorCard svc={svc()} />);
    expect(await screen.findByText(/Swarm is not enabled on this panel yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Orchestrator: Swarm' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('link', { name: 'Settings → Swarm' })).toHaveAttribute('href', '/settings?section=swarm');
  });

  it('on Swarm: switches back to plain containers and shows the tasks', async () => {
    api.services.swarm.mockResolvedValue({
      stack: 'nd-api',
      desired: 2,
      running: 1,
      tasks: [
        { node: 'panel', state: 'Running 2 minutes ago', error: null, image: 'nd/api:abc' },
        { node: '', state: 'Rejected', error: 'no suitable node', image: 'nd/api:abc' },
      ],
    });
    api.services.placement.set.mockResolvedValue(DEFAULT_PLACEMENT);
    renderWithProviders(<OrchestratorCard svc={svc({ placement: { ...DEFAULT_PLACEMENT, orchestrator: 'swarm' } })} />);
    expect(await screen.findByText('1/2 running')).toBeInTheDocument();
    expect(screen.getByText('unassigned')).toBeInTheDocument();
    expect(screen.getByText('no suitable node')).toBeInTheDocument();
    expect(api.swarm.get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('switch', { name: 'Orchestrator: Swarm' }));
    await waitFor(() => expect(api.services.placement.set).toHaveBeenCalledWith(5, { orchestrator: null }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Runs as plain containers from the next deploy', 'success'));
  });

  it('Swarm tasks: not deployed yet, an empty stack, all running, and a failed load', async () => {
    const onSwarm = (id: number) => svc({ id, placement: { ...DEFAULT_PLACEMENT, orchestrator: 'swarm' } });
    api.services.swarm.mockResolvedValueOnce({ stack: null, desired: 0, running: 0, tasks: [] });
    renderWithProviders(<OrchestratorCard svc={onSwarm(1)} />);
    expect(await screen.findByText(/the next deploy creates the stack/)).toBeInTheDocument();
    api.services.swarm.mockResolvedValueOnce({ stack: 'nd-x', desired: 1, running: 1, tasks: [] });
    renderWithProviders(<OrchestratorCard svc={onSwarm(2)} />);
    expect(await screen.findByText('1/1 running')).toHaveClass('text-emerald-300');
    expect(screen.getByText(/has no tasks/)).toBeInTheDocument();
    api.services.swarm.mockRejectedValueOnce(new Error('docker down'));
    renderWithProviders(<OrchestratorCard svc={onSwarm(3)} />);
    expect(await screen.findByText('Could not load the Swarm tasks')).toBeInTheDocument();
  });

  it('a member sees the state read-only (no switch, no swarm status call), and a refusal without a message', async () => {
    authState.user = { id: 2, isOperator: false };
    renderWithProviders(<OrchestratorCard svc={svc()} />);
    expect(screen.getByText('Only an instance operator can change the orchestrator.')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(api.swarm.get).not.toHaveBeenCalled();

    authState.user = { id: 1, isOperator: true };
    api.services.placement.set.mockRejectedValueOnce('odd');
    renderWithProviders(<OrchestratorCard svc={svc({ id: 7 })} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Orchestrator: Swarm' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not change the orchestrator');
  });
});

describe('SettingsTab wiring', () => {
  it('mounts the build placement and orchestrator cards when the panel sends placement', async () => {
    authState.user = { id: 1, isOperator: true };
    api.services.get.mockReturnValue(new Promise(() => {}));
    api.servers.list.mockResolvedValue([]);
    api.sources.list.mockResolvedValue([]);
    api.services.imageTransfers.mockResolvedValue([]);
    api.swarm.get.mockResolvedValue({ enabled: true, localState: 'active', controlAvailable: true, managerAddr: null, nodes: [] });
    api.environments.list.mockResolvedValue([]);
    api.serviceTags.get.mockReturnValue(new Promise(() => {}));
    api.services.github.get.mockResolvedValue({ link: null });
    api.fanout.get.mockResolvedValue([]);
    renderWithProviders(<SettingsTab serviceId={5} svc={svc({ cpuShares: 0, memLimitMb: 0, build: {} })} />);
    expect(screen.getByText('Build placement')).toBeInTheDocument();
    expect(screen.getByText('Runtime orchestrator')).toBeInTheDocument();
  });
});
