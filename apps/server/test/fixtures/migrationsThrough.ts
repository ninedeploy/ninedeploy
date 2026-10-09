import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The real migrations folder (packages/db/src/migrations). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url));

/**
 * A copy of the migrations folder, under `scratchDir`, whose journal ends with
 * `tag` (inclusive): the database a release that shipped `tag` as its last
 * migration would produce.
 *
 * An upgrade test proves that ITS migration leaves the older rows
 * byte-identical. Applying the whole chain instead also applies every later
 * migration, and an additive `ALTER TABLE … ADD COLUMN` there (0072) changes
 * the very rows and DDL the older test compares. So the byte-identity step
 * applies the chain through the test's own tag, and only the reads through
 * today's drizzle schema (which declares every later column) apply the rest.
 */
export function migrationsThrough(tag: string, scratchDir: string): string {
  const dir = path.join(scratchDir, `through-${tag}-${Math.random().toString(36).slice(2)}`);
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const journalPath = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
  const at = journal.entries.findIndex((e) => e.tag === tag);
  if (at < 0) throw new Error(`migrationsThrough: no journal entry ${tag}`);
  journal.entries = journal.entries.slice(0, at + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}
