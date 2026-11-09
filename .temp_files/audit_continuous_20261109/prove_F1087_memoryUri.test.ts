import { expect, it } from 'vitest';
import { sql } from '../../packages/db/node_modules/drizzle-orm/index.js';
import { createDb } from '../../packages/db/src/client.js';
for (const url of ['file::memory:', ':memory:']) it(`managed transaction works for supported memory URI ${url}`, async () => {
 const c = createDb({ url });
 try {
  await c.ready; await c.db.run(sql`create table adapter_proof (id integer primary key)`); let error: string | null = null;
  try { await c.db.transaction(async tx => { await tx.run(sql`insert into adapter_proof values (1)`); }); } catch (err) { error = String(err); }
  console.log('EXPECTED: successful memory transaction /error null; ACTUAL:', url, error);
  console.log(error ? 'PROBLEM CONFIRMED' : 'PROBLEM NOT REPRODUCED'); expect(error).toBeNull(); expect(await c.db.all(sql`select id from adapter_proof`)).toEqual([{ id: 1 }]);
 } finally { c.client?.close(); }
});
