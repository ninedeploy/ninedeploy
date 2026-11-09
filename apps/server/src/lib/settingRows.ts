import { and, gte, lt, or } from 'drizzle-orm';
import { settings, type DB } from '@ninedeploy/db';

/**
 * The first string that sorts after every key starting with `prefix`: the prefix
 * with its last character incremented (`restart_limit:` → `restart_limit;`).
 */
export function prefixUpperBound(prefix: string): string {
  if (!prefix) throw new Error('prefixUpperBound needs a non-empty prefix');
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

/**
 * Every settings row whose key starts with `prefix`, as a key range on the
 * primary key. `LIKE 'prefix%'` cannot use that index (SQLite's LIKE ignores
 * case) and treats `_` in a prefix such as `restart_limit:` as a wildcard.
 */
export async function settingRowsWithPrefix(db: DB, prefix: string): Promise<Array<{ key: string; value: unknown }>> {
  return db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(and(gte(settings.key, prefix), lt(settings.key, prefixUpperBound(prefix))));
}

/** Rows under any of `prefixes`, in one query (one key range per prefix). */
export async function settingRowsWithPrefixes(db: DB, prefixes: readonly string[]): Promise<Array<{ key: string; value: unknown }>> {
  if (prefixes.length === 0) return [];
  return db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(or(...prefixes.map((p) => and(gte(settings.key, p), lt(settings.key, prefixUpperBound(p))))));
}
