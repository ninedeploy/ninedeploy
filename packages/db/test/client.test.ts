import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/client.js';

describe('createDb', () => {
  it('creates an in-memory database and runs queries', async () => {
    const { db, client, ready } = createDb({ url: ':memory:' });
    await ready;
    expect(client).toBeDefined();
    const result = await db.run(sql`SELECT 1 as one`);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual({ one: 1 });
  });

  it('accepts an auth token', async () => {
    const { db, ready } = createDb({ url: ':memory:', authToken: 'secret' });
    await ready;
    const result = await db.run(sql`SELECT 2 as two`);
    expect(result.rows[0]).toEqual({ two: 2 });
  });

  it('returns the raw libsql client when withClient is true', async () => {
    const { db, client, ready } = createDb({ url: ':memory:', withClient: true });
    await ready;
    expect(typeof client.execute).toBe('function');
    const result = await db.run(sql`SELECT 3 as three`);
    expect(result.rows[0]).toEqual({ three: 3 });
  });

  it('suppresses the raw libsql client when withClient is false', async () => {
    // Regression for F1: the option used to be a dead no-op, so the raw
    // client was always returned. Callers that opt out to avoid retaining
    // the underlying connection must actually get suppression.
    const { db, client, ready } = createDb({ url: ':memory:', withClient: false });
    await ready;
    expect(client).toBeUndefined();
    // The Drizzle handle is unaffected and must still answer queries.
    const result = await db.run(sql`SELECT 4 as four`);
    expect(result.rows[0]).toEqual({ four: 4 });
  });
});

describe('r162: connection PRAGMAs survive a transaction', () => {
  it('keeps foreign_keys and busy_timeout on the connection opened after a transaction', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-pragma-'));
    const { db, client, ready } = createDb({ url: `file:${path.join(dir, 'p.db').split(path.sep).join('/')}` });
    await ready;
    const fk = async () => (await db.all<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`))[0]!.foreign_keys;
    const busy = async () => Object.values((await db.all<Record<string, number>>(sql`PRAGMA busy_timeout`))[0]!)[0];
    expect(await fk()).toBe(1);
    // libsql hands its connection to the transaction and lazily opens a
    // fresh, PRAGMA-less one for everything after it.
    await db.transaction(async (tx) => {
      await tx.run(sql`SELECT 1`);
    });
    expect(await fk()).toBe(1);
    expect(await busy()).toBe(5000);
    client?.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows file lock */
    }
  });
});
