import { randomBytes } from 'node:crypto';
import { settings, type DB } from '@ninedeploy/db';
import { eq } from 'drizzle-orm';
import { decrypt, encrypt } from './crypto.js';
import { WAKE_KEY_PATTERN } from '../wakeCatcher.js';

/** Internal per-node credential. A missing read never creates or rotates it. */
export async function nodeWakeKey(db: DB, nodeId: number, create = false): Promise<string | null> {
  if (!Number.isSafeInteger(nodeId) || nodeId <= 0) throw new Error('Invalid wake node');
  const key = `node_wake_key_${nodeId}`;
  if (create) {
    await db.insert(settings).values({ key, value: encrypt(randomBytes(32).toString('hex')) }).onConflictDoNothing();
  }
  const row = await db.query.settings.findFirst({ where: eq(settings.key, key) });
  if (!row) return null;
  if (typeof row.value !== 'string') throw new Error('Node wake credential is invalid');
  const value = decrypt(row.value);
  if (!WAKE_KEY_PATTERN.test(value)) throw new Error('Node wake credential is invalid');
  return value;
}
