import { beforeEach, describe, expect, it, vi } from 'vitest';
import { egressRoutes } from '../../src/modules/egress.js';
import type { EgressIpRule, EgressIpSelector, IEgressIpDriver } from '../../src/kernel/types.js';
import { asUser, buildTestApp, createFakeDb } from '../helpers.js';
import { audit } from '../../src/lib/audit.js';

vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

/**
 * The `egress` route module is a thin shell over the kernel's
 * `IServiceRegistry` — its entire job is to route
 * `list / attach / detach` calls to the registered
 * `IEgressIpDriver`. The driver itself (iptables, cloud, etc.)
 * is unit-tested in `test/kernel/drivers/iptablesEgressDriver.test.ts`
 * (when it lands) and its integration with the routes is what
 * this file pins.
 *
 * The contract being tested:
 *   1. `GET /` aggregates every registered driver's `list()` into a
 *      `{ drivers: [{ name, rules }] }` payload.
 *   2. `POST /` validates `projectId` (number) and `ip` (non-empty
 *      string), picks the named driver (or the first registered),
 *      and forwards the attach. Missing driver answers 200 with
 *      `{ ok: false, error: ... }` (the route's bespoke envelope).
 *   3. `DELETE /:projectId` validates the projectId, picks the
 *      first driver (no name override), and forwards the detach.
 *      Same error envelope on a missing driver.
 */
function makeRule(selector: EgressIpSelector, ip: string, createdAt = '2026-08-29T00:00:00Z'): EgressIpRule {
  return { selector, ip, createdAt };
}

function mockDriver(name: string, overrides: Partial<IEgressIpDriver> = {}): IEgressIpDriver {
  return {
    name,
    attach: vi.fn(async (selector, ip) => makeRule(selector, ip)),
    detach: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    ...overrides,
  };
}

