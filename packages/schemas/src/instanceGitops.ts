import { z } from 'zod';
import { gitBranch, gitRepoUrl } from './common.js';

// ── Instance-wide GitOps (G5.3) ──────────────────────────────────────────────
//
// The instance's projects, their services, domains and project grants as one
// YAML file in a repository. The panel reads it on a schedule, reports the
// drift between the file and the instance, alerts on new drift, and applies
// the file on request through the ordinary API (never deleting anything).

const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'lowercase letters, digits and dashes');

export const instanceSpecService = z
  .object({
    slug,
    name: z.string().min(1).max(100).optional(),
    type: z.enum(['docker', 'compose']).default('docker'),
    image: z.string().min(1).max(500).optional(),
    repoUrl: gitRepoUrl.optional(),
    branch: gitBranch.optional(),
    port: z.number().int().min(1).max(65535).optional(),
    /** Hostnames routed to the service (path `/`). */
    domains: z.array(z.string().min(3).max(253)).max(50).default([]),
  })
  .strict();

export const instanceSpecGrant = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    role: z.enum(['viewer', 'member', 'admin']),
  })
  .strict();

export const instanceSpecProject = z
  .object({
    slug,
    name: z.string().trim().min(2).max(63),
    description: z.string().trim().max(500).nullable().optional(),
    /** The workspace slug; the project's current workspace when omitted. */
    workspace: slug.optional(),
    services: z.array(instanceSpecService).max(200).default([]),
    grants: z.array(instanceSpecGrant).max(200).default([]),
  })
  .strict();

export const instanceSpec = z
  .object({
    version: z.literal('1'),
    projects: z.array(instanceSpecProject).max(500).default([]),
  })
  .strict();
export type InstanceSpec = z.infer<typeof instanceSpec>;
export type InstanceSpecProject = z.infer<typeof instanceSpecProject>;
export type InstanceSpecService = z.infer<typeof instanceSpecService>;

/** `PUT /v1/gitops`: where the file lives and how often it is read. */
export const gitopsConfigInput = z
  .object({
    enabled: z.boolean(),
    repoUrl: gitRepoUrl,
    branch: gitBranch.default('main'),
    path: z
      .string()
      .min(1)
      .max(200)
      .regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/, 'a relative path inside the repository')
      .default('ninedeploy-instance.yaml'),
    /** A git source whose credential reads a private repository. */
    sourceId: z.number().int().positive().nullable().default(null),
    /** Minutes between scheduled checks; 0 checks only on request. */
    intervalMinutes: z.number().int().min(0).max(1440).default(15),
  })
  .strict();
export type GitopsConfigInput = z.infer<typeof gitopsConfigInput>;
export type GitopsConfig = z.output<typeof gitopsConfigInput>;

export interface GitopsDriftItem {
  kind: 'project' | 'service' | 'domain' | 'grant';
  /** `shop`, `shop/api`, `shop/api/api.example.com`, `shop/bob@example.com`. */
  key: string;
  /** missing: in the file, not here. extra: here, not in the file. changed: both, different. */
  change: 'missing' | 'extra' | 'changed';
  fields?: Array<{ field: string; desired: unknown; actual: unknown }>;
}

export interface GitopsCheck {
  at: string;
  /** The commit the file was read at. */
  commit: string | null;
  error: string | null;
  drift: GitopsDriftItem[];
}

export interface GitopsApplyStep {
  item: string;
  ok: boolean;
  error?: string;
}

export interface GitopsView {
  config: GitopsConfig | null;
  lastCheck: GitopsCheck | null;
}
