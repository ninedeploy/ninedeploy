import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, describe, expect, it, vi } from 'vitest';

const tmp = path.join(os.tmpdir(), `ninedeploy-db-plugin-${process.pid}-${Date.now()}`);
mkdirSync(tmp, { recursive: true });

vi.stubEnv('NINEDEPLOY_DATA_DIR', tmp);
vi.stubEnv('NINEDEPLOY_DB_PATH', path.join(tmp, 'ninedeploy.db'));

const dbPlugin = (await import('../../src/plugins/db.js')).default;

afterAll(() => {
  vi.unstubAllEnvs();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows SQLite file lock */
  }
});

// MUST run first: it pre-populates the database file a 0.10.35 install would
// have, and the first plugin registration is the "first boot after upgrade".
describe('db plugin — r510/r512 upgrade seeding on first boot', () => {
  it('seeds the vault allowlist and the registry host bindings from current usage', async () => {
    const { createDb, runMigrations, envVars, services, sources, users } = await import('@ninedeploy/db');
    const { config } = await import('../../src/config.js');
    const { encrypt } = await import('../../src/lib/crypto.js');
    const pre = createDb({ url: config.dbUrl });
    await pre.ready;
    await runMigrations(pre.db);
    const [member] = await pre.db.insert(users).values({ email: 'm@x', passwordHash: 'h' }).returning();
    const [src] = await pre.db
      .insert(sources)
      .values({ type: 'registry', name: 'ghcr', registryUsername: 'ci', tokenEncrypted: encrypt('pat') })
      .returning();
    const [svc] = await pre.db
      .insert(services)
      .values({ name: 'legacy', slug: 'legacy', ownerUserId: member!.id, image: 'ghcr.io/acme/legacy:1', sourceId: src!.id })
      .returning();
    await pre.db.insert(envVars).values({
      serviceId: svc!.id,
      scope: 'service',
      scopeKey: svc!.id,
      key: 'DB_PASSWORD',
      valueEncrypted: encrypt(['$', '{{doppler:DB_PASSWORD}}'].join('')),
    });
    pre.client?.close();

    const app = Fastify();
    await app.register(dbPlugin);
    const { getVaultAllowlist } = await import('../../src/lib/vault.js');
    const { getRegistryBindings } = await import('../../src/lib/registryBinding.js');
    // An un-tagged member service with a reference is grandfathered by id;
    // the registry source is bound to the host its service pulls from.
    expect(await getVaultAllowlist(app.db)).toEqual({ workspaceIds: [], serviceIds: [svc!.id] });
    expect(await getRegistryBindings(app.db)).toEqual({ [String(src!.id)]: ['ghcr.io'] });
    await app.close();
  });
});

describe('db plugin', () => {
  it('decorates fastify.db when registered', async () => {
    const app = Fastify();
    await app.register(dbPlugin);
    expect(app.db).toBeDefined();
    expect(typeof app.db.select).toBe('function');
    expect(typeof app.db.insert).toBe('function');
    expect(typeof app.db.query).toBe('object');
    await app.close();
  });

  it('can be registered twice and only decorates once', async () => {
    const app = Fastify();
    await app.register(dbPlugin);
    const first = app.db;
    await app.register(dbPlugin);
    expect(app.db).toBe(first);
    await app.close();
  });

  it('keeps an existing decoration untouched', async () => {
    const app = Fastify();
    const fake = { select: vi.fn() };
    app.decorate('db', fake);
    await app.register(dbPlugin);
    expect(app.db).toBe(fake);
    await app.close();
  });
});
