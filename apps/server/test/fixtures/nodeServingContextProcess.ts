import { join } from 'node:path';
import { servingReceiptFixture } from './servingTrafficReceipt.js';
import { nodeServingTrafficContext } from '../../src/lib/nodeServingTrafficContext.js';
import { sql } from 'drizzle-orm';

const root = process.argv[2]!;
const f = await servingReceiptFixture(`file:${join(root, 'panel.db')}`);
try {
  const control = await nodeServingTrafficContext(f.c.db, f.input);
  let refusal = false;
  try { await nodeServingTrafficContext(f.c.db, { ...f.input, routingConfig: 'http: {}' }); }
  catch (error) { refusal = String(error).includes('serving routing or runtime context changed'); }
  const results = await Promise.allSettled([
    nodeServingTrafficContext(f.c.db, f.input), nodeServingTrafficContext(f.c.db, f.input),
  ]);
  await f.c.db.run(sql`create table concurrent_write_proof (id integer primary key)`);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const first = f.c.db.transaction(async tx => { await tx.run(sql`insert into concurrent_write_proof values (1)`); entered(); await gate; });
  await started;
  const second = f.c.db.transaction(async tx => { await tx.run(sql`insert into concurrent_write_proof values (2)`); });
  const writes = Promise.allSettled([first, second]); release();
  const writeResults = (await writes).map(result => result.status);
  const written = await f.c.db.all(sql`select id from concurrent_write_proof order by id`);
  console.log(JSON.stringify({ control: control === f.context, refusal, writeResults, written, results: results.map(result => result.status === 'fulfilled'
    ? { status: result.status, sameContext: result.value === control }
    : { status: result.status, reason: String(result.reason) }) }));
} finally { f.c.client?.close(); }
