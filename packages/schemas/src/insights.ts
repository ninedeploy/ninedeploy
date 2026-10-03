import { z } from 'zod';
import { gitBranch, gitRepoUrl, repoBaseDir } from './common.js';

// ── Repository / framework insights ─────────────────────────────────────────
// The analysis engine (server lib/frameworks.ts) inspects a checked-out repo
// and reduces it to this shape; the wizard and the service-detail Framework
// tab render it to explain "what is in this repo and how should it deploy".

export const frameworkCategory = z.enum(['ssr', 'spa', 'static', 'backend', 'container', 'unknown']);
export type FrameworkCategory = z.infer<typeof frameworkCategory>;

export const packageManagerId = z.enum(['npm', 'pnpm', 'yarn', 'bun']);
export type PackageManagerId = z.infer<typeof packageManagerId>;

/** One recommended environment variable (pre-filled, user-editable). */
export const envSuggestion = z.object({
  key: z.string(),
  value: z.string(),
  description: z.string().optional(),
});
export type EnvSuggestion = z.infer<typeof envSuggestion>;

/** A detected framework plus its deploy preset (commands already adapted to
 * the detected package manager). Null commands mean "no safe suggestion". */
export const frameworkPreset = z.object({
  id: z.string(),
  name: z.string(),
  emoji: z.string(),
  category: frameworkCategory,
  port: z.number().int().min(1).max(65535),
  installCmd: z.string().nullable(),
  buildCmd: z.string().nullable(),
  startCmd: z.string().nullable(),
  env: z.array(envSuggestion),
  notes: z.array(z.string()),
});
export type FrameworkPreset = z.infer<typeof frameworkPreset>;

export const repoInsights = z.object({
  framework: frameworkPreset,
  language: z.string(),
  packageManager: packageManagerId.nullable(),
  nodeVersion: z.string().nullable(),
  frameworkVersion: z.string().nullable(),
  scripts: z.record(z.string(), z.string()),
  dependencyCount: z.number().int(),
  devDependencyCount: z.number().int(),
  hasDockerfile: z.boolean(),
  hasComposeFile: z.boolean(),
  monorepo: z.boolean(),
  /** Marker files the detection was derived from (e.g. package.json, go.mod). */
  detectedFiles: z.array(z.string()),
  /** Workspace member packages of a monorepo root (empty for single-app repos
   * and for analyses scoped to a base directory). Powers the wizard's
   * "deploy each sub-app as its own service" picker. */
  workspacePackages: z.array(
    z.object({
      /** Repo-relative directory, e.g. "apps/web". */
      dir: z.string(),
      name: z.string().nullable(),
      framework: z.string().nullable(),
      frameworkVersion: z.string().nullable(),
    }),
  ),
  baseDir: z.string(),
  commitSha: z.string().nullable().optional(),
  analyzedAt: z.string().datetime(),
});
export type RepoInsights = z.infer<typeof repoInsights>;

/** Pre-deploy inspection request (DeployWizard, before a service exists). */
export const analyzeRepoInput = z.object({
  repoUrl: gitRepoUrl,
  branch: gitBranch.default('main'),
  sourceId: z.number().int().positive().optional(),
  baseDir: repoBaseDir.optional(),
});
export type AnalyzeRepoInput = z.input<typeof analyzeRepoInput>;
