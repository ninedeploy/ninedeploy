import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { swarmTrafficSampler } from '../../../scripts/lib/smoke-swarm-runtime.mjs';

it.each([
  [200, 'baked-one', 'one', true], [200, 'baked-two', 'two', true], [502, 'baked-one', 'one', false],
  [200, 'foreign', null, false], [200, 'baked-one'.repeat(3000), null, false],
] as const)('retains actual HTTP %s and accepts only the two exact fixture bodies', async (status, body, label, application) => {
  let receive!: (req: { url: string }, res: { end: (body: string) => void }) => Promise<void>;
  let host: string | undefined;
  runInNewContext(swarmTrafficSampler('owned.test'), {
    require: () => ({
      createServer: (handler: typeof receive) => { receive = handler; return { listen() {} }; },
      get: (options: { headers: { host: string } }, handler: (response: EventEmitter & { statusCode: number; setEncoding: () => void }) => void) => {
        host = options.headers.host;
        const request = Object.assign(new EventEmitter(), { destroy() {} });
        queueMicrotask(() => {
          const response = Object.assign(new EventEmitter(), { statusCode: status, setEncoding() {} });
          handler(response); response.emit('data', body); response.emit('end');
        });
        return request;
      },
    }),
    setTimeout: () => 1, clearTimeout() {},
  });
  let result = '';
  await receive({ url: '/finish' }, { end: value => { result = value; } });
  expect(host).toBe('owned.test');
  expect(JSON.parse(result)).toEqual([expect.objectContaining({ status, label, application })]);
});
