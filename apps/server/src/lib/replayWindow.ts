import { createHash } from 'node:crypto';
import { and, gte, lt } from 'drizzle-orm';
import { replayWindow, type DB } from '@ninedeploy/db';

/**
 * N07: the replay window, in the `replay_window` table.
 *
 * A webhook delivery (lib/webhooks.ts) and a SAML assertion (lib/saml.ts) each
 * carry something that makes a captured, correctly signed request recognisable
 * when it is sent again. Both checks used to keep it in memory only, and said
 * so: a panel restart let each captured request through once more. They ask
 * this table now, so the answer is the same before and after a restart.
 *
 * A row is the kind and a digest of what identifies the request, never the
 * request. It lives until `expires_at`, is taken over when it has passed, and
 * is removed by the hourly sweep (plugins/housekeeping.ts). Only a request
 * whose signature was verified reaches this table, so its size is bounded by
 * the window and by what the panel's own providers send.
 */

export type ReplayKind = 'webhook' | 'saml';

const rowKey = (kind: ReplayKind, key: string) => `${kind}:${createHash('sha256').update(key).digest('hex')}`;

/**
 * Remembers each of `keys` until `forgetAfter`, and returns those that were
 * remembered already and still live: a request that carries one of them was
 * accepted inside its window, and is a replay.
 *
 * One statement, so two identical requests that arrive together are accepted
 * once: the first inserts the row, the second finds it live and changes
 * nothing. A row whose time has passed is taken over as if it were new. Every
 * key is remembered by the call, the replayed ones included.
 */
export async function rememberReplayKeys(db: DB, kind: ReplayKind, keys: string[], now: number, forgetAfter: number): Promise<string[]> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return [];
  const expiresAt = new Date(forgetAfter);
  const accepted = await db
    .insert(replayWindow)
    .values(unique.map((key) => ({ key: rowKey(kind, key), expiresAt })))
    .onConflictDoUpdate({
      target: replayWindow.key,
      set: { expiresAt },
      // A live row is left as it is: that is the replay.
      setWhere: lt(replayWindow.expiresAt, new Date(now)),
    })
    .returning({ key: replayWindow.key });
  const live = new Set(accepted.map((row) => row.key));
  return unique.filter((key) => !live.has(rowKey(kind, key)));
}

/** Removes every row whose time has passed. The hourly sweep calls it. */
export async function forgetExpiredReplayKeys(db: DB, now: number = Date.now()): Promise<number> {
  const gone = await db.delete(replayWindow).where(lt(replayWindow.expiresAt, new Date(now))).returning({ key: replayWindow.key });
  return gone.length;
}

/** Forgets everything remembered for a kind. The tests use it to start clean. */
export async function forgetReplayKind(db: DB, kind: ReplayKind): Promise<number> {
  const gone = await db
    .delete(replayWindow)
    .where(and(gte(replayWindow.key, `${kind}:`), lt(replayWindow.key, `${kind};`)))
    .returning({ key: replayWindow.key });
  return gone.length;
}
