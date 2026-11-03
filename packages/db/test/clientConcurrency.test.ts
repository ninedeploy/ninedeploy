import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDb } from '../src/client.js';

it.each([false, true])('queues overlapping managed transactions until commit or rollback (rollback=%s)', async rollback => {
  const c = createDb({ url: 'file::memory:' }), other = createDb({ url: 'file::memory:' });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    await c.ready; await other.ready;
    await c.db.run(sql`create table concurrent_tx (id integer primary key)`);
    await c.db.transaction(async tx => { await tx.run(sql`insert into concurrent_tx values (0)`); });
    const first = c.db.transaction(async tx => {
      await tx.run(sql`insert into concurrent_tx values (1)`); entered(); await gate;
      if (rollback) throw new Error('rollback proof');
    });
    await started;
    const second = c.db.transaction(async tx => { await tx.run(sql`insert into concurrent_tx values (2)`); });
    const results = Promise.allSettled([first, second]);
    // A blocked transaction on this DB must not block another DB's work.
    expect(await other.db.transaction(tx => tx.all(sql`select 42 as answer`))).toEqual([{ answer: 42 }]);
    release(); const settled = await results;
    expect(settled[0]?.status).toBe(rollback ? 'rejected' : 'fulfilled');
    expect(settled[1]?.status, 'the next legitimate transaction must survive an overlapping owner').toBe('fulfilled');
    expect(await c.db.all(sql`select id from concurrent_tx order by id`)).toEqual((rollback ? [0, 2] : [0, 1, 2]).map(id => ({ id })));
    expect(await c.db.all(sql`pragma foreign_keys`)).toEqual([{ foreign_keys: 1 }]);
  } finally { release(); c.client?.close(); other.client?.close(); }
});

it('retains nested savepoint rollback inside a queued managed transaction', async () => {
  const c = createDb({ url: 'file::memory:' });
  try {
    await c.ready; await c.db.run(sql`create table nested_proof (id integer primary key)`);
    await c.db.transaction(async tx => {
      await tx.run(sql`insert into nested_proof values (1)`);
      await expect(tx.transaction(async nested => {
        await nested.run(sql`insert into nested_proof values (2)`); throw new Error('nested rollback');
      })).rejects.toThrow('nested rollback');
      await tx.run(sql`insert into nested_proof values (3)`);
    });
    expect(await c.db.all(sql`select id from nested_proof order by id`)).toEqual([{ id: 1 }, { id: 3 }]);
  } finally { c.client?.close(); }
});
