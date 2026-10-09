/**
 * 0.15 (T2b): node terminals, panel side (DESIGN §1.5, §1.6) against a real
 * migrated SQLite.
 *
 * - `POST /v1/terminals` for a service on a node (primary or fan-out) and a
 *   node host: the capability gate (`terminalRefusal`), the 422 "update the
 *   agent" refusal for older agents, the node owner's host switch, a stopped
 *   container, an unreachable node.
 * - End to end with only Docker faked: the panel's attach socket → the REAL
 *   sealed `agentOp` → a REAL agent (`agentRoutes`) on 127.0.0.1 → the
 *   encrypted channel → a fake TTY. Terminate, shell exit and a dropped
 *   browser all reach the node's process.
 * - `GET /v1/servers` gains the `terminal` capability field, cached 5 minutes.
 */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLog, createDb, type DB, servers, serviceTargets, services, sessions, settings, terminalSessions, users } from '@ninedeploy/db';
import { TERMINAL_CLOSE } from '@ninedeploy/schemas';

const fakes = vi.hoisted(() => {
  const make = () => {
    const dataCbs: Array<(c: Buffer) => void> = [];
    const endCbs: Array<(c: number | null) => void> = [];
    const early: Buffer[] = [];
    const t = {
      mode: 'exec' as const,
      written: [] as string[],
      resizes: [] as Array<[number, number]>,
      killed: 0,
      write: (b: Buffer) => void t.written.push(b.toString()),
      resize: (c: number, r: number) => void t.resizes.push([c, r]),
      pause: () => undefined,
      resume: () => undefined,
      kill: async () => {
        t.killed++;
      },
      onData: (cb: (c: Buffer) => void) => {
        dataCbs.push(cb);
        if (early.length) cb(Buffer.concat(early.splice(0)));
      },
      onEnd: (cb: (c: number | null) => void) => void endCbs.push(cb),
      emit: (s: string) => {
        if (dataCbs.length === 0) early.push(Buffer.from(s));
        for (const cb of dataCbs) cb(Buffer.from(s));
      },
      exit: (code: number | null) => {
        for (const cb of endCbs.splice(0)) cb(code);
      },
    };
    return t;
  };
  return { make, ttys: [] as Array<ReturnType<typeof make>>, openExec: vi.fn(), openHost: vi.fn() };
});
vi.mock('../src/lib/notifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/notifier.js')>()),
  notifyEvent: async () => undefined,
}));
vi.mock('../src/lib/dockerTty.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/dockerTty.js')>()),
  dockerTransport: () => ({ kind: 'socket', socketPath: '/var/run/docker.sock' }),
  inspectContainer: async () => ({ id: 'c', running: true, hostname: null, labels: {} }),
  probeHostShellImage: async () => ({ ok: true }),
  openExecTty: (...a: unknown[]) => fakes.openExec(...a),
  openHostShellTty: (...a: unknown[]) => fakes.openHost(...a),
  listContainersWithLabel: async () => [],
  forceRemoveContainer: async () => undefined,
}));
// The agent's child processes (docker inspect for the running check).
const spawnMock = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => 0));
vi.mock('../src/lib/spawnValidated.js', () => ({ spawnValidated: spawnMock }));
// Per test: either a scripted agent (h.agentOp / h.sealed) or the REAL client.
const h = vi.hoisted(() => ({
  agentOp: null as null | ((...a: unknown[]) => Promise<{ exitCode: number; lines: string[] }>),
  sealed: null as null | boolean,
  ops: [] as string[],
}));
vi.mock('../src/lib/agentClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/agentClient.js')>();
  return {
    ...actual,
    agentOp: (...a: unknown[]) => {
      h.ops.push(String(a[2]));
      return h.agentOp ? h.agentOp(...a) : (actual.agentOp as (...x: unknown[]) => Promise<never>)(...a);
    },
    agentTransportSealed: (...a: unknown[]) =>
      h.sealed !== null ? Promise.resolve(h.sealed) : (actual.agentTransportSealed as (...x: unknown[]) => Promise<boolean>)(...a),
  };
});

