import { eq } from 'drizzle-orm';
import { apiTokens } from '@ninedeploy/db';
import fp from 'fastify-plugin';
import { narrowScopes, resolveUser } from '../lib/auth.js';
import { sha256 } from '../lib/crypto.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export interface AuthUser {
  id: number;
  /**
   * True when `users.is_instance_operator` is set. Recomputed on every request
   * so granting or revoking it takes effect immediately. Deliberately not
   * derived from workspace roles — see `lib/resourceAccess.ts:isOperator`.
   *
   * A scope-restricted API token can only ever narrow this, never widen it.
   */
  isOperator: boolean;
  /**
   * Scopes of the API token used for this request, or `null` for an
   * interactive session (JWT) and for legacy tokens created before scopes
   * were enforced. `null` means unrestricted.
   */
  tokenScopes: string[] | null;
}

/** Methods that cannot change server state. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * `/v1/<first-segment>` → the fine-grained scopes [read, write] the mount
 * requires. All values are literals on purpose. Anything absent from this
 * table is unreachable for a fine-grained token — the table failing closed is
 * the point: a new mount is out of bounds for restricted tokens until someone
 * names its resource here.
 */
const PREFIX_SCOPES: Record<string, readonly [string, string]> = {
  services: ['nd://scope/read/services', 'nd://scope/write/services'],
  projects: ['nd://scope/read/projects', 'nd://scope/write/projects'],
  databases: ['nd://scope/read/databases', 'nd://scope/write/databases'],
  domains: ['nd://scope/read/domains', 'nd://scope/write/domains'],
  'domain-transfers': ['nd://scope/read/domains_transfer', 'nd://scope/write/domains_transfer'],
  'domain-presets': ['nd://scope/read/domains', 'nd://scope/write/domains'],
  'config-presets': ['nd://scope/read/config', 'nd://scope/write/config'],
  alerts: ['nd://scope/read/alerts', 'nd://scope/write/alerts'],
  notifications: ['nd://scope/read/notifications', 'nd://scope/write/notifications'],
  backups: ['nd://scope/read/backups', 'nd://scope/write/backups'],
  'backup-destinations': ['nd://scope/read/backups', 'nd://scope/write/backups'],
  volumes: ['nd://scope/read/volumes', 'nd://scope/write/volumes'],
  users: ['nd://scope/read/users', 'nd://scope/write/users'],
  settings: ['nd://scope/read/settings', 'nd://scope/write/settings'],
  config: ['nd://scope/read/config', 'nd://scope/write/config'],
  topology: ['nd://scope/read/topology', 'nd://scope/write/topology'],
  insights: ['nd://scope/read/manifests', 'nd://scope/write/manifests'],
  firewall: ['nd://scope/read/firewall', 'nd://scope/write/firewall'],
  sso: ['nd://scope/read/sso', 'nd://scope/write/sso'],
  egress: ['nd://scope/read/egress', 'nd://scope/write/egress'],
  orchestrators: ['nd://scope/read/orchestrators', 'nd://scope/write/orchestrators'],
  housekeeping: ['nd://scope/read/housekeeping', 'nd://scope/write/housekeeping'],
  system: ['nd://scope/read/health', 'nd://scope/write/health'],
  env: ['nd://scope/read/env', 'nd://scope/write/env'],
};

/**
 * Sub-resources mounted under a parent prefix but scoped on their own
 * (api.ts registers `webhookMgmtRoutes` under `/services`, for example).
 * Checked BEFORE the prefix table, most specific first.
 */
const ROUTE_SCOPE_OVERRIDES: Array<[RegExp, readonly [string, string]]> = [
  [/^services\/\d+\/env\b/, ['nd://scope/read/env', 'nd://scope/write/env']],
  [/^services\/\d+\/webhooks\b/, ['nd://scope/read/webhooks', 'nd://scope/write/webhooks']],
  [/^services\/\d+\/deploys\b/, ['nd://scope/read/deploys', 'nd://scope/write/deploys']],
  [/^services\/\d+\/volumes\b/, ['nd://scope/read/volumes', 'nd://scope/write/volumes']],
  [/^services\/\d+\/insights\b/, ['nd://scope/read/manifests', 'nd://scope/write/manifests']],
  [/^services\/\d+\/domains\b/, ['nd://scope/read/domains', 'nd://scope/write/domains']],
];

