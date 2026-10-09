import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NineDeployError } from '@ninedeploy/sdk';
import { volumesList, volumesRemove } from '../src/commands/manage.js';
import { dbCreate } from '../src/commands/misc.js';
import {
  placementInput,
  serversList,
  serversRoles,
  serverOption,
  servicesPlacement,
  servicesSwarm,
  servicesTransfers,
  sourcesAllowOnNodes,
  swarmInit,
  swarmJoin,
  swarmLeave,
  swarmSetEnabled,
  swarmStatus,
  volumesCreate,
} from '../src/commands/multiNode.js';

/** 0.16 T8: `servers`, `services placement|transfers|swarm`, `swarm`, node volumes and databases, `sources allow-on-nodes`. */

const h = vi.hoisted(() => ({ prompt: vi.fn(), promptHidden: vi.fn() }));
vi.mock('../src/prompts.js', () => ({ prompt: h.prompt, promptHidden: h.promptHidden }));

const ESC = String.fromCharCode(27);

function makeClient() {
  return {
    servers: { list: vi.fn(), update: vi.fn(), swarmJoin: vi.fn(), swarmLeave: vi.fn() },
    services: { placement: { get: vi.fn(), set: vi.fn() }, imageTransfers: vi.fn(), swarm: vi.fn() },
    swarm: { get: vi.fn(), init: vi.fn(), settings: vi.fn() },
    volumes: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
    databases: { create: vi.fn() },
    sources: { update: vi.fn() },
  };
}
type Client = ReturnType<typeof makeClient>;
const asClient = (c: Client) => c as never;

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
const out = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const err = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  vi.resetAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

const PLACEMENT = { buildOn: null, buildServerId: null, pushRegistrySourceId: null, pushRepository: null, orchestrator: null };
const SWARM = {
  enabled: true,
  localState: 'active',
  controlAvailable: true,
  managerAddr: '10.0.0.1:2377',
  nodes: [
    { id: 'abcdefghijklmnopqrstuvwxy', hostname: `panel${ESC}[2J`, role: 'manager', availability: 'active', state: 'ready', serverId: null },
    { id: 'zyxwvutsrqponmlkjihgfedcb', hostname: 'edge-1', role: 'worker', availability: 'active', state: 'ready', serverId: 2, warnings: ['socket off on edge-1'] },
  ],
  warnings: ['Firewall 2377/tcp'],
};

describe('servers list / roles', () => {
  it('lists nodes with agent, build role, databases and Swarm membership, and the update hint', async () => {
    const c = makeClient();
    c.servers.list.mockResolvedValue([
      {
        id: 2, name: 'edge-1', host: '10.0.0.5', port: 4600, status: 'online', lastSeenAt: null,
        agent: { version: '0.15.4', capabilities: [], checkedAt: null }, isBuildServer: true, buildConcurrency: 2, databases: 1,
        swarmNodeId: 'abc', swarmRole: 'worker', features: { reason: 'Update the agent to v0.15.4' },
      },
      { id: 3, name: 'old', host: '10.0.0.6', port: 4600, status: 'offline', lastSeenAt: null, swarmNodeId: 'def', swarmRole: null },
    ]);
    await serversList(asClient(c));
    expect(out()).toContain('0.15.4');
    expect(out()).toContain('on (2)');
    expect(out()).toContain('worker');
    expect(out()).toContain('member');
    expect(out()).toContain('Update the agent to v0.15.4');
    c.servers.list.mockResolvedValue([]);
    await serversList(asClient(c));
    expect(out()).toContain('No servers registered');
    c.servers.list.mockRejectedValue(new Error('Operator access required'));
    await serversList(asClient(c));
    expect(err()).toContain('Operator access required');
    expect(process.exitCode).toBe(1);
  });

  it('sets the build-server role, naming services still set to build there', async () => {
    const c = makeClient();
    c.servers.update.mockResolvedValue({ id: 2, name: 'edge-1', isBuildServer: true, buildConcurrency: 3, buildServiceIds: [] });
    await serversRoles(asClient(c), '2', { buildServer: 'on', buildConcurrency: '3' });
    expect(c.servers.update).toHaveBeenCalledWith(2, { isBuildServer: true, buildConcurrency: 3 });
    expect(out()).toContain('concurrency 3');
    c.servers.update.mockResolvedValue({ id: 2, name: 'edge-1', isBuildServer: false, buildConcurrency: 1, buildServiceIds: [7, 8] });
    await serversRoles(asClient(c), '2', { buildServer: 'off' });
    expect(c.servers.update).toHaveBeenLastCalledWith(2, { isBuildServer: false });
    expect(out()).toContain('7, 8');
    await serversRoles(asClient(c), '2', { buildConcurrency: '1' });
    expect(c.servers.update).toHaveBeenLastCalledWith(2, { buildConcurrency: 1 });
    c.servers.update.mockRejectedValue(new Error('nope'));
    await serversRoles(asClient(c), '2', { buildServer: 'yes' });
    expect(err()).toContain('nope');
  });

  it('refuses bad input before calling the server', async () => {
    const c = makeClient();
    await serversRoles(asClient(c), '0x10', { buildServer: 'on' });
    await serversRoles(asClient(c), '2');
    await serversRoles(asClient(c), '2', { buildServer: 'maybe' });
    await serversRoles(asClient(c), '2', { buildConcurrency: '9' });
    expect(c.servers.update).not.toHaveBeenCalled();
    expect(err()).toContain('Server id must be a positive integer');
    expect(err()).toContain('Usage: ninedeploy servers roles');
    expect(err()).toContain('--build-server must be on or off');
    expect(err()).toContain('--build-concurrency must be an integer from 1 to 8');
  });
});

