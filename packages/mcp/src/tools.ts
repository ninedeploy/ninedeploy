import { z } from 'zod';
import type { NineDeployClient } from '@ninedeploy/sdk';
import { SPEC_TOOLS } from './generated/specTools.js';

/**
 * The MCP tool surface: read-only inspection plus a handful of guarded actions
 * (deploy, cancel, restart, rollback). Every tool maps 1:1 onto the typed SDK,
 * so the MCP wire can never express anything the HTTP API could not, and API
 * token scopes still gate every write (`plugins/auth.ts`).
 *
 * `cancel_deploy` is deliberately paired with `deploy_service`: an agent that
 * can start a build must be able to stop one, or a runaway deploy it triggered
 * can only be halted from a browser.
 */

export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodTypeAny;
  handler: (client: NineDeployClient, input: unknown) => Promise<unknown>;
  /**
   * Fine-grained scopes the token must hold for this tool
   * to be registered (G-08). Multiple scopes are AND'd;
   * the token must hold every one. An empty / missing
   * array means "any token" — the existing behaviour for
   * the pre-G-08 read-only env var continues to apply
   * separately. The introspection layer maps the legacy
   * `read` / `write` / `operator` shorthand to the
   * resource-scoped form, so a `write` token covers
   * `nd://scope/write/<resource>` for every resource.
   *
   * r333: the fine-grained entries must be EXACTLY the scope the server's
   * route map (apps/server/src/plugins/auth.ts `requiredFineGrainedScope`)
   * demands for the tool's route — not a guess at a related resource. The
   * literal `operator` is listed when the route is operator-only
   * (requireAdmin / requireOperator): the server drops the owner's operator
   * flag from every token that does not carry the `operator` scope.
   * apps/server/test/mcpScopeContract.test.ts pins the route half against
   * the server's classifier.
   */
  requiredScopes?: string[];
  /**
   * r333: the tool's route has NO entry in the server's fine-grained route
   * map. The server refuses (403 "not scoped for this resource") such a
   * route for every token that carries any `nd://scope/…` entry, whatever
   * else the token holds — only interactive sessions, legacy unrestricted
   * tokens and coarse `read` / `write` / `operator` tokens reach it. Such a
   * tool is hidden from fine-grained tokens; `requiredScopes` then states
   * only the coarse requirement.
   */
  coarseTokenOnly?: true;
}

const serviceId = z.object({ serviceId: z.number().int().positive() });
const databaseId = z.object({ databaseId: z.number().int().positive() });
const entityOpt = z.object({ entity: z.string().optional() });

