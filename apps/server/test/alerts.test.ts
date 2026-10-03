import { describe, expect, it } from 'vitest';
import { alertRoutes } from '../src/modules/alerts.js';
import { asUser, buildTestApp, createFakeDb, tableName } from './helpers.js';

const NOW = new Date('2026-01-01T00:00:00Z');

const ruleRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  serviceId: null,
  name: 'high-cpu',
  metric: 'cpu',
  operator: '>',
  threshold: 80,
  durationWindows: 2,
  enabled: 1,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const stateRow = (over: Record<string, unknown> = {}) => ({
  ruleId: 1,
  status: 'ok',
  breachSince: null,
  firedAt: null,
  lastNotifiedAt: null,
  lastValue: null,
  updatedAt: NOW,
  ...over,
});

const asMember = (): Record<string, string> => ({ 'x-test-user': '2', 'x-test-role': 'member' });

describe('alert routes', () => {
  it('lists rules merged with their state', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          alertRules: [ruleRow({ id: 3, name: 'low-mem', metric: 'memory', operator: '<', threshold: 100 })],
          alertState: [stateRow({ ruleId: 3, status: 'firing', lastValue: 42 })],
        },
      }),
    });
    await app.register(alertRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        id: 3,
        serviceId: null,
        name: 'low-mem',
        metric: 'memory',
        operator: '<',
        threshold: 100,
        durationWindows: 2,
        enabled: true,
        status: 'firing',
        lastValue: 42,
        lastEvaluatedAt: '2026-01-01T00:00:00.000Z',
        firedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('lets members list rules', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(alertRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asMember() });
    expect(res.statusCode).toBe(200);
  });

  it("r281: a non-operator sees only rules on services they can see — not other tenants' or host-wide ones", async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          alertRules: [
            ruleRow({ id: 1, serviceId: null, name: 'host-disk' }),
            ruleRow({ id: 2, serviceId: 10, name: 'mine-cpu' }),
            ruleRow({ id: 3, serviceId: 20, name: 'other-tenant-cpu' }),
          ],
          alertState: [stateRow({ ruleId: 3, status: 'firing', lastValue: 97 })],
        },
        // User 2 owns service 10 only (and holds no workspace seat).
        select: { services: () => [{ id: 10 }] },
      }),
    });
    await app.register(alertRoutes);
    const member = await app.inject({ method: 'GET', url: '/', headers: asMember() });
    expect(member.statusCode).toBe(200);
    expect(member.json().map((r: { id: number }) => r.id)).toEqual([2]);
    expect(member.body).not.toContain('other-tenant-cpu');
    expect(member.body).not.toContain('host-disk');

    const operator = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(operator.json().map((r: { id: number }) => r.id)).toEqual([1, 2, 3]);
  });

  it('creates a rule with defaults and seeds its state', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ insert: { alert_rules: [ruleRow({ id: 9, name: 'cpu-hot', durationWindows: 1 })] } }),
    });
    await app.register(alertRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: 'cpu-hot', metric: 'cpu', threshold: 90 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 9, name: 'cpu-hot', operator: '>', durationWindows: 1, enabled: true, status: 'ok' });
  });

  it('rejects an invalid rule payload', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(alertRoutes);
    const res = await app.inject({ method: 'POST', url: '/', headers: asUser(), payload: { name: 'x' } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a service-scoped cert-expiry rule (host-wide metric)', async () => {
    const app = await buildTestApp({ db: createFakeDb({ insert: { alert_rules: [ruleRow({ id: 6, metric: 'cert-expiry' })] } }) });
    await app.register(alertRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: 'cert', metric: 'cert-expiry', threshold: 14, serviceId: 3 },
    });
    expect(res.statusCode).toBe(400);
    // Host-wide cert-expiry stays valid.
    const okRes = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: 'cert-host', metric: 'cert-expiry', threshold: 14 },
    });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.statusCode).toBe(200);
  });

  it('forbids members from creating rules', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(alertRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asMember(),
      payload: { name: 'x', metric: 'cpu', threshold: 1 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('patches a rule and resets its breach state', async () => {
    let deleted = false;
    const db = createFakeDb({
      update: { alert_rules: [ruleRow({ id: 4, threshold: 50, enabled: false })] },
    });    const rawDelete = db.delete.bind(db);
    (db as unknown as { delete: unknown }).delete = (table: unknown) => {
      if (tableName(table) === 'alert_state') deleted = true;
      return rawDelete(table);
    };
    const app = await buildTestApp({ db });
    await app.register(alertRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/4',
      headers: asUser(),
      payload: { threshold: 50, enabled: false },
    });
    if (res.statusCode !== 200) console.log('PATCH BODY', res.body);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 4, threshold: 50, enabled: false });
    expect(deleted).toBe(true);
  });

  it('applies only the fields present in the patch', async () => {
    let setPatch: Record<string, unknown> | null = null;
    const app = await buildTestApp({
      db: createFakeDb({
        update: {
          alert_rules: (patch: unknown) => {
            setPatch = patch as Record<string, unknown>;
            return [ruleRow({ id: 4 })];
          },
        },
      }),
    });
    await app.register(alertRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/4',
      headers: asUser(),
      payload: { name: 'renamed', metric: 'memory', operator: '<', threshold: 100, durationWindows: 5, enabled: false, serviceId: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(setPatch).toMatchObject({
      name: 'renamed',
      metric: 'memory',
      operator: '<',
      threshold: 100,
      durationWindows: 5,
      enabled: false,
      serviceId: 2,
    });
  });

  it('patches only the serviceId to null', async () => {
    let setPatch: Record<string, unknown> | null = null;
    const app = await buildTestApp({
      db: createFakeDb({
        update: {
          alert_rules: (patch: unknown) => {
            setPatch = patch as Record<string, unknown>;
            return [ruleRow({ id: 4, serviceId: null })];
          },
        },
      }),
    });
    await app.register(alertRoutes);
    const res = await app.inject({ method: 'PATCH', url: '/4', headers: asUser(), payload: { serviceId: null } });
    expect(res.statusCode).toBe(200);
    expect(setPatch).toEqual({ serviceId: null });
  });

  it('patches a rule with an empty body', async () => {
    const app = await buildTestApp({ db: createFakeDb({ update: { alert_rules: [ruleRow({ id: 5 })] } }) });
    await app.register(alertRoutes);
    const res = await app.inject({ method: 'PATCH', url: '/5', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 5 });
  });

  it('returns 404 when patching a missing rule', async () => {
    const app = await buildTestApp({ db: createFakeDb({ update: { alert_rules: [] } }) });
    await app.register(alertRoutes);
    const res = await app.inject({ method: 'PATCH', url: '/99', headers: asUser(), payload: { threshold: 1 } });
    expect(res.statusCode).toBe(404);
  });

  it('forbids members from patching rules', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(alertRoutes);
    const res = await app.inject({ method: 'PATCH', url: '/1', headers: asMember(), payload: { threshold: 1 } });
    expect(res.statusCode).toBe(403);
  });

  it('deletes a rule', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(alertRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/5', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('requires authentication', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(alertRoutes);
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(401);
  });
});
