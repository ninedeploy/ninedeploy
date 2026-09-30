import { describe, expect, it, vi, beforeEach } from 'vitest';
import { serverRoutes } from '../src/modules/servers.js';
import { asUser, buildTestApp, createFakeDb } from './helpers.js';

const agentMocks = vi.hoisted(() => ({
  agentPing: vi.fn(async () => undefined),
  generateAgentToken: vi.fn(() => 'raw-agent-token'),
  agentOp: vi.fn(),
}));
vi.mock('../src/lib/agentClient.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/agentClient.js')>('../src/lib/agentClient.js');
  return { ...actual, agentPing: agentMocks.agentPing, generateAgentToken: agentMocks.generateAgentToken, agentOp: agentMocks.agentOp };
});

const cryptoMocks = vi.hoisted(() => ({ encrypt: vi.fn((s: string) => `enc:${s}`), decrypt: vi.fn((s: string) => s.replace('enc:', '')) }));
// Only the envelope helpers are stubbed (so tests can read the stored value);
// everything else — notably the constant-time `secretEquals` the announce
// route compares tokens with — stays real.
vi.mock('../src/lib/crypto.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/crypto.js')>('../src/lib/crypto.js');
  return { ...actual, ...cryptoMocks };
});

const auditMocks = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMocks);

const provisionerMocks = vi.hoisted(() => ({
  testSshConnection: vi.fn(async () => ({ ok: true, message: 'Connected', os: 'Ubuntu', dockerInstalled: true })),
  bootstrapServer: vi.fn(async () => ({ ok: true, serverId: 10, serverName: 'node-10', steps: [], logs: [] })),
  getBootstrapLogs: vi.fn(() => ['log 1', 'log 2']),
}));
vi.mock('../src/engine/serverProvisioner.js', () => provisionerMocks);

const serverRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'edge-1',
  host: '10.0.0.5',
  port: 4600,
  status: 'offline',
  tokenEncrypted: 'enc:raw-agent-token',
  lastSeenAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

const appWith = async (fixtures: Record<string, unknown>) => {
  const app = await buildTestApp({ db: createFakeDb(fixtures as never) });
  await app.register(serverRoutes, { prefix: '/servers' });
  return app;
};

// M-6: announce now demands the admin-issued enrolment secret. The fake db
// serves it from the settings table; `cryptoMocks.decrypt` strips the `enc:`
// envelope, so the stored value decrypts to ENROLMENT_SECRET.
const ENROLMENT_SECRET = 'enrolment-secret-abc';
const enrolmentSetting = { key: 'agent_enrolment_token', value: `enc:${ENROLMENT_SECRET}` };
const enrolled = { 'x-ninedeploy-enrolment': ENROLMENT_SECRET };

