import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createDb, databaseAttachments, databaseImports, databases, deployments, envVars, runMigrations, services, volumeImports } from '@ninedeploy/db';
import { encrypt } from '../src/lib/crypto.js';
import { deploysRoutes } from '../src/modules/deploys.js';
import { asUser, buildTestApp } from './helpers.js';

it('reports runtime keys, running bindings and unfinished work without exposing values', async () => {
  const { db, client } = createDb({ url: ':memory:' });
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  const [service] = await db.insert(services).values({ name: 'Shop', slug: 'shop', type: 'docker', image: 'nginx', volumeMount: '/data' }).returning();
  const id = service!.id;
  const [database] = await db.insert(databases).values({ name: 'DB', slug: 'db', engine: 'postgres', status: 'running', passwordEncrypted: encrypt('hidden-db-password') }).returning();
  const [empty] = await db.insert(databases).values({ name: 'Cache', slug: 'cache', engine: 'redis', status: 'running', passwordEncrypted: encrypt('hidden-cache-password') }).returning();
  await db.insert(databaseAttachments).values([
    { serviceId: id, databaseId: database!.id, envAlias: 'DATABASE_URL' },
    { serviceId: id, databaseId: empty!.id, envAlias: 'REDIS_URL' },
  ]);
  await db.insert(envVars).values([
    { serviceId: id, scope: 'service', scopeKey: id, key: 'TOKEN', valueEncrypted: encrypt('hidden-token'), isSecret: true },
    { serviceId: id, scope: 'service', scopeKey: id, key: 'VAULT_TOKEN', valueEncrypted: encrypt(`\${{vault:fixture/secret#value}}`), isSecret: true },
  ]);
  await db.insert(deployments).values({ serviceId: id, status: 'awaiting_approval' });
  await db.insert(databaseImports).values([
    { databaseId: database!.id, source: 'upload', status: 'running', filename: 'private-dump.sql' },
    { databaseId: database!.id, source: 'upload', status: 'completed_with_warnings', error: 'private-import-error' },
  ]);
  await db.insert(volumeImports).values([
    { serviceId: id, volumeName: 'nd-svc-shop-data', status: 'pending', sha256: 'fixture' },
    { serviceId: id, volumeName: 'nd-svc-old-slug-data', status: 'completed', sha256: 'fixture' },
  ]);
  const app = await buildTestApp({ db });
  try {
    await app.register(deploysRoutes);
    const response = await app.inject({ method: 'GET', url: `/${id}/deploys/migration-readiness`, headers: asUser() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id, slug: 'shop', hasSource: true, environmentKeys: ['DATABASE_URL', 'REDIS_URL', 'TOKEN', 'VAULT_TOKEN'],
      secretReferenceKeys: ['VAULT_TOKEN'], managedDatabaseKeys: ['DATABASE_URL', 'REDIS_URL'],
      deploymentPending: true, databaseImportsPending: true, volumeImportsPending: true,
      primaryVolume: { mountPath: '/data', latestImportStatus: 'pending' },
    });
    expect(response.json().bindings).toEqual(expect.arrayContaining([
      { databaseId: database!.id, alias: 'DATABASE_URL', slug: 'db', engine: 'postgres', running: true, latestImportStatus: 'completed_with_warnings' },
      { databaseId: empty!.id, alias: 'REDIS_URL', slug: 'cache', engine: 'redis', running: true, latestImportStatus: null },
    ]));
    expect(response.body).not.toMatch(/hidden|fixture\/secret|private-dump|private-import-error/);
  } finally {
    await app.close();
    client?.close();
  }
});
