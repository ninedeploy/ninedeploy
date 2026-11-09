/**
 * S1/S2 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): settings rows that belong
 * to an entity go with it. The service delete route removes its own rows and
 * its domains' rows, the housekeeping sweep removes rows whose owner is gone
 * (a workspace, an FK cascade), and every per-entity prefix in the source is
 * declared or exempted.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { domains, eq, services, settings, users, workspaces, type DB } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/engine/proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/proxy.js')>()),
  writeDynamicConfig: vi.fn(async () => undefined),
}));

const { OWNED_SETTINGS, UNOWNED_SETTING_PREFIXES, deleteOwnedSettings, ownerIdOf, sweepOrphanedSettings } = await import('../src/lib/ownedSettings.js');
const { prefixUpperBound, settingRowsWithPrefix, settingRowsWithPrefixes } = await import('../src/lib/settingRows.js');
const { servicesRoutes } = await import('../src/modules/services.js');
const { asUser, buildTestApp } = await import('./helpers.js');
const { closeMigratedDb, migratedDb } = await import('./lib/githubAppKit.js');

const def = (prefix: string) => OWNED_SETTINGS.find((d) => d.prefix === prefix)!;
const keys = async (db: DB) => (await db.select({ key: settings.key }).from(settings)).map((r) => r.key).sort();
const put = (db: DB, ...k: string[]) => db.insert(settings).values(k.map((key) => ({ key, value: JSON.stringify({ x: 1 }) as never, updatedAt: new Date() })));

describe('key shapes', () => {
  it('reads the owner id only from a key with the declared shape', () => {
    expect(ownerIdOf(def('restart_limit:'), 'restart_limit:42')).toBe(42);
    expect(ownerIdOf(def('restart_limit:'), 'restart_limit:42:x')).toBeNull();
    expect(ownerIdOf(def('restart_limit:'), 'restart_limit:')).toBeNull();
    expect(ownerIdOf(def('restart_limit:'), 'restart_limit:0')).toBeNull();
    expect(ownerIdOf(def('restart_limit:'), 'restart_limit:007')).toBeNull();
    expect(ownerIdOf(def('restart_limit:'), 'restart_limit:-1')).toBeNull();
    expect(ownerIdOf(def('restart_limit:'), 'restart_limitX42')).toBeNull();
    expect(ownerIdOf(def('sticky_session:'), 'sticky_session:9:enabled')).toBe(9);
    expect(ownerIdOf(def('sticky_session:'), 'sticky_session:9')).toBeNull();
    expect(ownerIdOf(def('saml_identity:'), `saml_identity:3:${'a'.repeat(64)}`)).toBe(3);
    expect(ownerIdOf(def('scim.suspended.ws'), 'scim.suspended.ws12')).toBe(12);
    expect(ownerIdOf(def('oidc.allowed_domains.'), 'oidc.allowed_domains.5')).toBe(5);
  });

  it('bounds a prefix range just past every key with that prefix', () => {
    expect(prefixUpperBound('restart_limit:')).toBe('restart_limit;');
    expect('restart_limit:999999' < prefixUpperBound('restart_limit:')).toBe(true);
    expect('restart_limit;' < prefixUpperBound('restart_limit:')).toBe(false);
  });

  it('declares no prefix twice and none that is also exempt', () => {
    const prefixes = OWNED_SETTINGS.map((d) => d.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const p of prefixes) expect(UNOWNED_SETTING_PREFIXES[p]).toBeUndefined();
    // A regenerated row must be a secret, and a secret is never copied.
    for (const d of OWNED_SETTINGS) if (d.secret) expect(d.portability).not.toBe('copy');
  });
});

describe('against a migrated database', () => {
  let db: DB;
  beforeEach(async () => {
    db = await migratedDb();
    await db.insert(users).values({ id: 1, email: 'a@example.com', passwordHash: 'x' });
    await db.insert(services).values([
      { id: 5, name: 'gone', slug: 'gone', type: 'docker', branch: 'main', ownerUserId: 1, image: 'nginx', port: 80, status: 'stopped' },
      { id: 6, name: 'kept', slug: 'kept', type: 'docker', branch: 'main', ownerUserId: 1, image: 'nginx', port: 80, status: 'stopped' },
    ] as never);
    await db.insert(domains).values([
      { id: 11, serviceId: 5, hostname: 'gone.example.com', path: '/', ssl: true, status: 'active' },
      { id: 12, serviceId: 6, hostname: 'kept.example.com', path: '/', ssl: true, status: 'active' },
    ] as never);
  });
  afterEach(() => closeMigratedDb(db));

  it('the prefix range lists exactly that prefix, with `_` taken literally', async () => {
    await put(db, 'restart_limit:5', 'restart_limit:6', 'restartXlimit:5', 'restart_limit;x', 'restart_limits');
    expect((await settingRowsWithPrefix(db, 'restart_limit:')).map((r) => r.key).sort()).toEqual(['restart_limit:5', 'restart_limit:6']);
    expect((await settingRowsWithPrefixes(db, ['restart_limit:', 'restartXlimit:'])).map((r) => r.key).sort()).toEqual(['restartXlimit:5', 'restart_limit:5', 'restart_limit:6']);
    expect(await settingRowsWithPrefixes(db, [])).toEqual([]);
  });

  it('deleting a service through its route removes its rows and its domains’ rows, not a sibling’s', async () => {
    await put(db,
      'restart_limit:5', 'registry_hook:5', 'error_ingest:5', 'sticky_session:5:enabled', 'inline_dockerfile:5', 'forward_auth:11', 'compose_route:11',
      'restart_limit:6', 'registry_hook:6', 'sticky_session:6:enabled', 'forward_auth:12', 'restart_limit:50', 'image_scan_policy');
    const app = await buildTestApp({ db });
    await app.register(servicesRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'DELETE', url: '/services/5', headers: asUser() });
    await app.close();
    expect(res.statusCode, res.body).toBe(204);
    expect(await db.query.services.findFirst({ where: eq(services.id, 5) })).toBeUndefined();
    expect(await keys(db)).toEqual(['forward_auth:12', 'image_scan_policy', 'registry_hook:6', 'restart_limit:50', 'restart_limit:6', 'sticky_session:6:enabled']);
  });

  it('a refused delete keeps the rows', async () => {
    await put(db, 'restart_limit:5');
    const app = await buildTestApp({ db });
    await app.register(servicesRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'DELETE', url: '/services/5', headers: asUser({ id: 2, role: 'member', isOperator: false }) });
    await app.close();
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await keys(db)).toEqual(['restart_limit:5']);
  });

  it('the sweep removes rows of deleted entities, keeps live ones, unparseable and exempt keys', async () => {
    await db.insert(workspaces).values([{ id: 7, name: 'Live', slug: 'live', ownerId: 1 }] as never);
    await put(db,
      'restart_limit:5', 'restart_limit:99', 'forward_auth:12', 'forward_auth:404',
      'workspace_2fa:7', 'workspace_2fa:8', 'scim.suspended.ws8', 'access_grants.idp_suspended.ws7',
      `saml_identity:3:${'b'.repeat(64)}`, 'restart_limit:abc', 'cloud_server:77', 'oauth_client:x');
    const removed = await sweepOrphanedSettings(db);
    expect(removed).toEqual({ 'restart_limit:': 1, 'forward_auth:': 1, 'workspace_2fa:': 1, 'scim.suspended.ws': 1, 'saml_identity:': 1 });
    expect(await keys(db)).toEqual(['access_grants.idp_suspended.ws7', 'cloud_server:77', 'forward_auth:12', 'oauth_client:x', 'restart_limit:5', 'restart_limit:abc', 'workspace_2fa:7']);
  });

  it('the sweep never removes the row of an entity created while it runs', async () => {
    // The row's owner does not exist when the sweep lists the keys, and does
    // by the time the sweep deletes: the delete re-checks the owner.
    await put(db, 'restart_limit:77');
    const original = db.delete.bind(db);
    let created = false;
    const spy = vi.spyOn(db, 'delete').mockImplementation(((table: never) => {
      if (!created) {
        created = true;
        return {
          where: (cond: never) => ({
            returning: async (cols: never) => {
              await db.insert(services).values({ id: 77, name: 'new', slug: 'new', type: 'docker', branch: 'main', ownerUserId: 1, image: 'nginx', port: 80, status: 'stopped' } as never);
              return original(table).where(cond).returning(cols);
            },
          }),
        };
      }
      return original(table);
    }) as never);
    expect(await sweepOrphanedSettings(db)).toEqual({});
    spy.mockRestore();
    expect(await keys(db)).toEqual(['restart_limit:77']);
  });

  it('deleteOwnedSettings removes compound keys of one owner only', async () => {
    await put(db, `saml_identity:3:${'c'.repeat(64)}`, `saml_identity:3:${'d'.repeat(64)}`, `saml_identity:31:${'e'.repeat(64)}`);
    expect(await deleteOwnedSettings(db, 'ssoProvider', 3)).toBe(2);
    expect(await keys(db)).toEqual([`saml_identity:31:${'e'.repeat(64)}`]);
  });
});

describe('source scan', () => {
  it('every per-entity settings key prefix in src is declared or exempted', () => {
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(root);
    const known = [...OWNED_SETTINGS.map((d) => d.prefix), ...Object.keys(UNOWNED_SETTING_PREFIXES)];
    // Built the same way but never used as a settings key.
    const notSettingKeys = new Set([
      'lib/imageScan.ts: compose:', // the image id of a compose scan result
      'lib/swarm.ts: nd.preload.', // a Swarm node label
    ]);
    const misses: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // Only files that read or write the settings table.
      if (!/getSetting(Json|String)?\(|setSetting(Json|String)?\(|settings\.key|settingRowsWithPrefix\(/.test(text)) continue;
      // Key builders: a helper call with an interpolated key, an arrow function
      // building one, and a PREFIX/KEY constant ending in ':' or '.'.
      const patterns = [
        /(?:get|set)Setting(?:Json|String)?(?:<[^>]*>)?\(\s*[\w.]+,\s*`([a-z][\w.-]*?(?::|\.ws|\.))\$\{/g,
        /=\s*\([^)]*\)\s*(?::\s*\w+\s*)?=>\s*`([a-z][\w.-]*?(?::|\.ws|\.))\$\{/g,
        /const [A-Z_]*(?:PREFIX|KEY)[A-Z_]*\s*=\s*'([a-z][\w.-]*(?::|\.))'/g,
      ];
      for (const re of patterns) {
        for (const m of text.matchAll(re)) {
          const prefix = m[1]!;
          if (!known.some((k) => prefix === k || prefix.startsWith(k))) misses.push(`${file.slice(root.length + 1).split(sep).join('/')}: ${prefix}`);
        }
      }
    }
    expect(misses.filter((m) => !notSettingKeys.has(m))).toEqual([]);
  });
});