/** The hand-curated tools: every write lives here. */
const HAND_WRITTEN: ToolDef[] = [
  {
    name: 'list_services',
    description: 'List all deployed services with status, type and branch. Optionally scope to a project.',
    input: z.object({ projectId: z.number().int().positive().optional() }),
    requiredScopes: ['nd://scope/read/services'],
    handler: (c, input) => {
      const { projectId } = input as { projectId?: number };
      // The server dropped the legacy `?projectId=` query — it only reads
      // tagProjectIds/tagWorkspaceIds/tagLabelIds, so the old query silently
      // returned ALL services instead of the project's.
      return c.services.list(projectId != null ? `?tagProjectIds=${projectId}` : '');
    },
  },
  {
    name: 'get_service',
    description: 'Get one service in full detail (build config, limits, runtime).',
    input: serviceId,
    requiredScopes: ['nd://scope/read/services'],
    handler: (c, input) => c.services.get((input as { serviceId: number }).serviceId),
  },
  {
    name: 'service_logs',
    description: 'Read the recent runtime logs of a service.',
    input: serviceId,
    requiredScopes: ['nd://scope/read/services'],
    handler: (c, input) => c.services.logs((input as { serviceId: number }).serviceId),
  },
  {
    name: 'list_deploys',
    description: 'Deployment history of a service (status, commit, trigger).',
    input: serviceId,
    requiredScopes: ['nd://scope/read/deploys'],
    handler: (c, input) => c.deploys.list((input as { serviceId: number }).serviceId),
  },
  {
    name: 'list_domains',
    description: 'All routed domains across services, with SSL and status.',
    input: z.object({}),
    requiredScopes: ['nd://scope/read/domains'],
    handler: (c) => c.domains.all(),
  },
  {
    name: 'list_databases',
    description: 'Managed databases with engine and status.',
    input: z.object({}),
    requiredScopes: ['nd://scope/read/databases'],
    handler: (c) => c.databases.list(),
  },
  {
    name: 'list_projects',
    description: 'Projects with service/database counts.',
    input: z.object({}),
    requiredScopes: ['nd://scope/read/projects'],
    handler: (c) => c.projects.list(),
  },
  {
    name: 'list_alerts',
    description: 'Configured alert rules (cpu, memory, cert-expiry, disk, server_offline).',
    input: z.object({}),
    requiredScopes: ['nd://scope/read/alerts'],
    handler: (c) => c.alerts.list(),
  },
  {
    name: 'activity_log',
    description: 'Recent audit activity; optionally filter by entity name.',
    input: entityOpt,
    // GET /v1/activity: unmapped prefix, operator-only (requireAdmin).
    coarseTokenOnly: true,
    requiredScopes: ['operator'],
    handler: (c, input) => c.activity.list({ entity: (input as { entity?: string }).entity }),
  },
  {
    name: 'system_stats',
    description: 'Live host + per-container resource snapshot.',
    input: z.object({}),
    // GET /v1/stats: unmapped prefix.
    coarseTokenOnly: true,
    handler: (c) => c.stats.snapshot(),
  },
  {
    name: 'topology',
    description: 'The domains → services → databases routing graph.',
    input: z.object({}),
    requiredScopes: ['nd://scope/read/topology'],
    handler: (c) => c.topology.get(),
  },
  {
    name: 'health',
    description: 'NineDeploy instance health (API + DB).',
    input: z.object({}),
    // r333: GET /health is unauthenticated — every token reaches it, so it
    // declares no scope (the old `read/health` hid it from fine-grained
    // tokens that could call it).
    handler: (c) => c.health(),
  },
  // ── Actions (mutating) ─────────────────────────────────────────────────
  {
    name: 'deploy_service',
    description: 'Trigger a new deployment for a service. Returns the deployment id.',
    input: serviceId,
    requiredScopes: ['nd://scope/write/deploys'],
    handler: (c, input) => c.deploys.trigger((input as { serviceId: number }).serviceId),
  },
  {
    name: 'restart_service',
    description: 'Restart a running service runtime.',
    input: serviceId,
    requiredScopes: ['nd://scope/write/services'],
    handler: (c, input) => c.services.restart((input as { serviceId: number }).serviceId),
  },
  {
    name: 'cancel_deploy',
    description:
      'Cancel a queued or in-flight deployment. A queued deployment stops immediately; an in-flight one stops at the next pipeline step boundary, leaving the previous version serving.',
    input: z.object({ serviceId: z.number().int().positive(), deploymentId: z.number().int().positive() }),
    requiredScopes: ['nd://scope/write/deploys'],
    handler: (c, input) => {
      const { serviceId, deploymentId } = input as { serviceId: number; deploymentId: number };
      return c.deploys.cancel(serviceId, deploymentId);
    },
  },
  {
    name: 'remove_deploy',
    description:
      'Remove a finished deployment from history, with its build log. Refused for an in-flight deployment (cancel it first) and for the one currently serving traffic — that row carries the digest a rollback re-deploys.',
    input: z.object({ serviceId: z.number().int().positive(), deploymentId: z.number().int().positive() }),
    requiredScopes: ['nd://scope/write/deploys'],
    handler: (c, input) => {
      const { serviceId, deploymentId } = input as { serviceId: number; deploymentId: number };
      return c.deploys.remove(serviceId, deploymentId);
    },
  },
  {
    name: 'rollback_deploy',
    description: 'Roll a service back to a previous deployment (by deployment id).',
    input: z.object({ serviceId: z.number().int().positive(), deploymentId: z.number().int().positive() }),
    requiredScopes: ['nd://scope/write/deploys'],
    handler: (c, input) => {
      const { serviceId, deploymentId } = input as { serviceId: number; deploymentId: number };
      return c.deploys.rollback(serviceId, deploymentId);
    },
  },
  {
    name: 'list_queue',
    description:
      'List every in-flight (queued / building / deploying) deployment across every service the caller can see. Mirrors the web panel\'s /deploys page so an agent can audit the build pipeline without opening a browser.',
    input: z.object({}),
    // r333: GET /v1/services/queue is classified as `services` — the
    // `deploys` override only matches /services/<id>/deploys.
    requiredScopes: ['nd://scope/read/services'],
    handler: (c) => c.deploys.queue(),
  },
  // ── Plugins & Microkernel Extensibility ────────────────────────────────
  {
    name: 'list_plugins',
    description: 'List all installed and active kernel plugins, extensions, and their operational status.',
    input: z.object({}),
    // GET /v1/plugins: unmapped prefix.
    coarseTokenOnly: true,
    handler: (c) => c.plugins.list(),
  },
  {
    name: 'marketplace_plugins',
    description: 'Get verified plugins and extensions from the official NineDeploy Marketplace catalog.',
    input: z.object({}),
    coarseTokenOnly: true,
    handler: (c) => c.plugins.marketplace(),
  },
  {
    name: 'install_plugin',
    description: 'Install a new plugin from the marketplace, NPM registry, Git repository or local manifest.',
    input: z.object({
      source: z.enum(['marketplace', 'npm', 'git', 'local']).default('marketplace'),
      target: z.string(),
      name: z.string().optional(),
      version: z.string().optional(),
      description: z.string().optional(),
    }),
    // POST /v1/plugins/…: unmapped prefix, operator-only (requireAdmin).
    coarseTokenOnly: true,
    requiredScopes: ['operator'],
    handler: (c, input) => c.plugins.install(input as any),
  },
  {
    name: 'enable_plugin',
    description: 'Enable an installed plugin in the microkernel runtime.',
    input: z.object({ id: z.string() }),
    coarseTokenOnly: true,
    requiredScopes: ['operator'],
    handler: (c, input) => c.plugins.enable((input as { id: string }).id),
  },
  {
    name: 'disable_plugin',
    description: 'Disable a plugin and temporarily unload its runtime hooks and menu integrations.',
    input: z.object({ id: z.string() }),
    coarseTokenOnly: true,
    requiredScopes: ['operator'],
    handler: (c, input) => c.plugins.disable((input as { id: string }).id),
  },
  {
    name: 'uninstall_plugin',
    description: 'Uninstall a plugin, destroying its runtime resources and purging its registered menus/schemas.',
    input: z.object({ id: z.string() }),
    coarseTokenOnly: true,
    requiredScopes: ['operator'],
    handler: (c, input) => c.plugins.uninstall((input as { id: string }).id),
  },
  // ── Configuration Center ───────────────────────────────────────────────
  {
    name: 'list_configs',
    description:
      'List all configuration entries, scoped plugin configs, and system environment tokens. ' +
      'Secret values come back MASKED — the panel UI is the only reveal surface.',
    input: z.object({
      category: z.string().optional(),
      pluginId: z.string().optional(),
    }),
    // r472: this tool deliberately exposes NO `reveal` param. The SDK supports
    // it, but an MCP tool result is persisted in agent transcripts and can be
    // steered by prompt-injected content ("call list_configs with reveal
    // true") with no human in the loop — the same reasoning that keeps the
    // enrolment routes out of MCP entirely. Mask-only here; an operator who
    // needs a plaintext secret reads it in the panel.
    // r333: /v1/config is mapped (read|write/config) AND operator-only
    // (requireOperator), so a token needs both.
    requiredScopes: ['operator', 'nd://scope/read/config'],
    handler: (c, input) => c.config.list(input as any),
  },
  {
    name: 'get_config',
    description: 'Get details and value for a specific configuration key.',
    input: z.object({ key: z.string() }),
    requiredScopes: ['operator', 'nd://scope/read/config'],
    handler: (c, input) => c.config.get((input as { key: string }).key),
  },
  {
    name: 'set_config',
    description: 'Set or update a configuration key in the central dual-vault config store.',
    input: z.object({
      key: z.string(),
      value: z.unknown(),
      isSecret: z.boolean().optional(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }),
    requiredScopes: ['operator', 'nd://scope/write/config'],
    handler: (c, input) => {
      const { key, ...body } = input as { key: string; value: unknown; isSecret?: boolean; description?: string; tags?: string[] };
      return c.config.set(key, body);
    },
  },
  {
    name: 'delete_config',
    description: 'Delete a custom configuration key from the configuration center.',
    input: z.object({ key: z.string() }),
    // DELETE needs `write/config` — the route map has no admin tier.
    requiredScopes: ['operator', 'nd://scope/write/config'],
    handler: (c, input) => c.config.delete((input as { key: string }).key),
  },
  // ── Navigation & Menus ─────────────────────────────────────────────────
  {
    name: 'list_menus',
    description: 'List dynamic navigation menu items contributed by official and community plugins.',
    input: z.object({ slot: z.string().optional() }),
    // GET /v1/menus: unmapped prefix.
    coarseTokenOnly: true,
    handler: (c, input) => c.menus.list(input as any),
  },
  // ── Demo & Service Configuration ───────────────────────────────────────
  {
    name: 'seed_demo',
    description: 'Create the demo service: a Docker source build of github.com/ersinkoc/nextjs-test (port 3000 published) and queue its first deployment. No database, no PM2.',
    input: z.object({}),
    // POST /v1/demo/seed: unmapped prefix, operator-only (requireAdmin).
    coarseTokenOnly: true,
    requiredScopes: ['operator'],
    handler: (c) => c.demo.seed(),
  },
  {
    name: 'update_service',
    description: 'Update a service configuration, including port, published host port (publishedPort), and branch.',
    input: z.object({
      serviceId: z.number().int().positive(),
      name: z.string().optional(),
      port: z.number().int().min(1).max(65535).optional(),
      publishedPort: z.number().int().min(1).max(65535).nullable().optional(),
      branch: z.string().optional(),
    }),
    requiredScopes: ['nd://scope/write/services'],
    handler: (c, input) => {
      const { serviceId, ...patch } = input as { serviceId: number; name?: string; port?: number; publishedPort?: number | null; branch?: string };
      return c.services.update(serviceId, patch);
    },
  },
  // ── Workspaces & Teams ─────────────────────────────────────────────────
  {
    name: 'list_workspaces',
    description: 'List all accessible workspaces and organizations with roles and member counts.',
    input: z.object({}),
    // GET /v1/workspaces: unmapped prefix (it is not `projects`).
    coarseTokenOnly: true,
    handler: (c) => c.workspaces.list(),
  },
  {
    name: 'get_workspace',
    description: 'Get details of a specific workspace including full member list and roles.',
    input: z.object({ id: z.number().int().positive() }),
    coarseTokenOnly: true,
    handler: (c, input) => c.workspaces.get((input as { id: number }).id),
  },
  // ── Containers & Files ─────────────────────────────────────────────────
  {
    name: 'list_container_files',
    description: 'Explore files and directories inside a live deployed service container.',
    input: z.object({
      container: z.string().min(1),
      path: z.string().optional(),
    }),
    // /v1/containers: unmapped prefix, operator-only (requireAdmin).
    coarseTokenOnly: true,
    requiredScopes: ['operator'],
    handler: (c, input) => {
      const { container, path } = input as { container: string; path?: string };
      return c.containers.listFiles(container, path);
    },
  },
  {
    name: 'inspect_container',
    description: 'Get deep runtime inspection data for a container including state, mounts, network IP, resource limits, and Traefik tags.',
    input: z.object({ container: z.string().min(1) }),
    coarseTokenOnly: true,
    requiredScopes: ['operator'],
    handler: (c, input) => c.containers.inspect((input as { container: string }).container),
  },
  {
    name: 'get_container_compose',
    description: 'Generate and retrieve the live Docker Compose YAML manifest for a running container or service.',
    input: z.object({ container: z.string().min(1) }),
    coarseTokenOnly: true,
    requiredScopes: ['operator'],
    handler: (c, input) => c.containers.compose((input as { container: string }).container),
  },
  // ── Observability & Log Drains ─────────────────────────────────────────
  {
    name: 'list_log_drains',
    description: 'List structured log drain endpoints (Loki, Datadog, Vector, Syslog, HTTP) forwarding runtime logs.',
    input: z.object({ serviceId: z.number().int().positive().optional() }),
    // GET /v1/log-drains: unmapped prefix, operator-only (requireAdmin).
    coarseTokenOnly: true,
    requiredScopes: ['operator'],
    handler: (c, input) => c.logDrains.list(input as { serviceId?: number }),
  },
  // ── GitHub App (0.13) ──────────────────────────────────────────────────
  {
    name: 'list_github_installations',
    description:
      'List registered GitHub Apps and their installations: account, repository selection, suspended/removed state and the generated source id. Metadata only, never a key or secret.',
    input: z.object({ githubAppId: z.number().int().positive().optional() }),
    // GET /v1/github-apps: unmapped prefix, operator-only (requireOperator).
    coarseTokenOnly: true,
    requiredScopes: ['operator'],
    handler: async (c, input) => {
      const { githubAppId } = input as { githubAppId?: number };
      const apps = await c.githubApps.list();
      const picked = (Array.isArray(apps) ? apps : []).filter((a) => githubAppId === undefined || a.id === githubAppId);
      return Promise.all(
        picked.map(async (a) => ({
          githubAppId: a.id,
          name: a.name,
          appId: a.appId,
          webBaseUrl: a.webBaseUrl,
          installations: await c.githubApps.installations(a.id),
        })),
      );
    },
  },
  // ── Database network and data access (0.14) ────────────────────────────
  {
    name: 'get_database_public_access',
    description:
      'Public access state of a managed database: whether its TCP sidecar is configured and running, the host port, the IP allow-list, the TLS mode and the host clients connect to. Needs admin on the database. Read-only; never a credential.',
    input: databaseId,
    // GET /v1/databases/:id/public-access: read/databases (db admin enforced by the route).
    requiredScopes: ['nd://scope/read/databases'],
    handler: (c, input) => c.databases.publicAccess.get((input as { databaseId: number }).databaseId),
  },
  {
    name: 'list_database_imports',
    description:
      'Recent dump imports into a managed database (newest first, up to 50): status, source (upload or S3 object), detected format, size and upload progress, the pre-import safety backup id and any error. Needs admin on the database. Read-only.',
    input: databaseId,
    // GET /v1/databases/:id/imports: read/databases (db admin enforced by the route).
    requiredScopes: ['nd://scope/read/databases'],
    handler: (c, input) => c.databases.imports.list((input as { databaseId: number }).databaseId),
  },
  // ── Housekeeping & Maintenance ─────────────────────────────────────────
  {
    name: 'system_autoprune',
    description: 'Trigger immediate housekeeping prune to purge dangling Docker images, stopped containers, and expired build artifacts.',
    input: z.object({}),
    // Mapped (write/housekeeping) AND operator-only (requireAdmin).
    requiredScopes: ['operator', 'nd://scope/write/housekeeping'],
    handler: (c) => c.housekeeping.runPrune(),
  },
  // ── API discovery (0.15) ───────────────────────────────────────────────
  {
    name: 'search_api',
    description:
      'Search the NineDeploy HTTP API (its OpenAPI 3.1 document) by free text. Returns matching operations with method, path, summary, tag, the minimum caller (floor) and the API-token scope each needs. It lists operations; it never calls them. Omit the query to list the first operations.',
    input: z.object({
      query: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    // GET /v1/openapi.json: unmapped prefix (sessions and coarse tokens only).
    coarseTokenOnly: true,
    handler: (c, input) => searchApi(c, input as { query?: string; limit?: number }),
  },
];

// ── 0.15: search_api ──────────────────────────────────────────────────────
/** One documented operation, as `search_api` reports it. */
export interface ApiOperation {
  method: string;
  path: string;
  summary: string;
  tag: string | null;
  floor: string | null;
  scope: string | null;
}

interface OpenApiLike {
  paths?: Record<string, Record<string, { summary?: unknown; tags?: unknown; [ext: string]: unknown }>>;
}

/** The document is fetched once per client (per process, in practice); a failed fetch is retried next time. */
const operationsCache = new WeakMap<NineDeployClient, Promise<ApiOperation[]>>();

/** Flatten an OpenAPI document into its operations, tolerating a missing or partial document. */
export function apiOperations(doc: OpenApiLike | null | undefined): ApiOperation[] {
  const out: ApiOperation[] = [];
  for (const [path, ops] of Object.entries(doc?.paths ?? {})) {
    for (const [method, op] of Object.entries(ops ?? {})) {
      if (typeof op !== 'object' || op === null) continue;
      const tags = Array.isArray(op.tags) ? op.tags : [];
      out.push({
        method: method.toUpperCase(),
        path,
        summary: typeof op.summary === 'string' ? op.summary : '',
        tag: typeof tags[0] === 'string' ? tags[0] : null,
        floor: typeof op['x-ninedeploy-floor'] === 'string' ? op['x-ninedeploy-floor'] : null,
        scope: typeof op['x-ninedeploy-scope'] === 'string' ? op['x-ninedeploy-scope'] : null,
      });
    }
  }
  return out;
}

function loadOperations(c: NineDeployClient): Promise<ApiOperation[]> {
  let pending = operationsCache.get(c);
  if (!pending) {
    pending = c.api.get<OpenApiLike>('/v1/openapi.json').then(apiOperations);
    operationsCache.set(c, pending);
    pending.catch(() => operationsCache.delete(c));
  }
  return pending;
}

/** Every whitespace-separated term must appear in the operation's method, path, summary or tag (case-insensitive). */
export async function searchApi(
  c: NineDeployClient,
  input: { query?: string; limit?: number },
): Promise<{ total: number; operations: ApiOperation[] }> {
  const terms = (input.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (await loadOperations(c)).filter((op) => {
    const text = `${op.method} ${op.path} ${op.summary} ${op.tag ?? ''}`.toLowerCase();
    return terms.every((t) => text.includes(t));
  });
  return { total: matches.length, operations: matches.slice(0, input.limit ?? 25) };
}

/** Hand-written tools first, then the read-only tools generated from the route specs (0.15). */
export const TOOLS: ToolDef[] = [...HAND_WRITTEN, ...SPEC_TOOLS];
