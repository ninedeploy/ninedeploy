/**
 * Live manifest validation for the Manifest Creator.
 *
 * The exact zod schema the deploy pipeline validates with runs here too,
 * so the form can show "this file will pass / fail" *before* the operator
 * downloads anything. Zod issue paths (`routes.0.host`) are mapped back to
 * the nav's section ids so each error lights up the section it belongs to;
 * root-level issues (e.g. a missing `version`) carry `sectionId: null` and
 * surface in the page-level banner only.
 */
import { ninedeployManifest, type NinedeployManifest } from '@ninedeploy/schemas';
import type { SectionId } from './state.js';

export interface ManifestIssue {
  /** Dot path of the offending field — '' for root-level issues. */
  path: string;
  message: string;
  /** Nav section that owns the field, or null when it is root-level. */
  sectionId: SectionId | null;
}

/** Top-level manifest key → nav section id. */
const TOP_LEVEL_TO_SECTION: Record<string, SectionId> = {
  runtime: 'runtime',
  build: 'build',
  run: 'run',
  static: 'static',
  env: 'env',
  phases: 'phases',
  resources: 'resources',
  hooks: 'hooks',
  watch: 'watch',
  routes: 'routing',
  previews: 'previews',
  volume: 'volume',
  database: 'database',
  network: 'network',
  notifications: 'notifications',
  alerts: 'alerts',
};

/** Validate a manifest and return every schema issue, section-mapped. */
export function validateManifest(manifest: NinedeployManifest): ManifestIssue[] {
  const result = ninedeployManifest.safeParse(manifest);
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    return {
      path,
      message: issue.message,
      sectionId:
        issue.path.length > 0 ? (TOP_LEVEL_TO_SECTION[String(issue.path[0])] ?? null) : null,
    };
  });
}