/**
 * The fine-grained scope a request requires — always one of the literal
 * table values above, never assembled from the URL — or `null` when the URL
 * does not map to a scoped resource (which a fine-grained token may not
 * access). Exported for tests.
 */
export function requiredFineGrainedScope(url: string, method: string): string | null {
  const query = url.indexOf('?');
  let path = query === -1 ? url : url.slice(0, query);
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const apiRoot = '/v1/';
  if (!path.startsWith(apiRoot)) return null;
  const rest = path.slice(apiRoot.length);
  if (rest.length === 0) return null;
  const isRead = SAFE_METHODS.has(method);
  for (const [pattern, pair] of ROUTE_SCOPE_OVERRIDES) {
    if (pattern.test(rest)) return isRead ? pair[0] : pair[1];
  }
  const firstSlash = rest.indexOf('/');
  const top = firstSlash === -1 ? rest : rest.slice(0, firstSlash);
  const pair = PREFIX_SCOPES[top];
  if (!pair) return null;
  return isRead ? pair[0] : pair[1];
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Pre-handler that verifies a Bearer token (JWT access or API token). */
    authenticate: (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>;
    /** Pre-handler that requires the authenticated user to carry the
     *  instance-operator flag. Run after `authenticate`. */
    requireOperator: (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>;
    /**
     * Legacy alias for `requireOperator`. After the team overhaul, "admin"
     * no longer means a global `users.role` value; both names now resolve to
     * the same operator check. Existing call sites keep working unchanged.
     */
    requireAdmin: (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>;
    /**
     * Per-route fine-grained scope check (G-08). A route can
     * declare `config: { scope: 'write:services' }` (legacy
     * shorthand) or `config: { scope: 'nd://scope/write/services' }`
     * (resource-scoped) and this pre-handler will refuse the
     * request when the bearer token's stored scopes do not
     * cover it. Operator scope and the legacy `write`
     * shorthand cover any fine-grained scope; an interactive
     * session (JWT) is always treated as fully covered.
     */
    requireScope: (
      scope: string,
    ) => (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

/**
 * Authentication strategy: the `Authorization: Bearer <token>` header may hold
 * either a signed JWT access token (web/CLI sessions) or an opaque API token
 * (CI/scripts). Both resolve to `req.user.id` and a freshly-computed
 * `req.user.isOperator` flag.
 */
export default fp(
  async (fastify) => {
    fastify.decorateRequest('user', null);
    fastify.decorate('authenticate', async (req) => {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) throw unauthorized();
      const token = header.slice('Bearer '.length).trim();
      const user = await resolveUser(fastify.db, token);
      if (!user) throw unauthorized();

      // Apply API-token scopes. This is the single enforcement point: doing it
      // here (rather than annotating every route) means a new endpoint is
      // covered the day it is added, and it cannot be forgotten.
      //
      // Before 0.3.5 the `scopes` column was written as `[]` and never read, so
      // every token — including the ones handed to CI and to the MCP server —
      // carried its owner's full authority, operator flag included.
      if (user.tokenScopes !== null) {
        const scopes = user.tokenScopes;
        narrowScopes(user);
        // A fine-grained `nd://scope/write/<resource>` token IS a write token —
        // but only for the resources it names (checked below). The coarse
        // legacy scopes and `operator` keep their any-resource meaning.
        const mayWrite =
          scopes.includes('write') ||
          scopes.includes('operator') ||
          scopes.some((s) => /^nd:\/\/scope\/(write|admin)\//.test(s));
        if (!mayWrite && !SAFE_METHODS.has(req.method)) {
          throw forbidden('This API token is read-only');
        }
        // Fine-grained URI scopes must actually NARROW. Stored-but-never-checked
        // `nd://scope/...` values were decoration: a token holding only
        // `nd://scope/read/services` could still write every resource. When a
        // token carries any fine-grained scope, every request must be covered
        // for its resource+method; anything the route map cannot classify is
        // out of reach (fail closed). Coarse-only tokens keep the behaviour
        // above.
        if (scopes.some((s) => s.startsWith('nd://scope/'))) {
          const required = requiredFineGrainedScope(req.url, req.method);
          if (required === null || !scopeCovers(user, required)) {
            throw forbidden(
              required === null
                ? 'This API token is not scoped for this resource'
                : `This token is missing the required scope: ${required}`,
            );
          }
        }
      }
      req.user = user;

      // Stamp API-token last-used time (best effort; JWTs have no DB row).
      if (token.split('.').length !== 3) {
        await fastify.db
          .update(apiTokens)
          .set({ lastUsedAt: new Date() })
          .where(eq(apiTokens.hash, sha256(token)));
      }
    });

    fastify.decorate('requireOperator', async (req) => {
      // `authenticate` is expected to run first (as an onRequest hook), and it
      // has already resolved `isOperator` from `users.is_instance_operator` AND
      // narrowed it for scope-restricted API tokens. Re-querying the DB here
      // would undo that narrowing, so the flag on the request is authoritative.
      if (!req.user) throw unauthorized();
      if (!req.user.isOperator) throw forbidden('Operator access required');
    });

    // Back-compat alias — see the JSDoc on the FastifyInstance augmentation.
    fastify.decorate('requireAdmin', async (req) => {
      if (!req.user) throw unauthorized();
      if (!req.user.isOperator) throw forbidden('Admin access required');
    });

    // Per-route fine-grained scope check (G-08). The factory
    // closes over the required scope; the pre-handler reads
    // the bearer token's stored scopes (already on
    // `req.user.tokenScopes` from the authenticate hook) and
    // refuses when they don't cover the requirement.
    fastify.decorate('requireScope', (scope) => async (req) => {
      if (!req.user) throw unauthorized();
      if (!scopeCovers(req.user, scope)) throw forbidden(`This token is missing the required scope: ${scope}`);
    });
  },
  { name: 'ninedeploy-auth' },
);

/**
 * Decide whether `user`'s token scopes cover the
 * `required` scope. The rule:
 *   - `null` scopes (interactive JWT or legacy token) cover
 *     every fine-grained scope.
 *   - The legacy `operator` scope covers every scope.
 *   - The legacy `write` scope covers every fine-grained
 *     `nd://scope/write/<resource>` AND
 *     `nd://scope/admin/<resource>` (admin implies write).
 *   - The legacy `read` scope covers every fine-grained
 *     `nd://scope/read/<resource>`.
 *   - Otherwise exact match on the URI form.
 */
function scopeCovers(user: AuthUser, required: string): boolean {
  const scopes = user.tokenScopes;
  if (scopes === null) return true;
  if (scopes.includes('operator')) return true;
  if (scopes.includes(required)) return true;
  // Match the legacy coarse scopes against a fine-grained
  // URI requirement.
  if (required.startsWith('nd://scope/admin/') || required.startsWith('nd://scope/write/')) {
    if (scopes.includes('write') || scopes.includes('admin')) return true;
  }
  if (required.startsWith('nd://scope/read/')) {
    if (scopes.includes('read')) return true;
  }
  // `nd://scope/admin/X` is a strict superset of
  // `nd://scope/write/X` and `nd://scope/read/X`; the
  // resource-scope form does NOT cross resources (an
  // admin scope on `services` does not cover `databases`).
  if (required.startsWith('nd://scope/write/')) {
    const resource = required.slice('nd://scope/write/'.length);
    if (scopes.includes(`nd://scope/admin/${resource}`)) return true;
  }
  if (required.startsWith('nd://scope/read/')) {
    const resource = required.slice('nd://scope/read/'.length);
    if (scopes.includes(`nd://scope/write/${resource}`)) return true;
    if (scopes.includes(`nd://scope/admin/${resource}`)) return true;
  }
  return false;
}
