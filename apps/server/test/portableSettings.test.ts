/**
 * S3 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): configuration kept in
 * settings rows survives a service export → import and a clone, through each
 * feature's own validation; secrets never travel and are named instead.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, domains, services, users, type DB } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/retainedSlugVolume.js', () => ({ assertSlugVolumeNotRetained: vi.fn(async () => undefined) }));
vi.mock('../src/lib/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/exec.js')>()),
  capture: vi.fn(async () => ''),
  run: vi.fn(async () => undefined),
}));

const { serviceMigrationRoutes } = await import('../src/modules/serviceMigration.js');
const { servicesRoutes } = await import('../src/modules/services.js');
const { readPortableDomainSettings, readPortableServiceSettings, applyPortableServiceSettings } = await import('../src/lib/portableSettings.js');
const { setRestartLimit, getRestartLimit } = await import('../src/lib/restartLimit.js');
const { setMaintenance, getMaintenance, setErrorPages } = await import('../src/lib/maintenance.js');
const { setInlineDockerfile } = await import('../src/lib/inlineDockerfile.js');
const { setCommitStatusSetting } = await import('../src/lib/gitCommitStatus.js');
const { setPipeline, getPipeline } = await import('../src/lib/ci.js');
const { setForwardAuth } = await import('../src/lib/forwardAuth.js');
const { setSettingJson, setSettingString } = await import('../src/lib/settings.js');
const { asUser, buildTestApp } = await import('./helpers.js');

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const operator = asUser({ id: 1, isOperator: true });
const PIPELINE = { image: 'node:22', script: 'npm test', labels: [], secrets: [], timeoutMinutes: 30, maxAttempts: 2, requireApproval: false, runOnPush: true, gateDeploys: false };

let db: DB;
let close: () => void;
let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-portable-'));
  const created = createDb({ url: `file:${path.join(dir, 't.db').split(path.sep).join('/')}` });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: 'h', isInstanceOperator: true });
  await db.insert(services).values({ id: 5, name: 'api', slug: 'api', type: 'docker', branch: 'main', ownerUserId: 1, image: 'nginx:1.27', port: 80 } as never);
  await db.insert(domains).values({ id: 11, serviceId: 5, hostname: 'api.example.com', path: '/', ssl: true, status: 'active' } as never);
  await setRestartLimit(db, 5, { maxRestarts: 5, windowMinutes: 10 });
  await setMaintenance(db, 5, { title: 'Upgrading', message: 'Back soon', retryAfterSeconds: 120, bypass: ['203.0.113.0/24'] });
  await setErrorPages(db, 5, { '502': '<h1>Bad gateway</h1>' });
  await setInlineDockerfile(db, 5, 'FROM nginx:1.27\n');
  await setCommitStatusSetting(db, 5, { enabled: true });
  await setPipeline(db, 5, PIPELINE);
  await setSettingString(db, 'sticky_session:5:enabled', 'true');
  await setForwardAuth(db, 11, { minRole: 'member' });
  await setSettingJson(db, 'registry_hook:5', { tokenSha256: 'x'.repeat(64), createdBy: 1, createdAt: new Date().toISOString(), lastPushAt: null });
});
afterEach(() => {
  close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

describe('export → import', () => {
  it('carries settings-row configuration and names the secrets it leaves behind', async () => {
    const app = await buildTestApp({ db });
    await app.register(serviceMigrationRoutes, { prefix: '/services' });
    const exported = await app.inject({ method: 'GET', url: '/services/5/export', headers: operator });
    expect(exported.statusCode, exported.body).toBe(200);
    const bundle = exported.json();
    expect(bundle.settings).toMatchObject({ restartLimit: { maxRestarts: 5, windowMinutes: 10 }, inlineDockerfile: 'FROM nginx:1.27\n', stickySession: true, commitStatus: { enabled: true } });
    expect(bundle.settings.maintenance).not.toHaveProperty('since');
    expect(bundle.domains[0].settings).toEqual({ forwardAuth: { minRole: 'member' } });
    expect(bundle.notCarried).toEqual([expect.stringMatching(/registry push webhook/)]);
    expect(JSON.stringify(bundle)).not.toContain('x'.repeat(64));

    // The move: the source goes, its bundle lands on this panel.
    await db.delete(services).where(eq(services.id, 5));
    const imported = await app.inject({ method: 'POST', url: '/services/import', headers: operator, payload: bundle });
    expect(imported.statusCode, imported.body).toBe(200);
    const body = imported.json();
    expect(body.settings.skipped).toEqual([]);
    expect(body.settings.applied).toEqual(
      expect.arrayContaining(['restart limit', 'maintenance mode', 'error pages', 'inline Dockerfile', 'commit statuses', 'CI pipeline', 'sticky sessions', 'api.example.com forward auth']),
    );
    expect(body.notCarried).toEqual(bundle.notCarried);
    const id = body.serviceId as number;
    expect(await readPortableServiceSettings(db, id)).toEqual(bundle.settings);
    const [dom] = await db.select().from(domains).where(eq(domains.serviceId, id));
    expect(await readPortableDomainSettings(db, dom!.id)).toEqual({ forwardAuth: { minRole: 'member' } });
    await app.close();
  });

  it('skips a tampered value with its reason and still imports the service', async () => {
    const app = await buildTestApp({ db });
    await app.register(serviceMigrationRoutes, { prefix: '/services' });
    const bundle = (await app.inject({ method: 'GET', url: '/services/5/export', headers: operator })).json();
    await db.delete(services).where(eq(services.id, 5));
    bundle.settings = { ...bundle.settings, restartLimit: { maxRestarts: 1, windowMinutes: 10 } };
    const res = await app.inject({ method: 'POST', url: '/services/import', headers: operator, payload: bundle });
    expect(res.statusCode, res.body).toBe(200);
    const report = res.json().settings;
    expect(report.skipped).toEqual([{ setting: 'restart limit', reason: expect.stringMatching(/^not valid/) }]);
    expect(report.applied).toEqual(expect.arrayContaining(['inline Dockerfile', 'CI pipeline', 'api.example.com forward auth']));
    expect(await getRestartLimit(db, res.json().serviceId)).toBeNull();
    // An older bundle without settings imports as before.
    const old = { ...bundle, settings: undefined, notCarried: undefined, domains: [] };
    const plain = await app.inject({ method: 'POST', url: '/services/import', headers: operator, payload: old });
    expect(plain.json()).toMatchObject({ ok: true, settings: { applied: [], skipped: [] }, notCarried: [] });
    await app.close();
  });
});

describe('clone', () => {
  it('copies the configuration but starts outside maintenance mode and without secrets', async () => {
    const app = await buildTestApp({ db });
    await app.register(servicesRoutes);
    const res = await app.inject({ method: 'POST', url: '/5/clone', headers: operator, payload: { name: 'api copy' } });
    expect(res.statusCode, res.body).toBe(200);
    const copy = res.json().id as number;
    expect(await getRestartLimit(db, copy)).toMatchObject({ maxRestarts: 5, windowMinutes: 10 });
    expect(await getPipeline(db, copy)).toEqual(PIPELINE);
    expect(await getMaintenance(db, copy)).toBeNull();
    const carried = await readPortableServiceSettings(db, copy);
    expect(carried).toMatchObject({ inlineDockerfile: 'FROM nginx:1.27\n', stickySession: true, errorPages: { '502': '<h1>Bad gateway</h1>' } });
    const { getRegistryHook } = await import('../src/lib/registryHooks.js');
    expect(await getRegistryHook(db, copy)).toBeNull();
    await app.close();
  });

  it('skips panel-host features for a service that is not on the panel host', async () => {
    const report = await applyPortableServiceSettings(
      db,
      { id: 5, type: 'docker', serverId: 3, orchestrator: 'container' } as never,
      { restartLimit: { maxRestarts: 3, windowMinutes: 5 }, maintenance: { title: 'x', message: 'y', retryAfterSeconds: 60, bypass: [] }, shellHook: 'rm -rf /' },
      { kind: 'import' },
    );
    // P2: a node docker service has a restart-loop limit, sampled through its agent.
    expect(report.applied).toEqual(['restart limit']);
    expect(report.skipped.map((s) => s.setting)).toEqual(['shellHook', 'maintenance mode']);
  });
});
