import { eq } from 'drizzle-orm';
import { settings, type DB } from '@ninedeploy/db';

/**
 * Read a settings-table value with a fallback. Values are stored as JSON
 * (the column is json-mode text), so booleans arrive as real booleans.
 */
export async function getSetting(db: DB, key: string, fallback: boolean): Promise<boolean> {
  const row = await db.query.settings.findFirst({ where: eq(settings.key, key) });
  const value = row?.value;
  return typeof value === 'boolean' ? value : fallback;
}

/** Upsert a boolean setting (primary-key upsert on `key`). */
export async function setSetting(db: DB, key: string, value: boolean): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

/** Read a settings-table string value with a fallback. */
export async function getSettingString(db: DB, key: string, fallback: string | null): Promise<string | null> {
  const row = await db.query.settings.findFirst({ where: eq(settings.key, key) });
  return typeof row?.value === 'string' ? row.value : fallback;
}

/** Upsert a string setting (primary-key upsert on `key`). */
export async function setSettingString(db: DB, key: string, value: string): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

/** Read a settings-table JSON value with a fallback. */
export async function getSettingJson<T>(db: DB, key: string, fallback: T | null = null): Promise<T | null> {
  const row = await db.query.settings.findFirst({ where: eq(settings.key, key) });
  if (!row?.value) return fallback;
  if (typeof row.value === 'object') return row.value as T;
  try {
    return JSON.parse(String(row.value)) as T;
  } catch {
    return fallback;
  }
}

/** Upsert a JSON setting (primary-key upsert on `key`). */
export async function setSettingJson<T>(db: DB, key: string, value: T): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value: value as unknown as boolean, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: value as unknown as boolean, updatedAt: new Date() } });
}

