import { describe, expect, it } from 'vitest';
import { and, asc, eq, notInArray, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import { createDb, deployments, services } from '@ninedeploy/db';

/**
 * The worker's claim query, exercised against a REAL in-memory SQLite database
 * (same drizzle statements the plugin runs). Verifies the concurrency-safety
 * invariant: a service with a `building` deployment is never claimable — so
 * parallel slots / future multi-process workers can only ever pick up OTHER
 * services' deployments.
 */
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url));

describe('deploy worker claim semantics (real SQLite)', () => {
  it('skips queued deployments of services that already have a building deployment', async () => {
    const { db } = createDb({ url: ':memory:' });
    await migrate(db, { migrationsFolder });

    const [web] = await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker' }).returning();
    const [api] = await db.insert(services).values({ name: 'api', slug: 'api', type: 'docker' }).returning();

    // web: a deployment in flight (claimed by slot A) + a queued follow-up.
    // api: only a queued deployment.
    const base = Date.now();
    await db.insert(deployments).values([
      { serviceId: web!.id, status: 'building', trigger: 'user', createdAt: new Date(base - 3000) },
      { serviceId: web!.id, status: 'queued', trigger: 'user', createdAt: new Date(base - 2000) },
      { serviceId: api!.id, status: 'queued', trigger: 'user', createdAt: new Date(base - 1000) },
    ]);

    // The exact claim query the worker runs.
    const building = db
      .select({ serviceId: deployments.serviceId })
      .from(deployments)
      .where(eq(deployments.status, 'building'));
    const [claimed] = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.status, 'queued'), notInArray(deployments.serviceId, building)))
      .orderBy(asc(deployments.createdAt))
      .limit(1);

    // web's QUEUED deploy is older, but web is BUSY → api's deploy is next.
    expect(claimed).toBeDefined();
    expect(claimed!.id).toBe(3);

    // Once web's building deploy finishes, web's queued one becomes claimable.
    await db.update(deployments).set({ status: 'running', finishedAt: new Date() }).where(eq(deployments.id, 1));
    const building2 = db
      .select({ serviceId: deployments.serviceId })
      .from(deployments)
      .where(eq(deployments.status, 'building'));
    const [next] = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.status, 'queued'), notInArray(deployments.serviceId, building2)))
      .orderBy(asc(deployments.createdAt))
      .limit(1);
    expect(next!.id).toBe(2);
  });

  it('returns nothing claimable when every queued service is busy', async () => {
    const { db } = createDb({ url: ':memory:' });
    await migrate(db, { migrationsFolder });

    const [web] = await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker' }).returning();
    // Explicit distinct createdAt: the (serviceId, createdAt) unique index
    // would otherwise reject same-second inserts.
    await db.insert(deployments).values([
      { serviceId: web!.id, status: 'building', trigger: 'user', createdAt: new Date(Date.now() - 2000) },
      { serviceId: web!.id, status: 'queued', trigger: 'user', createdAt: new Date(Date.now() - 1000) },
    ]);

    const building = db
      .select({ serviceId: deployments.serviceId })
      .from(deployments)
      .where(eq(deployments.status, 'building'));
    const [claimed] = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.status, 'queued'), notInArray(deployments.serviceId, building)))
      .orderBy(asc(deployments.createdAt))
      .limit(1);
    expect(claimed).toBeUndefined();
  });

  it('lets only one same-service candidate win the atomic building guard', async () => {
    const { db } = createDb({ url: ':memory:' });
    await migrate(db, { migrationsFolder });
    const [web] = await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker' }).returning();
    await db.insert(deployments).values([
      { serviceId: web!.id, status: 'queued', trigger: 'user', createdAt: new Date(Date.now() - 2000) },
      { serviceId: web!.id, status: 'queued', trigger: 'user', createdAt: new Date(Date.now() - 1000) },
    ]);

    const claim = (id: number) => db.update(deployments).set({ status: 'building' }).where(and(
      eq(deployments.id, id),
      eq(deployments.status, 'queued'),
      sql`NOT EXISTS (SELECT 1 FROM deployments AS active WHERE active.service_id = ${deployments.serviceId} AND active.status = 'building')`,
    ));
    const first = await claim(1);
    const second = await claim(2);
    expect(first.rowsAffected).toBe(1);
    expect(second.rowsAffected).toBe(0);
  });
});