describe('services placement / transfers / swarm', () => {
  it('shows the placement without flags, with the 0.15 defaults spelled out', async () => {
    const c = makeClient();
    c.services.placement.get.mockResolvedValue(PLACEMENT);
    await servicesPlacement(asClient(c), '4');
    expect(c.services.placement.set).not.toHaveBeenCalled();
    expect(out()).toContain('target (default)');
    expect(out()).toContain('none (stream relay)');
    expect(out()).toContain('container (default)');
  });

  it('sets the named keys only', async () => {
    const c = makeClient();
    c.services.placement.set.mockResolvedValue({ ...PLACEMENT, buildOn: 'server', buildServerId: 2, pushRegistrySourceId: 5, pushRepository: 'team/app', orchestrator: 'swarm' });
    await servicesPlacement(asClient(c), '4', { buildOn: 'server', buildServer: '2', pushRegistry: '5', pushRepo: 'team/app', orchestrator: 'swarm' });
    expect(c.services.placement.set).toHaveBeenCalledWith(4, { buildOn: 'server', buildServerId: 2, pushRegistrySourceId: 5, pushRepository: 'team/app', orchestrator: 'swarm' });
    expect(out()).toContain('source #5 → team/app');
    expect(out()).toContain('#2');
    await servicesPlacement(asClient(c), '4', { buildServer: 'none', pushRegistry: 'none' });
    expect(c.services.placement.set).toHaveBeenLastCalledWith(4, { buildServerId: null, pushRegistrySourceId: null, pushRepository: null });
    c.services.placement.set.mockRejectedValue(new Error('Node "edge-1" is not a build server'));
    await servicesPlacement(asClient(c), '4', { buildOn: 'panel' });
    expect(err()).toContain('not a build server');
  });

  it('refuses bad placement flags before calling the server', async () => {
    const c = makeClient();
    await servicesPlacement(asClient(c), 'x');
    await servicesPlacement(asClient(c), '4', { buildOn: 'cloud' });
    await servicesPlacement(asClient(c), '4', { buildServer: '-1' });
    await servicesPlacement(asClient(c), '4', { pushRegistry: '5' });
    await servicesPlacement(asClient(c), '4', { pushRegistry: 'abc', pushRepo: 'team/app' });
    await servicesPlacement(asClient(c), '4', { pushRepo: 'team/app' });
    await servicesPlacement(asClient(c), '4', { orchestrator: 'k8s' });
    expect(c.services.placement.get).not.toHaveBeenCalled();
    expect(c.services.placement.set).not.toHaveBeenCalled();
    for (const text of ['--build-on must be one of', '--build-server must be', 'needs --push-repo', '--push-registry must be', 'needs --push-registry', '--orchestrator must be one of']) {
      expect(err()).toContain(text);
    }
    expect(placementInput({})).toEqual({});
  });

  it('lists image transfers with their route, size and outcome', async () => {
    const c = makeClient();
    c.services.imageTransfers.mockResolvedValue([
      { id: 9, deploymentId: 3, serviceId: 4, sourceServerId: null, targetServerId: 2, method: 'stream', imageRef: 'x', imageId: null, bytes: 2_097_152, sha256: null, status: 'completed', error: null, startedAt: '2026-10-09T10:00:00.000Z', finishedAt: null, durationMs: 4200 },
      { id: 8, deploymentId: null, serviceId: 4, sourceServerId: 3, targetServerId: null, method: 'registry', imageRef: 'x', imageId: null, bytes: 0, sha256: null, status: 'failed', error: `denied${ESC}[2J`, startedAt: '2026-10-09T09:00:00.000Z', finishedAt: null, durationMs: null },
    ]);
    await servicesTransfers(asClient(c), '4', { limit: '50' });
    expect(c.services.imageTransfers).toHaveBeenCalledWith(4, { limit: 50 });
    expect(out()).toContain('panel → #2');
    expect(out()).toContain('#3 → panel');
    expect(out()).toContain('4.2s');
    expect(out()).not.toContain('[2J');
    c.services.imageTransfers.mockResolvedValue([]);
    await servicesTransfers(asClient(c), '4');
    expect(c.services.imageTransfers).toHaveBeenLastCalledWith(4, undefined);
    expect(out()).toContain('No image transfers yet');
    await servicesTransfers(asClient(c), '4', { limit: '101' });
    await servicesTransfers(asClient(c), '0');
    expect(err()).toContain('--limit must be an integer from 1 to 100');
    c.services.imageTransfers.mockRejectedValue(new Error('Service not found'));
    await servicesTransfers(asClient(c), '4');
    expect(err()).toContain('Service not found');
  });

  it('shows the Swarm tasks of a service, or says it is not on Swarm', async () => {
    const c = makeClient();
    c.services.swarm.mockResolvedValue({ stack: 'nd-web', desired: 2, running: 1, tasks: [{ node: 'edge-1', state: 'running', error: null, image: 'web:1' }, { node: 'edge-2', state: 'rejected', error: 'no suitable node', image: 'web:1' }] });
    await servicesSwarm(asClient(c), '4');
    expect(out()).toContain('1 running / 2 desired');
    expect(out()).toContain('no suitable node');
    c.services.swarm.mockResolvedValue({ stack: null, desired: 0, running: 0, tasks: [] });
    await servicesSwarm(asClient(c), '4');
    expect(out()).toContain('Not on Swarm');
    await servicesSwarm(asClient(c), 'abc');
    c.services.swarm.mockRejectedValue(new Error('boom'));
    await servicesSwarm(asClient(c), '4');
    expect(err()).toContain('Service id must be a positive integer');
    expect(err()).toContain('boom');
  });
});

