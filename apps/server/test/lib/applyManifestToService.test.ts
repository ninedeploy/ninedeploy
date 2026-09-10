/**
 * Tests for the manifest → service orchestrator. Uses an in-memory SQLite
 * with the real Drizzle schema so the SQL semantics (unique indexes,
 * cascades, default values) are exercised end-to-end — no mocks.
 */
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  alertRules,
  alertState,
  createDb,
  databases,
  databaseAttachments,
  domains,
  notificationChannels,
  scheduledJobs,
  serviceNotificationChannels,
  services,
  users,
  workspaceMembers,
  workspaces,
  type DB,
} from '@ninedeploy/db';
import { MANIFEST_BACKUP_JOB_NAME, applyManifestToService } from '../../src/lib/applyManifestToService.js';
import { evaluateAlerts } from '../../src/lib/alerting.js';
import type { NinedeployManifest } from '@ninedeploy/schemas';

const migrationsFolder = fileURLToPath(
  new URL('../../../../packages/db/src/migrations', import.meta.url),
);

const m = (over: Partial<NinedeployManifest>): NinedeployManifest => ({
  version: '1',
  ...over,
});

let db: DB;
let serviceId: number;

beforeAll(async () => {
  db = createDb({ url: ':memory:' }).db;
  await migrate(db, { migrationsFolder });
});

beforeEach(async () => {
  // Wipe child tables before parents because of FK cascades (parents reference
  // parents). Order matters: leaves first, then services, then databases.
  await db.delete(alertRules);
  await db.delete(domains);
  await db.delete(databaseAttachments);
  await db.delete(services);
  await db.delete(databases);

  const [svc] = await db
    .insert(services)
    .values({
      name: 'web',
      slug: 'web',
      type: 'docker',
      port: 3000,
      healthPath: '/',
    })
    .returning();
  serviceId = svc!.id;
});

afterEach(async () => {
  // Cleanup is handled in beforeEach.
});

