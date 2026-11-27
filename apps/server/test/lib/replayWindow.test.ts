/**
 * N07: the replay window (lib/replayWindow.ts) on a migrated SQLite. The two checks that use it
 * (lib/webhooks.ts, lib/saml.ts) ask this table instead of memory, so the answer to "was this
 * request accepted already?" is the same after a panel restart as before it.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, replayWindow, type DB } from '@ninedeploy/db';
import { forgetExpiredReplayKeys, forgetReplayKind, rememberReplayKeys } from '../../src/lib/replayWindow.js';
import { closeMigratedDb, migratedDb } from './githubAppKit.js';

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url));
const MINUTE = 60_000;
const T0 = Date.parse('2026-11-27T12:00:00Z');

let db: DB;
beforeEach(async () => {
  db = await migratedDb();
});
afterEach(() => closeMigratedDb(db));

const rows = () => db.select().from(replayWindow);

describe('rememberReplayKeys', () => {
  it('remembers what is new, and names a key once it is remembered and still live', async () => {
    expect(await rememberReplayKeys(db, 'webhook', ['a', 'b'], T0, T0 + MINUTE)).toEqual([]);
    expect(await rememberReplayKeys(db, 'webhook', ['a', 'b'], T0 + 1, T0 + 2 * MINUTE)).toEqual(['a', 'b']);
    expect(await rows()).toHaveLength(2);
  });

  it('takes a key over once its time has passed, without a second row', async () => {
    await rememberReplayKeys(db, 'webhook', ['a'], T0, T0 + MINUTE);
    expect(await rememberReplayKeys(db, 'webhook', ['a'], T0 + MINUTE + 1, T0 + 3 * MINUTE)).toEqual([]);
    expect(await rows()).toHaveLength(1);
    // It is live again for as long as the new time says.
    expect(await rememberReplayKeys(db, 'webhook', ['a'], T0 + 2 * MINUTE, T0 + 4 * MINUTE)).toEqual(['a']);
  });

  it('keeps a key live until its time, to the millisecond', async () => {
    await rememberReplayKeys(db, 'webhook', ['a'], T0, T0 + MINUTE);
    expect(await rememberReplayKeys(db, 'webhook', ['a'], T0 + MINUTE, T0 + MINUTE)).toEqual(['a']);
    expect(await rememberReplayKeys(db, 'webhook', ['a'], T0 + MINUTE + 1, T0 + MINUTE)).toEqual([]);
  });

  it('answers for each key on its own, and remembers every key of the call', async () => {
    await rememberReplayKeys(db, 'webhook', ['old'], T0, T0 + 10 * MINUTE);
    expect(await rememberReplayKeys(db, 'webhook', ['old', 'new'], T0 + MINUTE, T0 + 10 * MINUTE)).toEqual(['old']);
    expect(await rememberReplayKeys(db, 'webhook', ['new'], T0 + 2 * MINUTE, T0 + 10 * MINUTE)).toEqual(['new']);
  });

  it('does not extend the time of a key it names as a replay', async () => {
    await rememberReplayKeys(db, 'saml', ['assertion:1'], T0, T0 + 10 * MINUTE);
    await rememberReplayKeys(db, 'saml', ['assertion:1'], T0 + MINUTE, T0 + 60 * MINUTE);
    expect(await forgetExpiredReplayKeys(db, T0 + 10 * MINUTE + 1)).toBe(1);
  });

  it('keeps the kinds apart', async () => {
    await rememberReplayKeys(db, 'webhook', ['same'], T0, T0 + MINUTE);
    expect(await rememberReplayKeys(db, 'saml', ['same'], T0, T0 + MINUTE)).toEqual([]);
    expect(await rows()).toHaveLength(2);
  });

  it('stores a digest of each key, never the key, and the time it is forgotten', async () => {
    const id = 'id:["github",7,"delivery-123"]';
    const body = 'body:github:7:cafe';
    await rememberReplayKeys(db, 'webhook', [body, id], T0, T0 + MINUTE);
    const all = await rows();
    const digest = (key: string) => createHash('sha256').update(key).digest('hex');
    expect(all.map((row) => row.key).sort()).toEqual([`webhook:${digest(body)}`, `webhook:${digest(id)}`].sort());
    expect(JSON.stringify(all)).not.toMatch(/delivery-123|cafe/);
    expect(all[0]?.expiresAt).toEqual(new Date(T0 + MINUTE));
  });

  it('asks nothing of the database for a request that carries no key', async () => {
    const never = { insert: () => { throw new Error('the database must not be asked'); } } as never;
    expect(await rememberReplayKeys(never, 'webhook', [], T0, T0 + MINUTE)).toEqual([]);
  });

  it('accepts one of several identical requests that arrive together, and names the others as replays', async () => {
    const answers = await Promise.all([1, 2, 3].map(() => rememberReplayKeys(db, 'webhook', ['same'], T0, T0 + MINUTE)));
    expect(answers.filter((replayed) => replayed.length === 0)).toHaveLength(1);
    expect(answers.filter((replayed) => replayed.length === 1)).toHaveLength(2);
    expect(await rows()).toHaveLength(1);
  });
});

describe('across a panel restart', () => {
  it('is answered by the database, so a process that opens it later refuses what the one before accepted', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-replay-'));
    const url = `file:${path.join(dir, 'panel.db').split(path.sep).join('/')}`;
    const before = createDb({ url });
    const after = createDb({ url });
    try {
      await migrate(before.db, { migrationsFolder: MIGRATIONS });
      const day = 24 * 60 * MINUTE;
      // The panel before the restart accepts a delivery, and keeps it for a day.
      expect(await rememberReplayKeys(before.db, 'webhook', ['id:captured'], T0, T0 + day)).toEqual([]);
      // It is restarted: its process is gone, with everything it held in memory.
      before.client?.close();
      expect(await rememberReplayKeys(after.db, 'webhook', ['id:captured'], T0 + MINUTE, T0 + day)).toEqual(['id:captured']);
      // What the new process accepts is known the same way.
      expect(await rememberReplayKeys(after.db, 'webhook', ['id:new'], T0 + MINUTE, T0 + day)).toEqual([]);
      expect(await rememberReplayKeys(after.db, 'webhook', ['id:new'], T0 + 2 * MINUTE, T0 + day)).toEqual(['id:new']);
    } finally {
      before.client?.close();
      after.client?.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file lock */
      }
    }
  });
});

