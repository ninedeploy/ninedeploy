/**
 * r656: bundle import against a migrated SQLite — the transaction, the owner
 * and the domain claim rules are database behaviour a fake cannot show.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, domains, services, users, webhooks, type DB } from '@ninedeploy/db';

// The retained-volume probe asks Docker.
vi.mock('../src/lib/retainedSlugVolume.js', () => ({ assertSlugVolumeNotRetained: vi.fn(async () => undefined) }));

const { serviceMigrationRoutes } = await import('../src/modules/serviceMigration.js');
const { asUser, buildTestApp } = await import('./helpers.js');

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));

let db: DB;
let close: () => void;
let dir: string;
let opId: number;

// A file database: the import runs a transaction, and an in-memory libsql
// client has a single connection that a transaction holds.
beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-import-'));
  const created = createDb({ url: `file:${path.join(dir, 't.db').split(path.sep).join('/')}` });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const [op] = await db.insert(users).values({ email: 'op@x', passwordHash: 'h', isInstanceOperator: true }).returning();
  opId = op!.id;
});

afterEach(() => {
  close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

const bundle = (over: Record<string, unknown> = {}) => ({
  version: '1.0.0',
  exportedAt: '2026-01-01T00:00:00.000Z',
  service: { name: 'Imported', type: 'docker', repoUrl: null, branch: 'main', image: 'nginx:1', port: 80, volumeMount: null, healthPath: '/', cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0 },
  buildConfig: null,
  envVars: [{ key: 'PORT', value: '80', isSecret: false }],
  domains: [{ hostname: 'shop.example.com', path: '/', ssl: true }],
  webhooks: [{ branch: 'main', events: ['push'], secret: 's3cret' }],
  attachments: [],
  ...over,
});

async function importBundle(payload: unknown) {
  const app = await buildTestApp({ db });
  await app.register(serviceMigrationRoutes, { prefix: '/services' });
  const res = await app.inject({ method: 'POST', url: '/services/import', headers: asUser({ id: opId }), payload: payload as object });
  await app.close();
  return res;
}

describe('POST /services/import (r656)', () => {
  it('the importing operator owns the new service and its domain goes live', async () => {
    const res = await importBundle(bundle());
    expect(res.statusCode).toBe(200);
    const [svc] = await db.select().from(services);
    expect(svc!.ownerUserId).toBe(opId);
    const [d] = await db.select().from(domains);
    expect(d).toMatchObject({ serviceId: svc!.id, hostname: 'shop.example.com', status: 'active' });
  });

  it('refuses a hostname another service routes with a 409 naming it, and writes nothing', async () => {
    const [other] = await db.insert(services).values({ name: 'shop', slug: 'shop', ownerUserId: opId }).returning();
    await db.insert(domains).values({ serviceId: other!.id, hostname: 'shop.example.com', path: '/', status: 'active' });
    const res = await importBundle(bundle());
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain(`shop.example.com is already routed by service #${other!.id}`);
    expect(await db.select().from(services)).toHaveLength(1);
  });

  it('refuses stacking a longer path onto another service\u2019s hostname', async () => {
    const [other] = await db.insert(services).values({ name: 'shop', slug: 'shop', ownerUserId: opId }).returning();
    await db.insert(domains).values({ serviceId: other!.id, hostname: 'shop.example.com', path: '/', status: 'active' });
    const res = await importBundle(bundle({ domains: [{ hostname: 'Shop.Example.com', path: '/admin', ssl: true }] }));
    expect(res.statusCode).toBe(409);
    expect(await db.select().from(domains)).toHaveLength(1);
  });

  it('rolls the whole import back when a later write fails', async () => {
    // Any failure after the service row: simulated with a trigger on webhooks.
    await db.run(sql`CREATE TRIGGER fail_webhooks BEFORE INSERT ON webhooks BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    const res = await importBundle(bundle());
    expect(res.statusCode).toBe(500);
    expect(await db.select().from(services)).toHaveLength(0);
    expect(await db.select().from(domains)).toHaveLength(0);
    expect(await db.select().from(webhooks)).toHaveLength(0);
  });

  it('rejects a malformed webhook or domain with a 400 before writing anything', async () => {
    const bad = await importBundle(bundle({ webhooks: [{ branch: 'main', events: ['push'], secret: 42 }] }));
    expect(bad.statusCode).toBe(400);
    const badDomain = await importBundle(bundle({ domains: [{ hostname: 'x.example.com', path: 'no-slash', ssl: true }] }));
    expect(badDomain.statusCode).toBe(400);
    expect(await db.select().from(services)).toHaveLength(0);
  });
});
