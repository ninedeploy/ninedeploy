import { join } from 'node:path';
import { servingReceiptFixture } from './servingTrafficReceipt.js';
import { nodeServingTrafficContext } from '../../src/lib/nodeServingTrafficContext.js';

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
  console.log(JSON.stringify({ control: control === f.context, refusal, results: results.map(result => result.status === 'fulfilled'
    ? { status: result.status, sameContext: result.value === control }
    : { status: result.status, reason: String(result.reason) }) }));
} finally { f.c.client?.close(); }
