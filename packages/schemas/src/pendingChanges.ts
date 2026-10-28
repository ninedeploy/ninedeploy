import { z } from 'zod';

// ── Pending changes tray (G5.2) ───────────────────────────────────────────
// With staging on, a service's edits collect as field-level changes instead
// of applying at once. They are reviewed as a diff and applied together —
// through the same checks as `PATCH /v1/services/:id` — optionally with a
// deploy, which an approval-gated lane then holds for review.

export const pendingStagingInput = z.object({ staging: z.boolean() }).strict();

export const pendingApplyInput = z
  .object({
    /** Queue a deploy once the changes are applied. */
    deploy: z.boolean().default(false),
    /**
     * Also apply changes other people staged. They run with YOUR authority
     * (an operator-only field a member staged included), so this confirms you
     * reviewed them; without it, such a tray is refused (409 others_changes).
     */
    includeOthers: z.boolean().default(false),
  })
  .strict();
export type PendingApplyInput = z.input<typeof pendingApplyInput>;

export const pendingChange = z.object({
  /** The `PATCH /v1/services/:id` field, `build.<key>` for a build setting. */
  field: z.string(),
  current: z.unknown(),
  next: z.unknown(),
  /** Who staged it (null for a tray stored before stagers were recorded). */
  stagedByUserId: z.number().int().nullable(),
  stagedBy: z.string().nullable(),
});
export type PendingChange = z.infer<typeof pendingChange>;

export const pendingChangesView = z.object({
  serviceId: z.number().int(),
  /** Edits collect here instead of applying at once. */
  staging: z.boolean(),
  changes: z.array(pendingChange),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
export type PendingChangesView = z.infer<typeof pendingChangesView>;

export const pendingApplyResult = z.object({
  applied: z.array(z.string()),
  /** The deploy queued with them, when asked for. */
  deploymentId: z.number().int().nullable(),
});
export type PendingApplyResult = z.infer<typeof pendingApplyResult>;
