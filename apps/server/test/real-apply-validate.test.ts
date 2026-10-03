/**
 * Real end-to-end DB validation: runs applyManifestToService against an
 * in-memory SQLite database with the real Drizzle schema and migrations.
 * Proves routes, alerts, and database attachment actually persist to DB.
 *
 * Run with:
 *   pnpm --filter @ninedeploy/server exec vitest run test/real-apply-validate.test.ts --reporter=verbose
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { describe, expect, it, beforeAll } from 'vitest';
import {
  alertRules,
  createDb,
  databases,
  databaseAttachments,
  domains,
  services,
  users,
  workspaceMembers,
  workspaces,
  type DB,
} from '@ninedeploy/db';
import { loadNinedeployManifest } from '../src/lib/ninedeployManifest.js';
import { applyManifestToService } from '../src/lib/applyManifestToService.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const FIXTURE_DIR = resolve(REPO_ROOT, '.tmp-real-validate', 'nextjs-test');
const MIGRATIONS = fileURLToPath(
  new URL(`file://${resolve(REPO_ROOT, 'packages/db/src/migrations').replace(/\\/g, '/')}`),
);

describe('real e2e: applyManifestToService against in-memory DB with real schema', () => {
  let db: DB;
  let serviceId: number;
  let dbRowId: number;

  beforeAll(async () => {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    const yaml = [
      'version: "1"',
      'runtime:',
      '  type: node',
      '  version: "20"',
      'build:',
      '  install: "npm ci"',
      '  build: "npm run build"',
      '  start: "npm start"',
      'run:',
      '  port: 3000',
      '  healthcheck: "/api/health"',
      '  restart: unless-stopped',
      'env:',
      '  required:',
      '    - DATABASE_URL',
      '    - STRIPE_SECRET_KEY',
      '  aliases:',
      '    POSTGRES_URL: DATABASE_URL',
      'routes:',
      '  - host: nextjs-test.example.com',
      '    path: /',
      '    ssl: true',
      '    headers:',
      '      X-Frame-Options: DENY',
      '    ipAllowlist:',
      '      - 10.0.0.0/8',
      '    rateLimit:',
      '      average: 100',
      '      burst: 200',
      'database:',
      '  ref: primary-postgres',
      '  env: DATABASE_URL',
      'alerts:',
      '  - when: highMemory',
      '    channel: oncall',
      '    thresholdPct: 85',
      '  - when: deployFailed',
      '    channel: deploys',
      '',
    ].join('\n');
    writeFileSync(resolve(FIXTURE_DIR, '.ninedeploy'), yaml, 'utf8');

    db = createDb({ url: ':memory:' }).db;
    await migrate(db, { migrationsFolder: MIGRATIONS });

    const [svc] = await db
      .insert(services)
      .values({
        name: 'nextjs-test',
        slug: 'nextjs-test',
        type: 'docker',
        port: 3000,
        healthPath: '/api/health',
      })
      .returning();
    if (!svc) throw new Error('failed to insert service');
    serviceId = svc.id;

    // The deploying service's owner must resolve through the attachment gate:
    // an operator owner makes visibleDatabaseIds unrestricted for these tests.
    // `isInstanceOperator` is an explicit column since migration 0038 — an
    // 'owner' workspace seat no longer implies operator rights.
    await db.insert(users).values({ id: 9, email: 'deploy-owner@example.com', passwordHash: 'h', isInstanceOperator: true });
    const [ws] = await db.insert(workspaces).values({ name: 'acme', slug: 'acme', ownerId: 9 }).returning();
    await db.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: 9, role: 'owner' });

    // Use the Drizzle schema directly — bug #1 (the owner_user_id drift) is
    // fixed by migration 0036, so this works without raw SQL.
    const [dbRow] = await db
      .insert(databases)
      .values({
        name: 'Primary Postgres',
        slug: 'primary-postgres',
        engine: 'postgres',
        version: '16',
        passwordEncrypted: 'encrypted-blob',
      })
      .returning();
    if (!dbRow) throw new Error('failed to insert database via Drizzle');
    dbRowId = dbRow.id;
  });

  it('loads the real Next.js .ninedeploy from disk', () => {
    const loaded = loadNinedeployManifest(FIXTURE_DIR);
    expect(loaded).not.toBeNull();
    expect(loaded!.manifest.version).toBe('1');
    expect(loaded!.manifest.runtime?.type).toBe('node');
    expect(loaded!.manifest.runtime?.version).toBe('20');
    expect(loaded!.manifest.routes).toHaveLength(1);
    expect(loaded!.manifest.alerts).toHaveLength(2);
    expect(loaded!.manifest.database?.ref).toBe('primary-postgres');
  });

  it('applyManifestToService persists routes to domains table', async () => {
    const loaded = loadNinedeployManifest(FIXTURE_DIR);
    expect(loaded).not.toBeNull();
    const result = await applyManifestToService(db, serviceId, loaded!.manifest, 9);
    expect(result.routesUpserted).toBe(1);
    expect(result.databaseAttached).toBe(true);
    // Only `highMemory` becomes a rule. `deployFailed` is event-shaped and the
    // alert engine evaluates metric samples, so it is reported as skipped
    // rather than written out as a `cert-expiry < 0` rule that can never fire.
    expect(result.alertsUpserted).toBe(1);
    expect(result.warnings.some((w) => w.includes('when="deployFailed"'))).toBe(true);

    const routeRows = await db.select().from(domains).where(eq(domains.serviceId, serviceId));
    expect(routeRows).toHaveLength(1);
    const r = routeRows[0]!;
    expect(r.hostname).toBe('nextjs-test.example.com');
    expect(r.path).toBe('/');
    expect(r.ssl).toBe(true);
    expect(r.status).toBe('pending');
    expect(r.ipAllowlist).toBe('10.0.0.0/8');
    expect(r.rateLimitAverage).toBe(100);
    expect(r.rateLimitBurst).toBe(200);
    expect(r.headers).toContain('X-Frame-Options');
  });

  it('applyManifestToService persists alerts to alert_rules table', async () => {
    const alertRows = await db.select().from(alertRules).where(eq(alertRules.serviceId, serviceId));
    expect(alertRows).toHaveLength(1);
    // Nothing was written for the event-shaped `deployFailed` alert.
    expect(alertRows.some((a) => a.metric === 'cert-expiry')).toBe(false);
    const mem = alertRows.find((a) => a.metric === 'memory');
    expect(mem).toBeDefined();
    expect(mem!.threshold).toBe(85);
    expect(mem!.operator).toBe('>');
    expect(mem!.enabled).toBe(true);
  });

  it('applyManifestToService persists database attachment', async () => {
    const attachRows = await db
      .select()
      .from(databaseAttachments)
      .where(eq(databaseAttachments.serviceId, serviceId));
    expect(attachRows).toHaveLength(1);
    expect(attachRows[0]!.databaseId).toBe(dbRowId);
    expect(attachRows[0]!.envAlias).toBe('DATABASE_URL');
  });

  it('applyManifestToService is idempotent (re-run does not duplicate)', async () => {
    const loaded = loadNinedeployManifest(FIXTURE_DIR);
    expect(loaded).not.toBeNull();
    const before = {
      domains: (await db.select().from(domains).where(eq(domains.serviceId, serviceId))).length,
      alerts: (await db.select().from(alertRules).where(eq(alertRules.serviceId, serviceId))).length,
      attach: (
        await db.select().from(databaseAttachments).where(eq(databaseAttachments.serviceId, serviceId))
      ).length,
    };
    await applyManifestToService(db, serviceId, loaded!.manifest, 9);
    const after = {
      domains: (await db.select().from(domains).where(eq(domains.serviceId, serviceId))).length,
      alerts: (await db.select().from(alertRules).where(eq(alertRules.serviceId, serviceId))).length,
      attach: (
        await db.select().from(databaseAttachments).where(eq(databaseAttachments.serviceId, serviceId))
      ).length,
    };
    expect(after.domains).toBe(before.domains);
    expect(after.alerts).toBe(before.alerts);
    expect(after.attach).toBe(before.attach);
  });

  it('applyManifestToService reports a missing database without crashing', async () => {
    const loaded = loadNinedeployManifest(FIXTURE_DIR);
    expect(loaded).not.toBeNull();
    const ghostManifest = {
      ...loaded!.manifest,
      database: { ref: 'does-not-exist', env: 'DATABASE_URL' },
    };
    const result = await applyManifestToService(db, serviceId, ghostManifest, 9);
    expect(result.databaseAttached).toBe(false);
    expect(result.databaseNotFound).toBe('does-not-exist');
    expect(result.warnings.some((w) => w.includes('does-not-exist'))).toBe(true);
  });
});