describe('applyManifestToService — routes', () => {
  it('inserts a domain in pending state for each declared route', async () => {
    const result = await applyManifestToService(
      db,
      serviceId,
      m({
        routes: [
          {
            host: 'app.example.com',
            path: '/',
            ssl: true,
            headers: { 'X-Frame-Options': 'DENY' },
            ipAllowlist: ['1.2.3.4/32', '10.0.0.0/8'],
            rateLimit: { average: 50, burst: 100 },
          },
        ],
      }),
    );
    expect(result.routesUpserted).toBe(1);

    const rows = await db.query.domains.findMany({ where: eq(domains.serviceId, serviceId) });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.hostname).toBe('app.example.com');
    expect(r.path).toBe('/');
    expect(r.ssl).toBe(true);
    expect(r.status).toBe('pending');
    expect(r.headers).toBe(JSON.stringify([{ name: 'X-Frame-Options', value: 'DENY' }]));
    expect(r.ipAllowlist).toBe('1.2.3.4/32, 10.0.0.0/8');
    expect(r.rateLimitAverage).toBe(50);
    expect(r.rateLimitBurst).toBe(100);
  });

  it('normalises the hostname to lowercase (DNS is case-insensitive)', async () => {
    await applyManifestToService(
      db,
      serviceId,
      m({ routes: [{ host: 'APP.Example.COM', path: '/' }] }),
    );
    const [r] = await db.select().from(domains).where(eq(domains.serviceId, serviceId));
    expect(r!.hostname).toBe('app.example.com');
  });

  it('updates an existing domain in place when the (host, path) matches', async () => {
    await db.insert(domains).values({
      serviceId,
      hostname: 'app.example.com',
      path: '/',
      ssl: false,
      status: 'active',
    });

    await applyManifestToService(
      db,
      serviceId,
      m({ routes: [{ host: 'app.example.com', path: '/', ssl: true }] }),
    );

    const rows = await db.select().from(domains).where(eq(domains.serviceId, serviceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ssl).toBe(true);
    // Status is the panel's concern — manifest never demotes an active host.
    expect(rows[0]!.status).toBe('active');
  });

  it('inserts two distinct domains for two different (host, path) pairs', async () => {
    await applyManifestToService(
      db,
      serviceId,
      m({
        routes: [
          { host: 'a.example.com', path: '/' },
          { host: 'a.example.com', path: '/api' },
        ],
      }),
    );
    const rows = await db.select().from(domains).where(eq(domains.serviceId, serviceId));
    expect(rows).toHaveLength(2);
  });

  it('leaves existing domains alone when the manifest declares no routes', async () => {
    await db.insert(domains).values({
      serviceId,
      hostname: 'existing.example.com',
      path: '/',
      ssl: true,
      status: 'active',
    });
    const result = await applyManifestToService(db, serviceId, m({}));
    expect(result.routesUpserted).toBe(0);
    const rows = await db.select().from(domains).where(eq(domains.serviceId, serviceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hostname).toBe('existing.example.com');
  });

  it('does not crash when the manifest lists the same (host, path) route twice', async () => {
    // `domains` enforces (hostname, path) uniqueness GLOBALLY
    // (domains_host_path_idx), while the sync loop matched only against this
    // service's pre-loop snapshot. Two identical entries therefore
    // blind-INSERTed both rows — the second died on `UNIQUE constraint
    // failed: domains.hostname, domains.path` and failed the whole deploy.
    // The second entry must update the row the first one created instead.
    const result = await applyManifestToService(
      db,
      serviceId,
      m({
        routes: [
          { host: 'dup.example.com', path: '/', ssl: true },
          { host: 'dup.example.com', path: '/', ssl: true },
        ],
      }),
    );
    expect(result.warnings).toEqual([]);
    const rows = await db.select().from(domains).where(eq(domains.serviceId, serviceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hostname).toBe('dup.example.com');
    expect(rows[0]!.ssl).toBe(true);
  });

  it('skips a route whose hostname another service already registered, with a warning', async () => {
    // The uniqueness is global across services: a manifest re-declaring a
    // hostname owned by ANOTHER service must be refused the way the panel's
    // assertHostnameClaimable flow refuses it — gracefully, with a warning —
    // not by crashing the deploy on the raw UNIQUE constraint (and unlike the
    // duplicate case, that crash was NOT self-healing: every redeploy of the
    // service failed until the manifest was edited).
    const [other] = await db
      .insert(services)
      .values({ name: 'other', slug: 'other', type: 'docker', port: 3000, healthPath: '/' })
      .returning();
    await db.insert(domains).values({
      serviceId: other!.id,
      hostname: 'taken.example.com',
      path: '/',
      status: 'active',
    });

    const result = await applyManifestToService(
      db,
      serviceId,
      m({ routes: [{ host: 'taken.example.com', path: '/', ssl: true }] }),
    );

    expect(result.routesUpserted).toBe(0);
    expect(result.warnings.some((w) => w.includes('taken.example.com'))).toBe(true);
    // The row stays with its original owner — the manifest cannot hijack it.
    const [row] = await db.select().from(domains).where(eq(domains.hostname, 'taken.example.com'));
    expect(row!.serviceId).toBe(other!.id);
    expect(row!.status).toBe('active');
  });
});

describe('applyManifestToService — database', () => {
  beforeEach(async () => {
    // Wipe everything the attachment gate reads: leaves first, then parents.
    await db.delete(databaseAttachments);
    await db.delete(databases);
    await db.delete(workspaceMembers);
    await db.delete(workspaces);
    await db.delete(users);
    // The drizzle schema declares `ownerUserId` on the `databases` table but
    // the latest migration does not yet add the column on `databases` (only
    // on `services`). Until the schema/migration drift is fixed, we insert
    // via raw SQL so the test does not depend on the missing column.
    const { sql } = await import('drizzle-orm');
    await db.run(sql`INSERT INTO databases (name, slug, engine, status, password_encrypted, volume_name) VALUES ('app-db', 'app-db', 'postgres', 'ready', 'fake-ciphertext', 'nd-db-app-db')`);

    // Operator owner (user 7) → visibleDatabaseIds returns null = unrestricted,
    // so the legacy attach flows stay green. The flag is an explicit column
    // now; an 'owner' workspace seat no longer implies it (migration 0038).
    await db.insert(users).values({ id: 7, email: 'owner@example.com', passwordHash: 'h', isInstanceOperator: true });
    const [ws] = await db.insert(workspaces).values({ name: 'acme', slug: 'acme', ownerId: 7 }).returning();
    await db.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: 7, role: 'owner' });
    // A second, seat-less user for cross-owner denial cases.
    await db.insert(users).values({ id: 8, email: 'other@example.com', passwordHash: 'h' });
  });

  it('attaches a managed database by slug when the owner is an operator', async () => {
    const result = await applyManifestToService(
      db,
      serviceId,
      m({ database: { ref: 'app-db', env: 'DATABASE_URL' } }),
      7,
    );
    expect(result.databaseAttached).toBe(true);
    expect(result.databaseAccessDenied).toBeNull();
    const attaches = await db
      .select()
      .from(databaseAttachments)
      .where(eq(databaseAttachments.serviceId, serviceId));
    expect(attaches).toHaveLength(1);
    expect(attaches[0]!.envAlias).toBe('DATABASE_URL');
  });

  it('is idempotent — re-running the manifest does not create a second attachment', async () => {
    await applyManifestToService(db, serviceId, m({ database: { ref: 'app-db', env: 'A' } }), 7);
    await applyManifestToService(db, serviceId, m({ database: { ref: 'app-db', env: 'B' } }), 7);
    const attaches = await db
      .select()
      .from(databaseAttachments)
      .where(eq(databaseAttachments.serviceId, serviceId));
    expect(attaches).toHaveLength(1);
    // The original env alias is preserved — manifest cannot flip an existing alias.
    expect(attaches[0]!.envAlias).toBe('A');
  });

  it('refuses to attach a managed database invisible to a non-operator owner', async () => {
    const result = await applyManifestToService(
      db,
      serviceId,
      m({ database: { ref: 'app-db', env: 'DATABASE_URL' } }),
      8,
    );
    expect(result.databaseAttached).toBe(false);
    expect(result.databaseAccessDenied).toBe('app-db');
    expect(result.warnings.join('\n')).toMatch(/outside this service's access/);
    const attaches = await db.select().from(databaseAttachments);
    expect(attaches).toHaveLength(0);
  });

  it('refuses manifest-driven attachments when the service has no recorded owner', async () => {
    const result = await applyManifestToService(
      db,
      serviceId,
      m({ database: { ref: 'app-db', env: 'DATABASE_URL' } }),
    );
    expect(result.databaseAttached).toBe(false);
    expect(result.databaseAccessDenied).toBe('app-db');
    expect(result.warnings.join('\n')).toMatch(/no recorded owner/);
  });

  it('emits a warning and a notFound marker when the slug does not resolve', async () => {
    const result = await applyManifestToService(
      db,
      serviceId,
      m({ database: { ref: 'ghost-db', env: 'DB_URL' } }),
    );
    expect(result.databaseAttached).toBe(false);
    expect(result.databaseNotFound).toBe('ghost-db');
    expect(result.warnings.join('\n')).toMatch(/ghost-db/);
  });

  it('does nothing when the manifest has no database section', async () => {
    const result = await applyManifestToService(db, serviceId, m({}));
    expect(result.databaseAttached).toBe(false);
    expect(result.databaseNotFound).toBeNull();
  });
});

describe('applyManifestToService — alerts', () => {
  it('inserts a rule for each metric alert and skips the event-shaped ones', async () => {
    const result = await applyManifestToService(
      db,
      serviceId,
      m({
        alerts: [
          { when: 'deployFailed', channel: 'oncall' },
          { when: 'highMemory', channel: 'oncall', thresholdPct: 85 },
        ],
      }),
    );
    // `deployFailed` has no metric the alert engine can evaluate. It used to be
    // written out as `cert-expiry < 0` — a rule that renders in Monitoring like
    // a configured alert and can never fire. It is now skipped, with a warning.
    expect(result.alertsUpserted).toBe(1);
    expect(result.warnings.some((w) => w.includes('when="deployFailed"'))).toBe(true);
    const rules = await db
      .select()
      .from(alertRules)
      .where(eq(alertRules.serviceId, serviceId));
    expect(rules).toHaveLength(1);
    expect(rules[0]!.metric).toBe('memory');
  });

  it('skips restartLoop the same way, without writing a placeholder rule', async () => {
    const result = await applyManifestToService(
      db,
      serviceId,
      m({ alerts: [{ when: 'restartLoop', channel: 'oncall' }] }),
    );
    expect(result.alertsUpserted).toBe(0);
    expect(result.warnings.some((w) => w.includes('when="restartLoop"'))).toBe(true);
    const rules = await db.select().from(alertRules).where(eq(alertRules.serviceId, serviceId));
    expect(rules).toHaveLength(0);
  });

  it('maps highMemory to a memory-metric rule with the manifest threshold', async () => {
    await applyManifestToService(
      db,
      serviceId,
      m({ alerts: [{ when: 'highMemory', channel: 'oncall', thresholdPct: 75 }] }),
    );
    const [rule] = await db
      .select()
      .from(alertRules)
      .where(eq(alertRules.serviceId, serviceId));
    expect(rule!.metric).toBe('memory');
    expect(rule!.operator).toBe('>');
    expect(rule!.threshold).toBe(75);
  });

  it('encodes the channel in the rule name so two alerts with the same when can coexist', async () => {
    await applyManifestToService(
      db,
      serviceId,
      m({
        alerts: [
          { when: 'highMemory', channel: 'oncall', thresholdPct: 90 },
          { when: 'highMemory', channel: 'ops', thresholdPct: 70 },
        ],
      }),
    );
    const rules = await db
      .select()
      .from(alertRules)
      .where(eq(alertRules.serviceId, serviceId));
    const names = rules.map((r) => r.name).sort();
    expect(names).toEqual([`svc-${serviceId}-highMemory-oncall`, `svc-${serviceId}-highMemory-ops`]);
  });

  it('updates an existing rule instead of duplicating it', async () => {
    await applyManifestToService(
      db,
      serviceId,
      m({ alerts: [{ when: 'highMemory', channel: 'oncall', thresholdPct: 50 }] }),
    );
    await applyManifestToService(
      db,
      serviceId,
      m({ alerts: [{ when: 'highMemory', channel: 'oncall', thresholdPct: 95 }] }),
    );
    const rules = await db
      .select()
      .from(alertRules)
      .where(eq(alertRules.serviceId, serviceId));
    expect(rules).toHaveLength(1);
    expect(rules[0]!.threshold).toBe(95);
  });

  it('does nothing when the manifest declares no alerts', async () => {
    const result = await applyManifestToService(db, serviceId, m({}));
    expect(result.alertsUpserted).toBe(0);
  });

  it('fires a manifest-declared alert rule once the breach sustains', async () => {
    // r014: rules created here previously had no alert_state row, and
    // evaluateAlerts only UPDATEs by ruleId — the breach clock could never
    // accumulate and the rule never fired.
    await db.delete(alertState);
    await applyManifestToService(
      db,
      serviceId,
      m({ alerts: [{ when: 'highMemory', channel: 'oncall', thresholdPct: 90 }] }),
    );
    const [rule] = await db.select().from(alertRules);

    const t0 = Date.parse('2026-01-01T00:00:00Z');
    for (let tick = 0; tick <= 4; tick++) {
      await evaluateAlerts(db, [{ serviceId, kind: 'memory', value: 95 }], new Date(t0 + tick * 30_000));
    }

    const [state] = await db.select().from(alertState);
    expect(state?.ruleId).toBe(rule!.id);
    expect(state?.status).toBe('firing');
  });

  it('recovers a fired manifest alert to ok once the metric clears', async () => {
    await db.delete(alertState);
    await applyManifestToService(
      db,
      serviceId,
      m({ alerts: [{ when: 'highMemory', channel: 'oncall', thresholdPct: 90 }] }),
    );

    const t0 = Date.parse('2026-01-01T00:00:00Z');
    for (let tick = 0; tick <= 4; tick++) {
      await evaluateAlerts(db, [{ serviceId, kind: 'memory', value: 95 }], new Date(t0 + tick * 30_000));
    }
    await evaluateAlerts(db, [{ serviceId, kind: 'memory', value: 30 }], new Date(t0 + 5 * 30_000));

    const [state] = await db.select().from(alertState);
    expect(state?.status).toBe('ok');
  });
});

describe('applyManifestToService — deferred sections emit warnings', () => {
  it('emits a warning when volume.backups is declared', async () => {
    const result = await applyManifestToService(
      db,
      serviceId,
      m({ volume: { mount: '/data', backups: { schedule: '0 3 * * *', retention: 7 } } }),
    );
    expect(result.warnings.join('\n')).toMatch(/volume\.backups/);
  });

  it('no longer warns for notifications — the section is wired into per-service subscriptions', async () => {
    const result = await applyManifestToService(
      db,
      serviceId,
      m({ notifications: { onDeploy: ['ops'], onFailure: ['oncall'], onAlert: [] } }),
    );
    // Unknown names warn; known-or-unknown resolution is covered by the
    // notifications describe — here we only pin that a bare declaration no
    // longer produces the old "not yet implemented" warning.
    expect(result.warnings.join('\n')).not.toMatch(/not yet implemented/);
  });

  it('no longer warns for previews — the section is wired onto the service row', async () => {
    const result = await applyManifestToService(
      db,
      serviceId,
      m({ previews: { enabled: true, pattern: 'pr-{n}.example.com', maxActive: 5, autoDestroyOnClose: true } }),
    );
    expect(result.warnings.join('\n')).not.toMatch(/previews/);
    expect(result.previewsApplied).toBe(true);
  });

  // `static`, `watch` and `network` are accepted by the (strict) schema and
  // consumed by nothing. They used to be the only unwired sections that were
  // dropped in complete silence, so a repo declaring them got no hint at all
  // that the setting had no effect.
  it('emits a warning when static is declared', async () => {
    const result = await applyManifestToService(db, serviceId, m({ static: { spa: true } }));
    expect(result.warnings.some((w) => w.startsWith('static: '))).toBe(true);
  });

  it('emits a warning when watch is declared', async () => {
    const result = await applyManifestToService(db, serviceId, m({ watch: { paths: ['apps/web/**'] } }));
    expect(result.warnings.some((w) => w.startsWith('watch: '))).toBe(true);
  });

  it('emits a warning when network is declared', async () => {
    const result = await applyManifestToService(db, serviceId, m({ network: { publishPort: 8080, aliases: ['edge'] } }));
    expect(result.warnings.some((w) => w.startsWith('network: '))).toBe(true);
  });

  it('produces no warnings for a minimal manifest', async () => {
    const result = await applyManifestToService(db, serviceId, m({}));
    expect(result.warnings).toEqual([]);
  });
});

describe('applyManifestToService — previews', () => {
  it('applies the previews section onto the service row without a warning', async () => {
    const result = await applyManifestToService(
      db,
      serviceId,
      m({
        previews: { enabled: true, pattern: 'pr-{n}.previews.example.com', maxActive: 3, autoDestroyOnClose: true },
      }),
    );
    expect(result.previewsApplied).toBe(true);
    expect(result.warnings.some((w) => w.startsWith('previews:'))).toBe(false);
    const [svc] = await db.select().from(services).where(eq(services.id, serviceId));
    expect(svc).toMatchObject({
      previewDeploymentsEnabled: true,
      previewDomainPattern: 'pr-{n}.previews.example.com',
      previewMaxActive: 3,
      previewAutoDestroyOnClose: true,
    });
  });

  it('applies enabled:false as an explicit override and clears the stored pattern', async () => {
    await db
      .update(services)
      .set({ previewDeploymentsEnabled: true, previewDomainPattern: 'old-{n}.x.example.com' })
      .where(eq(services.id, serviceId));
    const result = await applyManifestToService(
      db,
      serviceId,
      m({ previews: { enabled: false, maxActive: 5, autoDestroyOnClose: true } }),
    );
    expect(result.previewsApplied).toBe(true);
    const [svc] = await db.select().from(services).where(eq(services.id, serviceId));
    expect(svc!.previewDeploymentsEnabled).toBe(false);
    expect(svc!.previewDomainPattern).toBeNull();
  });

  it('is idempotent — re-running the same manifest rewrites the same values', async () => {
    const manifest = m({
      previews: { enabled: true, pattern: 'pr-{n}.prev.example.com', maxActive: 7, autoDestroyOnClose: false },
    });
    await applyManifestToService(db, serviceId, manifest);
    await applyManifestToService(db, serviceId, manifest);
    const [svc] = await db.select().from(services).where(eq(services.id, serviceId));
    expect(svc).toMatchObject({
      previewDeploymentsEnabled: true,
      previewDomainPattern: 'pr-{n}.prev.example.com',
      previewMaxActive: 7,
      previewAutoDestroyOnClose: false,
    });
  });

  it('leaves panel-set preview config alone when the manifest declares no previews section', async () => {
    await db
      .update(services)
      .set({ previewDeploymentsEnabled: true, previewDomainPattern: 'panel-{n}.x.example.com', previewMaxActive: 9 })
      .where(eq(services.id, serviceId));
    const result = await applyManifestToService(db, serviceId, m({}));
    expect(result.previewsApplied).toBe(false);
    const [svc] = await db.select().from(services).where(eq(services.id, serviceId));
    expect(svc!.previewDeploymentsEnabled).toBe(true);
    expect(svc!.previewDomainPattern).toBe('panel-{n}.x.example.com');
    expect(svc!.previewMaxActive).toBe(9);
  });
});

describe('applyManifestToService — notifications', () => {
  beforeEach(async () => {
    // Rules cascade on channel/service delete; the file's global beforeEach
    // already wipes services. Channels are wiped here so each test seeds its
    // own set.
    await db.delete(serviceNotificationChannels);
    await db.delete(notificationChannels);
    await db.insert(notificationChannels).values([
      { name: 'ops-slack', type: 'slack', targetEncrypted: 'enc-1' },
      { name: 'pager', type: 'webhook', targetEncrypted: 'enc-2' },
    ]);
  });

  const ruleRows = async () =>
    (await db.select().from(serviceNotificationChannels).orderBy(serviceNotificationChannels.id)).map((r) => ({
      scope: r.scope,
      channelId: r.channelId,
    }));

  it('resolves channel names into scoped subscriptions', async () => {
    const result = await applyManifestToService(
      db,
      serviceId,
      m({ notifications: { onDeploy: ['ops-slack'], onFailure: ['pager'], onAlert: [] } }),
    );
    expect(result.notificationsSynced).toBe(2);
    const rules = await ruleRows();
    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.scope).sort()).toEqual(['deploy', 'failure']);
    expect(result.warnings.some((w) => w.startsWith('notifications.'))).toBe(false);
  });

  it('warns for unknown channels and still applies the resolvable ones', async () => {
    const result = await applyManifestToService(
      db,
      serviceId,
      m({ notifications: { onDeploy: ['ops-slack', 'ghost-channel'] } }),
    );
    expect(result.notificationsSynced).toBe(1);
    expect(result.warnings.join('\n')).toContain('ghost-channel');
    const rules = await ruleRows();
    expect(rules).toHaveLength(1);
  });

  it('replaces a scope\u2019s subscriptions when the manifest changes', async () => {
    await applyManifestToService(db, serviceId, m({ notifications: { onDeploy: ['ops-slack'] } }));
    await applyManifestToService(db, serviceId, m({ notifications: { onDeploy: ['pager'] } }));
    const rules = await ruleRows();
    expect(rules).toHaveLength(1);
    const [pager] = await db.select().from(notificationChannels).where(eq(notificationChannels.name, 'pager'));
    expect(rules[0]).toMatchObject({ scope: 'deploy', channelId: pager!.id });
  });

  it('leaves scopes the manifest does not mention untouched', async () => {
    await applyManifestToService(db, serviceId, m({ notifications: { onFailure: ['pager'] } }));
    await applyManifestToService(db, serviceId, m({ notifications: { onDeploy: ['ops-slack'] } }));
    const rules = await ruleRows();
    expect(rules.map((r) => r.scope).sort()).toEqual(['deploy', 'failure']);
  });
});

