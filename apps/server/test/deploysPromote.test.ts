import { describe, expect, it } from 'vitest';
import { deploysRoutes } from '../src/modules/deploys.js';
import { asUser, buildTestApp, createFakeDb, depRow, svcRow } from './helpers.js';

const STAGING = svcRow({
  id: 5,
  name: 'web-staging',
  slug: 'web-staging',
  repoUrl: 'https://github.com/acme/web.git',
  branch: 'develop',
  status: 'running',
});
const PROD = svcRow({
  id: 9,
  name: 'web-prod',
  slug: 'web-prod',
  repoUrl: 'https://github.com/acme/web.git',
  branch: 'main',
  status: 'running',
});

// loadServiceForUser is called twice (source, then target) — alternate rows.
function alternateServices(first: Record<string, unknown>, second: Record<string, unknown>) {
  let loads = 0;
  return () => (loads++ === 0 ? first : second);
}

async function build(db: ReturnType<typeof createFakeDb>) {
  const app = await buildTestApp({ db });
  await app.register(deploysRoutes, { prefix: '/services' });
  return app;
}

describe('POST /:id/promote', () => {
  it('enqueues a promote deploy on the target service at the source commit', async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const app = await build(
      createFakeDb({
        findFirst: {
          services: alternateServices(STAGING, PROD),
          deployments: depRow({ id: 3, status: 'running', commitSha: 'abc1234', serviceId: 5 }),
        },
        findMany: { deployments: [] },
        insert: {
          deployments: (v: Record<string, unknown>) => {
            inserts.push(v);
            return [depRow({ id: 42, status: 'queued' })];
          },
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/services/5/promote',
      headers: asUser(),
      payload: { targetServiceId: 9 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, commitSha: 'abc1234', promotedFrom: 'web-staging' });
    const dep = inserts.find((i) => i.serviceId === 9);
    expect(dep).toMatchObject({ status: 'queued', commitSha: 'abc1234' });
    await app.close();
  });

  it('refuses self-promotion', async () => {
    const app = await build(createFakeDb({ findFirst: { services: STAGING } }));
    const res = await app.inject({
      method: 'POST',
      url: '/services/5/promote',
      headers: asUser(),
      payload: { targetServiceId: 5 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('refuses promotion across different repositories', async () => {
    const OTHER = svcRow({
      id: 9,
      name: 'api-prod',
      slug: 'api-prod',
      repoUrl: 'https://github.com/acme/api.git',
      branch: 'main',
      status: 'running',
    });
    const app = await build(createFakeDb({ findFirst: { services: alternateServices(STAGING, OTHER) } }));
    const res = await app.inject({
      method: 'POST',
      url: '/services/5/promote',
      headers: asUser(),
      payload: { targetServiceId: 9 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('refuses when the source has no running deployment with a pinned commit', async () => {
    const app = await build(
      createFakeDb({
        findFirst: {
          services: alternateServices(STAGING, PROD),
          deployments: depRow({ id: 3, status: 'running', commitSha: null, serviceId: 5 }),
        },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/services/5/promote',
      headers: asUser(),
      payload: { targetServiceId: 9 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