describe('swarm', () => {
  it('status prints the state, the nodes and every warning, sanitised', async () => {
    const c = makeClient();
    c.swarm.get.mockResolvedValue(SWARM);
    await swarmStatus(asClient(c));
    expect(out()).toContain('10.0.0.1:2377');
    expect(out()).toContain('abcdefghijkl');
    expect(out()).not.toContain('abcdefghijklm');
    expect(out()).not.toContain('[2J');
    expect(out()).toContain('socket off on edge-1');
    expect(out()).toContain('Firewall 2377/tcp');
    c.swarm.get.mockResolvedValue({ enabled: false, localState: 'inactive', controlAvailable: false, managerAddr: null, nodes: [] });
    await swarmStatus(asClient(c));
    expect(out()).toContain('disabled');
    c.swarm.get.mockRejectedValue(new Error('Operator access required'));
    await swarmStatus(asClient(c));
    expect(err()).toContain('Operator access required');
  });

  it('init asks for the password and sends it with the advertise address', async () => {
    const c = makeClient();
    c.swarm.init.mockResolvedValue(SWARM);
    h.promptHidden.mockResolvedValue('pw');
    await swarmInit(asClient(c), { advertiseAddr: ' 10.0.0.1 ' });
    expect(h.promptHidden).toHaveBeenCalledWith(expect.stringContaining('password'));
    expect(c.swarm.init).toHaveBeenCalledWith({ advertiseAddr: '10.0.0.1', password: 'pw' });
    expect(out()).toContain('ninedeploy swarm enable');
    h.promptHidden.mockResolvedValue('');
    await swarmInit(asClient(c), { advertiseAddr: '10.0.0.1' });
    expect(c.swarm.init).toHaveBeenLastCalledWith({ advertiseAddr: '10.0.0.1' });
    c.swarm.init.mockRejectedValue(new Error('swarm_already_active'));
    await swarmInit(asClient(c), { advertiseAddr: '10.0.0.1' });
    expect(err()).toContain('swarm_already_active');
  });

  it('init without --advertise-addr is refused before any prompt', async () => {
    const c = makeClient();
    await swarmInit(asClient(c));
    expect(h.promptHidden).not.toHaveBeenCalled();
    expect(c.swarm.init).not.toHaveBeenCalled();
    expect(err()).toContain('--advertise-addr');
  });

  it('enable asks for the password; disable does not', async () => {
    const c = makeClient();
    c.swarm.settings.mockResolvedValue(SWARM);
    h.promptHidden.mockResolvedValue('pw');
    await swarmSetEnabled(asClient(c), true);
    expect(c.swarm.settings).toHaveBeenCalledWith({ enabled: true, password: 'pw' });
    expect(out()).toContain('Swarm deploys enabled');
    h.promptHidden.mockClear();
    await swarmSetEnabled(asClient(c), false);
    expect(h.promptHidden).not.toHaveBeenCalled();
    expect(c.swarm.settings).toHaveBeenLastCalledWith({ enabled: false });
    expect(out()).toContain('running stacks keep running');
    h.promptHidden.mockResolvedValue('');
    await swarmSetEnabled(asClient(c), true);
    expect(c.swarm.settings).toHaveBeenLastCalledWith({ enabled: true });
    c.swarm.settings.mockRejectedValue(new Error('swarm_not_manager'));
    await swarmSetEnabled(asClient(c), true);
    expect(err()).toContain('swarm_not_manager');
  });

  it('join reports the node and any warnings', async () => {
    const c = makeClient();
    c.servers.swarmJoin.mockResolvedValue({ serverId: 2, nodeId: 'zyxwvutsrqponmlkjihgfedcb', role: 'worker', warnings: ['rotate the token'] });
    await swarmJoin(asClient(c), '2');
    expect(c.servers.swarmJoin).toHaveBeenCalledWith(2);
    expect(out()).toContain('joined the swarm as a worker');
    expect(out()).toContain('rotate the token');
    await swarmJoin(asClient(c), 'two');
    expect(c.servers.swarmJoin).toHaveBeenCalledTimes(1);
  });

  it('join prints the NINEDEPLOY_AGENT_SWARM_MANAGER hint on node_swarm_not_enabled, and only then', async () => {
    const c = makeClient();
    c.servers.swarmJoin.mockRejectedValue(new NineDeployError(422, 'node_swarm_not_enabled', 'The agent on node edge-1 does not accept Swarm membership'));
    await swarmJoin(asClient(c), '2');
    expect(err()).toContain('does not accept Swarm membership');
    expect(out()).toContain('NINEDEPLOY_AGENT_SWARM_MANAGER=');
    logSpy.mockClear();
    c.servers.swarmJoin.mockRejectedValue(new NineDeployError(422, 'node_agent_outdated', 'Update the node agent'));
    await swarmJoin(asClient(c), '2');
    expect(err()).toContain('Update the node agent');
    expect(out()).not.toContain('NINEDEPLOY_AGENT_SWARM_MANAGER');
    c.servers.swarmJoin.mockRejectedValue('plain failure');
    await swarmJoin(asClient(c), '2');
    expect(err()).toContain('plain failure');
  });

  it('leave confirms, then reports an incomplete drain and warnings', async () => {
    const c = makeClient();
    h.prompt.mockResolvedValue('no');
    await swarmLeave(asClient(c), '2');
    expect(c.servers.swarmLeave).not.toHaveBeenCalled();
    expect(out()).toContain('Cancelled');
    h.prompt.mockResolvedValue('yes');
    c.servers.swarmLeave.mockResolvedValue({ serverId: 2, nodeId: 'n', drained: false, warnings: ['rotate by hand'] });
    await swarmLeave(asClient(c), '2');
    expect(out()).toContain('left the swarm');
    expect(out()).toContain('had not moved within 5 minutes');
    expect(out()).toContain('rotate by hand');
    h.prompt.mockClear();
    c.servers.swarmLeave.mockResolvedValue({ serverId: 2, nodeId: 'n', drained: true });
    await swarmLeave(asClient(c), '2', { yes: true });
    expect(h.prompt).not.toHaveBeenCalled();
    await swarmLeave(asClient(c), '');
    c.servers.swarmLeave.mockRejectedValue(new Error('swarm_not_joined'));
    await swarmLeave(asClient(c), '2', { yes: true });
    expect(err()).toContain('Server id must be a positive integer');
    expect(err()).toContain('swarm_not_joined');
  });
});