describe('servers routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires authentication', async () => {
    const app = await appWith({});
    const res = await app.inject({ method: 'GET', url: '/servers' });
    expect(res.statusCode).toBe(401);
  });

  it('requires admin', async () => {
    const app = await appWith({ findFirst: { users: { id: 2, isOperator: false } } });
    const res = await app.inject({ method: 'GET', url: '/servers', headers: { 'x-test-user': '2', 'x-test-role': 'member' } });
    expect(res.statusCode).toBe(403);
  });

  it('lists servers without tokens', async () => {
    const app = await appWith({ findMany: { servers: [serverRow({ status: 'online', lastSeenAt: new Date() })] } });
    const res = await app.inject({ method: 'GET', url: '/servers', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({ id: 1, name: 'edge-1', host: '10.0.0.5', status: 'online' });
    expect(Object.keys(res.json()[0])).not.toContain('tokenEncrypted');
  });

  it('r421: reports a stale `online` node as offline at read time', async () => {
    // `online` used to mean "last BOOT" — a dead node kept its green badge
    // forever. The row itself is untouched; the listing is honest.
    const app = await appWith({ findMany: { servers: [serverRow({ status: 'online', lastSeenAt: new Date(Date.now() - 10 * 60_000) })] } });
    const res = await app.inject({ method: 'GET', url: '/servers', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({ status: 'offline' });
  });

  it('registers a server and returns the token exactly once', async () => {
    const app = await appWith({ insert: { servers: [serverRow()] } });
    const res = await app.inject({
      method: 'POST', url: '/servers', headers: asUser(),
      payload: { name: 'edge-1', host: '10.0.0.5' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBe('raw-agent-token');
    expect(body.tokenSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.agentCommand).toContain('NINEDEPLOY_AGENT=1');
    expect(body.agentCommand).toContain('-p 4600:4600');
    expect(cryptoMocks.encrypt).toHaveBeenCalledWith('raw-agent-token');

    // With custom port
    const resCustom = await app.inject({
      method: 'POST', url: '/servers', headers: asUser(),
      payload: { name: 'edge-custom', host: '10.0.0.5', port: 4650 },
    });
    expect(resCustom.statusCode).toBe(200);
    expect(resCustom.json().agentCommand).toContain('-p 4650:4600');
  });

  it('validates name and host', async () => {
    const app = await appWith({});
    const noName = await app.inject({ method: 'POST', url: '/servers', headers: asUser(), payload: { host: 'h' } });
    expect(noName.statusCode).toBe(400);
    expect(noName.json().error.code).toBe('validation_error');
    const badHost = await app.inject({ method: 'POST', url: '/servers', headers: asUser(), payload: { name: 'x', host: 'bad host!' } });
    expect(badHost.statusCode).toBe(400);
    expect(badHost.json().error.code).toBe('validation_error');
  });

  it('rejects an out-of-range port, an empty body and a failed insert', async () => {
    const app = await appWith({});
    const badPort = await app.inject({
      method: 'POST', url: '/servers', headers: asUser(),
      payload: { name: 'x', host: 'h', port: 99999 },
    });
    expect(badPort.statusCode).toBe(400);
    const empty = await app.inject({ method: 'POST', url: '/servers', headers: asUser() });
    expect(empty.statusCode).toBe(400);
    const failed = await appWith({ insert: { servers: [] } });
    const res = await failed.inject({
      method: 'POST', url: '/servers', headers: asUser(),
      payload: { name: 'x', host: 'h.example' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts host:port and non-Error test failures', async () => {
    const app = await appWith({ insert: { servers: [serverRow()] } });
    const res = await app.inject({
      method: 'POST', url: '/servers', headers: asUser(),
      payload: { name: 'edge', host: 'h.example:4601', port: 4601 },
    });
    expect(res.statusCode).toBe(200);
    // A non-numeric port falls back to the default 4600.
    const app3 = await appWith({ insert: { servers: [serverRow()] } });
    const nanPort = await app3.inject({
      method: 'POST', url: '/servers', headers: asUser(),
      payload: { name: 'edge', host: 'h.example', port: 'abc' },
    });
    expect(nanPort.statusCode).toBe(200);
    // Test failures with non-Error rejections stringify.
    agentMocks.agentPing.mockRejectedValueOnce('plain fail');
    const app2 = await appWith({
      findFirst: { servers: serverRow() },
      update: { servers: [serverRow({ status: 'error' })] },
    });
    const test = await app2.inject({ method: 'POST', url: '/servers/1/test', headers: asUser() });
    expect(test.statusCode).toBe(400);
    expect(test.json().error.message).toContain('plain fail');
  });

  it('deletes a server when no services are hosted or force is true', async () => {
    const app = await appWith({
      findFirst: { servers: serverRow({ id: 1, name: 'edge-host' }) },
      findMany: { services: [{ id: 10, name: 'hosted-api', serverId: 1, slug: 'hosted-api' }] },
    });

    // Blocked without force
    const resBlocked = await app.inject({ method: 'DELETE', url: '/servers/1', headers: asUser() });
    expect(resBlocked.statusCode).toBe(400);
    expect(resBlocked.json().error.message).toContain('locked');
    expect(resBlocked.json().error.message).toContain('hosted-api');

    // Allowed with force — and the response names what was orphaned: their
    // containers live on the removed node while the panel now reads them as
    // local (r399; the old `{ ok: true }` hid that entirely).
    const resForce = await app.inject({ method: 'DELETE', url: '/servers/1?force=true', headers: asUser() });
    expect(resForce.statusCode).toBe(200);
    expect(resForce.json()).toMatchObject({
      ok: true,
      orphanedServices: [{ id: 10, name: 'hosted-api', slug: 'hosted-api' }],
    });
    expect(resForce.json().note).toContain('hosted on this node');
  });

  it('r399: refuses a manual create for an endpoint that is already registered', async () => {
    const app = await appWith({
      findFirst: { servers: serverRow({ id: 3, name: 'node-a', host: '10.0.0.5', port: 4600 }) },
    });
    const res = await app.inject({
      method: 'POST', url: '/servers', headers: asUser(),
      payload: { name: 'node-b', host: '10.0.0.5', port: 4600 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('node-a');
  });

  it('404s when deleting a missing server', async () => {
    const app = await appWith({ findFirst: { servers: undefined } });
    const res = await app.inject({ method: 'DELETE', url: '/servers/99', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('marks a reachable agent online', async () => {
    const app = await appWith({
      findFirst: { servers: serverRow() },
      update: { servers: [serverRow({ status: 'online' })] },
    });
    const res = await app.inject({ method: 'POST', url: '/servers/1/test', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: 'online' });
    expect(agentMocks.agentPing).toHaveBeenCalledWith('10.0.0.5', 4600, 'raw-agent-token');
  });

  it('marks an unreachable agent error', async () => {
    agentMocks.agentPing.mockRejectedValueOnce(new Error('timeout'));
    const app = await appWith({
      findFirst: { servers: serverRow() },
      update: { servers: [serverRow({ status: 'error' })] },
    });
    const res = await app.inject({ method: 'POST', url: '/servers/1/test', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('timeout');
  });

  it('approves a pending server and marks it online', async () => {
    const app = await appWith({
      findFirst: { servers: serverRow({ status: 'pending' }) },
      update: { servers: [serverRow({ status: 'online' })] },
    });
    const res = await app.inject({ method: 'POST', url: '/servers/1/approve', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: 'online' });
    expect(agentMocks.agentPing).toHaveBeenCalledWith('10.0.0.5', 4600, 'raw-agent-token');
  });

  it('rejects a pending server and removes it', async () => {
    const app = await appWith({
      findFirst: { servers: serverRow({ status: 'pending' }) },
    });
    const res = await app.inject({ method: 'POST', url: '/servers/1/reject', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('404s when approving or rejecting a missing server', async () => {
    const app = await appWith({ findFirst: { servers: undefined } });
    const res1 = await app.inject({ method: 'POST', url: '/servers/99/approve', headers: asUser() });
    expect(res1.statusCode).toBe(404);
    const res2 = await app.inject({ method: 'POST', url: '/servers/99/reject', headers: asUser() });
    expect(res2.statusCode).toBe(404);
  });

  it('HIGH: a public announce with a wrong token can never take over an existing server', async () => {
    let updatedValues: Record<string, unknown> | null = null;
    const app = await appWith({
      findFirst: { servers: serverRow({ id: 3, host: '10.0.0.5', port: 4600, status: 'online' }), settings: enrolmentSetting },
      update: {
        servers: (v: Record<string, unknown>) => {
          updatedValues = v;
          return [serverRow({ id: 3 })];
        },
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/servers/announce',
      headers: enrolled,
      payload: { name: 'attacker-node', host: '10.0.0.5', port: 4600, token: 'attacker-forged-token-1' },
    });
    expect(res.statusCode).toBe(401);
    // The registry was not touched: no token/name overwrite happened.
    expect(updatedValues).toBeNull();
  });

  it('M-6: refuses an announce when no enrolment token is configured (fail closed)', async () => {
    const app = await appWith({
      findFirst: { servers: undefined, settings: undefined },
      insert: { servers: [serverRow({ id: 5, status: 'pending' })] },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/servers/announce',
      payload: { name: 'rogue', host: '203.0.113.9', port: 4600, token: 'a'.repeat(32) },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('enrolment_disabled');
  });

  it('M-6: refuses an announce with a missing or wrong enrolment token', async () => {
    const fixtures = {
      findFirst: { servers: undefined, settings: enrolmentSetting },
      insert: { servers: [serverRow({ id: 5, status: 'pending' })] },
    };
    const payload = { name: 'rogue', host: '203.0.113.9', port: 4600, token: 'a'.repeat(32) };

    const missing = await (await appWith(fixtures)).inject({ method: 'POST', url: '/servers/announce', payload });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe('enrolment_invalid');

    const wrong = await (await appWith(fixtures)).inject({
      method: 'POST',
      url: '/servers/announce',
      headers: { 'x-ninedeploy-enrolment': 'not-the-secret' },
      payload,
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('enrolment_invalid');
  });

  it('M-6: the enrolment check runs before the body is parsed, so it is not a schema oracle', async () => {
    const app = await appWith({ findFirst: { servers: undefined, settings: enrolmentSetting } });
    // A body that would fail zod validation still gets 401, not 400.
    const res = await app.inject({ method: 'POST', url: '/servers/announce', payload: { nonsense: true } });
    expect(res.statusCode).toBe(401);
  });

  it('allows unauthenticated edge agent announcement to register as pending', async () => {
    const app = await appWith({
      findFirst: { servers: undefined, settings: enrolmentSetting },
      insert: { servers: [serverRow({ id: 5, status: 'pending' })] },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/servers/announce',
      headers: enrolled,
      payload: {
        name: 'auto-edge-1',
        host: '192.168.1.55',
        port: 4600,
        token: 'a'.repeat(32),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, id: 5, status: 'pending' });
    expect(cryptoMocks.encrypt).toHaveBeenCalledWith('a'.repeat(32));

    // Re-announce online server (with the MATCHING stored token)
    const appOnline = await appWith({
      findFirst: { servers: serverRow({ id: 5, host: '192.168.1.55', port: 4600, status: 'online', tokenEncrypted: 'enc:edge-agent-token-12345' }), settings: enrolmentSetting },
      update: { servers: [serverRow({ id: 5 })] },
    });
    const resOnline = await appOnline.inject({
      method: 'POST',
      url: '/servers/announce',
      headers: enrolled,
      payload: { name: 'auto-edge-1', host: '192.168.1.55', port: 4600, token: 'edge-agent-token-12345' },
    });
    expect(resOnline.statusCode).toBe(200);
    expect(resOnline.json().message).toBe('Server already active and connected');

    // Announce with host:port extracting port
    const appHostPort = await appWith({
      findFirst: { servers: undefined, settings: enrolmentSetting },
      insert: { servers: [serverRow({ id: 6, host: '10.0.0.5', port: 4605, status: 'pending' })] },
    });
    const resHostPort = await appHostPort.inject({
      method: 'POST',
      url: '/servers/announce',
      headers: enrolled,
      payload: { name: 'node-host-port', host: '10.0.0.5:4605', token: 'd'.repeat(32) },
    });
    expect(resHostPort.statusCode).toBe(200);
    expect(resHostPort.json().id).toBe(6);

    // Announce with host without port falling back to 4600
    const appFallback = await appWith({
      findFirst: { servers: undefined, settings: enrolmentSetting },
      insert: { servers: [serverRow({ id: 7, host: '10.0.0.7', port: 4600, status: 'pending' })] },
    });
    const resFallback = await appFallback.inject({
      method: 'POST',
      url: '/servers/announce',
      headers: enrolled,
      payload: { name: 'node-fallback', host: '10.0.0.7', token: 'e'.repeat(32) },
    });
    expect(resFallback.statusCode).toBe(200);
    expect(resFallback.json().id).toBe(7);

    // Announce with empty host extracting IPv4 mapped in IPv6
    const appIpV6 = await appWith({
      findFirst: { servers: undefined, settings: enrolmentSetting },
      insert: { servers: [serverRow({ id: 8, host: '192.168.1.88', port: 4600, status: 'pending' })] },
    });
    const resIpV6 = await appIpV6.inject({
      method: 'POST',
      url: '/servers/announce',
      headers: enrolled,
      remoteAddress: '::ffff:192.168.1.88',
      payload: { name: 'node-ipv6', token: 'f'.repeat(32) },
    });
    expect(resIpV6.statusCode).toBe(200);

    // Announce with loopback ::1
    const appLoopback = await appWith({
      findFirst: { servers: undefined, settings: enrolmentSetting },
      insert: { servers: [serverRow({ id: 9, host: '127.0.0.1', port: 4600, status: 'pending' })] },
    });
    const resLoopback = await appLoopback.inject({
      method: 'POST',
      url: '/servers/announce',
      headers: enrolled,
      remoteAddress: '::1',
      payload: { name: 'node-loopback', token: 'g'.repeat(32) },
    });
    expect(resLoopback.statusCode).toBe(200);

    // Announce with regular IP
    const appIp = await appWith({
      findFirst: { servers: undefined, settings: enrolmentSetting },
      insert: { servers: [serverRow({ id: 10, host: '10.0.0.99', port: 4600, status: 'pending' })] },
    });
    const resIp = await appIp.inject({
      method: 'POST',
      url: '/servers/announce',
      headers: enrolled,
      remoteAddress: '10.0.0.99',
      payload: { name: 'node-ip', token: 'h'.repeat(32) },
    });
    expect(resIp.statusCode).toBe(200);

    // Re-announce pending server (matching stored token)
    const appPending = await appWith({
      findFirst: { servers: serverRow({ id: 5, host: '192.168.1.55', port: 4600, status: 'pending', tokenEncrypted: 'enc:pending-agent-token-1' }), settings: enrolmentSetting },
      update: { servers: [serverRow({ id: 5 })] },
    });
    const resPending = await appPending.inject({
      method: 'POST',
      url: '/servers/announce',
      headers: enrolled,
      payload: { name: 'auto-edge-1', host: '192.168.1.55', port: 4600, token: 'pending-agent-token-1' },
    });
    expect(resPending.statusCode).toBe(200);
    expect(resPending.json().message).toBe('Server re-announced. Pending admin approval.');
  });

  it('approves a pending server when reachable', async () => {
    const app = await appWith({
      findFirst: { servers: serverRow({ id: 1, status: 'pending' }) },
      update: { servers: [serverRow({ id: 1, status: 'online' })] },
    });
    agentMocks.agentPing.mockResolvedValueOnce({ ok: true, version: '1.0.0' });

    const res = await app.inject({
      method: 'POST',
      url: '/servers/1/approve',
      headers: asUser(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: 'online' });
  });

  it('sets server status to error and throws 400 when approve ping fails', async () => {
    const app = await appWith({
      findFirst: { servers: serverRow({ id: 1, status: 'pending' }) },
      update: { servers: [serverRow({ id: 1, status: 'error' })] },
    });
    agentMocks.agentPing.mockRejectedValueOnce(new Error('connection refused'));

    const res = await app.inject({
      method: 'POST',
      url: '/servers/1/approve',
      headers: asUser(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Agent unreachable: connection refused');

    // Non-Error rejection stringifies
    agentMocks.agentPing.mockRejectedValueOnce('raw string error');
    const resString = await app.inject({
      method: 'POST',
      url: '/servers/1/approve',
      headers: asUser(),
    });
    expect(resString.statusCode).toBe(400);
    expect(resString.json().error.message).toContain('Agent unreachable: raw string error');
  });

  it('rejects a pending server', async () => {
    const app = await appWith({
      findFirst: { servers: serverRow({ id: 1, status: 'pending' }) },
      delete: { servers: [serverRow({ id: 1 })] },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/servers/1/reject',
      headers: asUser(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('returns 404 when testing, approving or rejecting a non-existent server', async () => {
    const app = await appWith({ findFirst: { servers: undefined } });

    const resTest = await app.inject({ method: 'POST', url: '/servers/99/test', headers: asUser() });
    expect(resTest.statusCode).toBe(404);

    const resApprove = await app.inject({ method: 'POST', url: '/servers/99/approve', headers: asUser() });
    expect(resApprove.statusCode).toBe(404);

    const resReject = await app.inject({ method: 'POST', url: '/servers/99/reject', headers: asUser() });
    expect(resReject.statusCode).toBe(404);
  });

  it('throws 400 when announce insert fails to return a row or when body is empty', async () => {
    const app = await appWith({
      findFirst: { servers: undefined, settings: enrolmentSetting },
      insert: { servers: [] },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/servers/announce',
      headers: enrolled,
      payload: { name: 'failed-node', host: '10.0.0.1', port: 4600, token: 'c'.repeat(32) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Could not register announced server');

    const resEmpty = await app.inject({
      method: 'POST',
      url: '/servers/announce',
      headers: enrolled,
    });
    expect(resEmpty.statusCode).toBe(400);
  });

  it('runs SSH connection test via POST /servers/ssh-test', async () => {
    const app = await appWith({});
    const resEmpty = await app.inject({
      method: 'POST',
      url: '/servers/ssh-test',
      headers: asUser(),
    });
    expect(resEmpty.statusCode).toBe(400);

    const resEmptyBoot = await app.inject({
      method: 'POST',
      url: '/servers/ssh-bootstrap',
      headers: asUser(),
    });
    expect(resEmptyBoot.statusCode).toBe(400);

    const res = await app.inject({
      method: 'POST',
      url: '/servers/ssh-test',
      headers: asUser(),
      payload: { host: '192.168.1.50', sshPort: 22, authType: 'key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, message: 'Connected', os: 'Ubuntu' });
    expect(provisionerMocks.testSshConnection).toHaveBeenCalledWith(
      expect.objectContaining({ host: '192.168.1.50', sshPort: 22 }),
    );
  });

  it('runs SSH automated bootstrap and audits success', async () => {
    const app = await appWith({});
    const res = await app.inject({
      method: 'POST',
      url: '/servers/ssh-bootstrap',
      headers: asUser(),
      payload: { name: 'Node-10', host: '192.168.1.50', sshPort: 22, authType: 'key', installDocker: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, serverId: 10, serverName: 'node-10' });
    expect(provisionerMocks.bootstrapServer).toHaveBeenCalled();
    expect(auditMocks.audit).toHaveBeenCalledWith(expect.anything(), 1, 'server.ssh_bootstrap', 'Node-10');
  });

  it('handles bootstrap failure with 400 badRequest', async () => {
    provisionerMocks.bootstrapServer.mockResolvedValueOnce({
      ok: false,
      error: 'Docker install timed out',
      steps: [],
      logs: [],
    });

    const app = await appWith({});
    const res = await app.inject({
      method: 'POST',
      url: '/servers/ssh-bootstrap',
      headers: asUser(),
      payload: { name: 'Fail-Node', host: '192.168.1.99', authType: 'key' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Docker install timed out');

    // Default error message fallback
    provisionerMocks.bootstrapServer.mockResolvedValueOnce({
      ok: false,
      steps: [],
      logs: [],
    });
    const resDef = await app.inject({
      method: 'POST',
      url: '/servers/ssh-bootstrap',
      headers: asUser(),
      payload: { name: 'Fail-Node-2', host: '192.168.1.99', authType: 'key' },
    });
    expect(resDef.statusCode).toBe(400);
    expect(resDef.json().error.message).toBe('Server bootstrap failed');
  });

  it('retrieves bootstrap logs via GET /servers/:id/bootstrap-logs', async () => {
    const app = await appWith({});
    const res = await app.inject({
      method: 'GET',
      url: '/servers/5/bootstrap-logs',
      headers: asUser(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ logs: ['log 1', 'log 2'] });
    expect(provisionerMocks.getBootstrapLogs).toHaveBeenCalledWith(5);
  });
});


// ── r467: per-node telemetry endpoint ───────────────────────────────────
const statsAgentMock = vi.hoisted(() => ({ agentOp: vi.fn() }));
describe('GET /:id/stats (r467)', () => {
  const srvRow = (over: Record<string, unknown> = {}) => ({
    id: 4, name: 'node-4', host: '10.0.0.4', port: 4600, status: 'online',
    tokenEncrypted: 'enc:t', lastSeenAt: new Date(), createdAt: new Date(), ...over,
  });
  const svcRowRemote = (over: Record<string, unknown> = {}) => ({
    id: 9, name: 'Ghost', slug: 'ghost', runtimeId: 'ghost-11', serverId: 4, memLimitMb: 256, ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses the agent lines and joins containers to the node\'s services', async () => {
    // Patch the module-level agentOp the route uses (the file imports it
    // directly, so spy through the mocked client module).
    vi.spyOn(statsAgentMock, 'agentOp');
    const { agentOp } = await import('../src/lib/agentClient.js');
    const realAgentOp = agentOp as unknown as ReturnType<typeof vi.fn>;
    realAgentOp.mockImplementation(async (_db: unknown, id: number, op: string) => {
      void id; void op;
      return {
        exitCode: 0,
        lines: [
          'ND-HOST {"cpuCores":8,"load1":0.42,"memTotalBytes":16000000000,"memUsedBytes":4000000000}',
          'ghost-11|0.75%|51.2MiB / 256MiB',
          'other-1|0.10%|10MiB / 1GiB',
          'ND-DF /dev/sda1 100000000 40000000 60000000 40% /',
        ],
      };
    });
    const { servers: serversTable, services: servicesTable } = await import('@ninedeploy/db');
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { servers: srvRow() },
        findMany: { services: [svcRowRemote()], servers: [srvRow()] },
      } as never),
    });
    void serversTable; void servicesTable;
    await app.register(serverRoutes, { prefix: '/v1/servers' });
    const res = await app.inject({ method: 'GET', url: '/v1/servers/4/stats', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.host).toMatchObject({ cpuCores: 8, load1: 0.42 });
    expect(body.disk).toEqual({ totalBytes: 100000000 * 1024, usedBytes: 40000000 * 1024 });
    expect(body.containers).toHaveLength(1);
    expect(body.containers[0]).toMatchObject({ refName: 'Ghost', name: 'ghost-11', memLimitMb: 256 });
    expect(body.containers[0].memMb).toBeCloseTo(51.2, 0);
    await app.close();
  });

  it('answers 400 with the agent error when the node is unreachable', async () => {
    const { agentOp } = await import('../src/lib/agentClient.js');
    (agentOp as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fetch failed'));
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { servers: srvRow() }, findMany: { services: [], servers: [srvRow()] } } as never),
    });
    await app.register(serverRoutes, { prefix: '/v1/servers' });
    const res = await app.inject({ method: 'GET', url: '/v1/servers/4/stats', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('unreachable');
    await app.close();
  });
});

describe('GET /:id/stats (r467) — degraded arms', () => {
  const srvRow = { id: 4, name: 'node-4', host: '10.0.0.4', port: 4600, status: 'online', tokenEncrypted: 'enc:t', lastSeenAt: new Date(), createdAt: new Date() };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers 400 when the agent exits non-zero', async () => {
    agentMocks.agentOp.mockResolvedValue({ exitCode: 1, lines: [] });
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { servers: srvRow }, findMany: { services: [], servers: [srvRow] } } as never),
    });
    await app.register(serverRoutes, { prefix: '/v1/servers' });
    const res = await app.inject({ method: 'GET', url: '/v1/servers/4/stats', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('exit 1');
    await app.close();
  });

  it('degrades a malformed ND-HOST line to null instead of failing', async () => {
    agentMocks.agentOp.mockResolvedValue({ exitCode: 0, lines: ['ND-HOST {not-json', 'ND-DF /dev/sda1 100 40 60 40% /'] });
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { servers: srvRow }, findMany: { services: [], servers: [srvRow] } } as never),
    });
    await app.register(serverRoutes, { prefix: '/v1/servers' });
    const res = await app.inject({ method: 'GET', url: '/v1/servers/4/stats', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json().host).toBeNull();
    expect(res.json().disk.totalBytes).toBe(100 * 1024);
    await app.close();
  });
});

describe('GET /:id/stats (r467) — parser edge arms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips malformed container lines, short ND-DF lines and services without a runtime', async () => {
    agentMocks.agentOp.mockResolvedValue({
      exitCode: 0,
      lines: [
        'ND-HOST {"cpuCores":2,"load1":0.1,"memTotalBytes":10,"memUsedBytes":5}',
        'no-cpu-field',
        'x|notanumber%|',
        'ND-DF tooshort',
        'plain-noise-line',
      ],
    });
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { servers: { id: 4, name: 'n', host: 'h', port: 1, status: 'online', tokenEncrypted: 'enc:t', lastSeenAt: new Date(), createdAt: new Date() } },
        // A service pinned to the node but never deployed — no runtimeId, no row.
        findMany: { services: [{ id: 9, name: 'Pending', slug: 'pending', runtimeId: null, serverId: 4, memLimitMb: 0 }], servers: [] },
      } as never),
    });
    await app.register(serverRoutes, { prefix: '/v1/servers' });
    const res = await app.inject({ method: 'GET', url: '/v1/servers/4/stats', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.host.cpuCores).toBe(2);
    expect(body.containers).toEqual([]);
    expect(body.disk).toEqual({ totalBytes: 0, usedBytes: 0 });
    await app.close();
  });
});
