import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { canaryTrafficCode, startCanaryTraffic } from '../../../scripts/lib/smoke-canary-traffic.mjs';

it('waits for a sampled traffic baseline before admitting the deploy', async () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const inner = vi.fn(() => ({ status: 0 }));
  const until = vi.fn(async (probe: () => boolean) => { expect(probe()).toBe(true); await ready; });
  let complete = false;
  const pending = startCanaryTraffic({ inner, until, client: 'fixture', fixtureImage: 'fixture:1', hostname: 'app.test' }).then(() => { complete = true; });
  await Promise.resolve();
  expect(until).toHaveBeenCalledOnce();
  expect(complete).toBe(false);
  expect(inner.mock.calls).toHaveLength(2);
  release();
  await pending;
  expect(complete).toBe(true);
});

it('marks readiness after 20 actual outcomes and retains an early 502 in the final evidence', async () => {
  const files = new Map<string, string>(), timers: Array<() => void> = [];
  let terminate!: () => void, requests = 0;
  const exit = vi.fn();
  const http = { request: (_: unknown, receive: (response: EventEmitter & { statusCode: number }) => void) => {
    const request = new EventEmitter() as EventEmitter & { setTimeout: () => void; end: () => void };
    request.setTimeout = () => {};
    request.end = () => {
      const response = Object.assign(new EventEmitter(), { statusCode: ++requests === 3 ? 502 : 200 });
      receive(response); response.emit('data', 'fixture'); response.emit('end');
    };
    return request;
  } };
  runInNewContext(canaryTrafficCode('app.test'), {
    require: (name: string) => name === 'node:http' ? http : { writeFileSync: (name: string, value: string) => files.set(name, value) },
    setTimeout: (fn: () => void) => timers.push(fn),
    process: { on: (_: string, fn: () => void) => { terminate = fn; }, exit },
  });
  const settled = async () => { await Promise.resolve(); await Promise.resolve(); };
  await settled();
  while (requests < 19) { timers.shift()!(); await settled(); }
  expect(files.has('/tmp/r1-traffic-ready')).toBe(false);
  timers.shift()!(); await settled();
  expect(files.has('/tmp/r1-traffic-ready')).toBe(true);
  terminate();
  const rows = JSON.parse(files.get('/tmp/r1-traffic.json')!);
  expect(rows).toHaveLength(20);
  expect(rows.filter((row: { status: number }) => row.status === 502)).toHaveLength(1);
  expect(exit).toHaveBeenCalledWith(0);
});

it('refuses to proceed when the collector never confirms a traffic baseline', async () => {
  const inner = vi.fn(() => ({ status: 1 }));
  const until = vi.fn(async (probe: () => boolean, _: string, deadline: number) => {
    expect(deadline).toBe(30_000);
    expect(probe()).toBe(false);
    throw Error('traffic baseline deadline');
  });
  await expect(startCanaryTraffic({ inner, until, client: 'fixture', fixtureImage: 'fixture:1', hostname: 'app.test' }))
    .rejects.toThrow('traffic baseline deadline');
});
