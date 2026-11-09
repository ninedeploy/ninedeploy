import { expect, it, afterAll, afterEach } from 'vitest';
import { sql } from '../../packages/db/node_modules/drizzle-orm/index.js';
import { createDb } from '../../packages/db/src/client.js';
let failed = false;
afterEach(({ task }) => { if (task.result?.errors?.length) failed = true; });
afterAll(() => { if (!failed) console.log('FIX VERIFIED'); });
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
for (const url of ['file::memory:', ':memory:']) {
 it(`${url} commit, rollback and foreign-key enforcement retain the connection`, async () => {
  const c = createDb({ url }); try {
   await c.ready; await c.db.run(sql`create table parent (id integer primary key)`); await c.db.run(sql`create table child (id integer primary key, parent_id integer references parent(id))`);
   await c.db.transaction(tx => tx.run(sql`insert into parent values (1)`));
   await expect(c.db.transaction(async tx => { await tx.run(sql`insert into parent values (2)`); await tx.run(sql`insert into child values (1,999)`); })).rejects.toThrow();
   expect(await c.db.all(sql`select id from parent`)).toEqual([{ id: 1 }]); expect(await c.db.all(sql`pragma foreign_keys`)).toEqual([{ foreign_keys: 1 }]);
  } finally { c.client?.close(); }
 });
 for (const rollback of [false, true]) it(`${url} gated managed order releases after rollback=${rollback}`, async () => {
  const c = createDb({ url }), other = createDb({ url }); const entered = gate(), blocked = gate(); let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
  try {
   await c.ready; await other.ready; await c.db.run(sql`create table ordered (id integer primary key)`);
   first = c.db.transaction(async tx => { await tx.run(sql`insert into ordered values (1)`); entered.release(); await blocked.promise; if (rollback) throw new Error('controlled rollback'); });
   await entered.promise; second = c.db.transaction(tx => tx.run(sql`insert into ordered values (2)`)); const results = Promise.allSettled([first, second]);
   expect(await other.db.transaction(tx => tx.all(sql`select 42 as answer`))).toEqual([{ answer: 42 }]); blocked.release(); const settled = await results; expect(settled[0]?.status).toBe(rollback ? 'rejected' : 'fulfilled'); expect(settled[1]?.status).toBe('fulfilled'); expect(await c.db.all(sql`select id from ordered order by id`)).toEqual((rollback ? [2] : [1, 2]).map(id => ({ id })));
  } finally { blocked.release(); await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])]); c.client?.close(); other.client?.close(); }
 });
 it(`${url} nested savepoint rollback preserves outer transaction`, async () => {
  const c = createDb({ url }); try {
   await c.ready; await c.db.run(sql`create table nested (id integer primary key)`);
   await c.db.transaction(async tx => { await tx.run(sql`insert into nested values (1)`); await expect(tx.transaction(async inner => { await inner.run(sql`insert into nested values (2)`); throw new Error('inner rollback'); })).rejects.toThrow('inner rollback'); await tx.run(sql`insert into nested values (3)`); });
   expect(await c.db.all(sql`select id from nested order by id`)).toEqual([{ id: 1 }, { id: 3 }]);
  } finally { c.client?.close(); }
 });
}
