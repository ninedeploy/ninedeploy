/**
 * G5.4 Sentry-compatible ingest on a migrated SQLite: envelopes as the SDKs
 * send them (plain and gzip), the three places a DSN key travels, grouping
 * into issues, the deploy an issue is linked to, regressions, the rate
 * window, and retention.
 */
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deployments, errorEvents, errorIssues, services, users, type DB } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});
const audit = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../src/lib/audit.js', () => ({ audit }));
vi.mock('../src/lib/panelOrigin.js', () => ({ panelOrigin: vi.fn(async () => 'https://panel.example.com') }));

const lib = await import('../src/lib/errorIngest.js');
const { errorIngestPublicRoutes, serviceErrorRoutes } = await import('../src/modules/errorIngest.js');
const { buildTestApp, asUser } = await import('./helpers.js');
const { closeMigratedDb, migratedDb } = await import('./lib/githubAppKit.js');

let db: DB;
beforeEach(async () => {
  audit.mockClear();
  lib.resetIngestWindows();
  db = await migratedDb();
  await db.insert(users).values({ id: 1, email: 'a@example.com', passwordHash: 'x' });
  await db.insert(services).values({ id: 5, name: 'api', slug: 'api', type: 'docker', branch: 'main', ownerUserId: 1, image: 'nginx' } as never);
  await db.insert(deployments).values([
    { id: 40, serviceId: 5, status: 'superseded', commitSha: 'aaaaaaa1111111111111111111111111111111aa' },
    { id: 41, serviceId: 5, status: 'running', commitSha: 'bbbbbbb2222222222222222222222222222222bb' },
  ] as never);
});
afterEach(() => closeMigratedDb(db));

async function app() {
  const a = await buildTestApp({ db });
  await a.register(errorIngestPublicRoutes);
  await a.register(serviceErrorRoutes, { prefix: '/services' });
  return a;
}

/** A TypeError thrown in handler() of src/app.js, as @sentry/node reports it. */
const event = (o: { id?: string; release?: string; line?: number; value?: string } = {}) => ({
  event_id: o.id ?? 'a'.repeat(32),
  level: 'error',
  platform: 'node',
  release: o.release,
  environment: 'production',
  exception: {
    values: [
      {
        type: 'TypeError',
        value: o.value ?? "Cannot read properties of undefined (reading 'id')",
        stacktrace: {
          frames: [
            { filename: 'node:internal/process', function: 'processTicks', in_app: false },
            { filename: '/app/src/app.js', module: 'app', function: 'handler', lineno: o.line ?? 10, in_app: true },
          ],
        },
      },
    ],
  },
});

const envelope = (ev: object, dsn?: string) =>
  [JSON.stringify({ event_id: 'a'.repeat(32), sent_at: new Date().toISOString(), ...(dsn ? { dsn } : {}) }), JSON.stringify({ type: 'event' }), JSON.stringify(ev), ''].join('\n');

