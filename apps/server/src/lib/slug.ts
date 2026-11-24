import { slugifyResourceName as slugify } from '@ninedeploy/schemas';

export { slugify };

/**
 * slugify plus a uniqueness suffix, guaranteed to satisfy the canonical
 * contract. Collision-suffix callers append `-<n>` AFTER the base has already
 * been truncated to 63 chars, so a verbatim append produced 64+ char slugs
 * the `slug` schema rejects (r032) — the clone loop, import bundles, compose
 * stacks and personal workspaces all persist the minted value verbatim.
 * The base is re-truncated to leave room for `-<suffix>`, and the join is
 * re-run through slugify so the result stays canonical even when the cut
 * lands on a hyphen. The suffix is only separator-normalised, NOT run
 * through slugify: slugify's one-to-two-character pad exists so a
 * STANDALONE output clears min(2), and a suffix is a component — the joined
 * result is already ≥ 2 via the base. Padding it would also rewrite the
 * legacy `-1`…`-50` counter spellings. The suffix is capped so the base
 * never drops below the 2-char minimum.
 */
export function slugifyWithSuffix(input: string, suffix: string): string {
  const clean = suffix
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  const room = Math.max(2, 63 - clean.length - 1);
  const base = slugify(input).slice(0, room);
  return slugify(`${base}-${clean}`);
}
