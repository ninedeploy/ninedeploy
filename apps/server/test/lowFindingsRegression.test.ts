import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asUser, buildTestApp, createFakeDb, svcRow } from './helpers.js';
import { websocketBearerToken } from '../src/lib/websocketAuth.js';
import { assertMayPublishPort, reservedHostPorts } from '../src/lib/hostPort.js';

/**
 * Regressions for the Low findings closed in this pass. Each block names the
 * finding and asserts the property that was missing, plus a positive control
 * so a wholesale "deny everything" refactor cannot make them pass.
 */

const execMocks = vi.hoisted(() => ({ capture: vi.fn(async () => ''), run: vi.fn(async () => undefined) }));
vi.mock('../src/lib/exec.js', () => execMocks);
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/crypto.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/crypto.js')>('../src/lib/crypto.js');
  return { ...actual, encrypt: (v: string) => `enc:${v}`, randomToken: () => 'demo-rand-24-char-secret' };
});

// Request headers for inject(), and the plain user objects the lib helpers take.
const member = () => asUser({ id: 7, isOperator: false });
const admin = () => asUser({ id: 1, isOperator: true });
const memberUser = { id: 7, isOperator: false as const };
const adminUser = { id: 1, isOperator: true as const };

beforeEach(() => vi.clearAllMocks());

// ── L-2: /demo/seed writes instance-global, null-owner rows ────────────────
describe('L-2: seeding the demo stack is an admin action', () => {
  async function app() {
    const { demoRoutes } = await import('../src/modules/demo.js');
    const a = await buildTestApp({ db: createFakeDb({ findFirst: { projects: undefined } }) });
    await a.register(demoRoutes, { prefix: '/demo' });
    return a;
  }

  it('refuses a member', async () => {
    const res = await (await app()).inject({ method: 'POST', url: '/demo/seed', headers: member() });
    expect(res.statusCode).toBe(403);
  });

  it('still allows an admin', async () => {
    const res = await (await app()).inject({ method: 'POST', url: '/demo/seed', headers: admin() });
    expect(res.statusCode).toBe(200);
  });
});

// ── L-3: WebSocket tokens never travel in the query string ─────────────────
describe('L-3: the ?token= WebSocket fallback is gone', () => {
  it('reads the subprotocol form', () => {
    expect(websocketBearerToken({ 'sec-websocket-protocol': 'ninedeploy.bearer.abc123' })).toBe('abc123');
    expect(websocketBearerToken({ 'sec-websocket-protocol': ['ninedeploy, ninedeploy.bearer.xyz'] })).toBe('xyz');
  });

  it('has no second parameter to smuggle a query token through', () => {
    // The signature itself is the fix: there is nowhere to pass req.query.
    expect(websocketBearerToken.length).toBe(1);
    expect(websocketBearerToken({})).toBeUndefined();
    expect(websocketBearerToken({ 'sec-websocket-protocol': 'ninedeploy' })).toBeUndefined();
  });
});

// ── L-5: passkey login must not enumerate credentials ──────────────────────
describe('L-5: the passkey login ceremony leaks no credential ids', () => {
  it('returns an empty allowCredentials and never reads the table', async () => {
    const { beginAuthentication } = await import('../src/lib/webauthn.js');
    // No arguments to pass — the enumeration was the argument.
    expect(beginAuthentication.length).toBe(0);
    const options = JSON.parse(await beginAuthentication()) as { allowCredentials?: unknown[] };
    expect(options.allowCredentials ?? []).toEqual([]);
  });
});

// ── L-6: host ports are a shared, finite resource ──────────────────────────
describe('L-6: publishing a host port', () => {
  it('lets anyone publish an ordinary high port', () => {
    expect(() => assertMayPublishPort(memberUser, 8080)).not.toThrow();
    expect(() => assertMayPublishPort(memberUser, null)).not.toThrow();
    expect(() => assertMayPublishPort(memberUser, undefined)).not.toThrow();
  });

  it('refuses privileged ports to a member', () => {
    for (const port of [25, 53, 389, 1023]) {
      expect(() => assertMayPublishPort(memberUser, port), String(port)).toThrow(/Operator access required/);
    }
  });

  it('still allows an admin a privileged port', () => {
    expect(() => assertMayPublishPort(adminUser, 25)).not.toThrow();
  });

  it("refuses NineDeploy's own ports to admins too — that is an outage, not an attack", () => {
    for (const port of reservedHostPorts()) {
      expect(() => assertMayPublishPort(adminUser, port), String(port)).toThrow(/reserved by NineDeploy/);
      expect(() => assertMayPublishPort(memberUser, port), String(port)).toThrow(/reserved by NineDeploy/);
    }
  });

  it('is enforced on service creation, not just in the helper', async () => {
    const { servicesRoutes } = await import('../src/modules/services.js');
    const build = async () => {
      const a = await buildTestApp({ db: createFakeDb({ insert: { services: [svcRow({ id: 9, ownerUserId: 7 })] } }) });
      await a.register(servicesRoutes, { prefix: '/services' });
      return a;
    };
    const payload = {
      name: 'app', type: 'docker', repoUrl: 'https://example.com/x.git', branch: 'main',
      build: { buildPack: 'auto', baseDir: '/' },
    };
    const low = await (await build()).inject({ method: 'POST', url: '/services', headers: member(), payload: { ...payload, publishedPort: 80 } });
    expect(low.statusCode).toBe(403);

    const ok = await (await build()).inject({ method: 'POST', url: '/services', headers: member(), payload: { ...payload, publishedPort: 8443 } });
    expect(ok.statusCode).toBe(200);
  });
});

