import assert from 'node:assert/strict';
import { recordServiceRequest as record, resetRequestRates as reset, lastServiceRequestAt as last, serviceRequestRate as rate, REQUEST_RATE_BUCKET_MS as B } from '../../apps/server/src/lib/requestRate.ts';
const KEEP = 8640;
const collect = () => { global.gc(); global.gc(); };
function memory(count) { reset(); collect(); const before = process.memoryUsage().heapUsed; for (let i = 0; i < count; i++) record(1, i * B); collect(); return Math.max(0, process.memoryUsage().heapUsed - before); }
for (let i = 0; i < 20000; i++) record(1, i * B);
const day = memory(KEEP), month = memory(KEEP * 30), allowed = Math.max(3 * day, 2000000);
assert.ok(day <= 2000000); assert.ok(month <= allowed); assert.equal(last(1), KEEP * 30 * B);
console.log('EXPECTED retained30-day bytes <=', allowed, 'ACTUAL:', month, 'day control:', day);
reset(); record(1, 0); record(1, (KEEP + 1) * B); assert.equal(rate(1, B, B, 0), 0);
reset(); record(1, 0); record(1, KEEP * B); assert.equal(rate(1, B, B, 0), 0.1);
reset(); record(1, (KEEP + 2) * B); record(1, 0); assert.equal(rate(1, B, B, 0), 0); assert.equal(last(1), (KEEP + 3) * B);
reset(); record(1, (KEEP + 2) * B); record(1, (KEEP + 1) * B); assert.equal(rate(1, 2 * B, (KEEP + 3) * B, 0), 0.1);
reset(); record(1, 0); const distant = 8000000000000000; record(1, distant); assert.equal(last(1), distant + B); assert.equal(rate(1, B, B, 0), 0);
reset(); record(1, distant); record(2, 0); assert.equal(last(2), B);
reset(); record(1, 100 * B); assert.equal(rate(1, B, 26 * 3600000, 0), 0); assert.equal(last(1), null); record(1, 0); assert.equal(last(1), B);
reset(); record(1, distant); reset(); record(1, 0); assert.equal(last(1), B);
reset(); record(null, distant); record(1, -B); assert.equal(last(1), 0);
reset(); collect(); console.log('10 memory/retention/boundary/order/jump/isolation/reset controls passed; FIX VERIFIED');