describe('volumes and databases on a node', () => {
  it('creates a volume on the panel host or a node', async () => {
    const c = makeClient();
    c.volumes.create.mockResolvedValue({ ok: true, name: 'nd-svc-web-data', serverId: null });
    await volumesCreate(asClient(c), 'nd-svc-web-data');
    expect(c.volumes.create).toHaveBeenCalledWith({ name: 'nd-svc-web-data' });
    expect(out()).toContain('the panel host');
    c.volumes.create.mockResolvedValue({ ok: true, name: 'nd-svc-web-data', serverId: 2 });
    await volumesCreate(asClient(c), 'nd-svc-web-data', { server: '2' });
    expect(c.volumes.create).toHaveBeenLastCalledWith({ name: 'nd-svc-web-data', serverId: 2 });
    expect(out()).toContain('server #2');
    await volumesCreate(asClient(c), '');
    await volumesCreate(asClient(c), 'nd-svc-x', { server: 'abc' });
    expect(c.volumes.create).toHaveBeenCalledTimes(2);
    c.volumes.create.mockRejectedValue(new Error('node_volume_exists'));
    await volumesCreate(asClient(c), 'nd-svc-web-data', { server: '2' });
    expect(err()).toContain('Usage: ninedeploy volumes create');
    expect(err()).toContain('--server must be a positive integer');
    expect(err()).toContain('node_volume_exists');
    expect(serverOption(undefined)).toBeUndefined();
  });

  it('lists and removes a node volume with --server', async () => {
    const c = makeClient();
    c.volumes.list.mockResolvedValue([{ name: 'nd-svc-web-data', sizeBytes: 0, owner: null, inUse: false, serverId: 2 }]);
    await volumesList(asClient(c), { server: '2' });
    expect(c.volumes.list).toHaveBeenCalledWith({ serverId: 2 });
    expect(out()).toContain('Volumes on server #2');
    await volumesList(asClient(c));
    expect(c.volumes.list).toHaveBeenLastCalledWith(undefined);
    h.prompt.mockResolvedValue('nd-svc-web-data');
    await volumesRemove(asClient(c), 'nd-svc-web-data', { server: '2' });
    expect(h.prompt).toHaveBeenCalledWith(expect.stringContaining('on server #2'));
    expect(c.volumes.remove).toHaveBeenCalledWith('nd-svc-web-data', { serverId: 2 });
    await expect(volumesList(asClient(c), { server: '0x2' })).rejects.toThrow(/--server/);
  });

  it('creates a database on a node with --server', async () => {
    const c = makeClient();
    h.prompt.mockResolvedValueOnce('db').mockResolvedValueOnce('1');
    c.databases.create.mockResolvedValue({ id: 5, name: 'db', connectionString: null });
    await dbCreate(asClient(c), { server: '2' });
    expect(c.databases.create).toHaveBeenCalledWith({ name: 'db', engine: 'postgres', serverId: 2 });
    expect(out()).toContain('server #2');
    await dbCreate(asClient(c), { server: '1e1' });
    expect(c.databases.create).toHaveBeenCalledTimes(1);
    expect(err()).toContain('--server must be a positive integer');
  });
});

