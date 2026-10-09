import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, runMigrations, servers, settings, users } from '@ninedeploy/db';
import { MULTI_NODE_CAPABILITIES } from '@ninedeploy/schemas';

/**
 * Multi-node T7, Swarm cluster management (design §7.2, §7.5, §7.6; security
 * review M1–M3): `GET /v1/swarm`, `POST /v1/swarm/init` (operator,
 * interactive, step-up; the management port bound to a local advertise
 * address; the panel's node labelled a member), `PUT /v1/swarm/settings`,
 * `POST /v1/servers/:id/swarm/join|leave` (the node's agent, sealed,
 * capability `swarm`, opt-in on the node; the reported node verified on the
 * manager before it is linked and labelled; the join token rotated after
 * every join and leave). Docker and the agent are mocked; nothing runs.
 */

const TOKEN = `SWMTKN-1-${'c3'.repeat(25)}-${'d4'.repeat(12)}q`;
const PASSWORD = 'correct horse battery';
const MGR = 'mgr0000000000000000000001';
const WRK = 'wrk0000000000000000000001';

const h = vi.hoisted(() => ({
  swarm: { LocalNodeState: 'inactive', ControlAvailable: false, NodeID: '', NodeAddr: '' } as Record<string, unknown>,
  /** What the manager knows: node id → `docker node inspect` JSON. */
  nodes: new Map<string, Record<string, unknown>>(),
  /** The NodeID the node's agent reports in `swarm.info`. */
  reported: '',
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
      h.swarm = { LocalNodeState: 'active', ControlAvailable: true, NodeID: MGR, NodeAddr: args[3] };
      return `Swarm initialized: current node (${MGR}) is now a manager.\n\n    docker swarm join --token ${TOKEN} ${args[3]}:2377\n`;
    }
    if (args[0] === 'swarm' && args[1] === 'join-token') return `${TOKEN}\n`;
    if (args[0] === 'node' && args[1] === 'ls') return `{"ID":"${MGR}","Hostname":"panel","ManagerStatus":"Leader","Availability":"Active","Status":"Ready"}`;
    if (args[0] === 'node' && args[1] === 'ps') return h.nodePs.shift() ?? '';
    if (args[0] === 'node' && args[1] === 'inspect') {
      if (args.includes('{{json .}}')) {
        const n = h.nodes.get(args.at(-1)!);
        if (!n) throw new Error('Error: No such node');
        return JSON.stringify(n);
      }
      return 'down';
    }
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
      sink(`{"LocalNodeState":"active","NodeID":"${h.reported}","ControlAvailable":false}`);
      return { exitCode: 0, lines: [] };
    }
    if (op === 'swarm.join' && fails(['swarm.join'])) throw new Error(`agent swarm.join failed (500): invalid token ${TOKEN}`);
    return { exitCode: 0, lines: [] };
  },
}));
vi.mock('../src/lib/audit.js', () => ({
  audit: vi.fn(async (_db: unknown, _uid: unknown, action: string, entity: string, meta: unknown) => {
    h.audits.push({ action, entity, meta });
  }),
}));

