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
 * Trade-off note (r479, corrected): WebSocket upgrades DO traverse the
 * preHandler limiter (IP-keyed — no principal before auth) — @fastify/websocket
 * hijacks the socket in the route handler, not at onRequest, as an earlier
 * comment wrongly claimed.
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

    // r479: the principal limiter is APPENDED to route-level preHandlers, but
    // the module guards (requireAdmin/requireOperator) are INSTANCE-level
    // preHandlers — they run FIRST, and a thrown 401/403 short-circuits the
    // lifecycle before the limiter ever fires. A valid low-privilege
    // credential could therefore hammer operator-gated routes unmetered
    // (three DB round trips of auth per request). Backstop: count requests
    // that DIE with 400/401/403 per IP and refuse the next ones past the
    // same 1000/min ceiling. Successful traffic is never counted at IP level
    // (the principal limiter owns it), so the owner-throttle fix is intact.
    const REJECTION_WINDOW_MS = 60_000;
    const REJECTION_CAP = 1000;
    // r480: the map is keyed by source IP and every distinct IP that ever
    // produces one rejection leaves an entry — background scanning grows it
    // monotonically (~250 B/entry; an IPv6 /64 can mint unlimited keys at one
    // request each). Prune-on-write past this size: entries whose NEWEST
    // stamp has aged out go first (insertion order), so currently-engaged
    // IPs survive the sweep. Hard ceiling for the pathological case after
    // the sweep: drop the oldest-inserted keys regardless of age.
    const REJECTION_MAP_SOFT_CAP = 10_000;
    const PRE_HANDLER_DEATH = new Set([400, 401, 403]);
    const rejections = new Map<string, number[]>();

    fastify.addHook('onResponse', async (req, reply) => {
      if (!PRE_HANDLER_DEATH.has(reply.statusCode)) return;
      const key = req.ip;
      const now = Date.now();
      const stamps = (rejections.get(key) ?? []).filter((t) => now - t < REJECTION_WINDOW_MS);
      stamps.push(now);
      rejections.set(key, stamps);
      if (rejections.size <= REJECTION_MAP_SOFT_CAP) return;
      for (const [k, v] of rejections) {
        if (now - (v[v.length - 1] ?? 0) >= REJECTION_WINDOW_MS) rejections.delete(k);
      }
      let over = rejections.size - REJECTION_MAP_SOFT_CAP;
      for (const k of rejections.keys()) {
        if (over <= 0) break;
        rejections.delete(k);
        over--;
      }
    });

    fastify.addHook('onRequest', async (req, reply) => {
      const now = Date.now();
      const stamps = (rejections.get(req.ip) ?? []).filter((t) => now - t < REJECTION_WINDOW_MS);
      if (stamps.length === 0) rejections.delete(req.ip);
      else rejections.set(req.ip, stamps);
      if (stamps.length < REJECTION_CAP) return;
      const retryAfter = Math.max(1, Math.ceil((REJECTION_WINDOW_MS - (now - stamps[0]!)) / 1000));
      reply.header('retry-after', String(retryAfter));
      // The app error envelope ({ error: { code, message } }) — the web
      // client's error parser reads exactly this shape, so the flood moment
      // renders the real message instead of "Request failed with status 429".
      return await reply.code(429).send({
        error: { code: 'rate_limited', message: `Rate limit exceeded, retry in ${retryAfter} seconds` },
      });
    });
  },
  { name: 'ninedeploy-rate-limit' },
);