const { terminalRoutes } = await import('../src/modules/terminals.js');
const { serverRoutes } = await import('../src/modules/servers.js');
const S = await import('../src/lib/terminalSessions.js');
const agent = await import('../src/agent.js');
const caps = await import('../src/lib/agentCapabilities.js');
const { _resetSealedSupportCache } = await import('../src/lib/agentClient.js');
const { encrypt, hashPassword } = await import('../src/lib/crypto.js');
const { signAccessToken } = await import('../src/lib/jwt.js');
const { asUser, buildTestApp, listen } = await import('./helpers.js');

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const PASSWORD = 'correct horse battery';
const TOKEN = 'node-agent-raw-token-0123456789abcdef';
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');
const CAPS_015 = 'ND-AGENT {"version":"0.15.0","caps":["build-path-guard","workspace.remove","git.credential","terminal","terminal.host"]}';
const CAPS_015_NOHOST = 'ND-AGENT {"version":"0.15.0","caps":["build-path-guard","workspace.remove","git.credential","terminal"]}';
const CAPS_014 = 'ND-AGENT {"version":"0.14.0","caps":["build-path-guard","workspace.remove","git.credential"]}';

let db: DB;
let close: () => void;
let panelPort: number;
let agentApp: Awaited<ReturnType<typeof buildTestApp>>;
let panelApp: Awaited<ReturnType<typeof buildTestApp>>;
let bearer: string;
let ids: { server: number; nodeSvc: number; fanout: number };
const sockets: WebSocket[] = [];

/** A scripted agent: ping answers `pingLine`; docker.inspect answers `state`. */
function scripted(pingLine: string, state = 'running|10.0.0.2') {
  h.agentOp = async (...a: unknown[]) => {
    const op = a[2] as string;
    if (op === 'agent.ping') return { exitCode: 0, lines: [pingLine] };
    if (op === 'docker.inspect') return state === 'missing' ? { exitCode: 1, lines: ['Error: No such object'] } : { exitCode: 0, lines: [state] };
    throw new Error(`unexpected op ${op}`);
  };
}

beforeEach(async () => {
  const created = createDb({ url: ':memory:' });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: await hashPassword(PASSWORD), isInstanceOperator: true });
  await db.insert(sessions).values({ userId: 1, jti: 'jti-op', expiresAt: new Date(Date.now() + 3_600_000) });
  bearer = await signAccessToken(1, 0, 'jti-op');

  fakes.ttys.length = 0;
  fakes.openExec.mockReset().mockImplementation(async () => {
    const t = fakes.make();
    fakes.ttys.push(t);
    return t;
  });
  fakes.openHost.mockReset().mockImplementation(async () => {
    const t = fakes.make();
    fakes.ttys.push(t);
    return t;
  });
  spawnMock.mockReset().mockImplementation(async (_e: unknown, argv: unknown, onLine: unknown) => {
    if ((argv as string[])[0] === 'inspect') (onLine as (l: string) => void)('running|10.0.0.2');
    return 0;
  });
  delete process.env['NINEDEPLOY_HOST_TERMINAL'];
  delete process.env['NINEDEPLOY_AGENT_HOST_TERMINAL'];
  h.agentOp = null;
  h.sealed = null;
  h.ops.length = 0;
  S.resetTerminalRegistry();
  agent._resetAgentTerminals();
  caps.resetNodeCapabilityCache();
  _resetSealedSupportCache();

  agentApp = await buildTestApp();
  await agentApp.register(agent.agentRoutes, { tokenHash: TOKEN_HASH });
  const agentPort = await listen(agentApp);

  const [server] = await db
    .insert(servers)
    .values({ name: 'edge-1', host: '127.0.0.1', port: agentPort, tokenEncrypted: encrypt(TOKEN), status: 'online', lastSeenAt: new Date() })
    .returning();
  const [nodeSvc] = await db.insert(services).values({ name: 'remote', slug: 'remote', type: 'docker', runtimeId: 'remote-12', serverId: server!.id }).returning();
  const [fan] = await db.insert(services).values({ name: 'fan', slug: 'fan', type: 'docker', runtimeId: 'fan-local' }).returning();
  await db.insert(serviceTargets).values({ serviceId: fan!.id, serverId: server!.id, runtimeId: 'fan-t1-5', status: 'running' });
  ids = { server: server!.id, nodeSvc: nodeSvc!.id, fanout: fan!.id };

  panelApp = await buildTestApp({ websocket: true, db });
  await panelApp.register(terminalRoutes, { prefix: '/v1/terminals' });
  await panelApp.register(serverRoutes, { prefix: '/v1/servers' });
  panelPort = await listen(panelApp);
});

