import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { githubAppInstallations, githubApps, sources, type DB, type GithubApp, type GithubAppInstallation } from '@ninedeploy/db';
import {
  GITHUB_API_BASE_URL,
  githubAppCreate,
  githubAppManifestComplete,
  githubAppManifestRequest,
  githubAppPatch,
  githubAppPrivateKey,
} from '@ninedeploy/schemas';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { guardedFetch, privateEgressAllowed } from '../lib/egressGuard.js';
import { badRequest, conflict, forbidden, HttpError, isUniqueViolation, notFound, parseId } from '../lib/errors.js';
import { apiBase, appJwt, clearGithubAppCaches, GithubAppError, githubApi, githubApiPages, type GithubAppRef } from '../lib/githubApp.js';
import { createKeyedOperationGuard } from '../lib/keyedOperationGuard.js';
import { panelOrigin } from '../lib/panelOrigin.js';
import { redactSecrets } from '../lib/redactSecret.js';

/**
 * GitHub App registration (0.13), mounted under /v1/github-apps. Operator-only:
 * an App's private key can mint tokens for every repository its installations
 * reach, so it is instance-level configuration like `/v1/sources`.
 *
 * No response ever carries the private key, the webhook secret or the client
 * secret, and audit meta holds ids and names only.
 */

const MANIFEST_STATE_TTL_MS = 60 * 60_000;
/** Pending manifest nonces kept in memory; the oldest is dropped past this. */
const MAX_PENDING_NONCES = 500;
const API_TIMEOUT_MS = 15_000;
const MANIFEST_NAME_MAX = 34;
const STATE_KIND = 'gh-app-manifest';

/** nonce → expiry (ms). A nonce is burned by the first `/manifest/complete` that presents it. */
const pendingNonces = new Map<string, number>();
/** One installation sync per App at a time, so two syncs never create two sources for one installation. */
const syncGuard = createKeyedOperationGuard<number>();

interface ManifestState {
  k: typeof STATE_KIND;
  uid: number;
  hookKey: string;
  web: string;
  api: string;
  nonce: string;
  exp: number;
}

function signState(payloadJson: string): string {
  // Domain-separated from the OAuth login state (`lib/oauth.ts`), which signs with the same secret.
  return createHmac('sha256', config.jwt.secret).update(`${STATE_KIND}.${payloadJson}`).digest('base64url');
}

function issueState(state: ManifestState): string {
  const json = JSON.stringify(state);
  return `${Buffer.from(json).toString('base64url')}.${signState(json)}`;
}

/** The decoded state when its signature verifies, else null. Expiry and owner are checked by the caller. */
function readState(state: string): ManifestState | null {
  try {
    const [payloadB64, signature, extra] = state.split('.');
    if (!payloadB64 || !signature || extra !== undefined) return null;
    const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const a = Buffer.from(signature);
    const b = Buffer.from(signState(json));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const data = JSON.parse(json) as Partial<ManifestState>;
    if (
      data.k !== STATE_KIND ||
      !Number.isSafeInteger(data.uid) ||
      typeof data.hookKey !== 'string' ||
      !/^[0-9a-f]{32}$/.test(data.hookKey) ||
      typeof data.web !== 'string' ||
      typeof data.api !== 'string' ||
      typeof data.nonce !== 'string' ||
      !Number.isFinite(data.exp)
    ) {
      return null;
    }
    return data as ManifestState;
  } catch {
    return null;
  }
}

function rememberNonce(nonce: string, exp: number, now: number): void {
  for (const [n, e] of pendingNonces) if (e <= now) pendingNonces.delete(n);
  while (pendingNonces.size >= MAX_PENDING_NONCES) {
    const oldest = pendingNonces.keys().next().value;
    if (oldest === undefined) break;
    pendingNonces.delete(oldest);
  }
  pendingNonces.set(nonce, exp);
}

/** GitHub cannot deliver a webhook (or redirect a browser) to a loopback origin. */
function isLocalOrigin(origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return true;
  }
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127\./.test(host);
}

async function publicOrigin(db: DB): Promise<string> {
  const origin = await panelOrigin(db);
  if (isLocalOrigin(origin)) {
    throw badRequest(
      `The panel's address is ${origin}, which GitHub cannot reach. Set the panel domain (Settings → Security) first.`,
      'panel_origin_local',
    );
  }
  return origin;
}

