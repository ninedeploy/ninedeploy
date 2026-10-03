/**
 * Derive a URL-safe slug from an arbitrary name. Falls back to "service".
 *
 * The result must satisfy the canonical `slug` contract in
 * `@ninedeploy/schemas` (`/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/`, max 63):
 * callers store it verbatim as a service/database slug and reuse it as the
 * `nd-svc-<slug>` / `nd-db-<slug>` container name and bridge DNS label, and
 * none of those paths re-validate it. Truncation therefore happens BEFORE the
 * trailing separator is dropped — cutting at 63 first can strand a `-`, and a
 * DNS label may not end with one.
 */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  // The canonical contract is 2..63 characters. A one-character name ("a"), or
  // one that COLLAPSES to a single character ("a!"), is legal input to
  // createService / createDatabase / createProject, and those routes persist
  // this derivation without re-validating it — so the server would store a slug
  // that its own updateService / createProject schema then rejects. Padding
  // belongs here and not as a larger `name.min()` because the collapse happens
  // inside this function: no bound on the input length can prevent it. Repeat
  // the character rather than inventing a suffix or throwing — the user's own
  // letter is preserved, the result stays a legal DNS label, and the function
  // remains idempotent (slugify('aa') === 'aa'), so a re-slug never drifts.
  if (slug.length === 1) return `${slug}${slug}`;
  return slug || 'service';
}

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