// ── L-12: instance-wide inventories are operator data ──────────────────────
describe('L-12: instance-wide listings are admin-only', () => {
  it('GET /volumes refuses a member and answers an admin', async () => {
    const { volumeRoutes } = await import('../src/modules/volumes.js');
    const build = async () => {
      const a = await buildTestApp({ db: createFakeDb({}) });
      await a.register(volumeRoutes, { prefix: '/volumes' });
      return a;
    };
    expect((await (await build()).inject({ method: 'GET', url: '/volumes', headers: member() })).statusCode).toBe(403);
    expect((await (await build()).inject({ method: 'GET', url: '/volumes', headers: admin() })).statusCode).toBe(200);
  });

  it('GET /networks refuses a member and answers an admin', async () => {
    const { networkRoutes } = await import('../src/modules/networks.js');
    const build = async () => {
      const a = await buildTestApp({ db: createFakeDb({}) });
      await a.register(networkRoutes, { prefix: '/networks' });
      return a;
    };
    expect((await (await build()).inject({ method: 'GET', url: '/networks', headers: member() })).statusCode).toBe(403);
    expect((await (await build()).inject({ method: 'GET', url: '/networks', headers: admin() })).statusCode).toBe(200);
  });

  it('GET /networks/:name/members refuses a member and answers an admin', async () => {
    // Container names on a network map out the instance inventory just like
    // the listing does — the per-network route must not be the side door.
    const { networkRoutes } = await import('../src/modules/networks.js');
    const build = async () => {
      const a = await buildTestApp({ db: createFakeDb({}) });
      await a.register(networkRoutes, { prefix: '/networks' });
      return a;
    };
    expect(
      (await (await build()).inject({ method: 'GET', url: '/networks/bridge/members', headers: member() })).statusCode,
    ).toBe(403);
    expect(
      (await (await build()).inject({ method: 'GET', url: '/networks/bridge/members', headers: admin() })).statusCode,
    ).toBe(200);
  });

  it('GET /config/:key refuses a member and answers an admin', async () => {
    const { configCenterRoutes } = await import('../src/modules/configCenter.js');
    const build = async () => {
      const a = await buildTestApp({ db: createFakeDb({ findFirst: { config_entries: undefined } }) });
      await a.register(configCenterRoutes, { prefix: '/config' });
      return a;
    };
    // The gate fires before the handler, so the member sees 403 — never a
    // value, masked or not. The admin passes the gate (404 = unknown key).
    expect((await (await build()).inject({ method: 'GET', url: '/config/system.site_name', headers: member() })).statusCode).toBe(403);
    const adminRes = await (await build()).inject({ method: 'GET', url: '/config/system.site_name', headers: admin() });
    expect([200, 404]).toContain(adminRes.statusCode);
  });

  it('GET /traefik status/certificates/version refuse a member; the composite is scoped', async () => {
    const { traefikRoutes } = await import('../src/modules/traefik.js');
    const build = async () => {
      const a = await buildTestApp({ db: createFakeDb({}) });
      await a.register(traefikRoutes, { prefix: '/v1' });
      return a;
    };
    // Standalone inventory endpoints: member 403, admin 200.
    expect((await (await build()).inject({ method: 'GET', url: '/v1/traefik/status', headers: member() })).statusCode).toBe(403);
    expect((await (await build()).inject({ method: 'GET', url: '/v1/traefik/certificates', headers: member() })).statusCode).toBe(403);
    expect((await (await build()).inject({ method: 'GET', url: '/v1/traefik/version', headers: member() })).statusCode).toBe(403);
    // The shared UI page stays reachable for members but must not carry the
    // routing tables or certificate list — only the status banner.
    const memberRes = await (await build()).inject({ method: 'GET', url: '/v1/traefik', headers: member() });
    expect(memberRes.statusCode).toBe(200);
    const memberBody = memberRes.json();
    expect(memberBody.routers).toEqual([]);
    expect(memberBody.services).toEqual([]);
    expect(memberBody.middlewares).toEqual([]);
    expect(memberBody.certificates).toEqual([]);
    expect(memberBody.status).toBeDefined();
  });
});