/** https only; http is accepted only with NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1 (a lab GHES). */
function assertSecureBase(url: string, field: string): void {
  if (url.startsWith('http:') && !privateEgressAllowed()) {
    throw badRequest(`${field} must use https (http is allowed only with NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1)`, 'insecure_base_url');
  }
}

/** github.com's API lives on its own host; GitHub Enterprise Server serves it under `/api/v3`. */
function deriveApiBase(web: string): string {
  return new URL(web).hostname.toLowerCase() === 'github.com' ? GITHUB_API_BASE_URL : `${web}/api/v3`;
}

const webhookUrlFor = (origin: string, hookKey: string) => `${origin}/v1/hooks/github-app/${hookKey}`;

function serializeApp(row: GithubApp, origin: string) {
  return {
    id: row.id,
    name: row.name,
    appId: row.appId,
    slug: row.slug ?? null,
    clientId: row.clientId ?? null,
    ownerLogin: row.ownerLogin ?? null,
    ownerType: row.ownerType ?? null,
    webBaseUrl: row.webBaseUrl,
    apiBaseUrl: row.apiBaseUrl,
    htmlUrl: row.htmlUrl ?? null,
    permissions: row.permissions ?? null,
    events: row.events ?? null,
    webhookUrl: webhookUrlFor(origin, row.hookKey),
    installUrl: row.htmlUrl ? `${row.htmlUrl.replace(/\/+$/, '')}/installations/new` : null,
    hasPrivateKey: !!row.privateKeyEncrypted,
    hasClientSecret: !!row.clientSecretEncrypted,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function configureUrl(app: Pick<GithubApp, 'webBaseUrl'>, inst: GithubAppInstallation): string | null {
  if (!inst.accountLogin) return null;
  const web = app.webBaseUrl.replace(/\/+$/, '');
  return inst.accountType === 'Organization'
    ? `${web}/organizations/${encodeURIComponent(inst.accountLogin)}/settings/installations/${inst.installationId}`
    : `${web}/settings/installations/${inst.installationId}`;
}

function serializeInstallation(app: Pick<GithubApp, 'webBaseUrl'>, inst: GithubAppInstallation) {
  return {
    id: inst.id,
    githubAppId: inst.githubAppId,
    installationId: inst.installationId,
    accountLogin: inst.accountLogin ?? null,
    accountType: inst.accountType ?? null,
    accountId: inst.accountId ?? null,
    repositorySelection: inst.repositorySelection,
    permissions: inst.permissions ?? null,
    sourceId: inst.sourceId ?? null,
    suspendedAt: inst.suspendedAt ? inst.suspendedAt.toISOString() : null,
    removedAt: inst.removedAt ? inst.removedAt.toISOString() : null,
    configureUrl: configureUrl(app, inst),
    createdAt: inst.createdAt.toISOString(),
    updatedAt: inst.updatedAt.toISOString(),
  };
}

/** A string→string map from GitHub's JSON, anything else dropped. */
function stringMap(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
  return out;
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : null;
}

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** A `GithubAppError` (already redacted) as the HTTP error the operator sees. */
function githubFailure(err: unknown, secrets: readonly string[] = []): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof GithubAppError) {
    if (err.reason === 'bad_key') {
      return badRequest('The private key could not be read as an RSA PEM private key', 'github_app_bad_key');
    }
    if (err.reason === 'bad_base_url') return badRequest(err.message, 'insecure_base_url');
    if (err.status === 401 || err.status === 403 || err.status === 404) {
      return badRequest(`GitHub refused the App credentials: ${err.message}`, 'github_app_rejected');
    }
    return new HttpError(502, 'github_api_error', err.message);
  }
  return new HttpError(502, 'github_api_error', `GitHub API call failed: ${redactSecrets(err, secrets)}`);
}

interface AppIdentity {
  id?: unknown;
  slug?: unknown;
  name?: unknown;
  client_id?: unknown;
  html_url?: unknown;
  owner?: { login?: unknown; type?: unknown } | null;
  permissions?: unknown;
  events?: unknown;
}

/**
 * Prove a private key belongs to App `appId`: sign an App JWT with it and
 * call `GET /app`. Nothing is stored; the transient ref uses id 0 so the
 * module's key cache keeps at most one unsaved key.
 */
