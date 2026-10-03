/**
 * End-to-end smoke for the deploy-queue surface.
 *
 * Exercises the full path the operator sees in production:
 *   SDK client → HTTP request → Fastify route → fake DB → response → SDK
 *
 * The Fastify `app.inject()` API runs the registered routes against a
 * synthetic request without binding a port; we point the SDK at it by
 * passing a custom `fetch` to `createClient`. This catches contract
 * drift between the SDK shape (typed `QueueResponse` etc.) and the
 * server's response shape — a unit test on either side alone would
 * not surface a missing field or a renamed key.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createClient } from '@ninedeploy/sdk';
import { deploysRoutes } from '../src/modules/deploys.js';
import { buildTestApp, createFakeDb, depRow, svcRow } from './helpers.js';

const authMocks = vi.hoisted(() => ({
  resolveUser: vi.fn(async () => ({ id: 1, isOperator: true as const })),
}));
vi.mock('../src/lib/auth.js', () => authMocks);

/** Build a `fetch` that delegates to a Fastify app's `inject()`. */
function makeInProcessFetch(app: Awaited<ReturnType<typeof buildTestApp>>) {
  return async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    // The SDK hits absolute URLs like `http://x/v1/services/queue`; the
    // app.inject() helper only needs the path + headers. Strip the
    // synthetic origin before forwarding.
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) {
      if (typeof v === 'string') headers[k] = v;
    }
    // The SDK attaches `Authorization: Bearer <token>`; the in-process
    // test app reads `x-test-user` + `x-test-role` instead. Translate
    // the standard header into the test header so the SDK and the
    // fake auth resolver agree on a stable contract.
    const auth = headers['Authorization'] ?? headers['authorization'];
    if (auth?.startsWith('Bearer ')) {
      headers['x-test-user'] = auth.slice('Bearer '.length);
      headers['x-test-role'] = 'admin';
      delete headers['Authorization'];
      delete headers['authorization'];
    }
    const res = await app.inject({
      method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      url: path,
      headers,
      // inject() takes a raw string body — the SDK already JSON.stringifies
      // its payloads.
      payload: typeof init?.body === 'string' ? init.body : undefined,
    });
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      text: async () => res.body,
    } as unknown as Response;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SDK ↔ server queue end-to-end', () => {
  it('lists every in-flight deploy through the real route via the real SDK', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          deployments: [
            depRow({ id: 1, serviceId: 7, status: 'building' }),
            depRow({ id: 2, serviceId: 7, status: 'queued' }),
            depRow({ id: 3, serviceId: 8, status: 'queued' }),
          ],
          services: [
            svcRow({ id: 7, name: 'api' }),
            svcRow({ id: 8, name: 'web' }),
          ],
        },
      }),
    });
    await app.register(deploysRoutes, { prefix: '/v1/services' });

    const client = createClient({
      baseUrl: 'http://in-process',
      getToken: () => 'valid',
      fetch: makeInProcessFetch(app),
    });

    const queue = await client.deploys.queue();

    expect(queue.count).toBe(3);
    expect(queue.byStatus).toEqual({ building: 1, queued: 2, deploying: 0 });
    expect(queue.items).toHaveLength(3);
    // The SDK schema and the server response agree on the item shape.
    const item = queue.items[0]!;
    expect(item).toMatchObject({
      id: expect.any(Number),
      serviceId: expect.any(Number),
      serviceName: expect.any(String),
      status: expect.stringMatching(/^(queued|building|deploying)$/),
      createdAt: expect.any(String),
    });
    expect(['api', 'web']).toContain(item.serviceName);

    await app.close();
  });

  it('round-trips a typed success and a typed error on the same client', async () => {
    // One client, two operations. The success path proves the SDK
    // typed response matches the route JSON. The error path flips
    // the fake DB into "deploy removed" mode and proves the SDK
    // surfaces the server's 404 as a typed NineDeployError — same
    // shape a real consumer would see in production.
    const queue = [depRow({ id: 9, serviceId: 21, status: 'queued' })];
    let removed = false;
    const db = createFakeDb({
      findFirst: {
        services: () => svcRow({ id: 21 }),
        deployments: () => (removed ? undefined : queue[0]),
      },
      findMany: { deployments: queue },
    });
    const app = await buildTestApp({ db });
    await app.register(deploysRoutes, { prefix: '/v1/services' });

    const client = createClient({
      baseUrl: 'http://in-process',
      getToken: () => 'valid',
      fetch: makeInProcessFetch(app),
    });

    // Success: typed shape from server → typed shape to caller.
    const ok = await client.deploys.cancel(21, 9);
    expect(ok).toEqual({ ok: true, status: 'cancelled' });

    // Error: server 404 → typed SDK error with matching status.
    removed = true;
    await expect(client.deploys.remove(21, 9)).rejects.toMatchObject({
      status: 404,
    });

    await app.close();
  });
});
