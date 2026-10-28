import { z } from 'zod';

// ── Deploy freezes (G5.5) ──────────────────────────────────────────────────
// An operator's block on deploys: the whole instance, a workspace, a project
// or an environment (lane), with a reason and an optional expiry. The deploy
// queue holds every deploy it covers — whatever triggered it — as `queued`
// until the freeze ends or is lifted; nothing is dropped.

export const deployFreezeScope = z.enum(['instance', 'workspace', 'project', 'environment']);
export type DeployFreezeScope = z.infer<typeof deployFreezeScope>;

/** At most this many freezes exist at once. */
export const DEPLOY_FREEZES_MAX = 100;

export const deployFreezeCreate = z
  .object({
    scope: deployFreezeScope,
    /** The workspace, project or environment id; null for the whole instance. */
    targetId: z.number().int().positive().nullable().default(null),
    reason: z.string().trim().min(1).max(500),
    /** When the freeze ends on its own (ISO 8601); null keeps it until lifted. */
    until: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .refine((v) => (v.scope === 'instance') === (v.targetId === null), {
    message: 'A freeze of the whole instance takes no target; any other scope needs one',
    path: ['targetId'],
  });
export type DeployFreezeCreate = z.input<typeof deployFreezeCreate>;

export const deployFreeze = z.object({
  id: z.string(),
  scope: deployFreezeScope,
  targetId: z.number().int().nullable(),
  /** The target's name now, or null (whole instance, or the target is gone). */
  targetName: z.string().nullable(),
  reason: z.string(),
  until: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
});
export type DeployFreeze = z.infer<typeof deployFreeze>;
