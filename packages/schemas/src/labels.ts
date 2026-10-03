import { z } from 'zod';

/**
 * Workspace-scoped free-form labels used to tag services without tying them
 * to the project hierarchy (e.g. "production", "staging", "team-x"). Labels
 * can be created on the fly; the color is a tailwind-style palette token
 * consumed by the UI.
 */
export const labelColor = z.enum([
  'indigo',
  'emerald',
  'amber',
  'rose',
  'sky',
  'slate',
  'violet',
  'lime',
]);
export type LabelColor = z.infer<typeof labelColor>;

export const createLabel = z.object({
  workspaceId: z.number().int().positive().nullable().optional(),
  name: z.string().trim().min(1).max(40),
  color: labelColor.default('indigo'),
});
export type CreateLabel = z.infer<typeof createLabel>;
export type CreateLabelInput = CreateLabel;

export const labelPatch = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    color: labelColor.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });
export type LabelPatch = z.infer<typeof labelPatch>;
export type LabelPatchInput = LabelPatch;

export const label = z.object({
  id: z.number().int(),
  workspaceId: z.number().int().nullable(),
  name: z.string(),
  color: z.string(),
  serviceCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Label = z.infer<typeof label>;

/**
 * PUT /v1/services/:id/tags body — replaces the service's project / workspace
 * / label memberships wholesale. The caller must be a member of every
 * workspace in `workspaceIds` (or an operator), and every project/label id
 * must be valid. Empty arrays clear the corresponding dimension.
 */
export const setServiceTags = z.object({
  projectIds: z.array(z.number().int().positive()).default([]),
  workspaceIds: z.array(z.number().int().positive()).default([]),
  labelIds: z.array(z.number().int().positive()).default([]),
});
export type SetServiceTags = z.infer<typeof setServiceTags>;
export type SetServiceTagsInput = SetServiceTags;

export const serviceTags = z.object({
  serviceId: z.number().int(),
  projects: z.array(z.object({ id: z.number().int(), name: z.string(), slug: z.string() })),
  workspaces: z.array(z.object({ id: z.number().int(), name: z.string(), slug: z.string() })),
  labels: z.array(z.object({ id: z.number().int(), name: z.string(), color: z.string() })),
});
export type ServiceTags = z.infer<typeof serviceTags>;

/**
 * /v1/services list filter — every present array is OR'd within its dimension
 * and AND'd across dimensions. An empty array means "no filter on this
 * dimension" (so omitting all three is equivalent to the unfiltered list).
 *
 *   ?tagWorkspaceIds=1,2   → service is in ws 1 OR ws 2
 *   ?tagProjectIds=10      → service has project 10
 *   ?tagLabelIds=3,4       → service has label 3 OR 4
 *   combined: AND across dimensions
 */
export const serviceListFilter = z.object({
  tagWorkspaceIds: z.array(z.number().int().positive()).default([]),
  tagProjectIds: z.array(z.number().int().positive()).default([]),
  tagLabelIds: z.array(z.number().int().positive()).default([]),
});
export type ServiceListFilter = z.infer<typeof serviceListFilter>;
