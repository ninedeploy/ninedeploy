/**
 * 0.16.1 Getting started checklist (`GET /v1/onboarding`) against a real
 * migrated SQLite: each step is derived from state the panel already has.
 */
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backupDestinations,
  createDb,
  type DB,
  deployments,
  domains,
  notificationChannels,
  services,
  sources,
  users,
} from '@ninedeploy/db';

const cfg = vi.hoisted(() => ({
  config: {
    wildcardDomain: '',
    publicUrl: 'http://203.0.113.10:3000',
    isProd: false,
    paths: { dataDir: '/tmp', masterKeyFile: '/tmp/master.key' },
    jwt: { secret: 'x', accessTtl: '15m', refreshTtl: '7d' },
    port: 3000,
  },
}));
vi.mock('../src/config.js', () => cfg);
const auditMock = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMock);
const acme = vi.hoisted(() => ({ email: null as string | null }));
vi.mock('../src/engine/proxy.js', () => ({ getAcmeEmail: vi.fn(async () => acme.email) }));

const { onboardingRoutes } = await import('../src/modules/onboarding.js');
const { setAutoUrlConfig } = await import('../src/lib/autoUrl.js');
const { asUser, buildTestApp } = await import('./helpers.js');

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));

let db: DB;
let close: () => void;

beforeEach(async () => {
  acme.email = null;
  const created = createDb({ url: ':memory:' });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: 'x' });
  await setAutoUrlConfig(db, { mode: 'off' });
});
afterEach(() => close());

async function app() {
  const a = await buildTestApp({ db });
  await a.register(onboardingRoutes);
  return a;
}
const op = () => asUser({ id: 1, isOperator: true });
const stepMap = (body: { steps: { id: string; done: boolean }[] }) =>
  Object.fromEntries(body.steps.map((s) => [s.id, s.done]));

describe('GET /onboarding', () => {
  it('starts with nothing done on an empty instance', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/', headers: op() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ completed: 0, total: 8, ready: false, dismissed: false });
    expect(Object.values(stepMap(body)).every((d) => d === false)).toBe(true);
  });

  it('ticks each step off from real state, and is ready once the required ones are done', async () => {
    await setAutoUrlConfig(db, { mode: 'sslip', ip: '203.0.113.10' });
    await db.insert(sources).values({ name: 'gh', type: 'github' });
    const [svc] = await db.insert(services).values({ name: 'web', slug: 'web' }).returning();
    await db.insert(deployments).values({ serviceId: svc!.id, status: 'superseded' });
    // A minted name does not count as the operator's own domain…
    await db.insert(domains).values({ serviceId: svc!.id, hostname: 'web.203.0.113.10.sslip.io', path: '/', status: 'active' });
    let body = (await (await app()).inject({ method: 'GET', url: '/', headers: op() })).json();
    expect(stepMap(body)).toMatchObject({ auto_url: true, git_source: true, first_service: true, first_deploy: true, custom_domain: false });
    expect(body.ready).toBe(true);

    // …a real one does; so do ACME, a channel and a backup destination.
    await db.insert(domains).values({ serviceId: svc!.id, hostname: 'shop.example.com', path: '/', status: 'active' });
    await db.insert(notificationChannels).values({ name: 'ops', type: 'webhook', targetEncrypted: 'v1:x' });
    await db
      .insert(backupDestinations)
      .values({ name: 'R2', endpoint: 'https://r2.invalid', bucket: 'b', accessKeyId: 'k', secretKeyEncrypted: 'v1:s' });
    acme.email = 'ops@example.com';
    body = (await (await app()).inject({ method: 'GET', url: '/', headers: op() })).json();
    expect(body.completed).toBe(8);
  });

  it('does not count a queued or failed deploy, or a pending domain', async () => {
    const [svc] = await db.insert(services).values({ name: 'web', slug: 'web' }).returning();
    await db.insert(deployments).values([{ serviceId: svc!.id, status: 'failed' }, { serviceId: svc!.id, status: 'queued' }]);
    await db.insert(domains).values({ serviceId: svc!.id, hostname: 'shop.example.com', path: '/', status: 'pending' });
    const body = (await (await app()).inject({ method: 'GET', url: '/', headers: op() })).json();
    expect(stepMap(body)).toMatchObject({ first_service: true, first_deploy: false, custom_domain: false, auto_url: false });
  });

  it('remembers a dismissal and audits it', async () => {
    const a = await app();
    const put = await a.inject({ method: 'PUT', url: '/dismissed', headers: op(), payload: { dismissed: true } });
    expect(put.json()).toEqual({ ok: true, dismissed: true });
    expect((await a.inject({ method: 'GET', url: '/', headers: op() })).json().dismissed).toBe(true);
    expect(auditMock.audit).toHaveBeenCalledWith(db, 1, 'onboarding.dismiss', 'hidden');
  });

  it('is operator-only', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/', headers: asUser({ id: 1, isOperator: false }) });
    expect(res.statusCode).toBe(403);
  });
});