describe('ingest', () => {
  it('groups one error into one issue across lines and releases, and links the deploy of its release', async () => {
    const a = await app();
    const { dsn } = (await a.inject({ method: 'POST', url: '/services/5/error-ingest', headers: asUser(1) })).json();
    const key = new URL(dsn).username;
    expect(dsn).toBe(`https://${key}@panel.example.com/5`);
    const send = (body: string | Buffer, headers: Record<string, string> = {}, query = '') =>
      a.inject({ method: 'POST', url: `/api/5/envelope/${query}`, headers: { 'content-type': 'application/x-sentry-envelope', ...headers }, payload: body });

    // Header auth, release = an older deploy's commit.
    const first = await send(envelope(event({ release: 'aaaaaaa' })), { 'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${key}, sentry_client=sentry.javascript.node/8.0.0` });
    expect(first.statusCode).toBe(200);
    expect(first.headers['access-control-allow-origin']).toBe('*');
    // Query auth, gzip, another line number: the same issue.
    expect((await send(gzipSync(envelope(event({ id: 'b'.repeat(32), line: 99 }))), { 'content-encoding': 'gzip' }, `?sentry_key=${key}`)).statusCode).toBe(200);
    // Envelope dsn auth.
    expect((await send(envelope(event({ id: 'c'.repeat(32) }), dsn))).statusCode).toBe(200);

    const issues = (await a.inject({ method: 'GET', url: '/services/5/errors', headers: asUser(1) })).json();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ title: "TypeError: Cannot read properties of undefined (reading 'id')", culprit: 'handler (app)', count: 3, firstDeploymentId: 40, lastDeploymentId: 41, firstRelease: 'aaaaaaa' });
    // The alert names the issue, never the sender's text.
    expect(audit).toHaveBeenCalledWith(db, null, 'alert.error_new', `api: new error issue #${issues[0].id}`, expect.objectContaining({ serviceId: 5 }));
    expect(audit).toHaveBeenCalledTimes(2); // the key, then the new issue

    const detail = (await a.inject({ method: 'GET', url: `/services/5/errors/${issues[0].id}`, headers: asUser(1) })).json();
    expect(detail.events).toHaveLength(3);
    expect(detail.events[2]).toMatchObject({ release: 'aaaaaaa', environment: 'production', deploymentId: 40 });
    await a.close();
  });

  it('reopens a resolved issue when it happens again, and keeps a different error apart', async () => {
    const a = await app();
    const { dsn } = (await a.inject({ method: 'POST', url: '/services/5/error-ingest', headers: asUser(1) })).json();
    const post = (ev: object) => a.inject({ method: 'POST', url: '/api/5/envelope/', headers: { 'content-type': 'text/plain' }, payload: envelope(ev, dsn) });
    await post(event());
    const [issue] = await db.select().from(errorIssues);
    expect((await a.inject({ method: 'PATCH', url: `/services/5/errors/${issue!.id}`, headers: asUser(1), payload: { status: 'resolved' } })).json().status).toBe('resolved');
    await post(event({ id: 'd'.repeat(32) }));
    expect((await db.select().from(errorIssues))[0]!.status).toBe('unresolved');
    expect(audit).toHaveBeenCalledWith(db, null, 'alert.error_regressed', expect.any(String), expect.any(Object));
    await post({ event_id: 'e'.repeat(32), message: 'Payment provider timed out after 3000 ms' });
    await post({ event_id: 'f'.repeat(32), message: 'Payment provider timed out after 4500 ms' });
    const all = await db.select().from(errorIssues);
    expect(all).toHaveLength(2);
    expect(all.find((i) => i.title.startsWith('Payment'))?.count).toBe(2);
    await a.close();
  });

  it('refuses a wrong or removed key, a broken envelope and a flood', async () => {
    const a = await app();
    const { dsn } = (await a.inject({ method: 'POST', url: '/services/5/error-ingest', headers: asUser(1) })).json();
    const post = (body: string, k: string) => a.inject({ method: 'POST', url: `/api/5/envelope/?sentry_key=${k}`, headers: { 'content-type': 'text/plain' }, payload: body });
    const key = new URL(dsn).username;
    expect((await post(envelope(event()), 'f'.repeat(32))).statusCode).toBe(401);
    expect((await post('not json', key)).statusCode).toBe(400);
    // Another service's DSN path with this key.
    expect((await a.inject({ method: 'POST', url: `/api/6/envelope/?sentry_key=${key}`, headers: { 'content-type': 'text/plain' }, payload: envelope(event()) })).statusCode).toBe(401);
    const saved = lib.INGEST_RATE.perMinute;
    lib.INGEST_RATE.perMinute = 2;
    try {
      expect((await post(envelope(event()), key)).statusCode).toBe(200);
      expect((await post(envelope(event()), key)).statusCode).toBe(200);
      const limited = await post(envelope(event()), key);
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['x-sentry-rate-limits']).toBe('60:error:project');
    } finally {
      lib.INGEST_RATE.perMinute = saved;
    }
    await a.inject({ method: 'DELETE', url: '/services/5/error-ingest', headers: asUser(1) });
    lib.resetIngestWindows();
    expect((await post(envelope(event()), key)).statusCode).toBe(401);
    await a.close();
  });

  it('skips non-event items and decodes length-prefixed payloads', () => {
    const ev = JSON.stringify(event());
    const raw = Buffer.from(
      [JSON.stringify({}), JSON.stringify({ type: 'session' }), '{"sid":"x"}', JSON.stringify({ type: 'event', length: Buffer.byteLength(ev) }), ev].join('\n'),
    );
    expect(lib.parseEnvelope(raw).events).toHaveLength(1);
  });
});

