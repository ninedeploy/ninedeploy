import { desc, eq } from 'drizzle-orm';
import { alertRules, type alertState } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { alertRuleCreate, alertRulePatch } from '@ninedeploy/schemas';
import { ensureAlertState, resetAlertState } from '../lib/alerting.js';
import { notFound, parseId } from '../lib/errors.js';
import { audit } from '../lib/audit.js';

function serialize(rule: typeof alertRules.$inferSelect, state?: typeof alertState.$inferSelect) {
  return {
    id: rule.id,
    serviceId: rule.serviceId,
    name: rule.name,
    metric: rule.metric,
    operator: rule.operator,
    threshold: rule.threshold,
    durationWindows: rule.durationWindows,
    enabled: !!rule.enabled,
    status: state?.status ?? 'ok',
    lastValue: state?.lastValue ?? null,
    // Proof of liveness for the UI — null means the collector hasn't
    // evaluated this rule yet (fresh rule, or the target has no samples).
    lastEvaluatedAt: state?.updatedAt ? new Date(state.updatedAt).toISOString() : null,
    firedAt: state?.firedAt?.toISOString() ?? null,
    createdAt: rule.createdAt.toISOString(),
  };
}

/** Alert rule management. Mounted under /alerts. Members read; admins manage. */
export const alertRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/', async () => {
    const rules = await app.db.query.alertRules.findMany({ orderBy: desc(alertRules.id) });
    const states = await app.db.query.alertState.findMany();
    const byRule = new Map(states.map((s) => [s.ruleId, s]));
    return rules.map((r) => serialize(r, byRule.get(r.id)));
  });

  // Everything below mutates system-wide config — admin-only per the RBAC model.
  app.post('/', { preHandler: [app.requireAdmin] }, async (req) => {
    const input = alertRuleCreate.parse(req.body);
    const [rule] = await app.db
      .insert(alertRules)
      .values({
        name: input.name,
        serviceId: input.serviceId ?? null,
        metric: input.metric,
        operator: input.operator,
        threshold: input.threshold,
        durationWindows: input.durationWindows,
        enabled: input.enabled,
      })
      .returning();
    await ensureAlertState(app.db, rule!.id);
    void audit(app.db, req.user!.id, 'alert.create', rule!.name);
    return serialize(rule!);
  });

  app.patch('/:id', { preHandler: [app.requireAdmin] }, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const input = alertRulePatch.parse(req.body ?? {});
    const patch: Partial<typeof alertRules.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.serviceId !== undefined) patch.serviceId = input.serviceId;
    if (input.metric !== undefined) patch.metric = input.metric;
    if (input.operator !== undefined) patch.operator = input.operator;
    if (input.threshold !== undefined) patch.threshold = input.threshold;
    if (input.durationWindows !== undefined) patch.durationWindows = input.durationWindows;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    const [rule] = await app.db.update(alertRules).set(patch).where(eq(alertRules.id, id)).returning();
    if (!rule) throw notFound('Alert rule not found');
    // Edits invalidate stale breach state so the rule re-evaluates from scratch.
    await resetAlertState(app.db, rule.id);
    await ensureAlertState(app.db, rule.id);
    void audit(app.db, req.user!.id, 'alert.update', rule.name);
    return serialize(rule);
  });

  app.delete('/:id', { preHandler: [app.requireAdmin] }, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const [gone] = await app.db.delete(alertRules).where(eq(alertRules.id, id)).returning();
    if (gone) void audit(app.db, req.user!.id, 'alert.delete', gone.name);
    return { ok: true };
  });
};