describe('applyManifestToService — volume.backups', () => {
  const jobRow = async () => {
    const [job] = await db
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.name, MANIFEST_BACKUP_JOB_NAME));
    return job ?? null;
  };

  it('creates a manifest-owned backup job with the declared cron', async () => {
    const result = await applyManifestToService(
      db,
      serviceId,
      m({ volume: { backups: { schedule: '0 4 * * *', retention: 7 } } }),
    );
    expect(result.volumeBackupSchedule).toBe('0 4 * * *');
    const job = await jobRow();
    expect(job).toMatchObject({ serviceId, kind: 'backup', cron: '0 4 * * *', enabled: true });
    expect(result.warnings.join('\n')).toContain('retention');
  });

  it('updates the same job on a re-deploy instead of piling up duplicates', async () => {
    await applyManifestToService(db, serviceId, m({ volume: { backups: { schedule: '0 4 * * *', retention: 7 } } }));
    await applyManifestToService(db, serviceId, m({ volume: { backups: { schedule: '30 5 * * 1', retention: 14 } } }));
    const jobs = await db.select().from(scheduledJobs);
    expect(jobs.filter((j) => j.kind === 'backup')).toHaveLength(1);
    expect(await jobRow()).toMatchObject({ cron: '30 5 * * 1' });
  });

  it('refuses an invalid cron loudly and changes nothing', async () => {
    const result = await applyManifestToService(
      db,
      serviceId,
      m({ volume: { backups: { schedule: 'not a cron at all!!', retention: 7 } } }),
    );
    expect(result.volumeBackupSchedule).toBeNull();
    expect(result.warnings.join('\n')).toContain('is not a valid cron expression');
    expect(await jobRow()).toBeNull();
  });

  it('leaves the operator\u2019s own backup jobs alone', async () => {
    await db.insert(scheduledJobs).values({
      serviceId,
      name: 'my nightly backup',
      cron: '0 2 * * *',
      kind: 'backup',
      enabled: true,
    });
    await applyManifestToService(db, serviceId, m({ volume: { backups: { schedule: '0 4 * * *', retention: 7 } } }));
    const jobs = await db.select().from(scheduledJobs).where(eq(scheduledJobs.kind, 'backup'));
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.name).sort()).toEqual(['my nightly backup', MANIFEST_BACKUP_JOB_NAME]);
  });
});
