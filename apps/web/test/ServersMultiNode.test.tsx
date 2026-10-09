import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

/**
 * Multi-node, Servers page: the per-node panel (agent version, feature chips
 * and the "update the agent" hint, the build-server role, Swarm join/leave
 * with the opt-in hint and warnings, the hosted database count, and the
 * swarm member's delete guard). An older panel sends none of these fields and
 * the page must look exactly as before.
 */

const apiMock = vi.hoisted(() => ({
  api: {
    servers: {
      list: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
      test: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
      sshTest: vi.fn(),
      sshBootstrap: vi.fn(),
      bootstrapLogs: vi.fn(),
      update: vi.fn(),
      swarmJoin: vi.fn(),
      swarmLeave: vi.fn(),
    },
    swarm: { get: vi.fn() },
    services: { list: vi.fn() },
    databases: { list: vi.fn() },
    workspaces: { list: vi.fn() },
    projects: { list: vi.fn() },
    sources: { list: vi.fn() },
    auth: { me: vi.fn(), status: vi.fn() },
    settings: { enrolment: { get: vi.fn(), rotate: vi.fn(), disable: vi.fn() } },
  },
  deployLogsWsUrl: vi.fn(() => 'ws://localhost/v1/logs'),
  websocketAuthProtocols: vi.fn(() => ['ninedeploy.bearer.test']),
  authedFetch: vi.fn(),
}));
vi.mock('../src/lib/api.js', () => apiMock);

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useToast: () => toastSpy,
}));

const authMock = vi.hoisted(() => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({ user: { id: 1, isOperator: true }, status: 'ready', logout: vi.fn() }),
}));
vi.mock('../src/lib/auth.js', () => authMock);

import { Servers } from '../src/routes/Servers.js';
import { renderWithProviders } from './helpers.js';

const s = apiMock.api.servers;

const FEATURES_ALL = { nixpacks: true, railpack: true, privateClones: true, volumes: true, databases: true, imageTransfer: true, swarm: true };

const node = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'edge-1',
  host: '10.0.0.5',
  port: 4600,
  status: 'online',
  lastSeenAt: null,
  agent: { version: '0.15.4', capabilities: ['ping', 'stream', 'swarm'], checkedAt: '2026-10-09T10:00:00Z' },
  features: FEATURES_ALL,
  isBuildServer: false,
  buildConcurrency: 1,
  databases: 0,
  swarmNodeId: null,
  swarmRole: null,
  ...over,
});

const swarmStatus = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  localState: 'active',
  controlAvailable: true,
  managerAddr: '10.0.0.2:2377',
  nodes: [],
  ...over,
});

function panel(id = 1) {
  return within(screen.getByTestId(`node-panel-${id}`));
}

