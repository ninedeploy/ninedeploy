import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, runMigrations, servers, settings, users } from '@ninedeploy/db';
import { MULTI_NODE_CAPABILITIES } from '@ninedeploy/schemas';

/**
 * Multi-node T7, Swarm cluster management (design §7.2, §7.5, §7.6):
 * `GET /v1/swarm`, `POST /v1/swarm/init` (operator, interactive, step-up),
 * `PUT /v1/swarm/settings` (step-up to enable, a manager required),
 * `POST /v1/servers/:id/swarm/join|leave` (the node's agent, sealed,
 * capability `swarm`). Docker and the agent are mocked; nothing runs.
 */

const TOKEN = `SWMTKN-1-${'c3'.repeat(25)}-${'d4'.repeat(12)}q`;
const PASSWORD = 'correct horse battery';

const h = vi.hoisted(() => ({
  swarm: { LocalNodeState: 'inactive', ControlAvailable: false, NodeID: '', NodeAddr: '' } as Record<string, unknown>,
  docker: [] as string[][],
  /** argv prefixes that fail. */
  failing: [] as string[],
  nodePs: [] as string[],
  agentOps: [] as Array<{ op: string; params: Record<string, unknown> }>,
  ping: '',
  sealed: true,
  audits: [] as Array<{ action: string; entity: string; meta: unknown }>,
}));

const fails = (args: string[]) => h.failing.some((p) => args.join(' ').startsWith(p));
vi.mock('../src/lib/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/exec.js')>()),
  capture: vi.fn(async (_cmd: string, args: string[]) => {
    h.docker.push(args);
    if (fails(args)) throw new Error(`docker ${args.slice(0, 2).join(' ')} failed: boom`);
    if (args[0] === 'info') return JSON.stringify(h.swarm);
    if (args[0] === 'swarm' && args[1] === 'init') {
      h.swarm = { LocalNodeState: 'active', ControlAvailable: true, NodeID: 'mgr1', NodeAddr: args[3] };
      return `Swarm initialized: current node (mgr1) is now a manager.\n\n    docker swarm join --token ${TOKEN} ${args[3]}:2377\n`;
    }
    if (args[0] === 'swarm' && args[1] === 'join-token') return `${TOKEN}\n`;
    if (args[0] === 'node' && args[1] === 'ls') return '{"ID":"mgr1","Hostname":"panel","ManagerStatus":"Leader","Availability":"Active","Status":"Ready"}\n{"ID":"wrk1","Hostname":"edge","ManagerStatus":"","Availability":"Active","Status":"Ready"}';
    if (args[0] === 'node' && args[1] === 'ps') return h.nodePs.shift() ?? '';
    if (args[0] === 'node' && args[1] === 'inspect') return 'down';
    return '';
  }),
  run: vi.fn(async (_cmd: string, args: string[]) => {
    h.docker.push(args);
    if (fails(args)) throw new Error(`docker ${args.slice(0, 2).join(' ')} exited 1`);
  }),
  sleep: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/agentClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agentClient.js')>()),
  agentTransportSealed: async () => h.sealed,
  agentOp: async (_db: unknown, _id: number, op: string, params: Record<string, unknown>, sink: (l: string) => void) => {
    h.agentOps.push({ op, params });
    if (op === 'agent.ping') return { exitCode: 0, lines: [h.ping] };
    if (op === 'swarm.info') {
      sink('{"LocalNodeState":"active","NodeID":"wrk1","ControlAvailable":false}');
      return { exitCode: 0, lines: [] };
    }
    return { exitCode: 0, lines: [] };
  },
}));
vi.mock('../src/lib/audit.js', () => ({
  audit: vi.fn(async (_db: unknown, _uid: unknown, action: string, entity: string, meta: unknown) => {
    h.audits.push({ action, entity, meta });
  }),
}));

