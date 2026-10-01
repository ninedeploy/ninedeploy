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
});