async function verifyAppKey(
  appId: number,
  apiBaseUrl: string,
  privateKeyEncrypted: string,
): Promise<{ ref: GithubAppRef; jwt: string; info: AppIdentity }> {
  const ref: GithubAppRef = { id: 0, appId, privateKeyEncrypted, apiBaseUrl, updatedAt: new Date() };
  let jwt = '';
  try {
    jwt = appJwt(ref);
    const res = await githubApi<AppIdentity>(ref, jwt, 'GET', '/app');
    if (res.data?.id !== appId) {
      throw badRequest(`The private key belongs to a different GitHub App than #${appId}`, 'github_app_mismatch');
    }
    return { ref, jwt, info: res.data };
  } catch (err) {
    throw githubFailure(err, [jwt]);
  }
}

/** Point the App's webhook at this panel (`PATCH /app/hook/config`). */
async function registerWebhook(ref: Pick<GithubApp, 'apiBaseUrl'>, jwt: string, url: string, secret: string): Promise<void> {
  try {
    await githubApi(ref, jwt, 'PATCH', '/app/hook/config', { url, secret, content_type: 'json' });
  } catch (err) {
    throw githubFailure(err, [jwt, secret]);
  }
}

const newHookKey = () => randomBytes(16).toString('hex');
const newWebhookSecret = () => randomBytes(32).toString('hex');

interface ManifestConversion {
  id?: unknown;
  slug?: unknown;
  name?: unknown;
  client_id?: unknown;
  client_secret?: unknown;
  webhook_secret?: unknown;
  pem?: unknown;
  html_url?: unknown;
  owner?: { login?: unknown; type?: unknown } | null;
  permissions?: unknown;
  events?: unknown;
}

