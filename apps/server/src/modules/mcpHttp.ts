import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { DEFAULT_MCP_HTTP_POLICY, mcpHttpPolicy, mcpHttpPolicyPatch, type McpHttpPolicy } from '@ninedeploy/schemas';
import { buildServer, handleHttpRequest } from '@ninedeploy/mcp';
import { createClient } from '@ninedeploy/sdk';
import { audit } from '../lib/audit.js';
import { resolveUser } from '../lib/auth.js';
import { mcpInternalHeaders } from '../lib/mcpAudience.js';
import { protectedResourceMetadataUrl } from './mcpOAuth.js';
import { forbidden, HttpError, notFound, unauthorized } from '../lib/errors.js';
import { getSettingJson, setSettingJson } from '../lib/settings.js';

/**
 * R4 remote MCP over Streamable HTTP.
 *  - `POST /v1/mcp`: the MCP endpoint (stateless, JSON responses). The caller
 *    presents an API token as `Authorization: Bearer`; every tool call then
 *    runs as an in-process request to the API with that same token, so the
 *    route's own authorization, the token's scopes and 2FA apply per call,
 *    and a revoked or expired token fails on its next request.
 *  - `GET`/`PUT /v1/mcp/policy` (operator): on/off and read-only.
 *
 * `/v1/mcp` sits outside the `authenticate` hook on purpose: that hook would
 * refuse a read-only or resource-scoped token on any POST, while what such a
 * token may do is decided per tool call, by the route the tool calls.
 */

const KEY = 'mcp_http';

export async function getMcpHttpPolicy(db: FastifyInstance['db']): Promise<McpHttpPolicy> {
  const parsed = mcpHttpPolicy.safeParse(await getSettingJson(db, KEY, null));
  return parsed.success ? parsed.data : DEFAULT_MCP_HTTP_POLICY;
}

const view = (policy: McpHttpPolicy) => ({ policy, path: '/v1/mcp' as const });

export const mcpPolicyRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireOperator);

  app.get('/', async () => view(await getMcpHttpPolicy(app.db)));

  app.put('/', async (req) => {
    const patch = mcpHttpPolicyPatch.parse(req.body ?? {});
    const policy = mcpHttpPolicy.parse({ ...(await getMcpHttpPolicy(app.db)), ...patch });
    await setSettingJson(app.db, KEY, policy);
    void audit(app.db, req.user!.id, 'mcp.policy', 'mcp', { ...policy });
    return view(policy);
  });
};

/** The SDK's fetch, answered in process by the API itself, as the caller and from the caller's address. */
export function injectFetch(app: FastifyInstance, req: FastifyRequest) {
  return async (input: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const url = new URL(input);
    const res = await app.inject({
      method: (init.method ?? 'GET') as 'GET',
      url: `${url.pathname}${url.search}`,
      headers: { ...init.headers, ...(req.headers['user-agent'] ? { 'user-agent': String(req.headers['user-agent']) } : {}), ...mcpInternalHeaders() },
      remoteAddress: req.ip,
      ...(init.body !== undefined ? { payload: init.body } : {}),
    });
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      text: async () => res.body,
      headers: {
        get: (name: string) => {
          const v = res.headers[name.toLowerCase()];
          return v == null ? null : Array.isArray(v) ? v.join(', ') : String(v);
        },
      },
    };
  };
}

export const mcpEndpointRoutes: FastifyPluginAsync = async (app) => {
  const challenge = 'Bearer realm="ninedeploy-mcp"';

  app.post('/', async (req, reply) => {
    // DNS rebinding: a browser page on another origin must not drive the endpoint.
    // MCP clients send no Origin; a browser always does.
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let same = false;
      try {
        const o = new URL(origin);
        // Both sides through URL, so a default port (`:80`, `:443`) compares equal either way.
        same = o.host === new URL(`${o.protocol}//${req.headers.host ?? ''}`).host;
      } catch {
        /* not a URL */
      }
      if (!same) throw forbidden('Cross-origin requests to the MCP endpoint are refused');
    }
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const user = token ? await resolveUser(app.db, token, { audience: 'mcp' }) : null;
    if (!user) {
      // R4: the challenge names the resource metadata, where an OAuth client starts.
      reply.header('WWW-Authenticate', `${challenge}, resource_metadata="${protectedResourceMetadataUrl(req)}"`);
      throw unauthorized();
    }
    if (user.twoFactorPending) throw new HttpError(403, 'two_factor_required', 'A workspace you belong to requires two-factor authentication.');
    const policy = await getMcpHttpPolicy(app.db);
    if (!policy.enabled) throw notFound('Remote MCP is off. An operator can turn it on under Settings → API tokens → Remote MCP.');
    const client = createClient({ baseUrl: 'http://ninedeploy.internal', getToken: () => token, fetch: injectFetch(app, req) });
    reply.hijack();
    await handleHttpRequest(req.raw, reply.raw, req.body, {
      client,
      build: (c, options) => buildServer(c, () => undefined, options),
      readOnly: policy.readOnly,
      tokenScopes: user.tokenScopes,
    });
  });

  // Stateless: no server-to-client stream and no session to end.
  const notAllowed = async (_req: FastifyRequest, reply: { header: (k: string, v: string) => unknown; code: (n: number) => { send: (b: unknown) => unknown } }) => {
    reply.header('Allow', 'POST');
    return reply.code(405).send({ error: 'method_not_allowed', message: 'This MCP endpoint is stateless: POST JSON-RPC messages to it.' });
  };
  app.get('/', notAllowed as never);
  app.delete('/', notAllowed as never);
};
