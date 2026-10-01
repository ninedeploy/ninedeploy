import rateLimit from '@fastify/rate-limit';
import fp from 'fastify-plugin';

/**
 * Global rate limiting, bucketed by PRINCIPAL (r478). The original IP-only
 * design pooled every client behind a proxy/NAT into one bucket — an operator
 * polling their own dashboard could be throttled by anonymous probing, CLI
 * traffic or another tenant sharing the egress IP ("Rate limit exceeded" on a
 * panel they alone use).
 *
 * The hook runs at preHandler — AFTER the panel's authenticate (an onRequest
 * hook) has resolved request.user — so:
 *   • authenticated requests bucket as `user:<id>` (a runaway script with a
 *     valid token is still capped per account);
 *   • unauthenticated requests (login brute-force, setup, the public webhook
 *     receiver, agent announce) keep the per-IP bucket. The tight per-route
 *     ceilings on those routes (see `config.rateLimit`) are the real
 *     brute-force guards and are unaffected.
 *
 * Trade-off: WebSocket upgrades (which hijack the socket at onRequest) no
 * longer pass through the limiter — every WS endpoint authenticates in the
 * subprotocol and revalidates, and connection floods are a proxy-level
 * (Traefik) concern, not an application-rate one.
 */
export default fp(
  async (fastify) => {
    await fastify.register(rateLimit, {
      global: true,
      max: 1000,
      timeWindow: '1 minute',
      hook: 'preHandler',
      keyGenerator: (request) => (request.user ? `user:${request.user.id}` : request.ip),
      // Don't leak rate-limit headers (reduces fingerprinting / probing surface).
      addHeadersOnExceeding: { 'x-ratelimit-remaining': false, 'x-ratelimit-limit': false },
      addHeaders: { 'x-ratelimit-remaining': false, 'x-ratelimit-limit': false, 'retry-after': true },
    });
  },
  { name: 'ninedeploy-rate-limit' },
);
