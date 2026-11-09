import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { lastServiceRequestAt, recordServiceRequest, resetRequestRates, serviceRequestRate, REQUEST_RATE_BUCKET_MS as B } from '../../src/lib/requestRate.js';
afterEach(() => resetRequestRates());
it('bounds retained heap for30 days of traffic without rate-reader pruning', () => {
 const moduleUrl = new URL('../../src/lib/requestRate.ts', import.meta.url).href;
 const program = `
 import { recordServiceRequest as record, resetRequestRates as reset } from ${JSON.stringify(moduleUrl)};
 const collect = () => { global.gc(); global.gc(); };
 function measure(n) { reset(); collect(); const before = process.memoryUsage().heapUsed; for(let i=0;i<n;i++) record(1,i*10000); collect(); return Math.max(0,process.memoryUsage().heapUsed-before); }
 for(let i=0;i<20000;i++) record(1,i*10000);
 const day=measure(8640), month=measure(8640*30); console.log(JSON.stringify({day,month,allowed:Math.max(3*day,2000000)})); reset();
 `;
 const child = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '--eval', program], { encoding: 'utf8', timeout: 30000 });
 expect(child.status, child.stderr).toBe(0);
 const observed = JSON.parse(child.stdout.trim()) as { day: number; month: number; allowed: number };
 expect(observed.day).toBeLessThanOrEqual(2000000); expect(observed.month).toBeLessThanOrEqual(observed.allowed);
});
it('expires write-only history strictly outside24 hours while retaining the exact boundary', () => {
 recordServiceRequest(1, 0); recordServiceRequest(1, 8640 * B); expect(serviceRequestRate(1, B, B, 0)).toBe(0.1);
 resetRequestRates(); recordServiceRequest(1, 0); recordServiceRequest(1, 8641 * B); expect(serviceRequestRate(1, B, B, 0)).toBe(0);
});
it('late expired requests cannot repopulate an evicted bucket', () => {
 recordServiceRequest(1, 8642 * B); recordServiceRequest(1, 0); expect(serviceRequestRate(1, B, B, 0)).toBe(0); expect(lastServiceRequestAt(1)).toBe(8643 * B);
});
it('reset and rate-driven emptying release latest-bucket ownership', () => {
 recordServiceRequest(1, 100 * B); serviceRequestRate(1, B, 26 * 3600000, 0); recordServiceRequest(1, 0); expect(lastServiceRequestAt(1)).toBe(B);
 resetRequestRates(); recordServiceRequest(1, 8000000000000000); resetRequestRates(); recordServiceRequest(1, 0); expect(lastServiceRequestAt(1)).toBe(B);
});