/** `POST /app-manifests/{code}/conversions` — unauthenticated; the code is the credential. */
async function convertManifest(api: string, code: string): Promise<ManifestConversion> {
  let base: string;
  try {
    base = apiBase({ apiBaseUrl: api });
  } catch (err) {
    throw githubFailure(err);
  }
  let res: Response;
  try {
    res = await guardedFetch(`${base}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'NineDeploy', 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (err) {
    throw new HttpError(502, 'github_api_error', `GitHub API unreachable: ${redactSecrets(err, [code])}`);
  }
  if (res.status === 404 || res.status === 422) {
    throw badRequest('GitHub did not accept the manifest code (it is single-use and expires after an hour). Start the setup again.', 'manifest_code_invalid');
  }
  if (!res.ok) throw new HttpError(502, 'github_api_error', `GitHub answered the manifest conversion with HTTP ${res.status}`);
  let data: ManifestConversion;
  try {
    data = (await res.json()) as ManifestConversion;
  } catch {
    throw new HttpError(502, 'github_api_error', 'GitHub answered the manifest conversion with a body that is not JSON');
  }
  if (!Number.isSafeInteger(data?.id) || (data.id as number) <= 0 || typeof data.pem !== 'string' || !data.pem) {
    throw new HttpError(502, 'github_api_error', 'GitHub answered the manifest conversion without an App id and private key');
  }
  return data;
}

async function loadApp(db: DB, id: number): Promise<GithubApp> {
  const row = await db.query.githubApps.findFirst({ where: eq(githubApps.id, id) });
  if (!row) throw notFound('GitHub App not found');
  return row;
}

/** Insert an App row, a duplicate `(api_base_url, app_id)` becoming a 409. */
async function insertApp(db: DB, values: typeof githubApps.$inferInsert): Promise<GithubApp> {
  try {
    const [row] = await db.insert(githubApps).values(values).returning();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`GitHub App #${values.appId} on ${values.apiBaseUrl} is already registered`);
    throw err;
  }
}

interface GithubInstallationPayload {
  id?: unknown;
  app_id?: unknown;
  account?: { login?: unknown; type?: unknown; id?: unknown } | null;
  repository_selection?: unknown;
  permissions?: unknown;
  suspended_at?: unknown;
}

export interface InstallationSyncResult {
  created: number;
  updated: number;
  removed: number;
  sourcesCreated: number;
  truncated: boolean;
}

/**
 * Upsert the App's installations from `GET /app/installations` and give each
 * live installation a `github_app` source (no token: clones mint one). The
 * list GitHub returns is the only input — never a caller-supplied id.
 */
async function syncInstallations(db: DB, row: GithubApp, actorId: number): Promise<InstallationSyncResult> {
  return syncGuard(row.id, async () => {
    let jwt = '';
    let listed: { rows: GithubInstallationPayload[]; truncated: boolean };
    try {
      jwt = appJwt(row);
      listed = await githubApiPages<GithubInstallationPayload[], GithubInstallationPayload>(row, jwt, '/app/installations', (data) =>
        Array.isArray(data) ? data : [],
      );
    } catch (err) {
      throw githubFailure(err, [jwt]);
    }
    const now = new Date();
    const result: InstallationSyncResult = { created: 0, updated: 0, removed: 0, sourcesCreated: 0, truncated: listed.truncated };
    const seen = new Set<number>();
    const createdIds: number[] = [];
    for (const item of listed.rows) {
      const installationId = item.id;
      if (!Number.isSafeInteger(installationId) || (installationId as number) <= 0) continue;
      if (item.app_id !== undefined && item.app_id !== row.appId) continue;
      seen.add(installationId as number);
      const accountId = item.account?.id;
      const suspended = typeof item.suspended_at === 'string' ? new Date(item.suspended_at) : null;
      const fields = {
        accountLogin: str(item.account?.login),
        accountType: str(item.account?.type),
        accountId: Number.isSafeInteger(accountId) ? (accountId as number) : null,
        repositorySelection: item.repository_selection === 'all' ? ('all' as const) : ('selected' as const),
        permissions: stringMap(item.permissions),
        suspendedAt: suspended && !Number.isNaN(suspended.getTime()) ? suspended : null,
        removedAt: null,
      };
      const existing = await db.query.githubAppInstallations.findFirst({
        where: and(eq(githubAppInstallations.githubAppId, row.id), eq(githubAppInstallations.installationId, installationId as number)),
      });
      let inst: GithubAppInstallation;
      if (existing) {
        [inst] = (await db.update(githubAppInstallations).set(fields).where(eq(githubAppInstallations.id, existing.id)).returning()) as [
          GithubAppInstallation,
        ];
        result.updated++;
      } else {
        [inst] = (await db
          .insert(githubAppInstallations)
          .values({ githubAppId: row.id, installationId: installationId as number, ...fields })
          .returning()) as [GithubAppInstallation];
        result.created++;
        createdIds.push(installationId as number);
      }
      // A source deleted by the operator leaves `source_id` NULL (FK SET NULL); a live installation gets a new one.
      const hasSource = inst.sourceId != null && !!(await db.query.sources.findFirst({ where: eq(sources.id, inst.sourceId) }));
      if (!hasSource) {
        const [src] = await db
          .insert(sources)
          .values({ type: 'github_app', name: `gh-app:${fields.accountLogin ?? `installation-${installationId}`}`.slice(0, 100) })
          .returning();
        await db.update(githubAppInstallations).set({ sourceId: src!.id }).where(eq(githubAppInstallations.id, inst.id));
        result.sourcesCreated++;
      }
    }
    // Only a complete list proves an installation is gone.
    if (!listed.truncated) {
      const live = await db.query.githubAppInstallations.findMany({
        where: and(eq(githubAppInstallations.githubAppId, row.id), isNull(githubAppInstallations.removedAt)),
      });
      for (const inst of live) {
        if (seen.has(inst.installationId)) continue;
        await db.update(githubAppInstallations).set({ removedAt: now }).where(eq(githubAppInstallations.id, inst.id));
        result.removed++;
        await audit(db, null, 'github_installation.removed', inst.accountLogin ?? `installation#${inst.installationId}`, {
          installationRowId: inst.id,
          installationId: inst.installationId,
          githubAppId: row.id,
          detectedBy: 'sync',
        });
      }
    }
    await audit(db, actorId, 'github_app.sync', row.name, {
      githubAppId: row.id,
      appId: row.appId,
      created: result.created,
      updated: result.updated,
      removed: result.removed,
      sourcesCreated: result.sourcesCreated,
      createdInstallationIds: createdIds,
      truncated: result.truncated,
    });
    return result;
  });
}

/** GitHub App registration and installations. Mounted under /github-apps. Operator-only. */
export const githubAppsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireOperator);

  // ── manifest flow ──────────────────────────────────────────────────────
  app.post('/manifest', async (req) => {
    const input = githubAppManifestRequest.parse(req.body ?? {});
    assertSecureBase(input.webBaseUrl, 'webBaseUrl');
    const api = input.apiBaseUrl ?? deriveApiBase(input.webBaseUrl);
    assertSecureBase(api, 'apiBaseUrl');
    const origin = await publicOrigin(app.db);
    const hookKey = newHookKey();
    const nonce = randomBytes(16).toString('hex');
    const now = Date.now();
    const exp = now + MANIFEST_STATE_TTL_MS;
    const state = issueState({ k: STATE_KIND, uid: req.user!.id, hookKey, web: input.webBaseUrl, api, nonce, exp });
    rememberNonce(nonce, exp, now);

    const host = new URL(origin).host;
    const manifest = {
      name: `NineDeploy ${host}`.slice(0, MANIFEST_NAME_MAX).trim(),
      url: origin,
      public: false,
      hook_attributes: { url: webhookUrlFor(origin, hookKey), active: true },
      redirect_url: `${origin}/github-apps/callback`,
      setup_url: `${origin}/github-apps/installed`,
      setup_on_update: true,
      default_permissions: {
        contents: 'read',
        metadata: 'read',
        pull_requests: 'write',
        statuses: 'write',
        ...(input.checks ? { checks: 'write' } : {}),
      },
      default_events: ['push', 'pull_request'],
    };
    const qs = `?state=${encodeURIComponent(state)}`;
    const postUrl =
      input.target === 'org'
        ? `${input.webBaseUrl}/organizations/${encodeURIComponent(input.org!)}/settings/apps/new${qs}`
        : `${input.webBaseUrl}/settings/apps/new${qs}`;
    return { postUrl, manifest, state };
  });

  app.post('/manifest/complete', async (req) => {
    const input = githubAppManifestComplete.parse(req.body ?? {});
    const state = readState(input.state);
    if (!state) throw badRequest('The setup state is invalid. Start the setup again.', 'manifest_state_invalid');
    if (state.exp <= Date.now()) throw badRequest('The setup state has expired. Start the setup again.', 'manifest_state_expired');
    if (state.uid !== req.user!.id) throw forbidden('This GitHub App setup was started by another user');
    if (!pendingNonces.delete(state.nonce)) {
      throw badRequest('This setup state was already used (or the server restarted). Start the setup again.', 'manifest_state_used');
    }
    assertSecureBase(state.web, 'webBaseUrl');
    assertSecureBase(state.api, 'apiBaseUrl');

    const data = await convertManifest(state.api, input.code);
    const appId = data.id as number;
    const pem = data.pem as string;
    let webhookSecret = str(data.webhook_secret);
    const origin = await panelOrigin(app.db);
    if (!webhookSecret) {
      // GitHub normally generates one for a manifest with hook_attributes; if
      // not, generate it here and register it so deliveries are signed.
      webhookSecret = newWebhookSecret();
      const privateKeyEncrypted = encrypt(pem);
      const ref: GithubAppRef = { id: 0, appId, privateKeyEncrypted, apiBaseUrl: state.api, updatedAt: new Date() };
      let jwt = '';
      try {
        jwt = appJwt(ref);
      } catch (err) {
        throw githubFailure(err);
      }
      await registerWebhook(ref, jwt, webhookUrlFor(origin, state.hookKey), webhookSecret);
    }
    const clientSecret = str(data.client_secret);
    const row = await insertApp(app.db, {
      name: (str(data.name) ?? str(data.slug) ?? `GitHub App ${appId}`).slice(0, 100),
      appId,
      slug: str(data.slug),
      clientId: str(data.client_id),
      clientSecretEncrypted: clientSecret ? encrypt(clientSecret) : null,
      privateKeyEncrypted: encrypt(pem),
      webhookSecretEncrypted: encrypt(webhookSecret),
      hookKey: state.hookKey,
      ownerLogin: str(data.owner?.login),
      ownerType: str(data.owner?.type),
      webBaseUrl: state.web,
      apiBaseUrl: state.api,
      htmlUrl: str(data.html_url),
      permissions: stringMap(data.permissions),
      events: stringList(data.events),
      createdByUserId: req.user!.id,
    });
    void audit(app.db, req.user!.id, 'github_app.create', row.name, {
      githubAppId: row.id,
      appId: row.appId,
      slug: row.slug,
      via: 'manifest',
    });
    return serializeApp(row, origin);
  });

  // ── manual entry (GHES or an existing App) ─────────────────────────────
  app.post('/', async (req) => {
    const input = githubAppCreate.parse(req.body ?? {});
    assertSecureBase(input.webBaseUrl, 'webBaseUrl');
    assertSecureBase(input.apiBaseUrl, 'apiBaseUrl');
    const existing = await app.db.query.githubApps.findFirst({
      where: and(eq(githubApps.apiBaseUrl, input.apiBaseUrl), eq(githubApps.appId, input.appId)),
    });
    if (existing) throw conflict(`GitHub App #${input.appId} on ${input.apiBaseUrl} is already registered`);
    // Without a webhook secret the panel registers its own webhook, which GitHub must be able to reach.
    const origin = input.webhookSecret ? await panelOrigin(app.db) : await publicOrigin(app.db);

    const privateKeyEncrypted = encrypt(input.privateKey);
    const { ref, jwt, info } = await verifyAppKey(input.appId, input.apiBaseUrl, privateKeyEncrypted);
    const hookKey = newHookKey();
    const webhookSecret = input.webhookSecret ?? newWebhookSecret();
    if (!input.webhookSecret) await registerWebhook(ref, jwt, webhookUrlFor(origin, hookKey), webhookSecret);

    const row = await insertApp(app.db, {
      name: input.name,
      appId: input.appId,
      slug: str(info.slug),
      clientId: input.clientId ?? str(info.client_id),
      clientSecretEncrypted: input.clientSecret ? encrypt(input.clientSecret) : null,
      privateKeyEncrypted,
      webhookSecretEncrypted: encrypt(webhookSecret),
      hookKey,
      ownerLogin: str(info.owner?.login),
      ownerType: str(info.owner?.type),
      webBaseUrl: input.webBaseUrl,
      apiBaseUrl: input.apiBaseUrl,
      htmlUrl: str(info.html_url),
      permissions: stringMap(info.permissions),
      events: stringList(info.events),
      createdByUserId: req.user!.id,
    });
    void audit(app.db, req.user!.id, 'github_app.create', row.name, {
      githubAppId: row.id,
      appId: row.appId,
      slug: row.slug,
      via: 'manual',
      webhookRegistered: !input.webhookSecret,
    });
    return serializeApp(row, origin);
  });

  // ── read ───────────────────────────────────────────────────────────────
  app.get('/', async () => {
    const rows = await app.db.query.githubApps.findMany({ orderBy: (t, { asc }) => [asc(t.id)] });
    const origin = await panelOrigin(app.db);
    return rows.map((r) => serializeApp(r, origin));
  });

  app.get('/:id', async (req) => {
    const row = await loadApp(app.db, parseId((req.params as { id: string }).id));
    return serializeApp(row, await panelOrigin(app.db));
  });

  // ── update ─────────────────────────────────────────────────────────────
  app.patch('/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const input = githubAppPatch.parse(req.body ?? {});
    await loadApp(app.db, id);
    const patch: Partial<typeof githubApps.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.clientId !== undefined) patch.clientId = input.clientId;
    if (input.clientSecret !== undefined) patch.clientSecretEncrypted = input.clientSecret ? encrypt(input.clientSecret) : null;
    const [row] = await app.db.update(githubApps).set(patch).where(eq(githubApps.id, id)).returning();
    if (!row) throw notFound('GitHub App not found');
    const changed = (['name', 'clientId', 'clientSecret'] as const).filter((k) => input[k] !== undefined);
    void audit(app.db, req.user!.id, 'github_app.update', row.name, { githubAppId: row.id, appId: row.appId, changed });
    return serializeApp(row, await panelOrigin(app.db));
  });

  app.put('/:id/private-key', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const input = githubAppPrivateKey.parse(req.body ?? {});
    const current = await loadApp(app.db, id);
    const privateKeyEncrypted = encrypt(input.privateKey);
    const { info } = await verifyAppKey(current.appId, current.apiBaseUrl, privateKeyEncrypted);
    const [row] = await app.db
      .update(githubApps)
      .set({
        privateKeyEncrypted,
        slug: str(info.slug) ?? current.slug,
        ownerLogin: str(info.owner?.login) ?? current.ownerLogin,
        ownerType: str(info.owner?.type) ?? current.ownerType,
        htmlUrl: str(info.html_url) ?? current.htmlUrl,
        permissions: stringMap(info.permissions) ?? current.permissions,
        events: stringList(info.events) ?? current.events,
        updatedAt: new Date(),
      })
      .where(eq(githubApps.id, id))
      .returning();
    if (!row) throw notFound('GitHub App not found');
    void audit(app.db, req.user!.id, 'github_app.rotate_key', row.name, { githubAppId: row.id, appId: row.appId });
    return serializeApp(row, await panelOrigin(app.db));
  });

  /** Re-point the App's webhook at this panel (after a panel domain change). */
  app.post('/:id/webhook/sync', async (req) => {
    const row = await loadApp(app.db, parseId((req.params as { id: string }).id));
    const origin = await publicOrigin(app.db);
    const secret = decrypt(row.webhookSecretEncrypted);
    let jwt = '';
    try {
      jwt = appJwt(row);
    } catch (err) {
      throw githubFailure(err);
    }
    await registerWebhook(row, jwt, webhookUrlFor(origin, row.hookKey), secret);
    void audit(app.db, req.user!.id, 'github_app.update', row.name, { githubAppId: row.id, appId: row.appId, changed: ['webhook'] });
    return serializeApp(row, origin);
  });

  /** A fresh webhook secret, registered on GitHub first so no delivery is signed with a secret the panel lacks for long. */
  app.post('/:id/webhook-secret/rotate', async (req) => {
    const current = await loadApp(app.db, parseId((req.params as { id: string }).id));
    const origin = await publicOrigin(app.db);
    const secret = newWebhookSecret();
    let jwt = '';
    try {
      jwt = appJwt(current);
    } catch (err) {
      throw githubFailure(err);
    }
    await registerWebhook(current, jwt, webhookUrlFor(origin, current.hookKey), secret);
    const [row] = await app.db
      .update(githubApps)
      .set({ webhookSecretEncrypted: encrypt(secret), updatedAt: new Date() })
      .where(eq(githubApps.id, current.id))
      .returning();
    if (!row) throw notFound('GitHub App not found');
    void audit(app.db, req.user!.id, 'github_app.rotate_webhook_secret', row.name, { githubAppId: row.id, appId: row.appId });
    return serializeApp(row, origin);
  });

  /**
   * Forget the App. Its installation rows and service links go with it (FK
   * cascade); the generated `github_app` sources stay, so services keep
   * their source, and their clones fail closed (no installation to mint from).
   */
  app.delete('/:id', async (req) => {
    const row = await loadApp(app.db, parseId((req.params as { id: string }).id));
    await app.db.delete(githubApps).where(eq(githubApps.id, row.id));
    clearGithubAppCaches();
    void audit(app.db, req.user!.id, 'github_app.delete', row.name, { githubAppId: row.id, appId: row.appId });
    return { ok: true };
  });

  // ── installations ──────────────────────────────────────────────────────
  /** The SPA's `/github-apps/installed?installation_id=…` lands here; the query is never read. */
  app.post('/:id/installations/sync', async (req) => {
    const row = await loadApp(app.db, parseId((req.params as { id: string }).id));
    const result = await syncInstallations(app.db, row, req.user!.id);
    const installations = await app.db.query.githubAppInstallations.findMany({
      where: eq(githubAppInstallations.githubAppId, row.id),
      orderBy: (t, { asc }) => [asc(t.id)],
    });
    return { ...result, installations: installations.map((i) => serializeInstallation(row, i)) };
  });

  app.get('/:id/installations', async (req) => {
    const row = await loadApp(app.db, parseId((req.params as { id: string }).id));
    const installations = await app.db.query.githubAppInstallations.findMany({
      where: eq(githubAppInstallations.githubAppId, row.id),
      orderBy: (t, { asc }) => [asc(t.id)],
    });
    return installations.map((i) => serializeInstallation(row, i));
  });
};

/** Test seam: forget every pending manifest nonce. */
export function resetManifestNoncesForTests(): void {
  pendingNonces.clear();
}
