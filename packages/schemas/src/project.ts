import { z } from 'zod';
import { slug } from './common.js';

/**
 * Project contracts — the single-level grouping layer over services and
 * databases (Easypanel-style). Projects own nothing directly; deleting one
 * detaches its resources (projectId → null), it never cascades.
 */

export const createProject = z.object({
  name: z.string().trim().min(2).max(63),
  slug: slug.optional(),
  description: z.string().trim().max(500).nullable().optional(),
  workspaceId: z.number().int().positive().nullable().optional(),
});
export type CreateProject = z.infer<typeof createProject>;
export type CreateProjectInput = CreateProject;

export const projectPatch = z
  .object({
    name: z.string().trim().min(2).max(63).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    workspaceId: z.number().int().positive().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });
export type ProjectPatch = z.infer<typeof projectPatch>;
export type ProjectPatchInput = ProjectPatch;

/** Serialized project as returned by /v1/projects. */
export interface ProjectEntry {
  id: number;
  workspaceId?: number | null;
  /** Display name of the owning workspace. Resolved server-side. */
  workspaceName?: string | null;
  name: string;
  slug: string;
  description: string | null;
  serviceCount: number;
  databaseCount: number;
  createdAt: string;
  updatedAt: string;
}
