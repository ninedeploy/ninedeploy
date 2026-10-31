import { expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';

it('addresses the R5 CI routes', async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const fetch = vi.fn(async (url: string, init: { method?: string; body?: string }) => {
    calls.push({ path: url.replace(/^https?:\/\/[^/]+/, ''), method: init.method ?? 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => '{}' } as Response;
  });
  const { ci } = createClient({ baseUrl: 'http://api.test', fetch });
  await ci.runners.list();
  await ci.runners.create({ name: 'builder', labels: ['linux'] });
  await ci.runners.revoke(3);
  await ci.pipeline(7);
  await ci.setPipeline(7, { image: 'node:24-alpine', script: 'npm test', gateDeploys: true });
  await ci.deletePipeline(7);
  await ci.jobs.list(7);
  await ci.jobs.get(7, 9);
  await ci.jobs.create(7);
  await ci.jobs.create(7, { ref: 'main' });
  await ci.jobs.approve(7, 9);
  await ci.jobs.cancel(7, 9);
  await ci.jobs.log(7, 9, 1);
  await ci.jobs.log(7, 9, 2, { offset: 120 });
  expect(calls).toEqual([
    { path: '/v1/ci/runners', method: 'GET', body: undefined },
    { path: '/v1/ci/runners', method: 'POST', body: { name: 'builder', labels: ['linux'] } },
    { path: '/v1/ci/runners/3', method: 'DELETE', body: undefined },
    { path: '/v1/services/7/ci', method: 'GET', body: undefined },
    { path: '/v1/services/7/ci', method: 'PUT', body: { image: 'node:24-alpine', script: 'npm test', gateDeploys: true } },
    { path: '/v1/services/7/ci', method: 'DELETE', body: undefined },
    { path: '/v1/services/7/ci/jobs', method: 'GET', body: undefined },
    { path: '/v1/services/7/ci/jobs/9', method: 'GET', body: undefined },
    { path: '/v1/services/7/ci/jobs', method: 'POST', body: {} },
    { path: '/v1/services/7/ci/jobs', method: 'POST', body: { ref: 'main' } },
    { path: '/v1/services/7/ci/jobs/9/approve', method: 'POST', body: undefined },
    { path: '/v1/services/7/ci/jobs/9/cancel', method: 'POST', body: undefined },
    { path: '/v1/services/7/ci/jobs/9/attempts/1/log', method: 'GET', body: undefined },
    { path: '/v1/services/7/ci/jobs/9/attempts/2/log?offset=120', method: 'GET', body: undefined },
  ]);
});