const { serverSwarmRoutes, swarmRoutes } = await import('../src/modules/swarm.js');
const swarmLib = await import('../src/lib/swarm.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { encrypt } = await import('../src/lib/crypto.js');
const caps = await import('../src/lib/agentCapabilities.js');
const { asUser, buildTestApp } = await import('./helpers.js');

const CAPS_015_LIST = ['build-path-guard', 'workspace.remove', 'git.credential', 'terminal', 'terminal.host'];
const pingLine = (version: string, list: string[]) => `ND-AGENT ${JSON.stringify({ version, caps: list })}`;
const worker = (id: string, addr: string, role = 'worker') => ({ ID: id, Spec: { Role: role, Labels: {} }, Status: { Addr: addr } });

let db: DB;
let serverId: number;

beforeEach(async () => {
  h.swarm = { LocalNodeState: 'inactive', ControlAvailable: false, NodeID: '', NodeAddr: '' };
  h.nodes = new Map([[WRK, worker(WRK, '10.0.0.5')]]);
  h.reported = WRK;
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
/** Everything but the token read itself: never a token anywhere. */
const allText = () => JSON.stringify({ docker: h.docker.filter((a) => !(a[0] === 'swarm' && a[1] === 'join-token')), audits: h.audits });
const nodeCmds = () => h.docker.filter((a) => a[0] === 'node' && a[1] !== 'ls').map((a) => a.join(' '));

describe('GET /v1/swarm', () => {
  it('reports the disabled default, the daemon state and no nodes off a manager; never a token', async () => {
    const a = await app();
    const res = await a.inject({ method: 'GET', url: '/swarm', headers: asUser() });
    expect(res.json()).toEqual({ enabled: false, localState: 'inactive', controlAvailable: false, managerAddr: null, nodes: [] });
    h.failing = ['info'];
    expect((await a.inject({ method: 'GET', url: '/swarm', headers: asUser() })).json()).toMatchObject({ localState: 'unreachable' });
  });

  it('on a manager: the nodes, linked to their NineDeploy server, and the address nodes join', async () => {
    h.swarm = { LocalNodeState: 'active', ControlAvailable: true, NodeID: MGR, NodeAddr: '10.0.0.1' };
    await db.update(servers).set({ swarmNodeId: MGR, swarmRole: 'worker' });
    const res = (await (await app()).inject({ method: 'GET', url: '/swarm', headers: asUser() })).json();
    expect(res.managerAddr).toBe('10.0.0.1:2377');
    expect(res.nodes).toEqual([{ id: MGR, hostname: 'panel', role: 'manager', availability: 'active', state: 'ready', serverId }]);
    expect(JSON.stringify(res)).not.toContain('SWMTKN');
  });

  it('is operator only', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/swarm', headers: asUser({ isOperator: false }) });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /v1/swarm/init (operator + interactive + step-up)', () => {
  it('initialises, labels the panel node a member, probes an encrypted overlay, audits; the join token never leaves', async () => {
    const res = await (await app()).inject({ method: 'POST', url: '/swarm/init', headers: asUser(), payload: { advertiseAddr: '10.0.0.1', password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ localState: 'active', controlAvailable: true, managerAddr: '10.0.0.1:2377' });
    expect(h.docker).toContainEqual(['node', 'update', '--label-add', 'nd.member=1', '--', MGR]);
    const probe = h.docker.find((a) => a[0] === 'network' && a[1] === 'create');
    expect(probe).toEqual(['network', 'create', '--driver', 'overlay', '--opt', 'encrypted', '--attachable', expect.stringMatching(/^nd-swarm-probe-[0-9a-f]{8}$/)]);
    expect(h.docker).toContainEqual(['network', 'rm', probe!.at(-1)]);
    expect(h.audits).toEqual([{ action: 'swarm.init', entity: '10.0.0.1', meta: { advertiseAddr: '10.0.0.1', listenAddr: null } }]);
    expect(res.body).not.toContain('SWMTKN');
    expect(JSON.stringify(h.audits)).not.toContain('SWMTKN');
    expect((await db.query.settings.findFirst({ where: (s, { eq }) => eq(s.key, 'swarm_advertise_addr') }))?.value).toBe('10.0.0.1');
    expect(await db.query.settings.findFirst({ where: (s, { eq }) => eq(s.key, 'swarm_enabled') })).toBeUndefined();
  });

  it('M1b: an address the panel cannot see as its own keeps the default bind, with a firewall warning', async () => {
    const res = await (await app()).inject({ method: 'POST', url: '/swarm/init', headers: asUser(), payload: { advertiseAddr: '10.0.0.1', password: PASSWORD } });
    expect(h.docker).toContainEqual(['swarm', 'init', '--advertise-addr', '10.0.0.1']);
    expect(res.json().warnings).toEqual([expect.stringMatching(/2377\/tcp listens on every interface\. Firewall 2377\/tcp/)]);
  });

  it('M1b: a local interface address binds the management port there only (--listen-addr)', async () => {
    const res = await (await app()).inject({ method: 'POST', url: '/swarm/init', headers: asUser(), payload: { advertiseAddr: '127.0.0.1', password: PASSWORD } });
    expect(h.docker).toContainEqual(['swarm', 'init', '--advertise-addr', '127.0.0.1', '--listen-addr', '127.0.0.1:2377']);
    expect(res.json().warnings).toBeUndefined();
    expect(h.audits[0]!.meta).toEqual({ advertiseAddr: '127.0.0.1', listenAddr: '127.0.0.1:2377' });
    expect(swarmLib.isLocalInterfaceAddr('10.1.2.3', { eth0: [{ address: '10.1.2.3' } as never] })).toBe(true);
    expect(swarmLib.isLocalInterfaceAddr('10.1.2.4', { eth0: [{ address: '10.1.2.3' } as never] })).toBe(false);
  });

  it('refuses a daemon already in a swarm (409 with the state), and touches nothing', async () => {
    h.swarm = { LocalNodeState: 'active', ControlAvailable: true, NodeID: 'x' };
    const res = await (await app()).inject({ method: 'POST', url: '/swarm/init', headers: asUser(), payload: { advertiseAddr: '10.0.0.1', password: PASSWORD } });
    expect([res.statusCode, res.json().error.code]).toEqual([409, 'swarm_already_active']);
    expect(h.docker.filter((a) => a[0] === 'swarm')).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('needs the password (step-up) and an interactive session (never an API token)', async () => {
    const a = await app();
    const wrong = await a.inject({ method: 'POST', url: '/swarm/init', headers: asUser(), payload: { advertiseAddr: '10.0.0.1', password: 'nope' } });
    expect([wrong.statusCode, wrong.json().error.code]).toEqual([403, 'invalid_password']);
    const none = await a.inject({ method: 'POST', url: '/swarm/init', headers: asUser(), payload: { advertiseAddr: '10.0.0.1' } });
    expect([none.statusCode, none.json().error.code]).toEqual([403, 'reauth_required']);
    const token = await a.inject({ method: 'POST', url: '/swarm/init', headers: { ...asUser(), 'x-test-token-scopes': 'operator' }, payload: { advertiseAddr: '10.0.0.1', password: PASSWORD } });
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
    h.swarm = { LocalNodeState: 'active', ControlAvailable: true, NodeID: MGR, NodeAddr: '10.0.0.1' };
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
    h.swarm = { LocalNodeState: 'active', ControlAvailable: true, NodeID: MGR, NodeAddr: '10.0.0.1' };
  });
  const join = async () => (await app()).inject({ method: 'POST', url: `/servers/${serverId}/swarm/join`, headers: asUser() });

  it('join: token read locally, sent sealed, rotated after; the node verified on the manager, then linked and labelled a member', async () => {
    const res = await join();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ serverId, nodeId: WRK, role: 'worker' });
    expect(h.agentOps.map((o) => o.op)).toEqual(['agent.ping', 'swarm.join', 'swarm.info']);
    expect(h.agentOps[1]!.params).toEqual({ token: TOKEN, managerAddr: '10.0.0.1:2377' });
    // M1a: rotated right after the join.
    const tokenCalls = h.docker.filter((a) => a[1] === 'join-token').map((a) => a.join(' '));
    expect(tokenCalls).toEqual(['swarm join-token -q worker', 'swarm join-token --rotate -q worker']);
    // M3: confirmed on the manager (`--` before the id), then M1c: the member label.
    expect(nodeCmds()).toEqual([`node inspect --format {{json .}} -- ${WRK}`, `node update --label-add nd.member=1 -- ${WRK}`]);
    expect(await db.query.servers.findFirst()).toMatchObject({ swarmNodeId: WRK, swarmRole: 'worker' });
    expect(h.audits).toEqual([
      { action: 'server.swarm.join', entity: 'edge-1', meta: { serverId, nodeId: WRK, managerAddr: '10.0.0.1:2377', tokenRotated: true, memberLabel: true } },
    ]);
    expect(res.body).not.toContain('SWMTKN');
    expect(allText()).not.toContain('SWMTKN');
  });

  it('M1a: a failed join still rotates the token; a failed rotation is audited and returned as a warning', async () => {
    h.failing = ['swarm.join'];
    const failed = await join();
    expect([failed.statusCode, failed.json().error.code]).toEqual([502, 'node_swarm_failed']);
    expect(failed.json().error.message).not.toContain(TOKEN);
    expect(h.docker.some((a) => a.includes('--rotate'))).toBe(true);
    h.failing = ['swarm join-token --rotate'];
    h.docker = [];
    caps.resetNodeCapabilityCache();
    const res = await join();
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings).toEqual([expect.stringMatching(/could not be rotated.*docker swarm join-token --rotate worker/)]);
    expect(h.audits.map((a) => a.action)).toContain('alert.swarm_token_rotation_failed');
  });

  it('M3: a reported id the manager cannot confirm is never linked or labelled', async () => {
    const cases: Array<[() => void, RegExp]> = [
      [() => (h.reported = 'not-a-node-id'), /malformed swarm node id/],
      [() => (h.reported = MGR), /panel host's own swarm node id/],
      [() => (h.reported = 'zzz0000000000000000000009'), /manager does not know swarm node/],
      [() => h.nodes.set(WRK, worker(WRK, '10.0.0.5', 'manager')), /is a manager, not a worker/],
      [() => h.nodes.set(WRK, worker(WRK, '203.0.113.9')), /reaches the manager from 203\.0\.113\.9, not from the server's host 10\.0\.0\.5/],
    ];
    for (const [setup, why] of cases) {
      h.nodes = new Map([[WRK, worker(WRK, '10.0.0.5')]]);
      h.reported = WRK;
      h.docker = [];
      h.audits = [];
      caps.resetNodeCapabilityCache();
      setup();
      const res = await join();
      expect([res.statusCode, res.json().error.code], String(why)).toEqual([502, 'swarm_node_unverified']);
      expect(res.json().error.message).toMatch(why);
      expect(h.docker.filter((a) => a[1] === 'update'), String(why)).toEqual([]);
      expect(await db.query.servers.findFirst()).toMatchObject({ swarmNodeId: null });
      expect(h.audits.map((a) => a.action)).toEqual(['server.swarm.join_refused']);
    }
  });

  it('M3: a swarm node id already linked to another server is refused (enforced in code, no index)', async () => {
    await db.insert(servers).values({ name: 'other', host: '10.0.0.6', port: 4600, tokenEncrypted: encrypt('t'), status: 'online', swarmNodeId: WRK });
    const res = await join();
    expect(res.json().error).toMatchObject({ code: 'swarm_node_unverified', message: expect.stringMatching(/already linked to server "other"/) });
    expect((await db.query.servers.findFirst({ where: (s, { eq }) => eq(s.id, serverId) }))!.swarmNodeId).toBeNull();
    expect(await swarmLib.swarmNodeLinkedElsewhere(db, WRK, serverId)).toMatchObject({ name: 'other' });
    expect(await swarmLib.swarmNodeLinkedElsewhere(db, WRK, -1)).not.toBeNull();
  });

  it('M3: a hostname host matches when it resolves to the address the manager sees', async () => {
    h.swarm = { LocalNodeState: 'active', ControlAvailable: true, NodeID: MGR };
    const resolve = vi.fn(async () => ['10.0.0.5']);
    expect(await swarmLib.joinedNodeRefusal(db, { id: serverId, host: 'edge.example.com' }, WRK, { resolve })).toBeNull();
    expect(resolve).toHaveBeenCalledWith('edge.example.com');
    expect(await swarmLib.joinedNodeRefusal(db, { id: serverId, host: 'edge.example.com' }, WRK, { resolve: async () => ['10.9.9.9'] })).toMatch(/not from the server's host/);
  });

  it('join refuses the unencrypted transport, a node already joined, and a panel that is not a manager — sending nothing', async () => {
    const a = await app();
    h.sealed = false;
    const unsealed = await a.inject({ method: 'POST', url: `/servers/${serverId}/swarm/join`, headers: asUser() });
    expect([unsealed.statusCode, unsealed.json().error.code]).toEqual([422, 'node_transport_unsealed']);
    h.sealed = true;
    h.swarm = { LocalNodeState: 'inactive' };
    expect((await a.inject({ method: 'POST', url: `/servers/${serverId}/swarm/join`, headers: asUser() })).json().error.code).toBe('swarm_not_manager');
    h.swarm = { LocalNodeState: 'active', ControlAvailable: true, NodeID: MGR, NodeAddr: '10.0.0.1' };
    await db.update(servers).set({ swarmNodeId: WRK });
    expect((await a.inject({ method: 'POST', url: `/servers/${serverId}/swarm/join`, headers: asUser() })).json().error.code).toBe('swarm_already_joined');
    expect(h.agentOps.filter((o) => o.op.startsWith('swarm.'))).toEqual([]);
    expect(h.docker.filter((x) => x[1] === 'join-token')).toEqual([]);
    expect((await a.inject({ method: 'POST', url: '/servers/999/swarm/join', headers: asUser() })).statusCode).toBe(404);
  });

  it('join is refused before the token is read when the swarm cannot create an encrypted overlay', async () => {
    h.failing = ['network create'];
    const res = await join();
    expect([res.statusCode, res.json().error.code]).toEqual([502, 'swarm_overlay_unavailable']);
    expect(res.json().error.message).toMatch(/"edge-1" was not joined.*encrypted overlay/);
    expect(h.docker.filter((x) => x[1] === 'join-token')).toEqual([]);
    expect(h.agentOps.map((o) => o.op)).toEqual(['agent.ping']);
  });

  it('M2: a current agent whose owner has not opted in gets 422 naming the variable and the value to set', async () => {
    await db.insert(settings).values({ key: 'swarm_advertise_addr', value: '10.0.0.1' });
    h.ping = pingLine('0.15.4', [...CAPS_015_LIST, 'stream', 'image.manage', 'db.manage']);
    const res = await join();
    expect([res.statusCode, res.json().error.code]).toEqual([422, 'node_swarm_not_enabled']);
    expect(res.json().error.message).toMatch(/Set NINEDEPLOY_AGENT_SWARM_MANAGER=10\.0\.0\.1:2377 in the agent's environment/);
    expect(h.agentOps.map((o) => o.op)).toEqual(['agent.ping']);
  });

  it('leave: the member label goes first, then drain, the tasks move, the node leaves and is removed; the token rotates; audited', async () => {
    await db.update(servers).set({ swarmNodeId: WRK, swarmRole: 'worker' });
    h.nodePs = ['task1\ntask2', 'task2', ''];
    const res = await (await app()).inject({ method: 'POST', url: `/servers/${serverId}/swarm/leave`, headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ serverId, nodeId: WRK, drained: true });
    expect(nodeCmds()).toEqual([
      `node update --label-rm nd.member -- ${WRK}`,
      `node update --availability drain -- ${WRK}`,
      `node ps --filter desired-state=running -q -- ${WRK}`,
      `node ps --filter desired-state=running -q -- ${WRK}`,
      `node ps --filter desired-state=running -q -- ${WRK}`,
      `node inspect --format {{.Status.State}} -- ${WRK}`,
      `node rm -- ${WRK}`,
    ]);
    expect(h.agentOps.map((o) => o.op)).toEqual(['agent.ping', 'swarm.leave']);
    expect(h.docker).toContainEqual(['swarm', 'join-token', '--rotate', '-q', 'worker']);
    expect(await db.query.servers.findFirst()).toMatchObject({ swarmNodeId: null, swarmRole: null });
    expect(h.audits).toEqual([{ action: 'server.swarm.leave', entity: 'edge-1', meta: { serverId, nodeId: WRK, drained: true, tokenRotated: true } }]);
  });

  it('leave refuses a node that never joined, and an older agent before touching anything', async () => {
    const a = await app();
    expect((await a.inject({ method: 'POST', url: `/servers/${serverId}/swarm/leave`, headers: asUser() })).json().error.code).toBe('swarm_not_joined');
    await db.update(servers).set({ swarmNodeId: WRK });
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
    expect(h.docker.filter((x) => x[0] === 'stack' || x[0] === 'service')).toEqual([]);
  });

  it('GET /v1/services/:id/swarm answers stack null for a service not on Swarm, without asking Docker', async () => {
    const { a, svc } = await placementApp();
    const res = await a.inject({ method: 'GET', url: `/services/${svc.id}/swarm`, headers: asUser() });
    expect(res.json()).toEqual({ stack: null, desired: 0, running: 0, tasks: [] });
    expect(h.docker).toEqual([]);
  });
});