describe('forgetting', () => {
  it('removes what has passed and nothing else, and says how many', async () => {
    await rememberReplayKeys(db, 'webhook', ['a', 'b'], T0, T0 + MINUTE);
    await rememberReplayKeys(db, 'saml', ['c'], T0, T0 + 5 * MINUTE);
    expect(await forgetExpiredReplayKeys(db, T0 + 30_000)).toBe(0);
    expect(await forgetExpiredReplayKeys(db, T0 + MINUTE + 1)).toBe(2);
    expect(await rows()).toHaveLength(1);
    expect(await forgetExpiredReplayKeys(db, T0 + 6 * MINUTE)).toBe(1);
    expect(await rows()).toHaveLength(0);
  });

  it('forgets one kind only: what the tests need to start clean', async () => {
    await rememberReplayKeys(db, 'webhook', ['a'], T0, T0 + MINUTE);
    await rememberReplayKeys(db, 'saml', ['b'], T0, T0 + MINUTE);
    expect(await forgetReplayKind(db, 'webhook')).toBe(1);
    expect(await rememberReplayKeys(db, 'webhook', ['a'], T0, T0 + MINUTE)).toEqual([]);
    expect(await rememberReplayKeys(db, 'saml', ['b'], T0, T0 + MINUTE)).toEqual(['b']);
  });
});
