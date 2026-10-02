import { config } from '../config.js';

/**
 * PR-preview hostnames, rendered from the member-editable
 * `services.previewDomainPattern`.
 *
 * r511: the rendered host lands in Traefik as an `active` router with no
 * ownership proof (it is inside the operator's own zone), so the pattern
 * itself must make the host unmistakably THIS service's preview. Holding it
 * to the zone was not enough: `victim-slug.{{domain}}` renders to another
 * service's automatic domain, and whoever inserts first owns the router —
 * the victim's later auto-domain insert hit the unique index and was skipped.
 * A pattern must therefore carry both `{{pr}}` and `{{slug}}`, and the
 * webhook additionally runs the r223 own-zone claim check on the result.
 */

export const DEFAULT_PREVIEW_DOMAIN_PATTERN = 'pr-{{pr}}-{{slug}}.{{domain}}';

const HOST_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export type PreviewDomainSkipReason =
  | 'pattern_outside_wildcard_zone'
  | 'invalid_hostname_shape'
  | 'pattern_requires_pr_and_slug';

/** The zone previews render into (the webhook's long-standing fallback). */
export function previewBaseDomain(): string {
  return config.wildcardDomain || 'localhost';
}

/** Render a pattern into a lowercase hostname. */
export function renderPreviewHost(pattern: string, prNumber: number, slug: string, baseDomain = previewBaseDomain()): string {
  return pattern
    .replace(/\{\{pr\}\}/g, String(prNumber))
    .replace(/\{\{slug\}\}/g, slug)
    .replace(/\{\{domain\}\}/g, baseDomain)
    .trim()
    .toLowerCase();
}

/** Why a rendered preview host must not be provisioned, or null when it may. */
export function previewHostSkipReason(
  pattern: string,
  host: string,
  baseDomain = previewBaseDomain(),
): PreviewDomainSkipReason | null {
  if (!host.endsWith(`.${baseDomain.toLowerCase()}`)) return 'pattern_outside_wildcard_zone';
  if (!HOST_SHAPE.test(host)) return 'invalid_hostname_shape';
  if (!pattern.includes('{{pr}}') || !pattern.includes('{{slug}}')) return 'pattern_requires_pr_and_slug';
  return null;
}

/**
 * Write-time validation (services create / PATCH): a human-readable reason
 * the pattern is refused, or null. Rendered with a sample PR number and the
 * service's own slug, so the zone/shape check is the one the webhook runs.
 */
export function previewPatternError(pattern: string, slug: string): string | null {
  const base = previewBaseDomain();
  const reason = previewHostSkipReason(pattern, renderPreviewHost(pattern, 1, slug, base), base);
  if (!reason) return null;
  const why =
    reason === 'pattern_requires_pr_and_slug'
      ? 'must contain both {{pr}} and {{slug}}'
      : reason === 'pattern_outside_wildcard_zone'
        ? `must render inside the instance's wildcard domain (${base})`
        : 'does not render to a valid hostname';
  return `previewDomainPattern ${why} — for example ${DEFAULT_PREVIEW_DOMAIN_PATTERN}`;
}
