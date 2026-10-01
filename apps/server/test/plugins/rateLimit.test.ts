import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import rateLimitPlugin from '../../src/plugins/rateLimit.js';

describe('rateLimitPlugin', () => {
  it('rejects with 429 once a per-route ceiling is exceeded', async () => {
    const app = Fastify({ logger: false });
    await app.register(rateLimitPlugin);
    app.post(
      '/sensitive',
      { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } },
      async () => ({ ok: true }),
    );

    expect((await app.inject({ method: 'POST', url: '/sensitive' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/sensitive' })).statusCode).toBe(200);
    const blocked = await app.inject({ method: 'POST', url: '/sensitive' });
    expect(blocked.statusCode).toBe(429);
    await app.close();
  });

  it('counts buckets independently per route', async () => {
    const app = Fastify({ logger: false });
    await app.register(rateLimitPlugin);
    app.post('/a', { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, async () => ({ ok: true }));
    app.post('/b', { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, async () => ({ ok: true }));

    expect((await app.inject({ method: 'POST', url: '/a' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/a' })).statusCode).toBe(429);
    // Different route — independent bucket, still allowed.
    expect((await app.inject({ method: 'POST', url: '/b' })).statusCode).toBe(200);
    await app.close();
  });

  it('r478: authenticated requests bucket per PRINCIPAL, not per IP', async () => {
    // The panel owner was throttled on their own dashboard because every
    // client behind one proxy/NAT shared a single IP bucket. The limiter now
    // runs post-authentication and keys authenticated requests by user id —
    // an operator polling the dashboard can never be crowded out by
    // anonymous probing, while unauthenticated traffic stays per-IP.
    const app = Fastify({ logger: false });
    await app.register(rateLimitPlugin);
    app.addHook('onRequest', async (req, reply) => {
      // Stand in for the panel's authenticate hook: resolve the user from a
      // header (the real plugin runs at preHandler, after this).
      const who = req.headers['x-test-user'];
      if (who !== undefined) (req as { user?: { id: number } }).user = { id: Number(who) };
      void reply;
    });
    app.get(
      '/dash',
      { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } },
      async (req) => ({ who: (req as { user?: { id: number } }).user?.id ?? 'anon' }),
    );

    const H = (u: number | null) => (u === null ? {} : { 'x-test-user': String(u) });
    // Operator 1 exhausts THEIR bucket…
    expect((await app.inject({ method: 'GET', url: '/dash', headers: H(1) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/dash', headers: H(1) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/dash', headers: H(1) })).statusCode).toBe(429);
    // …operator 2 — same IP in the test harness — has their OWN bucket.
    expect((await app.inject({ method: 'GET', url: '/dash', headers: H(2) })).statusCode).toBe(200);
    // Anonymous (per-IP) is a third, separate bucket.
    expect((await app.inject({ method: 'GET', url: '/dash' })).statusCode).toBe(200);
    await app.close();
  });

  it('r479: requests that die BEFORE the preHandler limiter (401/403 guards) are still IP-capped', async () => {
    // The principal limiter is appended to route-level preHandlers, but the
    // module guards are instance-level — they run FIRST and a thrown 403
    // used to short-circuit past the limiter entirely: a valid low-privilege
    // credential could hammer operator routes unmetered. The rejection
    // backstop counts 400/401/403 responses per IP and refuses past the cap.
    const app = Fastify({ logger: false });
    await app.register(rateLimitPlugin);
    app.addHook('onRequest', async (req) => {
      const who = req.headers['x-test-user'];
      if (who !== undefined) (req as { user?: { id: number } }).user = { id: Number(who) };
    });
    // Instance-level guard BEFORE the route-level limiter — the real pattern.
    app.addHook('preHandler', async (req, reply) => {
      if (req.url?.startsWith('/admin') && (req as { user?: { id: number } }).user?.id !== 1) {
        return await reply.code(403).send({ error: 'forbidden' });
      }
    });
    app.get('/open', async () => ({ ok: true }));
    app.get('/admin', { config: { rateLimit: { max: 10_000, timeWindow: '1 minute' } } }, async () => ({ ok: true }));

    const H = (u: number) => ({ 'x-test-user': String(u) });
    // A low-privilege principal hammers the admin route: each request dies
    // with 403 at the instance guard (before the route-level limiter).
    let refused = 0;
    for (let i = 0; i < 12; i++) {
      const r = await app.inject({ method: 'GET', url: '/admin', headers: H(2) });
      if (r.statusCode === 403) refused++;
    }
    expect(refused).toBe(12); // the guard still does its job
    // …and after the backstop's ceiling, the IP is refused outright.
    // (Cap is 1000 in production; this test only proves the mechanism via
    // the production code path — hammer to the cap.)
    let saw429 = false;
    for (let i = 0; i < 1100; i++) {
      const r = await app.inject({ method: 'GET', url: '/admin', headers: H(2) });
      if (r.statusCode === 429) { saw429 = true; break; }
    }
    expect(saw429).toBe(true);
    // The 429 blocks the IP even for OTHER principals until the window
    // drains — acceptable: it takes 1000 pre-handler rejections in a minute
    // to get here, which is never legitimate traffic.
    // Successful traffic was never counted: the privileged user still works
    // when the window is clean (simulate by a fresh harness below).
    await app.close();

    const app2 = Fastify({ logger: false });
    await app2.register(rateLimitPlugin);
    app2.get('/open', async () => ({ ok: true }));
    for (let i = 0; i < 50; i++) {
      expect((await app2.inject({ method: 'GET', url: '/open' })).statusCode).toBe(200);
    }
    await app2.close();
  });
});
