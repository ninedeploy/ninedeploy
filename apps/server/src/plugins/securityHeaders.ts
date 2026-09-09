import fp from 'fastify-plugin';
import { config } from '../config.js';

/**
 * Baseline response security headers for the dashboard and API.
 *
 * Hand-rolled rather than `@fastify/helmet`: the header set a single-origin
 * control plane needs is small and fixed, and this avoids adding a dependency
 * (and its transitive tree) to a project that deliberately keeps that tree
 * audited and pinned. Swap in helmet if the policy ever grows past this.
 *
 * The Content-Security-Policy matches how the dashboard is actually built and
 * served (Vite bundle from @fastify/static, same-origin API and WebSocket):
 *   • `default-src 'self'`      — no third-party origins are used at runtime.
 *   • `style-src` allows inline — the bundler emits inline style attributes.
 *   • `img-src` allows data:    — icons/avatars are inlined by the bundler.
 *   • `connect-src 'self'`      — the log stream and event bus are same-origin
 *     WebSockets, and 'self' matches ws:// and wss:// on the document's own
 *     host. A bare `ws:` would let even an injected script open a WebSocket
 *     to ANY host, exfiltrating anything it can read.
 *   • `frame-ancestors 'none'`  — the real prize: the panel drives deploys,
 *     deletions and node approvals, so it must never be framed.
 * No `'unsafe-eval'`: nothing in the app needs it, and leaving it out is most
 * of the value of having a CSP at all.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export default fp(
  async (fastify) => {
    fastify.addHook('onSend', async (req, reply) => {
      reply.header('x-content-type-options', 'nosniff');
      reply.header('x-frame-options', 'DENY');
      reply.header('referrer-policy', 'no-referrer');
      // The dashboard needs no powerful browser features.
      reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
      // A CSP on a JSON 404 buys nothing and shows up in every API response;
      // scope it to documents, which is where it actually applies.
      const contentType = reply.getHeader('content-type');
      if (typeof contentType === 'string' && contentType.includes('text/html')) {
        reply.header('content-security-policy', CSP);
      }
      // HSTS only over a connection the browser reached via HTTPS: sending it
      // on plain HTTP is ignored by browsers, and sending it from a LAN-only
      // HTTP install would be a footgun if the host later serves TLS-less.
      if (config.isProd && (req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https')) {
        reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
      }
    });
  },
  { name: 'ninedeploy-security-headers' },
);