describe('egress routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a member before listing or mutating host egress rules', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    const driver = mockDriver('iptables');
    app.kernel.registry.registerEgressIpDriver(driver);
    await app.register(egressRoutes);
    const headers = asUser({ role: 'member' });
    const list = await app.inject({ method: 'GET', url: '/', headers });
    const attach = await app.inject({ method: 'POST', url: '/', headers, payload: { projectId: 1, ip: '203.0.113.7' } });
    expect(list.statusCode).toBe(403);
    expect(attach.statusCode).toBe(403);
    expect(driver.list).not.toHaveBeenCalled();
    expect(driver.attach).not.toHaveBeenCalled();
    await app.close();
  });

  describe('GET /', () => {
    it('aggregates the list() of every registered driver', async () => {
      const app = await buildTestApp({ db: createFakeDb() });
      const a = mockDriver('iptables', {
        list: vi.fn(async () => [
          makeRule({ projectId: 1 }, '203.0.113.10'),
          makeRule({ projectId: 2 }, '203.0.113.11'),
        ]),
      });
      const b = mockDriver('cloud-nat', {
        list: vi.fn(async () => [makeRule({ projectId: 3 }, '198.51.100.5')]),
      });
      app.kernel.registry.registerEgressIpDriver(a);
      app.kernel.registry.registerEgressIpDriver(b);
      await app.register(egressRoutes);
      const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        drivers: [
          { name: 'iptables', rules: [
            { selector: { projectId: 1 }, ip: '203.0.113.10', createdAt: '2026-08-29T00:00:00Z' },
            { selector: { projectId: 2 }, ip: '203.0.113.11', createdAt: '2026-08-29T00:00:00Z' },
          ] },
          { name: 'cloud-nat', rules: [
            { selector: { projectId: 3 }, ip: '198.51.100.5', createdAt: '2026-08-29T00:00:00Z' },
          ] },
        ],
      });
      expect(a.list).toHaveBeenCalledTimes(1);
      expect(b.list).toHaveBeenCalledTimes(1);
      await app.close();
    });

    it('returns an empty drivers list when no driver is registered', async () => {
      // No registerEgressIpDriver call — `listEgressIpDrivers()` is [].
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(egressRoutes);
      const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ drivers: [] });
      await app.close();
    });
  });

  describe('POST /', () => {
    it('attaches the IP to the named driver when ?driver= is supplied', async () => {
      const app = await buildTestApp({ db: createFakeDb() });
      const ipt = mockDriver('iptables');
      const cloud = mockDriver('cloud-nat');
      app.kernel.registry.registerEgressIpDriver(ipt);
      app.kernel.registry.registerEgressIpDriver(cloud);
      await app.register(egressRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/',
        headers: asUser(),
        payload: { projectId: 7, ip: '203.0.113.42', driver: 'cloud-nat' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        driver: 'cloud-nat',
        rule: { selector: { projectId: 7 }, ip: '203.0.113.42', createdAt: '2026-08-29T00:00:00Z' },
      });
      // The named driver was picked; the other one was not called.
      expect(cloud.attach).toHaveBeenCalledWith({ projectId: 7 }, '203.0.113.42');
      expect(ipt.attach).not.toHaveBeenCalled();
      await app.close();
    });

    it('falls back to the first registered driver when no name is supplied', async () => {
      const app = await buildTestApp({ db: createFakeDb() });
      const ipt = mockDriver('iptables');
      const cloud = mockDriver('cloud-nat');
      app.kernel.registry.registerEgressIpDriver(ipt);
      app.kernel.registry.registerEgressIpDriver(cloud);
      await app.register(egressRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/',
        headers: asUser(),
        payload: { projectId: 11, ip: '198.51.100.1' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        driver: 'iptables',
        rule: { selector: { projectId: 11 }, ip: '198.51.100.1', createdAt: '2026-08-29T00:00:00Z' },
      });
      expect(ipt.attach).toHaveBeenCalledWith({ projectId: 11 }, '198.51.100.1');
      expect(cloud.attach).not.toHaveBeenCalled();
      await app.close();
    });

    it('answers 200 with { ok: false, error } when the named driver is not registered', async () => {
      // The driver is missing. The route's contract is a soft
      // 200 with an error envelope (NOT 4xx) so a plugin that
      // loses its driver can keep polling and recover when the
      // driver re-registers — the failure must not look like an
      // HTTP error to a CI / panel caller.
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(egressRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/',
        headers: asUser(),
        payload: { projectId: 1, ip: '203.0.113.1', driver: 'iptables' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: false,
        error: 'Egress IP driver "iptables" is not registered',
      });
      await app.close();
    });

    it('rejects a missing projectId with { ok: false, error }', async () => {
      const app = await buildTestApp({ db: createFakeDb() });
      const ipt = mockDriver('iptables');
      app.kernel.registry.registerEgressIpDriver(ipt);
      await app.register(egressRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/',
        headers: asUser(),
        payload: { ip: '203.0.113.1' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: false,
        error: '`projectId` is required (number)',
      });
      expect(ipt.attach).not.toHaveBeenCalled();
      await app.close();
    });

    it('rejects a missing/empty ip with { ok: false, error }', async () => {
      const app = await buildTestApp({ db: createFakeDb() });
      const ipt = mockDriver('iptables');
      app.kernel.registry.registerEgressIpDriver(ipt);
      await app.register(egressRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/',
        headers: asUser(),
        payload: { projectId: 7, ip: '' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: false,
        error: '`ip` is required (string)',
      });
      expect(ipt.attach).not.toHaveBeenCalled();
      await app.close();
    });

    it('rejects a non-string ip with { ok: false, error }', async () => {
      // Defensive — a number slipping through is the most common
      // caller bug (e.g. a front-end sending `{ ip: 203 }`).
      const app = await buildTestApp({ db: createFakeDb() });
      const ipt = mockDriver('iptables');
      app.kernel.registry.registerEgressIpDriver(ipt);
      await app.register(egressRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/',
        headers: asUser(),
        payload: { projectId: 7, ip: 203 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: false,
        error: '`ip` is required (string)',
      });
      expect(ipt.attach).not.toHaveBeenCalled();
      await app.close();
    });

    it('handles a missing request body (undefined req.body) without crashing', async () => {
      // The route does `req.body ?? {}` so a body-less POST
      // (or an empty object) is well-defined: both `projectId`
      // and `ip` are missing, and the `projectId` check fires
      // first. We send `{}` rather than an empty body because
      // fastify's body parser answers 400 before the route is
      // ever reached when the body is missing entirely.
      const app = await buildTestApp({ db: createFakeDb() });
      const ipt = mockDriver('iptables');
      app.kernel.registry.registerEgressIpDriver(ipt);
      await app.register(egressRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/',
        headers: asUser(),
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: false,
        error: '`projectId` is required (number)',
      });
      expect(ipt.attach).not.toHaveBeenCalled();
      await app.close();
    });

    it('falls through the `req.body ?? {}` guard when the body is a literal undefined', async () => {
      // With a custom body parser that returns `undefined` (e.g.
      // a legacy plugin that does not parse the body), the
      // route's `req.body ?? {}` must keep the validation chain
      // alive rather than throw on `req.body.projectId`. We
      // override the default JSON parser to return `undefined`
      // for this one request and assert the same `{ ok: false,
      // error: '`projectId` is required' }` shape.
      const app = await buildTestApp({ db: createFakeDb() });
      const ipt = mockDriver('iptables');
      app.kernel.registry.registerEgressIpDriver(ipt);
      app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, _body, done) => done(null, undefined));
      await app.register(egressRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/',
        headers: { ...asUser(), 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: false,
        error: '`projectId` is required (number)',
      });
      expect(ipt.attach).not.toHaveBeenCalled();
      await app.close();
    });

    it('uses DEFAULT_DRIVER ("iptables") in the error message when the unnamed driver is missing', async () => {
      // `driver ?? DEFAULT_DRIVER` fires when the request has
      // no `driver` field. The error message substitutes the
      // default so the operator knows which one was looked up.
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(egressRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/',
        headers: asUser(),
        payload: { projectId: 1, ip: '203.0.113.1' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: false,
        error: 'Egress IP driver "iptables" is not registered',
      });
      await app.close();
    });
  });

  describe('DELETE /:projectId', () => {
    it('detaches via the first registered driver', async () => {
      const app = await buildTestApp({ db: createFakeDb() });
      const ipt = mockDriver('iptables');
      const cloud = mockDriver('cloud-nat');
      app.kernel.registry.registerEgressIpDriver(ipt);
      app.kernel.registry.registerEgressIpDriver(cloud);
      await app.register(egressRoutes);
      const res = await app.inject({ method: 'DELETE', url: '/42', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, driver: 'iptables' });
      expect(ipt.detach).toHaveBeenCalledWith({ projectId: 42 });
      expect(cloud.detach).not.toHaveBeenCalled();
      await app.close();
    });

    it('r199: honours ?driver= and audits the detach', async () => {
      const app = await buildTestApp({ db: createFakeDb() });
      const ipt = mockDriver('iptables');
      const cloud = mockDriver('cloud-nat');
      app.kernel.registry.registerEgressIpDriver(ipt);
      app.kernel.registry.registerEgressIpDriver(cloud);
      await app.register(egressRoutes);
      const res = await app.inject({ method: 'DELETE', url: '/42?driver=cloud-nat', headers: asUser() });
      expect(res.json()).toEqual({ ok: true, driver: 'cloud-nat' });
      expect(cloud.detach).toHaveBeenCalledWith({ projectId: 42 });
      expect(ipt.detach).not.toHaveBeenCalled();
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), 'egress.detach', 'project:42', { driver: 'cloud-nat' }, expect.anything(),
      );
      const missing = await app.inject({ method: 'DELETE', url: '/42?driver=nope', headers: asUser() });
      expect(missing.json()).toEqual({ ok: false, error: 'Egress IP driver "nope" is not registered' });
      await app.close();
    });

    it('r199: audits an attach', async () => {
      const app = await buildTestApp({ db: createFakeDb() });
      app.kernel.registry.registerEgressIpDriver(mockDriver('iptables'));
      await app.register(egressRoutes);
      await app.inject({ method: 'POST', url: '/', headers: asUser(), payload: { projectId: 3, ip: '203.0.113.9' } });
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), 'egress.attach', 'project:3', { ip: '203.0.113.9', driver: 'iptables' }, expect.anything(),
      );
      await app.close();
    });

    it('rejects a non-numeric projectId with { ok: false, error }', async () => {
      const app = await buildTestApp({ db: createFakeDb() });
      const ipt = mockDriver('iptables');
      app.kernel.registry.registerEgressIpDriver(ipt);
      await app.register(egressRoutes);
      const res = await app.inject({ method: 'DELETE', url: '/not-a-number', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: false,
        error: '`projectId` must be a number',
      });
      expect(ipt.detach).not.toHaveBeenCalled();
      await app.close();
    });

    it('answers { ok: false, error } when no driver is registered', async () => {
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(egressRoutes);
      const res = await app.inject({ method: 'DELETE', url: '/7', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: false,
        error: 'No egress IP driver is registered',
      });
      await app.close();
    });

    it('accepts a projectId of 0 (Number.isFinite(0) is true)', async () => {
      // The validator uses `Number.isFinite` rather than `> 0`,
      // so 0 is a valid projectId. The driver decides what to
      // do with it; the route just passes it through.
      const app = await buildTestApp({ db: createFakeDb() });
      const ipt = mockDriver('iptables');
      app.kernel.registry.registerEgressIpDriver(ipt);
      await app.register(egressRoutes);
      const res = await app.inject({ method: 'DELETE', url: '/0', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, driver: 'iptables' });
      expect(ipt.detach).toHaveBeenCalledWith({ projectId: 0 });
      await app.close();
    });
  });
});
