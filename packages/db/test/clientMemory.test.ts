import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb } from '../src/client.js';

describe('in-memory database transactions', () => {
  it('can commit and roll back without borrowing a second connection, while foreign keys remain enabled', async () => {
    const { db, client, ready } = createDb({ url: 'file::memory:' });
    try {
      await ready;
      await db.run(sql`create table tx_proof (id integer primary key)`);
      await db.transaction(async tx => { await tx.run(sql`insert into tx_proof values (1)`); });
      expect(await db.all(sql`select id from tx_proof`)).toEqual([{ id: 1 }]);
      await expect(db.transaction(async tx => {
        await tx.run(sql`insert into tx_proof values (2)`);
        throw new Error('rollback proof');
      })).rejects.toThrow('rollback proof');
      expect(await db.all(sql`select id from tx_proof`)).toEqual([{ id: 1 }]);
      expect(await db.all(sql`pragma foreign_keys`)).toEqual([{ foreign_keys: 1 }]);
    } finally { client?.close(); }
  });
});
