import { recordServiceRequest, resetRequestRates, lastServiceRequestAt, REQUEST_RATE_BUCKET_MS as B } from '../../apps/server/src/lib/requestRate.ts';
if (typeof global.gc !== 'function') throw new Error('Run node --expose-gc');
const collect = () => { global.gc(); global.gc(); };
for (let i = 0; i < 20000; i++) recordServiceRequest(1, i * B);
resetRequestRates(); collect();
function measure(count) {
 resetRequestRates(); collect(); const before = process.memoryUsage().heapUsed;
 for (let i = 0; i < count; i++) recordServiceRequest(1, i * B);
 collect(); const bytes = Math.max(0, process.memoryUsage().heapUsed - before);
 if (lastServiceRequestAt(1) !== count * B) throw new Error('Latest-time control failed');
 return bytes;
}
const day = measure(8640); const month = measure(8640 * 30); const allowed = Math.max(3 * day, 2000000);
console.log('CONTROL: fixed8640 buckets /1day retained bytes:', day, 'EXPECTED <=2000000');
console.log('EXPECTED: fixed259200 buckets /30days retain <=', allowed, 'bytes; ACTUAL:', month);
resetRequestRates(); collect();
if (day > 2000000) throw new Error('One-day control did not establish an acceptable memory baseline');
if (month > allowed) { console.log('PROBLEM CONFIRMED'); process.exitCode = 1; } else console.log('PROBLEM NOT REPRODUCED');