describe('sources allow-on-nodes', () => {
  it('on asks for the password and warns; off does neither', async () => {
    const c = makeClient();
    c.sources.update.mockResolvedValue({ id: 3, name: 'gh' });
    h.promptHidden.mockResolvedValue('pw');
    await sourcesAllowOnNodes(asClient(c), '3', 'on');
    expect(c.sources.update).toHaveBeenCalledWith(3, { allowOnNodes: true, password: 'pw' });
    expect(out()).toContain('NINEDEPLOY_AGENT_STATIC_CREDENTIALS=off');
    expect(out()).toContain('allowed on nodes');
    h.promptHidden.mockClear();
    await sourcesAllowOnNodes(asClient(c), '3', 'off');
    expect(h.promptHidden).not.toHaveBeenCalled();
    expect(c.sources.update).toHaveBeenLastCalledWith(3, { allowOnNodes: false });
    expect(out()).toContain('panel host only');
    h.promptHidden.mockResolvedValue('');
    await sourcesAllowOnNodes(asClient(c), '3', 'true');
    expect(c.sources.update).toHaveBeenLastCalledWith(3, { allowOnNodes: true });
  });

  it('refuses bad input and reports a refused step-up', async () => {
    const c = makeClient();
    await sourcesAllowOnNodes(asClient(c), 'x', 'on');
    await sourcesAllowOnNodes(asClient(c), '3', 'sometimes');
    expect(c.sources.update).not.toHaveBeenCalled();
    expect(err()).toContain('The setting must be on or off');
    c.sources.update.mockRejectedValue(new Error('reauth_required'));
    h.promptHidden.mockResolvedValue('wrong');
    await sourcesAllowOnNodes(asClient(c), '3', 'on');
    expect(err()).toContain('reauth_required');
  });
});