const { serverSwarmRoutes, swarmRoutes } = await import('../src/modules/swarm.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { encrypt } = await import('../src/lib/crypto.js');
const caps = await import('../src/lib/agentCapabilities.js');
const { asUser, buildTestApp } = await import('./helpers.js');

const CAPS_015_LIST = ['build-path-guard', 'workspace.remove', 'git.credential', 'terminal', 'terminal.host'];
const pingLine = (version: string, list: string[]) => `ND-AGENT ${JSON.stringify({ version, caps: list })}`;

let db: DB;
let serverId: number;

beforeEach(async () => {
  h.swarm = { LocalNodeState: 'inactive', ControlAvailable: false, NodeID: '', NodeAddr: '' };
  h.docker = [];
  h.failing = [];
  h.nodePs = [];
  h.agentOps = [];
  h.audits = [];
  h.sealed = true;
  h.ping = pingLine('0.15.4', [...CAPS_015_LIST, ...MULTI_NODE_CAPABILITIES]);
  caps.resetNodeCapabilityCache();
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: await hashPassword(PASSWORD), isInstanceOperator: true });
  serverId = (await db.insert(servers).values({ name: 'edge-1', host: '10.0.0.5', port: 4600, tokenEncrypted: encrypt('t'), status: 'online' }).returning())[0]!.id;
});

async function app() {
  const a = await buildTestApp({ db });
  await a.register(swarmRoutes, { prefix: '/swarm' });
  await a.register(serverSwarmRoutes, { prefix: '/servers' });
  return a;
}
const allText = () => JSON.stringify({ docker: h.docker.filter((a) => !(a[0] === 'swarm' && a[1] === 'join-token')), audits: h.audits });

