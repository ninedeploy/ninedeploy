import websocket, { type WebsocketPluginOptions } from '@fastify/websocket';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import { config } from './config.js';
import rateLimitPlugin from './plugins/rateLimit.js';

/**
 * 0.15 (T2b): the agent's WebSocket server, used only by the node terminal
 * channel (`GET /agent/terminal`). The panel sends at most 32 KiB of payload
 * per frame, so 256 KiB bounds what an unauthenticated peer can make the
 * agent buffer. The default subprotocol selection (the first offered) echoes
 * the single-use channel id, which is not a credential.
 */
export const AGENT_WEBSOCKET_MAX_PAYLOAD = 256 * 1024;
export const agentWebsocketOptions: WebsocketPluginOptions = { options: { maxPayload: AGENT_WEBSOCKET_MAX_PAYLOAD } };

/**
 * The agent's minimal HTTP surface: rate limiting plus (once the caller
 * registers `agentRoutes`) ONLY the token-gated /agent/exec and /agent/ping
 * routes, and (0.15) the /agent/terminal channel a sealed `terminal.open`
 * hands out. Deliberately NOT buildApp(): an agent host must never expose the
 * API/dashboard/deploy worker, which would run against a fresh local SQLite
 * and turn any reachable agent into a full control plane.
 */
export async function buildAgentApp() {
  const app = Fastify({
    // r438/r456: above the agent's OWN 1 MiB content caps on purpose. Those caps
    // (MAX_PROXY_CONFIG_BYTES / MAX_WORKSPACE_FILE_BYTES in agent.ts) apply
    // to the decoded content, but workspace files travel base64-wrapped in
    // JSON — a ~4/3 inflation plus envelope overhead that pushed honest 1 MiB
    // payloads past Fastify's default 1 MiB bodyLimit, so the request died
    // with a generic 413 before the agent's own (better-messaged) check ever
    // ran. The effective cap was ~0.75 MiB while the errors claimed 1 MiB.
    // 2 MiB covers the ~1.4 MiB worst-case envelope with headroom; the content
    // limits stay the real gate, and pre-auth per-request buffering stays
    // bounded (the body parses before the token check, rate-limited per IP).
    bodyLimit: 2 * 1024 * 1024,
    // Same reasoning as buildApp(): the agent may sit behind the panel's
    // Traefik (agent enrolment routes are proxied), so trust the configured
    // hop count for rate-limit keying.
    trustProxy: config.trustProxy,
    logger: {
      // Same rule as the master app: never persist query strings.
      serializers: {
        req(req: { method?: string; url: string; remoteAddress?: string; hostname?: string }) {
          const url = req.url.split('?')[0]!;
          return { method: req.method, url, remoteAddress: req.remoteAddress, hostname: req.hostname };
        },
      },
    },
  });

  await app.register(rateLimitPlugin);
  // 0.15 (T2b): after the rate limiter, so the upgrade request is limited too.
  await app.register(websocket, agentWebsocketOptions);

  app.setErrorHandler((err: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
    const status =
      err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) app.log.error({ err }, 'agent request error');
    return reply.status(status).send({
      error: {
        code: err.code ?? 'internal_error',
        message: status >= 500 && config.isProd ? 'Internal server error' : err.message,
      },
    });
  });

  return app;
}
