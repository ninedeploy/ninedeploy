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
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Environment = z.infer<typeof environment>;

export const environmentCreate = z.object({
  workspaceId: z.number().int().positive(),
  name: z.string().min(1).max(80),
});
export type EnvironmentCreateInput = z.infer<typeof environmentCreate>;
