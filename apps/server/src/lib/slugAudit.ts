import { slug as slugSchema } from '@ninedeploy/schemas';
import { slugify } from './slug.js';

/**
 * Slug hygiene audit (r030).
 *
 * r028 and r029 fixed `slugify()` for NEW rows, but both fixes are forward-only:
 * a row written by an older build can still hold a slug that the canonical
 * `slug` contract in `@ninedeploy/schemas` rejects — a stranded trailing hyphen
 * from truncation, a one-character slug, or an illegal character from a
 * hand-written `input.slug`. Those rows are invisible today, and a stored slug
 * that `slug` rejects is a record the API refuses to round-trip.
 *
 * This module is pure — it classifies rows it is handed and proposes a repair.
 * No DB, no Docker, no I/O. The grammar lives in ONE place (the `slug` schema)
 * and the repair lives in ONE place (`slugify`), so this can never drift from
 * the contract it audits.
 */

/** Every table with a unique `slug` column. */
export type SlugTable =
  | 'services'
  | 'databases'
  | 'projects'
  | 'workspaces'
  | 'tunnels'
  | 'oidc_providers';

export interface SlugTableInfo {
  table: SlugTable;
  /**
   * True when the slug is ALSO a live Docker identity, so renaming only the
   * database row would desync it from the host: `services`/`databases`/`tunnels`
   * build `nd-svc-<slug>` / `nd-db-<slug>` / `nd-tunnel-<slug>` bridge, container
   * and volume names from it, and `lib/inventory.ts` parses the owning slug back
   * OUT of the volume name. A migration cannot fix those, and a Doctor DB-only
   * UPDATE must not pretend to.
   */
  dockerBound: boolean;
  /** Where the slug comes from, for the operator-facing detail line. */
  label: string;
}

export const SLUG_TABLES: readonly SlugTableInfo[] = [
  { table: 'services', dockerBound: true, label: 'service' },
  { table: 'databases', dockerBound: true, label: 'database' },
  { table: 'tunnels', dockerBound: true, label: 'tunnel' },
  { table: 'projects', dockerBound: false, label: 'project' },
  { table: 'workspaces', dockerBound: false, label: 'workspace' },
  { table: 'oidc_providers', dockerBound: false, label: 'OIDC provider' },
];

export function slugTableInfo(table: SlugTable): SlugTableInfo {
  const info = SLUG_TABLES.find((t) => t.table === table);
  if (!info) throw new Error(`unknown slug table: ${table}`);
  return info;
}

/** A row as the audit needs to see it. `name` drives the repair suggestion. */
export interface SlugRow {
  id: number;
  slug: string | null;
  name?: string | null;
}

export interface SlugViolation {
  table: SlugTable;
  id: number;
  /** The stored value, verbatim (may be null/empty). */
  current: string | null;
  /** Why it is invalid, in terms the canonical schema would use. */
  reason: string;
  /**
   * The value to move to, or null when this row must not be auto-repaired:
   * either the slug is a live Docker identity, or no collision-free candidate
   * could be derived and an operator has to choose.
   */
  recommended: string | null;
  dockerBound: boolean;
}

/** The single authority on what a valid slug is: the canonical schema itself. */
export function isCanonicalSlug(value: unknown): value is string {
  return typeof value === 'string' && slugSchema.safeParse(value).success;
}

/** Human-readable reason, derived from the schema's own rejection. */
function describe(current: string | null): string {
  if (current === null || current === '') return 'slug is empty';
  const parsed = slugSchema.safeParse(current);
  if (parsed.success) return '';
  const issue = parsed.error.issues[0];
  const atEdge = /^-$|^-/.test(current);
  if (current.length === 1) return `single-character slug (minimum is 2)`;
  if (atEdge && current.length > 62) return 'trailing separator left by 63-char truncation';
  if (atEdge) return 'starts or ends with a separator';
  return `invalid slug: ${issue ? issue.message : 'rejected by the canonical slug schema'}`;
}

/**
 * Propose the repaired slug for a row. Prefers re-deriving from the row's own
 * name through the (now-fixed) `slugify`, which keeps the repair consistent
 * with what the create route would have stored today. Falls back to trimming
 * the illegal edges of the stored value when there is no usable name.
 * `taken` holds the table's other live slugs so a repair can never create a
 * duplicate against a UNIQUE column.
 */
export function proposeRepair(row: SlugRow, taken: ReadonlySet<string>): string | null {
  const candidates: string[] = [];
  if (row.name && row.name.trim()) candidates.push(slugify(row.name));
  const trimmed = (row.slug ?? '').replace(/^-+|-+$/g, '');
  if (trimmed) candidates.push(trimmed, slugify(trimmed));
  // Guarantee the minimum length without inventing a new identity: repeat the
  // single character, exactly as slugify does (r029).
  for (const c of candidates) if (c.length === 1) candidates.push(`${c}${c}`);

  for (const base of candidates) {
    if (!isCanonicalSlug(base)) continue;
    if (!taken.has(base)) return base;
    // Collision with a sibling row: the row id is the only suffix guaranteed
    // unique, stable and DNS-legal here.
    const suffixed = `${base}-${row.id}`;
    if (isCanonicalSlug(suffixed) && !taken.has(suffixed) && suffixed.length <= 63) return suffixed;
  }
  return null;
}

/**
 * Audit one table's rows. `rows` must be the FULL set for that table, because a
 * slug is UNIQUE per table and the collision check needs every sibling value.
 */
export function auditSlugRows(table: SlugTable, rows: readonly SlugRow[]): SlugViolation[] {
  const { dockerBound } = slugTableInfo(table);
  const out: SlugViolation[] = [];
  for (const row of rows) {
    if (isCanonicalSlug(row.slug)) continue;
    const others = new Set(rows.filter((r) => r.id !== row.id && r.slug).map((r) => r.slug as string));
    out.push({
      table,
      id: row.id,
      current: row.slug,
      reason: describe(row.slug),
      // A Docker-bound slug cannot be repaired by moving the row alone: the
      // bridge, container and volume still carry the old name. Report it, never
      // silently half-rename it.
      recommended: dockerBound ? null : proposeRepair(row, others),
      dockerBound,
    });
  }
  return out;
}

/** Audit all tables from a table -> rows map. Tables absent from the map are skipped. */
export function auditAllSlugs(rowsByTable: Partial<Record<SlugTable, readonly SlugRow[]>>): SlugViolation[] {
  const out: SlugViolation[] = [];
  for (const info of SLUG_TABLES) {
    const rows = rowsByTable[info.table];
    if (rows) out.push(...auditSlugRows(info.table, rows));
  }
  return out;
}