const settle = () => new Promise((r) => setTimeout(r, 30));

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await vi.waitFor(() => expect(S.liveTerminalCount()).toBe(0));
  await settle();
  await panelApp.close();
  await agentApp.close();
  agent._resetAgentTerminals();
  delete process.env['NINEDEPLOY_HOST_TERMINAL'];
  close();
});

const headers = () => ({ ...asUser({ id: 1, isOperator: true }), authorization: `Bearer ${bearer}` });

async function create(target: unknown, extra: Record<string, unknown> = {}) {
  const res = await fetch(`http://127.0.0.1:${panelPort}/v1/terminals`, {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({ target, ...extra }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

function attach(s: { attachPath: string; ticket: string }) {
  const ws = new WebSocket(`ws://127.0.0.1:${panelPort}${s.attachPath}`, ['ninedeploy.terminal.v1', `ninedeploy.ticket.${s.ticket}`]);
  ws.binaryType = 'arraybuffer';
  sockets.push(ws);
  const texts: Array<Record<string, unknown>> = [];
  const binary: string[] = [];
  ws.addEventListener('message', (ev) => {
    if (typeof ev.data === 'string') texts.push(JSON.parse(ev.data));
    else binary.push(Buffer.from(ev.data as ArrayBuffer).toString());
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.addEventListener('close', (ev) => resolve({ code: ev.code, reason: ev.reason })));
  return { ws, texts, binary, closed };
}

const waitFor = async (pred: () => boolean, ms = 4000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const row = async (id: number) => (await db.select().from(terminalSessions).where(eq(terminalSessions.id, id)))[0]!;
const actions = async () => (await db.select().from(auditLog)).map((r) => r.action);
const enableHost = () => db.insert(settings).values({ key: 'terminal_host_enabled', value: true });

describe('POST /v1/terminals: node targets', () => {
  it('a service on a node with a 0.15 agent → 201, the session names the node', async () => {
    scripted(CAPS_015);
    const res = await create({ kind: 'service', serviceId: ids.nodeSvc });
    expect(res.status).toBe(201);
    expect(res.body.session).toMatchObject({ targetKind: 'service', targetLabel: 'remote', serverId: ids.server, status: 'pending' });
    expect((await row(res.body.session.id)).containerName).toBe('remote-12');
    expect(h.ops).toEqual(['agent.ping', 'docker.inspect']);
    // A fan-out target resolves to that node's container.
    const fan = await create({ kind: 'service', serviceId: ids.fanout, serverId: ids.server });
    expect(fan.status).toBe(201);
    expect((await row(fan.body.session.id)).containerName).toBe('fan-t1-5');
  });

  it('a 0.15 panel with a 0.14 agent refuses cleanly: 422 with an update message, nothing opened or stored', async () => {
    scripted(CAPS_014);
    const res = await create({ kind: 'service', serviceId: ids.nodeSvc });
    expect([res.status, res.body.error.code]).toEqual([422, 'node_terminal_unsupported']);
    expect(res.body.error.message).toMatch(/"edge-1" \(#\d+\) \(version 0\.14\.0\) cannot open terminals\. Update the node agent to v0\.15\.0 or newer/);
    expect(h.ops).toEqual(['agent.ping']);
    expect(await db.select().from(terminalSessions)).toHaveLength(0);
    // A pre-0.10.42 agent answers the ping with no line at all.
    scripted('');
    expect((await create({ kind: 'service', serviceId: ids.nodeSvc })).body.error.message).toMatch(/an older release/);
  });

  it('a node reached only over the plaintext transport is refused before the agent is asked anything', async () => {
    h.sealed = false;
    scripted(CAPS_015);
    const res = await create({ kind: 'service', serviceId: ids.nodeSvc });
    expect([res.status, res.body.error.code]).toEqual([422, 'node_terminal_unsupported']);
    expect(res.body.error.message).toMatch(/unencrypted transport/);
    expect(h.ops).toEqual([]);
  });

  it('a stopped or missing container on the node is 409; an unreachable node is 502', async () => {
    scripted(CAPS_015, 'exited|');
    expect((await create({ kind: 'service', serviceId: ids.nodeSvc })).body.error.code).toBe('not_running');
    scripted(CAPS_015, 'missing');
    const missing = await create({ kind: 'service', serviceId: ids.nodeSvc });
    expect([missing.status, missing.body.error.message]).toEqual([409, expect.stringMatching(/does not exist on node "edge-1"/)]);
    h.agentOp = async () => {
      throw new Error('fetch failed');
    };
    const down = await create({ kind: 'service', serviceId: ids.nodeSvc });
    expect([down.status, down.body.error.code]).toEqual([502, 'node_unreachable']);
    expect(await db.select().from(terminalSessions)).toHaveLength(0);
  });

  it("a node host shell passes the panel's four gates first, then the node's capability and its owner's switch", async () => {
    scripted(CAPS_015);
    const host = { kind: 'host', serverId: ids.server };
    expect((await create(host, { password: PASSWORD })).body.error.code).toBe('host_terminal_disabled'); // panel setting off
    expect(h.ops).toEqual([]);
    await enableHost();
    expect((await create(host, { password: 'wrong' })).body.error.code).toBe('invalid_password');
    process.env['NINEDEPLOY_HOST_TERMINAL'] = 'off';
    expect((await create(host, { password: PASSWORD })).body.error.code).toBe('host_terminal_disabled');
    delete process.env['NINEDEPLOY_HOST_TERMINAL'];
    expect(h.ops).toEqual([]);

    const ok = await create(host, { password: PASSWORD });
    expect(ok.status).toBe(201);
    expect(ok.body.session).toMatchObject({ targetKind: 'host', targetLabel: 'node edge-1 host', serverId: ids.server });

    scripted(CAPS_015_NOHOST);
    const off = await create(host, { password: PASSWORD });
    expect([off.status, off.body.error.code]).toEqual([403, 'host_terminal_disabled']);
    expect(off.body.error.message).toMatch(/NINEDEPLOY_AGENT_HOST_TERMINAL=off/);
    scripted(CAPS_014);
    expect((await create(host, { password: PASSWORD })).body.error.code).toBe('node_terminal_unsupported');
    expect((await create({ kind: 'host', serverId: 9999 }, { password: PASSWORD })).status).toBe(404);
  });
});

describe('attach: end to end through the real agent', () => {
  it('ready → stdin/output → resize → terminate (4410); the node process is killed and the session recorded', async () => {
    const s = await create({ kind: 'service', serviceId: ids.nodeSvc });
    expect(s.status).toBe(201);
    const c = attach(s.body as { attachPath: string; ticket: string });
    await waitFor(() => c.texts.length > 0);
    expect(c.texts[0]).toEqual({ t: 'ready', sessionId: s.body.session.id, target: { kind: 'service', label: 'remote', serverId: ids.server } });
    expect(fakes.openExec).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ container: 'remote-12', cols: 120, rows: 32 }));
    const t = fakes.ttys[0]!;
    await waitFor(() => t.resizes.length === 1); // the channel's authenticating first frame
    c.ws.send(Buffer.from('uname -a\r'));
    await waitFor(() => t.written.length === 1);
    expect(t.written).toEqual(['uname -a\r']);
    t.emit('Linux edge-1\r\n');
    await waitFor(() => c.binary.join('') === 'Linux edge-1\r\n');
    c.ws.send(JSON.stringify({ t: 'resize', cols: 150, rows: 45 }));
    await waitFor(() => t.resizes.length === 2);
    expect(t.resizes[1]).toEqual([150, 45]);
    expect(S.liveTerminalCount()).toBe(1);

    const del = await fetch(`http://127.0.0.1:${panelPort}/v1/terminals/${s.body.session.id}`, { method: 'DELETE', headers: headers() });
    expect(await del.json()).toEqual({ ok: true, wasLive: true });
    expect((await c.closed).code).toBe(TERMINAL_CLOSE.terminated);
    await waitFor(() => t.killed === 1);
    await vi.waitFor(async () => expect((await row(s.body.session.id)).status).toBe('ended'));
    expect(await row(s.body.session.id)).toMatchObject({ endReason: 'terminated', serverId: ids.server, bytesIn: 9, bytesOut: 14, terminatedByUserId: 1 });
    await vi.waitFor(async () =>
      expect(await actions()).toEqual(expect.arrayContaining(['terminal.session.create', 'terminal.session.start', 'terminal.session.end', 'terminal.session.terminate'])),
    );
    const [start] = await db.select().from(auditLog).where(eq(auditLog.action, 'terminal.session.start'));
    expect(start!.meta).toMatchObject({ serverId: ids.server, targetKind: 'service' });
    expect(agent.terminalChannelCount()).toBe(0);
  });

  it('the shell exiting on the node ends the session with its exit code', async () => {
    const s = await create({ kind: 'service', serviceId: ids.nodeSvc });
    const c = attach(s.body as { attachPath: string; ticket: string });
    await waitFor(() => c.texts.length > 0);
    await waitFor(() => fakes.ttys[0]?.resizes.length === 1);
    fakes.ttys[0]!.exit(3);
    expect(await c.closed).toEqual({ code: 1000, reason: 'shell exited' });
    expect(c.texts.at(-1)).toEqual({ t: 'exit', code: 3, reason: 'shell_exited' });
    await vi.waitFor(async () => expect((await row(s.body.session.id)).endReason).toBe('shell_exited'));
    expect((await row(s.body.session.id)).exitCode).toBe(3);
  });

  it('the browser leaving closes the channel and the node kills its process', async () => {
    const s = await create({ kind: 'service', serviceId: ids.nodeSvc });
    const c = attach(s.body as { attachPath: string; ticket: string });
    await waitFor(() => c.texts.length > 0);
    await waitFor(() => fakes.ttys[0]?.resizes.length === 1);
    c.ws.close();
    await waitFor(() => fakes.ttys[0]!.killed === 1);
    await vi.waitFor(async () => expect((await row(s.body.session.id)).endReason).toBe('client_closed'));
    await waitFor(() => agent.terminalChannelCount() === 0);
  });

  it('a node host shell runs the helper on the node and reaches the security fan-out', async () => {
    await enableHost();
    const s = await create({ kind: 'host', serverId: ids.server }, { password: PASSWORD });
    expect(s.status).toBe(201);
    const c = attach(s.body as { attachPath: string; ticket: string });
    await waitFor(() => c.texts.length > 0);
    expect(c.texts[0]).toMatchObject({ t: 'ready', target: { kind: 'host', serverId: ids.server } });
    expect(fakes.openHost).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ image: 'traefik:v3.1', sessionId: s.body.session.id }));
    await vi.waitFor(async () => expect(await actions()).toContain('security.host_terminal'));
    c.ws.close();
    await waitFor(() => fakes.ttys[0]!.killed === 1);
  });

  it('the agent refusing at attach time (its switch flipped since create) closes 4502 and records the failure', async () => {
    await enableHost();
    const s = await create({ kind: 'host', serverId: ids.server }, { password: PASSWORD });
    process.env['NINEDEPLOY_AGENT_HOST_TERMINAL'] = 'off';
    try {
      const c = attach(s.body as { attachPath: string; ticket: string });
      expect((await c.closed).code).toBe(TERMINAL_CLOSE.targetUnreachable);
      expect(String(c.texts[0]?.['message'])).toMatch(/Host shells are disabled on this node/);
      await vi.waitFor(async () => expect((await row(s.body.session.id)).status).toBe('failed'));
      expect(fakes.openHost).not.toHaveBeenCalled();
    } finally {
      delete process.env['NINEDEPLOY_AGENT_HOST_TERMINAL'];
    }
  });
});

describe('terminalRefusal', () => {
  const ping = (line: string) => async () => ({ exitCode: 0, lines: [line] });
  it('names the node and what to do', async () => {
    expect(await caps.terminalRefusal(ping(CAPS_015), '"n" (#1)', true, { host: true })).toBeNull();
    expect(await caps.terminalRefusal(ping(CAPS_015_NOHOST), '"n" (#1)', true, { host: false })).toBeNull();
    expect(await caps.terminalRefusal(ping(CAPS_015), '"n" (#1)', false, { host: false })).toMatchObject({ status: 422, code: 'node_terminal_unsupported', message: expect.stringMatching(/unencrypted transport.*v0\.15\.0/) });
    expect(await caps.terminalRefusal(ping(CAPS_014), '"n" (#1)', true, { host: false })).toMatchObject({ status: 422, message: expect.stringMatching(/version 0\.14\.0/) });
    expect(await caps.terminalRefusal(ping(CAPS_015_NOHOST), '"n" (#1)', true, { host: true })).toMatchObject({ status: 403, code: 'host_terminal_disabled' });
    expect(
      await caps.terminalRefusal(
        async () => {
          throw new Error('boom');
        },
        '"n" (#1)',
        true,
        { host: false },
      ),
    ).toMatchObject({ status: 502, code: 'node_unreachable', message: expect.stringMatching(/boom/) });
  });
});

describe('GET /v1/servers: the terminal capability field', () => {
  it('reports what each node offers, from a sealed ping cached for 5 minutes', async () => {
    scripted(CAPS_015_NOHOST);
    const [old] = await db.insert(servers).values({ name: 'old', host: '10.9.9.9', port: 4600, tokenEncrypted: encrypt('t'), status: 'online', lastSeenAt: new Date() }).returning();
    const [off] = await db.insert(servers).values({ name: 'off', host: '10.9.9.8', port: 4600, tokenEncrypted: encrypt('t'), status: 'offline' }).returning();
    h.agentOp = async (...a: unknown[]) => ({ exitCode: 0, lines: [a[1] === old!.id ? CAPS_014 : CAPS_015_NOHOST] });
    const list = async () => (await (await fetch(`http://127.0.0.1:${panelPort}/v1/servers`, { headers: headers() })).json()) as Array<Record<string, any>>;
    const byName = (rows: Array<Record<string, any>>, n: string) => rows.find((r) => r.name === n)!;
    const first = await list();
    expect(byName(first, 'edge-1').terminal).toEqual({ host: false, container: true, reason: expect.stringMatching(/NINEDEPLOY_AGENT_HOST_TERMINAL=off/) });
    expect(byName(first, 'old').terminal).toMatchObject({ host: false, container: false, reason: expect.stringMatching(/version 0\.14\.0.*v0\.15\.0/) });
    expect(byName(first, 'off').terminal).toMatchObject({ host: false, container: false, reason: expect.stringMatching(/not been reached/) });
    // Multi-node (additive): `agent` and `features` follow `terminal`, then
    // the build-server role (0.16 T4), then the hosted database count (0.16 T6),
    // then the Swarm membership (0.16 T8).
    expect(Object.keys(byName(first, 'edge-1'))).toEqual([
      'id', 'name', 'host', 'port', 'status', 'lastSeenAt', 'createdAt', 'terminal', 'agent', 'features', 'isBuildServer', 'buildConcurrency', 'databases', 'swarmNodeId', 'swarmRole',
    ]);
    expect(h.ops.filter((o) => o === 'agent.ping')).toHaveLength(2); // the offline node is not asked
    await list();
    expect(h.ops.filter((o) => o === 'agent.ping')).toHaveLength(2); // cached

    // Past the TTL the next read refreshes.
    h.agentOp = async () => ({ exitCode: 0, lines: [CAPS_015] });
    expect(await caps.nodeTerminalCapability(db, ids.server, { online: true, now: Date.now() + caps.NODE_CAPABILITY_TTL_MS + 1 })).toEqual({ host: true, container: true });
    expect(byName(await list(), 'edge-1').terminal).toEqual({ host: true, container: true });
    expect(off).toBeDefined();
  });
});

// ── 0.16 T6 node databases ── (the database terminal on a node, design §5.4)
describe('T6: a database on a node opens its shell through the node agent', () => {
  const nodeDatabase = async (status: 'running' | 'stopped' = 'running') => {
    const { databases } = await import('@ninedeploy/db');
    const [d] = await db
      .insert(databases)
      .values({
        name: 'orders',
        slug: 'orders',
        engine: 'postgres',
        status,
        containerName: null,
        volumeName: null,
        serverId: ids.server,
        nodeContainerName: 'nd-db-orders',
        nodeVolumeName: 'nd-db-orders-data',
        internalHost: 'nd-db-orders',
        passwordEncrypted: encrypt('pw'),
        ownerUserId: 1,
      })
      .returning();
    return d!.id;
  };

  it('shell mode: 201 naming the node; attach opens the nd-db-* container on the node (never the panel host)', async () => {
    const databaseId = await nodeDatabase();
    const s = await create({ kind: 'database', databaseId });
    expect(s.status).toBe(201);
    expect(s.body.session).toMatchObject({ targetKind: 'database', targetLabel: 'orders', serverId: ids.server });
    expect((await row(s.body.session.id)).containerName).toBe('nd-db-orders');
    const c = attach(s.body as { attachPath: string; ticket: string });
    await waitFor(() => c.texts.length > 0);
    expect(c.texts[0]).toEqual({ t: 'ready', sessionId: s.body.session.id, target: { kind: 'database', label: 'orders', serverId: ids.server } });
    // The REAL agent opened the exec in the database container on the node.
    expect(fakes.openExec).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ container: 'nd-db-orders' }));
    await waitFor(() => fakes.ttys[0]?.resizes.length === 1);
    const del = await fetch(`http://127.0.0.1:${panelPort}/v1/terminals/${s.body.session.id}`, { method: 'DELETE', headers: headers() });
    expect(await del.json()).toEqual({ ok: true, wasLive: true });
    await c.closed;
  });

  it('client mode is refused on a node (the agent opens shells only); a stopped database is 409; a 0.14 agent 422', async () => {
    const databaseId = await nodeDatabase();
    const client = await create({ kind: 'database', databaseId, mode: 'client' });
    expect([client.status, client.body.error.code]).toEqual([422, 'client_mode_unsupported']);
    expect(client.body.error.message).toMatch(/runs on a node/);
    scripted(CAPS_014);
    expect((await create({ kind: 'database', databaseId })).body.error.code).toBe('node_terminal_unsupported');
    const { databases } = await import('@ninedeploy/db');
    await db.update(databases).set({ status: 'stopped' }).where(eq(databases.id, databaseId));
    expect((await create({ kind: 'database', databaseId })).body.error.code).toBe('not_running');
    expect(await db.select().from(terminalSessions)).toHaveLength(0);
  });
});
// ── end 0.16 T6 ──
