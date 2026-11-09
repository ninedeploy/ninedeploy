import { afterEach, expect, it } from 'vitest';
import type { Service } from '@ninedeploy/db';
import { lastServiceRequestAt, recordServiceRequest, resetRequestRates, REQUEST_RATE_BUCKET_MS } from '../../apps/server/src/lib/requestRate.js';
import { markAwake, resetSleepState, sleepHoldReason } from '../../apps/server/src/lib/sleep.js';
afterEach(() => { resetRequestRates(); resetSleepState(); });
function populate(count: number) { for (let i = 0; i < count; i++) recordServiceRequest(5, i * REQUEST_RATE_BUCKET_MS); return count * REQUEST_RATE_BUCKET_MS; }
it('control: last timestamp works for a full day of distinct buckets', () => {
 const expected = populate(8640); expect(lastServiceRequestAt(5)).toBe(expected);
});
it('long-running valid request history returns latest bucket without throwing', () => {
 const expected = populate(200000); let value: number | null = null, error: string | null = null;
 try { value = lastServiceRequestAt(5); } catch (err) { error = String(err); }
 console.log('EXPECTED:', expected, 'error null; ACTUAL:', value, error); console.log(error ? 'PROBLEM CONFIRMED' : 'PROBLEM NOT REPRODUCED'); expect({ value, error }).toEqual({ value: expected, error: null });
});
it('long-running traffic history does not abort the scale-to-zero idle decision', () => {
 const end = populate(200000);
 const svc = { id: 5, type: 'docker', status: 'running', serverId: null, orchestrator: null, runtimeId: 'r1', sleepAfterMinutes: 10, asleepAt: null } as Service;
 markAwake(svc, end - 600000); let value: string | null = null, error: string | null = null;
 try { value = sleepHoldReason(svc, { now: end + 600000, analyticsOn: true, inFlight: new Set(), routedDomains: 1, canaryRunning: false }); } catch (err) { error = String(err); }
 console.log('EXPECTED: idle decision null without error; ACTUAL:', value, error); console.log(error ? 'PROBLEM CONFIRMED' : 'PROBLEM NOT REPRODUCED'); expect({ value, error }).toEqual({ value: null, error: null });
});