describe('bounds (a browser DSN is public)', () => {
  it('keeps the latest events of an issue, stores a retried event once, folds issues past the cap and pauses alerts past the budget', async () => {
    const saved = { ...lib.ERROR_LIMITS };
    const savedBudget = lib.ALERT_BUDGET.perHour;
    lib.ERROR_LIMITS.eventsPerIssue = 2;
    lib.ERROR_LIMITS.firstEventsKept = 1;
    lib.ERROR_LIMITS.issuesPerService = 2;
    lib.ALERT_BUDGET.perHour = 1;
    try {
      const a = await app();
      const { dsn } = (await a.inject({ method: 'POST', url: '/services/5/error-ingest', headers: asUser(1) })).json();
      const post = (ev: object) => a.inject({ method: 'POST', url: '/api/5/envelope/', headers: { 'content-type': 'text/plain' }, payload: envelope(ev, dsn) });
      for (const id of ['1', '2', '3', '3']) await post(event({ id: id.repeat(32) }));
      const [first] = await db.select().from(errorIssues);
      expect(first!.count).toBe(4);
      // The first event stays; the latest replaces the one before it.
      expect((await db.select().from(errorEvents)).map((e) => e.eventId)).toEqual(['1'.repeat(32), '3'.repeat(32)]);
      // A second distinct issue fits; the third and fourth fold into the overflow issue.
      await post({ event_id: 'a'.repeat(32), message: 'second' });
      await post({ event_id: 'b'.repeat(32), message: 'third' });
      await post({ event_id: 'c'.repeat(32), message: 'fourth' });
      const all = await db.select().from(errorIssues);
      expect(all.map((i) => i.fingerprint).filter((f) => f === 'overflow')).toHaveLength(1);
      expect(all).toHaveLength(3);
      expect(all.find((i) => i.fingerprint === 'overflow')?.count).toBe(2);
      const actions = audit.mock.calls.map((c) => (c as unknown[])[2]);
      // The first issue alerts, the second hits the budget (burst), and the overflow issue alerts regardless.
      expect(actions.filter((x) => x === 'alert.error_new')).toHaveLength(2);
      expect(actions.filter((x) => x === 'alert.error_burst')).toHaveLength(1);
      // Resolving makes room: a new fingerprint gets its own issue again.
      const second = all.find((i) => i.title === 'second')!;
      await a.inject({ method: 'PATCH', url: `/services/5/errors/${second.id}`, headers: asUser(1), payload: { status: 'resolved' } });
      await post({ event_id: 'd'.repeat(32), message: 'fifth' });
      expect((await db.select().from(errorIssues)).some((i) => i.title === 'fifth')).toBe(true);
      await a.close();
    } finally {
      Object.assign(lib.ERROR_LIMITS, saved);
      lib.ALERT_BUDGET.perHour = savedBudget;
    }
  });
});

describe('retention', () => {
  it('drops events after 30 days and issues not seen for 90', async () => {
    const now = Date.now();
    const day = 86_400_000;
    await db.insert(errorIssues).values([
      { id: 1, serviceId: 5, fingerprint: 'a', title: 'old', firstSeen: new Date(now - 100 * day), lastSeen: new Date(now - 95 * day) },
      { id: 2, serviceId: 5, fingerprint: 'b', title: 'live', firstSeen: new Date(now - 100 * day), lastSeen: new Date(now - day) },
    ] as never);
    await db.insert(errorEvents).values([
      { issueId: 2, payload: '{}', receivedAt: new Date(now - 40 * day) },
      { issueId: 2, payload: '{}', receivedAt: new Date(now - day) },
    ] as never);
    expect(await lib.pruneErrorEvents(db, now)).toEqual({ events: 1, issues: 1 });
    expect((await db.select().from(errorIssues)).map((i) => i.title)).toEqual(['live']);
    expect(await db.select().from(errorEvents)).toHaveLength(1);
  });
});