describe('GET /v1/swarm', () => {
  it('reports the disabled default, the daemon state and no nodes off a manager; never a token', async () => {
    const a = await app();
    const res = await a.inject({ method: 'GET', url: '/swarm', headers: asUser() });
    expect(res.json()).toEqual({ enabled: false, localState: 'inactive', controlAvailable: false, managerAddr: null, nodes: [] });
    // An unreachable daemon is a state, not a 500.
    h.failing = ['info'];
    expect((await a.inject({ method: 'GET', url: '/swarm', headers: asUser() })).json()).toMatchObject({ localState: 'unreachable' });
  });

  it('on a manager: the nodes, linked to their NineDeploy server, and the address nodes join', async () => {
    h.swarm = { LocalNodeState: 'active', ControlAvailable: true, NodeID: 'mgr1', NodeAddr: '10.0.0.1' };
    await db.update(servers).set({ swarmNodeId: 'wrk1', swarmRole: 'worker' });
    const res = (await (await app()).inject({ method: 'GET', url: '/swarm', headers: asUser() })).json();
    expect(res.managerAddr).toBe('10.0.0.1:2377');
    expect(res.nodes).toEqual([
      { id: 'mgr1', hostname: 'panel', role: 'manager', availability: 'active', state: 'ready', serverId: null },
      { id: 'wrk1', hostname: 'edge', role: 'worker', availability: 'active', state: 'ready', serverId },
    ]);
    expect(JSON.stringify(res)).not.toContain('SWMTKN');
  });

  it('is operator only', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/swarm', headers: asUser({ isOperator: false }) });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /v1/swarm/init (operator + interactive + step-up)', () => {
  it('initialises with the advertise address, probes an encrypted overlay, audits; the join token never leaves', async () => {
    const res = await (await app()).inject({ method: 'POST', url: '/swarm/init', headers: asUser(), payload: { advertiseAddr: '10.0.0.1', password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ localState: 'active', controlAvailable: true, managerAddr: '10.0.0.1:2377' });
    expect(h.docker).toContainEqual(['swarm', 'init', '--advertise-addr', '10.0.0.1']);
    const probe = h.docker.find((a) => a[0] === 'network' && a[1] === 'create');
    expect(probe).toEqual(['network', 'create', '--driver', 'overlay', '--opt', 'encrypted', '--attachable', expect.stringMatching(/^nd-swarm-probe-[0-9a-f]{8}$/)]);
    expect(h.docker).toContainEqual(['network', 'rm', probe!.at(-1)]);
    expect(h.audits).toEqual([{ action: 'swarm.init', entity: '10.0.0.1', meta: { advertiseAddr: '10.0.0.1' } }]);
    expect(res.body).not.toContain('SWMTKN');
    expect(JSON.stringify(h.audits)).not.toContain('SWMTKN');
    expect((await db.query.settings.findFirst({ where: (s, { eq }) => eq(s.key, 'swarm_advertise_addr') }))?.value).toBe('10.0.0.1');
    // Initialising never enables deploys.
    expect((await db.query.settings.findFirst({ where: (s, { eq }) => eq(s.key, 'swarm_enabled') }))).toBeUndefined();
  });

  it('refuses a daemon already in a swarm (409 with the state), and touches nothing', async () => {
    h.swarm = { LocalNodeState: 'active', ControlAvailable: true, NodeID: 'x' };
    const res = await (await app()).inject({ method: 'POST', url: '/swarm/init', headers: asUser(), payload: { advertiseAddr: '10.0.0.1', password: PASSWORD } });
    expect([res.statusCode, res.json().error.code]).toEqual([409, 'swarm_already_active']);
    expect(res.json().error.message).toMatch(/state: active/);
    expect(h.docker.filter((a) => a[0] === 'swarm')).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('needs the password (step-up) and an interactive session (never an API token)', async () => {
    const a = await app();
    const wrong = await a.inject({ method: 'POST', url: '/swarm/init', headers: asUser(), payload: { advertiseAddr: '10.0.0.1', password: 'nope' } });
    expect([wrong.statusCode, wrong.json().error.code]).toEqual([403, 'invalid_password']);
    const none = await a.inject({ method: 'POST', url: '/swarm/init', headers: asUser(), payload: { advertiseAddr: '10.0.0.1' } });
    expect([none.statusCode, none.json().error.code]).toEqual([403, 'reauth_required']);
    const token = await a.inject({
      method: 'POST',
      url: '/swarm/init',
      headers: { ...asUser(), 'x-test-token-scopes': 'operator' },
      payload: { advertiseAddr: '10.0.0.1', password: PASSWORD },
    });
    expect(token.statusCode).toBe(403);
    expect((await a.inject({ method: 'POST', url: '/swarm/init', headers: asUser(), payload: { advertiseAddr: 'not-an-ip', password: PASSWORD } })).statusCode).toBe(400);
    expect(h.docker.filter((a2) => a2[0] === 'swarm')).toEqual([]);
  });

  it('reports a clear error when the swarm cannot create an encrypted overlay (ESP, Windows)', async () => {
    h.failing = ['network create'];
    const res = await (await app()).inject({ method: 'POST', url: '/swarm/init', headers: asUser(), payload: { advertiseAddr: '10.0.0.1', password: PASSWORD } });
    expect([res.statusCode, res.json().error.code]).toEqual([502, 'swarm_overlay_unavailable']);
    expect(res.json().error.message).toMatch(/initialised.*cannot create an encrypted overlay.*ESP, IP protocol 50.*Windows/);
  });
});

describe('PUT /v1/swarm/settings', () => {
  it('enabling needs step-up and an active manager; disabling needs neither; both audited', async () => {
    const a = await app();
    const notManager = await a.inject({ method: 'PUT', url: '/swarm/settings', headers: asUser(), payload: { enabled: true, password: PASSWORD } });
    expect([notManager.statusCode, notManager.json().error.code]).toEqual([409, 'swarm_not_manager']);
    h.swarm = { LocalNodeState: 'active', ControlAvailable: true, NodeID: 'mgr1', NodeAddr: '10.0.0.1' };
    expect((await a.inject({ method: 'PUT', url: '/swarm/settings', headers: asUser(), payload: { enabled: true } })).json().error.code).toBe('reauth_required');
    const on = await a.inject({ method: 'PUT', url: '/swarm/settings', headers: asUser(), payload: { enabled: true, password: PASSWORD } });
    expect([on.statusCode, on.json().enabled]).toEqual([200, true]);
    const off = await a.inject({ method: 'PUT', url: '/swarm/settings', headers: asUser(), payload: { enabled: false } });
    expect([off.statusCode, off.json().enabled]).toEqual([200, false]);
    expect(h.audits.map((x) => [x.action, x.meta])).toEqual([
      ['swarm.settings', { enabled: true, previous: false }],
      ['swarm.settings', { enabled: false, previous: true }],
    ]);
    const row = await db.select().from(settings);
    expect(row.find((r) => r.key === 'swarm_enabled')?.value).toBe(false);
  });
});

describe('POST /v1/servers/:id/swarm/join and /leave', () => {
  beforeEach(() => {
    h.swarm = { LocalNodeState: 'active', ControlAvailable: true, NodeID: 'mgr1', NodeAddr: '10.0.0.1' };
  });

  it('join: reads the worker token locally, sends it sealed to swarm.join, records the node id; never logs, audits or returns it', async () => {
    const res = await (await app()).inject({ method: 'POST', url: `/servers/${serverId}/swarm/join`, headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ serverId, nodeId: 'wrk1', role: 'worker' });
    expect(h.agentOps.map((o) => o.op)).toEqual(['agent.ping', 'swarm.join', 'swarm.info']);
    expect(h.agentOps[1]!.params).toEqual({ token: TOKEN, managerAddr: '10.0.0.1:2377' });
    expect(await db.query.servers.findFirst()).toMatchObject({ swarmNodeId: 'wrk1', swarmRole: 'worker' });
    expect(h.audits).toEqual([{ action: 'server.swarm.join', entity: 'edge-1', meta: { serverId, nodeId: 'wrk1', managerAddr: '10.0.0.1:2377' } }]);
    expect(res.body).not.toContain('SWMTKN');
    expect(allText()).not.toContain('SWMTKN');
    // The encrypted-overlay probe ran before the token was read.
    const probeAt = h.docker.findIndex((a) => a[0] === 'network' && a[1] === 'create');
    expect(probeAt).toBeGreaterThanOrEqual(0);
    expect(probeAt).toBeLessThan(h.docker.findIndex((a) => a[1] === 'join-token'));
  });

  it('join refuses the unencrypted transport, a node already joined, and a panel that is not a manager — sending nothing', async () => {
    const a = await app();
    h.sealed = false;
    const unsealed = await a.inject({ method: 'POST', url: `/servers/${serverId}/swarm/join`, headers: asUser() });
    expect([unsealed.statusCode, unsealed.json().error.code]).toEqual([422, 'node_transport_unsealed']);
    h.sealed = true;
    h.swarm = { LocalNodeState: 'inactive' };
    expect((await a.inject({ method: 'POST', url: `/servers/${serverId}/swarm/join`, headers: asUser() })).json().error.code).toBe('swarm_not_manager');
    h.swarm = { LocalNodeState: 'active', ControlAvailable: true, NodeID: 'mgr1', NodeAddr: '10.0.0.1' };
    await db.update(servers).set({ swarmNodeId: 'wrk1' });
    expect((await a.inject({ method: 'POST', url: `/servers/${serverId}/swarm/join`, headers: asUser() })).json().error.code).toBe('swarm_already_joined');
    expect(h.agentOps.filter((o) => o.op.startsWith('swarm.'))).toEqual([]);
    expect(h.docker.filter((x) => x[1] === 'join-token')).toEqual([]);
    expect((await a.inject({ method: 'POST', url: '/servers/999/swarm/join', headers: asUser() })).statusCode).toBe(404);
  });

  it('join is refused before the token is read when the swarm cannot create an encrypted overlay', async () => {
    h.failing = ['network create'];
    const res = await (await app()).inject({ method: 'POST', url: `/servers/${serverId}/swarm/join`, headers: asUser() });
    expect([res.statusCode, res.json().error.code]).toEqual([502, 'swarm_overlay_unavailable']);
    expect(res.json().error.message).toMatch(/"edge-1" was not joined.*encrypted overlay/);
    expect(h.docker.filter((x) => x[1] === 'join-token')).toEqual([]);
    expect(h.agentOps.map((o) => o.op)).toEqual(['agent.ping']);
  });

  it('a node owner who switched Swarm off gets 403 node_feature_disabled, nothing sent', async () => {
    h.ping = pingLine('0.15.4', [...CAPS_015_LIST, 'stream', 'image.manage']);
    const res = await (await app()).inject({ method: 'POST', url: `/servers/${serverId}/swarm/join`, headers: asUser() });
    expect([res.statusCode, res.json().error.code]).toEqual([403, 'node_feature_disabled']);
    expect(h.agentOps.map((o) => o.op)).toEqual(['agent.ping']);
  });

  it('leave: drains first, waits for the tasks to move, leaves on the node, removes the node, clears the row; audited', async () => {
    await db.update(servers).set({ swarmNodeId: 'wrk1', swarmRole: 'worker' });
    h.nodePs = ['task1\ntask2', 'task2', ''];
    const res = await (await app()).inject({ method: 'POST', url: `/servers/${serverId}/swarm/leave`, headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ serverId, nodeId: 'wrk1', drained: true });
    const order = h.docker
      .filter((a) => a[0] === 'node')
      .map((a) => a.slice(0, 2).join(' '));
    expect(order).toEqual(['node update', 'node ps', 'node ps', 'node ps', 'node inspect', 'node rm']);
    expect(h.docker).toContainEqual(['node', 'update', '--availability', 'drain', 'wrk1']);
    expect(h.docker).toContainEqual(['node', 'rm', 'wrk1']);
    expect(h.agentOps.map((o) => o.op)).toEqual(['agent.ping', 'swarm.leave']);
    expect(await db.query.servers.findFirst()).toMatchObject({ swarmNodeId: null, swarmRole: null });
    expect(h.audits).toEqual([{ action: 'server.swarm.leave', entity: 'edge-1', meta: { serverId, nodeId: 'wrk1', drained: true } }]);
  });

  it('leave refuses a node that never joined, and an older agent before draining anything', async () => {
    const a = await app();
    expect((await a.inject({ method: 'POST', url: `/servers/${serverId}/swarm/leave`, headers: asUser() })).json().error.code).toBe('swarm_not_joined');
    await db.update(servers).set({ swarmNodeId: 'wrk1' });
    h.ping = pingLine('0.15.3', [...CAPS_015_LIST, 'stream', 'image.manage', 'db.manage']);
    const old = await a.inject({ method: 'POST', url: `/servers/${serverId}/swarm/leave`, headers: asUser() });
    expect([old.statusCode, old.json().error.code]).toEqual([422, 'node_agent_outdated']);
    expect(old.json().error.message).toMatch(/cannot leave the Swarm\. Update the node agent to v0\.15\.4/);
    expect(h.docker.filter((x) => x[0] === 'node')).toEqual([]);
  });
});

describe('PUT /v1/services/:id/placement orchestrator, GET /v1/services/:id/swarm (design §7.5)', () => {
  async function placementApp() {
    const { servicePlacementRoutes } = await import('../src/modules/servicePlacement.js');
    const { services } = await import('@ninedeploy/db');
    const a = await buildTestApp({ db });
    await a.register(servicePlacementRoutes, { prefix: '/services' });
    const [svc] = await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker', image: 'nginx:1.27', ownerUserId: 1 } as never).returning();
    return { a, svc: svc! };
  }

  it('switching to Swarm needs Swarm enabled and a service Swarm can run; switching back is always allowed; audited', async () => {
    const { a, svc } = await placementApp();
    const put = (payload: unknown) => a.inject({ method: 'PUT', url: `/services/${svc.id}/placement`, headers: asUser(), payload: payload as never });
    const disabled = await put({ orchestrator: 'swarm' });
    expect([disabled.statusCode, disabled.json().error.code]).toEqual([422, 'swarm_disabled']);
    await db.insert(settings).values({ key: 'swarm_enabled', value: true });
    const ok = await put({ orchestrator: 'swarm' });
    expect([ok.statusCode, ok.json().orchestrator]).toEqual([200, 'swarm']);
    expect(h.audits.at(-1)).toMatchObject({ action: 'service.placement.update' });
    const back = await put({ orchestrator: null });
    expect([back.statusCode, back.json().orchestrator]).toEqual([200, null]);
    const { services } = await import('@ninedeploy/db');
    const { eq } = await import('drizzle-orm');
    await db.update(services).set({ volumeMount: '/data' }).where(eq(services.id, svc.id));
    const volume = await put({ orchestrator: 'swarm' });
    expect([volume.statusCode, volume.json().error.code]).toEqual([422, 'swarm_unsupported']);
    expect(volume.json().error.message).toMatch(/persistent volume/);
    // Nothing was deployed by any of it.
    expect(h.docker.filter((x) => x[0] === 'stack' || x[0] === 'service')).toEqual([]);
  });

  it('GET /v1/services/:id/swarm answers stack null for a service not on Swarm, without asking Docker', async () => {
    const { a, svc } = await placementApp();
    const res = await a.inject({ method: 'GET', url: `/services/${svc.id}/swarm`, headers: asUser() });
    expect(res.json()).toEqual({ stack: null, desired: 0, running: 0, tasks: [] });
    expect(h.docker).toEqual([]);
  });
});