describe('Servers page — multi-node node panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.api.services.list.mockResolvedValue([]);
    apiMock.api.databases.list.mockResolvedValue([]);
    apiMock.api.settings.enrolment.get.mockResolvedValue({ enabled: false, token: null });
    apiMock.api.swarm.get.mockResolvedValue(swarmStatus());
  });

  it('an older panel (no multi-node fields) shows no node panel and never asks for the swarm', async () => {
    s.list.mockResolvedValue([{ id: 1, name: 'edge-1', host: '10.0.0.5', port: 4600, status: 'online', lastSeenAt: null }]);
    renderWithProviders(<Servers />);
    expect(await screen.findByText('edge-1')).toBeInTheDocument();
    expect(screen.queryByTestId('node-panel-1')).toBeNull();
    expect(apiMock.api.swarm.get).not.toHaveBeenCalled();
  });

  it('shows the agent version, feature chips, capabilities and the "update the agent" hint naming the missing features', async () => {
    s.list.mockResolvedValue([
      node({ features: { ...FEATURES_ALL, railpack: false, databases: false, reason: 'The agent predates v0.15.3.' }, databases: 2 }),
    ]);
    renderWithProviders(<Servers />);
    await screen.findByTestId('node-panel-1');
    expect(panel().getByText('0.15.4')).toBeInTheDocument();
    expect(panel().getByText('3 capabilities')).toBeInTheDocument();
    expect(panel().getByText(/Update the agent on this node to use: Railpack, Databases\. The agent predates v0\.15\.3\./)).toBeInTheDocument();
    expect(panel().getByText('2 managed databases')).toBeInTheDocument();
    expect(panel().getByText(/remove is refused/)).toBeInTheDocument();
  });

  it('labels an agent that has not answered a sealed ping yet, and one without a version', async () => {
    s.list.mockResolvedValue([
      node({ agent: null, features: undefined, isBuildServer: undefined, swarmNodeId: undefined, databases: 1 }),
      node({ id: 2, name: 'edge-2', agent: { version: null, capabilities: [], checkedAt: null }, features: undefined, swarmNodeId: undefined }),
    ]);
    renderWithProviders(<Servers />);
    await screen.findByTestId('node-panel-1');
    expect(panel(1).getByText('not checked yet')).toBeInTheDocument();
    expect(panel(1).getByText('1 managed database')).toBeInTheDocument();
    expect(panel(2).getByText('unknown (older agent)')).toBeInTheDocument();
    expect(panel(2).getByText('No managed databases')).toBeInTheDocument();
    // No Swarm field from the panel: no Swarm section and no swarm status call.
    expect(panel(1).queryByText('Swarm')).toBeNull();
    expect(apiMock.api.swarm.get).not.toHaveBeenCalled();
  });

  it('turns the build-server role on, saves the concurrency, and warns when services still build there', async () => {
    s.list.mockResolvedValue([node({ features: { ...FEATURES_ALL, imageTransfer: false } })]);
    s.update.mockResolvedValue({ id: 1, name: 'edge-1', isBuildServer: true, buildConcurrency: 1, buildServiceIds: [] });
    renderWithProviders(<Servers />);
    await screen.findByTestId('node-panel-1');
    expect(panel().getByText(/cannot hand built images over yet/)).toBeInTheDocument();
    // The refetch after the save sees the new role.
    s.list.mockResolvedValue([node({ isBuildServer: true, buildConcurrency: 2 })]);
    fireEvent.click(panel().getByRole('switch', { name: 'Build server edge-1' }));
    await waitFor(() => expect(s.update).toHaveBeenCalledWith(1, { isBuildServer: true }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('edge-1 builds images (up to 1 at once)', 'success'));
    await waitFor(() => expect(panel().getByRole('switch', { name: 'Build server edge-1' })).toHaveAttribute('aria-checked', 'true'));
  });

  it('saves a valid build concurrency and refuses an out-of-range one', async () => {
    s.list.mockResolvedValue([node({ isBuildServer: true, buildConcurrency: 2 })]);
    s.update.mockResolvedValue({ id: 1, name: 'edge-1', isBuildServer: true, buildConcurrency: 4, buildServiceIds: [] });
    renderWithProviders(<Servers />);
    const input = await screen.findByLabelText('Build concurrency for edge-1');
    const save = panel().getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled(); // unchanged
    fireEvent.change(input, { target: { value: '9' } });
    expect(save).toBeDisabled();
    fireEvent.submit(input.closest('form')!);
    expect(s.update).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.click(save);
    await waitFor(() => expect(s.update).toHaveBeenCalledWith(1, { buildConcurrency: 4 }));
  });

  it('turning the role off names the services that still build there; a refusal is toasted', async () => {
    s.list.mockResolvedValue([node({ isBuildServer: true, buildConcurrency: 2 })]);
    s.update.mockResolvedValueOnce({ id: 1, name: 'edge-1', isBuildServer: false, buildConcurrency: 2, buildServiceIds: [7, 8] });
    renderWithProviders(<Servers />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Build server edge-1' }));
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith(expect.stringContaining('2 service(s) still build there'), 'info'),
    );
    s.update.mockResolvedValueOnce({ id: 1, name: 'edge-1', isBuildServer: false, buildConcurrency: 2, buildServiceIds: [] });
    fireEvent.click(panel().getByRole('switch', { name: 'Build server edge-1' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('edge-1 is no longer a build server', 'success'));
    s.update.mockRejectedValueOnce(new Error('nope'));
    fireEvent.click(panel().getByRole('switch', { name: 'Build server edge-1' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('nope', 'error'));
  });

  it('shows the Swarm opt-in line with the manager address, and the exact fix when the node refuses to join', async () => {
    s.list.mockResolvedValue([node()]);
    s.swarmJoin.mockRejectedValue(
      Object.assign(new Error('The agent on node edge-1 does not accept Swarm membership: it is opt-in on the node.'), { code: 'node_swarm_not_enabled' }),
    );
    renderWithProviders(<Servers />);
    await screen.findByTestId('node-panel-1');
    expect(await panel().findByText('NINEDEPLOY_AGENT_SWARM_MANAGER=10.0.0.2:2377')).toBeInTheDocument();
    expect(panel().getByText('not in the swarm')).toBeInTheDocument();
    fireEvent.click(panel().getByRole('button', { name: 'Join' }));
    const alert = await panel().findByRole('alert');
    expect(alert).toHaveTextContent('opt-in on the node');
    expect(alert).toHaveTextContent('On the node: NINEDEPLOY_AGENT_SWARM_MANAGER=10.0.0.2:2377');
  });

  it('falls back to a placeholder manager address, and shows a plain refusal without the hint', async () => {
    apiMock.api.swarm.get.mockResolvedValue(swarmStatus({ managerAddr: null, localState: 'inactive' }));
    s.list.mockResolvedValue([node()]);
    s.swarmJoin.mockRejectedValue(Object.assign(new Error('Initialise Swarm first.'), { code: 'swarm_not_manager' }));
    renderWithProviders(<Servers />);
    await screen.findByTestId('node-panel-1');
    expect(await panel().findByText('NINEDEPLOY_AGENT_SWARM_MANAGER=<advertise addr>:2377')).toBeInTheDocument();
    fireEvent.click(panel().getByRole('button', { name: 'Join' }));
    const alert = await panel().findByRole('alert');
    expect(alert).toHaveTextContent('Initialise Swarm first.');
    expect(alert).not.toHaveTextContent('On the node:');
  });

  it('joins and shows the join warnings and the node warnings from the swarm status', async () => {
    apiMock.api.swarm.get.mockResolvedValue(
      swarmStatus({ nodes: [{ id: 'n1', hostname: 'edge-1', role: 'worker', availability: 'active', state: 'ready', serverId: 1, warnings: ['Docker socket is off on edge-1'] }] }),
    );
    s.list.mockResolvedValue([node()]);
    s.swarmJoin.mockResolvedValue({ serverId: 1, nodeId: 'abc', role: 'worker', warnings: ['Rotate the join token by hand'] });
    renderWithProviders(<Servers />);
    await screen.findByTestId('node-panel-1');
    expect(await panel().findByText('Docker socket is off on edge-1')).toBeInTheDocument();
    fireEvent.click(panel().getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(s.swarmJoin).toHaveBeenCalledWith(1));
    expect(await panel().findByText('Rotate the join token by hand')).toBeInTheDocument();
    expect(toastSpy.toast).toHaveBeenCalledWith('edge-1 joined the swarm', 'success');
  });

  it('a join with no warnings and a refused join without a message', async () => {
    s.list.mockResolvedValue([node()]);
    s.swarmJoin.mockResolvedValueOnce({ serverId: 1, nodeId: 'abc', role: 'worker' });
    renderWithProviders(<Servers />);
    await screen.findByTestId('node-panel-1');
    fireEvent.click(panel().getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('edge-1 joined the swarm', 'success'));
    s.swarmJoin.mockRejectedValueOnce('boom');
    fireEvent.click(panel().getByRole('button', { name: 'Join' }));
    expect(await panel().findByRole('alert')).toHaveTextContent('Could not join the swarm');
  });

  it('an agent without Swarm cannot join and says to update', async () => {
    s.list.mockResolvedValue([node({ features: { ...FEATURES_ALL, swarm: false } })]);
    renderWithProviders(<Servers />);
    await screen.findByTestId('node-panel-1');
    expect(panel().getByRole('button', { name: 'Join' })).toBeDisabled();
    expect(panel().getByText(/predates Swarm/)).toBeInTheDocument();
  });

  it('a swarm member: role, leave after confirming, and delete needs leave first', async () => {
    s.list.mockResolvedValue([node({ swarmNodeId: 'abcdef0123456789', swarmRole: 'worker' })]);
    s.swarmLeave.mockResolvedValueOnce({ serverId: 1, nodeId: 'abcdef0123456789', drained: false, warnings: ['Tasks had not moved'] });
    renderWithProviders(<Servers />);
    await screen.findByTestId('node-panel-1');
    expect(panel().getByText('worker')).toBeInTheDocument();
    expect(panel().getByText('abcdef012345')).toBeInTheDocument();
    expect(panel().getByText(/make it leave before you remove it/)).toBeInTheDocument();
    const trash = screen.getByTitle('In the swarm: make it leave first');
    expect(trash).toBeDisabled();

    fireEvent.click(panel().getByRole('button', { name: 'Leave' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Leave' }).at(-1)!);
    await waitFor(() => expect(s.swarmLeave).toHaveBeenCalledWith(1));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('edge-1 left the swarm before its tasks moved', 'info'));
    expect(await panel().findByText('Tasks had not moved')).toBeInTheDocument();
  });

  it('a drained leave, a failed leave, and a member with no reported role', async () => {
    s.list.mockResolvedValue([node({ swarmNodeId: 'abc', swarmRole: null })]);
    s.swarmLeave.mockResolvedValueOnce({ serverId: 1, nodeId: 'abc', drained: true });
    renderWithProviders(<Servers />);
    await screen.findByTestId('node-panel-1');
    expect(panel().getByText('member')).toBeInTheDocument();
    fireEvent.click(panel().getByRole('button', { name: 'Leave' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Leave' }).at(-1)!);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('edge-1 left the swarm', 'success'));
    s.swarmLeave.mockRejectedValueOnce(new Error('drain failed'));
    fireEvent.click(panel().getByRole('button', { name: 'Leave' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Leave' }).at(-1)!);
    expect(await panel().findByRole('alert')).toHaveTextContent('drain failed');
  });

  it('a refused delete shows the server reason (e.g. the node hosts databases)', async () => {
    s.list.mockResolvedValue([node({ databases: 1 })]);
    s.remove.mockRejectedValue(Object.assign(new Error('Node "edge-1" hosts 1 managed database.'), { code: 'server_hosts_databases' }));
    renderWithProviders(<Servers />);
    fireEvent.click(await screen.findByTitle('Remove server'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Node "edge-1" hosts 1 managed database.', 'error'));
  });
});
