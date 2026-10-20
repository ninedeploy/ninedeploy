import { z } from 'zod';

/**
 * Environment = a named deployment lane (production / staging / development)
 * inside a workspace. Services opt in via `services.environment_id`; the
 * promote flow builds on this grouping.
 */
export const environment = z.object({
  id: z.number().int(),
  workspaceId: z.number().int(),
  name: z.string(),
  slug: z.string(),
  serviceCount: z.number().int(),
  /** 0.16.13: variable values, logs and shells of the lane's services are for workspace admins only (absent on older panels). */
  protected: z.boolean().optional(),
  /** 0.16.13: every deploy into the lane waits for a workspace admin's approval (absent on older panels). */
  requireApproval: z.boolean().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Environment = z.infer<typeof environment>;

export const environmentCreate = z.object({
  workspaceId: z.number().int().positive(),
  name: z.string().min(1).max(80),
});
export type EnvironmentCreateInput = z.infer<typeof environmentCreate>;

/** `PATCH /v1/environments/:id`. The two 0.16.13 switches need an admin seat. */
export const environmentPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  protected: z.boolean().optional(),
  requireApproval: z.boolean().optional(),
});
export type EnvironmentPatchInput = z.infer<typeof environmentPatch>;
