import { eq } from 'drizzle-orm';
import { backupDestinations, databaseBackupPolicies } from '@ninedeploy/db';
import { backupPolicyInput, backupReplicasInput } from '@ninedeploy/schemas';
import type { FastifyPluginAsync } from 'fastify';
import { audit } from '../lib/audit.js';
import { assertBackupCron, notifyBackupPolicyChanged, serializeBackupPolicy } from '../lib/backupPolicy.js';
import { getBackupReplicas, setBackupReplicas } from '../lib/backupReplicas.js';
import { badRequest, forbidden, parseId } from '../lib/errors.js';
import { assertDatabaseRole, loadDatabaseForUser } from '../lib/resourceAccess.js';

/**
 * Per-database backup policy (0.12). Mounted under /databases, next to the
 * backup routes, with the same authorization: reading follows the database
 * (`loadDatabaseForUser`, like GET /:id/backups); writing needs `admin` on
 * it (like POST /:id/backups — the policy decides how many full copies of the
 * data exist and where they go).
 *
 * Backup destinations are instance-level, operator-managed rows (their list
 * route is operator-only), so pointing a policy at a SPECIFIC destination is
 * an operator decision too. A workspace admin may choose the active
 * destination or local-only, and may re-save a policy that keeps the
 * destination an operator already picked.
 */
export const databaseBackupPolicyRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/backup-policy', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const d = await loadDatabaseForUser(app.db, id, req.user!);
    const row = await app.db.query.databaseBackupPolicies.findFirst({
      where: eq(databaseBackupPolicies.databaseId, d.id),
    });
    return serializeBackupPolicy(d.id, row ?? null);
  });

  app.put('/:id/backup-policy', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const d = await loadDatabaseForUser(app.db, id, req.user!);
    await assertDatabaseRole(app.db, d, req.user!, 'admin');
    const parsed = backupPolicyInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw badRequest(issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid backup policy');
    }
    const input = parsed.data;
    assertBackupCron(input.cron);

    const existing = await app.db.query.databaseBackupPolicies.findFirst({
      where: eq(databaseBackupPolicies.databaseId, d.id),
    });
    if (input.destinationId != null && input.destinationId !== (existing?.destinationId ?? null)) {
      if (!req.user!.isOperator) {
        throw forbidden('Choosing a specific backup destination requires instance operator access');
      }
      const dest = await app.db.query.backupDestinations.findFirst({
        where: eq(backupDestinations.id, input.destinationId),
      });
      if (!dest) throw badRequest('Unknown backup destination');
    }

    const values = {
      enabled: input.enabled,
      cron: input.cron,
      retainCount: input.retainCount,
      retainRemoteCount: input.retainRemoteCount,
      destinationId: input.destinationId,
      localOnly: input.localOnly,
    };
    const [row] = await app.db
      .insert(databaseBackupPolicies)
      .values({ databaseId: d.id, ...values })
      .onConflictDoUpdate({ target: databaseBackupPolicies.databaseId, set: { ...values, updatedAt: new Date() } })
      .returning();
    // Re-arm this database's cron now rather than at the next resync.
    notifyBackupPolicyChanged(d.id);
    const where = input.localOnly ? 'local only' : input.destinationId != null ? `destination #${input.destinationId}` : 'active destination';
    void audit(
      app.db,
      req.user!.id,
      'backup.policy.update',
      `${d.name}: ${input.enabled ? input.cron : 'disabled'}, keep ${input.retainCount}, ${where}`,
      { databaseId: d.id },
    );
    return serializeBackupPolicy(d.id, row ?? null);
  });

  // G3.3 replica destinations: more copies of the scheduled dumps, each with
  // its own retention. Destinations are operator rows, so naming them is too.
  app.get('/:id/backup-replicas', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const d = await loadDatabaseForUser(app.db, id, req.user!);
    return getBackupReplicas(app.db, d.id);
  });

  app.put('/:id/backup-replicas', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const d = await loadDatabaseForUser(app.db, id, req.user!);
    await assertDatabaseRole(app.db, d, req.user!, 'admin');
    if (!req.user!.isOperator) throw forbidden('Choosing backup replica destinations requires instance operator access');
    const parsed = backupReplicasInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw badRequest(issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid replica list');
    }
    for (const r of parsed.data.replicas) {
      const dest = await app.db.query.backupDestinations.findFirst({ where: eq(backupDestinations.id, r.destinationId) });
      if (!dest) throw badRequest(`Unknown backup destination #${r.destinationId}`);
    }
    await setBackupReplicas(app.db, d.id, parsed.data.replicas);
    void audit(
      app.db,
      req.user!.id,
      'backup.replicas.update',
      `${d.name}: ${parsed.data.replicas.map((r) => `#${r.destinationId} keep ${r.retainCount}`).join(', ') || 'none'}`,
      { databaseId: d.id },
    );
    return getBackupReplicas(app.db, d.id);
  });
};
