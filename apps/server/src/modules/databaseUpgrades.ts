import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { databaseUpgrades, type Database } from '@ninedeploy/db';
import { databaseUpgradeStart } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { conflict, notFound, parseId, unprocessable } from '../lib/errors.js';
import { assertDatabaseRole, loadDatabaseForUser } from '../lib/resourceAccess.js';
import {
  admitUpgrade,
  finalizeDatabaseUpgrade,
  planUpgrade,
  rollbackDatabaseUpgrade,
  runDatabaseUpgrade,
  serializeUpgrade,
  upgradeOptions,
} from '../lib/databaseUpgrade.js';

/**
 * O2: major-version upgrades of a managed database (lib/databaseUpgrade.ts).
 * Mounted under /databases. Starting, rolling back and finalizing take the
 * database's admin role, like deleting it: each stops the database.
 */
export const databaseUpgradeRoutes: FastifyPluginAsync = async (app) => {
  // Resolved per request: the wiring guard mounts this module on a bare Fastify.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    await (app as FastifyInstance & { authenticate: (r: FastifyRequest, p: FastifyReply) => Promise<void> }).authenticate(req, reply);
  });

  const load = async (req: FastifyRequest, role: 'viewer' | 'admin'): Promise<Database> => {
    const d = await loadDatabaseForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertDatabaseRole(app.db, d, req.user!, role);
    return d;
  };
  const loadUpgrade = async (req: FastifyRequest, d: Database) => {
    const upgradeId = parseId((req.params as { upgradeId: string }).upgradeId);
    const row = await app.db.query.databaseUpgrades.findFirst({
      where: and(eq(databaseUpgrades.id, upgradeId), eq(databaseUpgrades.databaseId, d.id)),
    });
    if (!row) throw notFound('Upgrade not found');
    return row;
  };
  // Two admissions racing in this process would both pass the "none running"
  // check before either row exists; the run re-checks under the lock as well.
  const admitting = new Set<number>();

  app.get('/:id/upgrades', async (req) => {
    const d = await load(req, 'viewer');
    const rows = await app.db.query.databaseUpgrades.findMany({
      where: eq(databaseUpgrades.databaseId, d.id),
      orderBy: desc(databaseUpgrades.id),
      limit: 20,
    });
    return rows.map(serializeUpgrade);
  });

  app.get('/:id/upgrades/options', async (req) => {
    const d = await load(req, 'viewer');
    return { databaseId: d.id, ...(await upgradeOptions(app.db, d)) };
  });

  app.post('/:id/upgrades', async (req, reply) => {
    const d = await load(req, 'admin');
    const body = databaseUpgradeStart.safeParse(req.body ?? {});
    if (!body.success) throw unprocessable(body.error.issues[0]!.message);
    if (admitting.has(d.id)) throw conflict('An upgrade of this database is being started.');
    admitting.add(d.id);
    let admitted: Awaited<ReturnType<typeof admitUpgrade>>;
    try {
      const plan = await planUpgrade(app.db, d, body.data.toMajor);
      admitted = await admitUpgrade(app.db, d, plan, req.user!.id);
    } finally {
      admitting.delete(d.id);
    }
    void audit(app.db, req.user!.id, 'database.upgrade.start', d.name, { databaseId: d.id, upgradeId: admitted.id, fromMajor: admitted.fromMajor, toMajor: admitted.toMajor });
    void runDatabaseUpgrade(app.db, admitted.id, {
      actorId: req.user!.id,
      fromImageTag: admitted.fromImageTag,
      log: (line) => app.log.info({ component: 'database-upgrade', upgradeId: admitted.id }, line),
    });
    const row = await app.db.query.databaseUpgrades.findFirst({ where: eq(databaseUpgrades.id, admitted.id) });
    return reply.code(202).send(serializeUpgrade(row!));
  });

  app.post('/:id/upgrades/:upgradeId/rollback', async (req) => {
    const d = await load(req, 'admin');
    const row = await loadUpgrade(req, d);
    await rollbackDatabaseUpgrade(app.db, row, req.user!.id);
    return serializeUpgrade((await app.db.query.databaseUpgrades.findFirst({ where: eq(databaseUpgrades.id, row.id) }))!);
  });

  app.post('/:id/upgrades/:upgradeId/finalize', async (req) => {
    const d = await load(req, 'admin');
    const row = await loadUpgrade(req, d);
    const { removedVolume } = await finalizeDatabaseUpgrade(app.db, row, req.user!.id);
    return { ...serializeUpgrade((await app.db.query.databaseUpgrades.findFirst({ where: eq(databaseUpgrades.id, row.id) }))!), removedVolume };
  });
};
