import { relations, sql } from 'drizzle-orm';
import { type AnySQLiteColumn, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * NineDeploy — database schema (single source of truth).
 *
 * All tables live in one SQLite file. Timestamps are unix-epoch seconds.
 * Secrets are stored encrypted (AES-256-GCM) in their `*_encrypted` columns.
 */

// ─── helpers ──────────────────────────────────────────────────────────────
const id = () => integer('id').primaryKey({ autoIncrement: true });
const ts = (name: string) =>
  integer(name, { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`);
const tsUpdatable = (name: string) =>
  integer(name, { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`)
    .$onUpdate(() => new Date());

// ─── enums (stored as TEXT) ───────────────────────────────────────────────
// Global `userRole` was removed when the team model was made workspace-only.
// Authorization now flows from `workspace_members.role` for every action; the
// only operator-level shortcut is "is `owner`/`admin` in any workspace", which
// is computed at request time.
export const workspaceRole = ['owner', 'admin', 'member', 'viewer'] as const;
export const serviceType = ['pm2', 'docker', 'compose'] as const;
export const serviceStatus = [
  'idle',
  'deploying',
  'running',
  'stopped',
  'error',
  'deleting',
] as const;
export const buildPack = ['auto', 'nixpacks', 'dockerfile', 'railpack', 'static'] as const;
export const deploymentStatus = [
  'queued',
  'building',
  'deploying',
  'running',
  // Was live once, replaced by a newer successful deploy of the same service.
  // History keeps these so the Deploys tab shows which build SERVED when —
  // without it every past deploy would read "running" forever.
  'superseded',
  'failed',
  'cancelled',
] as const;
export const deploymentTrigger = ['user', 'webhook', 'cli', 'schedule'] as const;
export const domainStatus = ['pending', 'active', 'error'] as const;
export const sourceType = ['github', 'gitlab', 'gitea', 'bitbucket', 'custom', 'registry'] as const;
export const backupScope = ['db', 'scheduled', 'volumes', 'full'] as const;
export const backupStatus = ['pending', 'running', 'completed', 'failed'] as const;
export const jobKind = ['deploy', 'exec', 'backup'] as const;
export const jobRunStatus = ['running', 'completed', 'failed'] as const;
export const serverStatus = ['offline', 'online', 'error', 'pending'] as const;

// ─── users & auth ─────────────────────────────────────────────────────────
export const users = sqliteTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name'),
  // Monotonic counter baked into issued JWTs (`ver` claim). Bumping it
  // (logout / role change / password change) invalidates all outstanding tokens
  // for the user without needing a server-side blocklist.
  tokenVersion: integer('token_version').notNull().default(0),
  // TOTP (2FA): secret encrypted at rest; null = never set up.
  totpSecretEncrypted: text('totp_secret_encrypted'),
  totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
  // Highest TOTP step already accepted for this user. A code is single-use:
  // replaying one inside the +/-1-step (90 s) drift window is refused because
  // its step is no longer strictly greater than this. Null = none used yet.
  totpLastStep: integer('totp_last_step'),
  // Instance-level operator flag.
  //
  // This is DELIBERATELY not derived from workspace membership. It used to be:
  // "operator" meant "owner/admin in at least one workspace", and because any
  // authenticated user can create a workspace they own (POST /v1/workspaces),
  // every member could promote themselves to full instance operator — which
  // gates host-privileged features (PM2/compose deploys, lifecycle hooks,
  // docker-socket templates) and therefore meant host code execution.
  //
  // The flag is set at bootstrap (first user) and can only be granted or
  // revoked by an existing instance operator. Workspace roles stay purely
  // workspace-scoped. See `lib/resourceAccess.ts`.
  isInstanceOperator: integer('is_instance_operator', { mode: 'boolean' }).notNull().default(false),
  createdAt: ts('created_at'),
  updatedAt: tsUpdatable('updated_at'),
});

export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: id(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // The token presented by clients is hashed (sha256) before comparison.
    hash: text('hash').notNull().unique(),
    scopes: text('scopes', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    createdAt: ts('created_at'),
  },
  // Plain index (NOT unique): a user may hold many API tokens. The previous
  // uniqueIndex here silently capped every user to a single token.
  (t) => ({ userIdx: index('api_tokens_user_idx').on(t.userId) }),
);

// WebAuthn (passkey) credentials: one row per registered authenticator.
// publicKey is the COSE public key bytes (base64url); counter tracks the
// signature counter for clone detection.
export const webauthnCredentials = sqliteTable(
  'webauthn_credentials',
  {
    id: id(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialId: text('credential_id').notNull().unique(),
    publicKey: text('public_key').notNull(),
    counter: integer('counter').notNull().default(0),
    transports: text('transports', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    name: text('name').notNull(),
    createdAt: ts('created_at'),
  },
  (t) => ({ userIdx: index('webauthn_credentials_user_idx').on(t.userId) }),
);

// Per-session rows backing refresh tokens. `jti` matches the JWT claim; a
// revoked/expired row makes the corresponding refresh token unusable even
// before password/tokenVersion changes.
export const sessions = sqliteTable(
  'sessions',
  {
    id: id(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    jti: text('jti').notNull().unique(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: ts('created_at'),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  },
  (t) => ({ userIdx: index('sessions_user_idx').on(t.userId) }),
);

// ─── workspaces & teams ───────────────────────────────────────────────────
export const workspaces = sqliteTable('workspaces', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  ownerId: integer('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: ts('created_at'),
  updatedAt: tsUpdatable('updated_at'),
});

export const workspaceMembers = sqliteTable(
  'workspace_members',
  {
    id: id(),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: workspaceRole }).notNull().default('member'),
    createdAt: ts('created_at'),
    updatedAt: tsUpdatable('updated_at'),
  },
  (t) => ({
    workspaceUserIdx: uniqueIndex('workspace_members_workspace_user_idx').on(t.workspaceId, t.userId),
    userIdx: index('workspace_members_user_idx').on(t.userId),
  }),
);

// ─── email template overrides (G-30) ───────────────────────────────────────
// One row per (workspace, name) overrides the subject + text
// of a built-in transactional email. The (workspace_id, name)
// pair is the unique key; the renderer falls back to the
// built-in default when no override exists.
export const emailTemplateOverrides = sqliteTable(
  'email_template_overrides',
  {
    id: id(),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    // Same string set as `lib/emailTemplates.ts` DEFAULTS keys.
    // Validated at the route layer; the column is plain text
    // to keep the migration add-only.
    name: text('name').notNull(),
    subject: text('subject').notNull(),
    text: text('text').notNull(),
    createdAt: ts('created_at'),
    updatedAt: tsUpdatable('updated_at'),
  },
  (t) => ({
    workspaceNameIdx: uniqueIndex('email_template_overrides_workspace_name_idx').on(t.workspaceId, t.name),
  }),
);

export const oidcProviders = sqliteTable('oidc_providers', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  issuerUrl: text('issuer_url'),
  clientId: text('client_id').notNull(),
  clientSecretEncrypted: text('client_secret_encrypted').notNull(),
  scopes: text('scopes').notNull().default('openid profile email'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  autoEnroll: integer('auto_enroll', { mode: 'boolean' }).notNull().default(true),
  defaultRole: text('default_role', { enum: workspaceRole }).notNull().default('member'),
  createdAt: ts('created_at'),
  updatedAt: tsUpdatable('updated_at'),
});

// Pending workspace invitations. One row per (workspace, email) — the row is
// created when an owner/admin invites an address that does not yet have a
// `users` row (or that we want to onboard into a specific role). A non-null
// `token` is the shareable accept URL handle; a non-null `acceptedAt` means
// the invite was consumed (and a `users` row exists at the address by then).
export const workspaceInvitations = sqliteTable(
  'workspace_invitations',
  {
    id: id(),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: workspaceRole }).notNull().default('member'),
    // Opaque random token used in the public accept URL. Unguessable from
    // outside (32 bytes hex) so it can be sent over email without further
    // obfuscation; only the hash is needed server-side to look the row up.
    token: text('token').notNull().unique(),
    invitedByUserId: integer('invited_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    acceptedAt: integer('accepted_at', { mode: 'timestamp' }),
    acceptedByUserId: integer('accepted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
    createdAt: ts('created_at'),
    updatedAt: tsUpdatable('updated_at'),
  },
  (t) => ({
    // One outstanding (non-revoked, unaccepted) invite per (workspace, email).
    // Once consumed, a fresh invite to the same address is allowed (separate
    // row) so a re-add after a member was removed can be tracked independently.
    workspaceEmailIdx: uniqueIndex('workspace_invitations_workspace_email_idx').on(t.workspaceId, t.email),
    workspaceIdx: index('workspace_invitations_workspace_idx').on(t.workspaceId),
    emailIdx: index('workspace_invitations_email_idx').on(t.email),
  }),
);

// ─── projects & services ──────────────────────────────────────────────────
export const projects = sqliteTable('projects', {
  id: id(),
  workspaceId: integer('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  createdAt: ts('created_at'),
  updatedAt: tsUpdatable('updated_at'),
});

// Labels are workspace-scoped free-form tags (color + name). A service can
// carry many labels; labels themselves live inside a workspace and a label
// row deleted by the workspace cascade removes all service_labels rows too.
export const labels = sqliteTable(
  'labels',
  {
    id: id(),
    workspaceId: integer('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull().default('indigo'),
    createdAt: ts('created_at'),
    updatedAt: tsUpdatable('updated_at'),
  },
  (t) => ({
    workspaceNameIdx: uniqueIndex('labels_workspace_name_idx').on(t.workspaceId, t.name),
    workspaceIdx: index('labels_workspace_idx').on(t.workspaceId),
  }),
);

/**
 * Environment = a named deployment lane (production / staging / development)
 * inside a workspace. Services opt in via `services.environment_id`
 * (nullable — ungrouped services are not part of any lane). The promote
 * flow (copying a build from one lane to the next) builds on this.
 */
export const environments = sqliteTable(
  'environments',
  {
    id: id(),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: ts('created_at'),
    updatedAt: tsUpdatable('updated_at'),
  },
  (t) => ({
    workspaceNameIdx: uniqueIndex('environments_workspace_name_idx').on(t.workspaceId, t.name),
    workspaceIdx: index('environments_workspace_idx').on(t.workspaceId),
  }),
);

// N-N: services ↔ projects. Replaces the legacy single `services.project_id`
// FK. A service can be linked to multiple projects (and live in multiple
// workspaces via `service_workspaces`) so the top-bar filter can compose
// across dimensions.
export const serviceProjects = sqliteTable(
  'service_projects',
  {
    serviceId: integer('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    createdAt: ts('created_at'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serviceId, t.projectId] }),
    projectIdx: index('service_projects_project_idx').on(t.projectId),
  }),
);

// N-N: services ↔ workspaces. A service can belong to many workspaces; the
// effective list is the union of explicit `service_workspaces` rows.
export const serviceWorkspaces = sqliteTable(
  'service_workspaces',
  {
    serviceId: integer('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdAt: ts('created_at'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serviceId, t.workspaceId] }),
    workspaceIdx: index('service_workspaces_workspace_idx').on(t.workspaceId),
  }),
);

// N-N: services ↔ labels. A label grants cross-cutting tagging that isn't
// tied to the project hierarchy (e.g. "production", "staging", "team-x").
export const serviceLabels = sqliteTable(
  'service_labels',
  {
    serviceId: integer('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    labelId: integer('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
    createdAt: ts('created_at'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serviceId, t.labelId] }),
    labelIdx: index('service_labels_label_idx').on(t.labelId),
  }),
);

export const services = sqliteTable(
  'services',
  {
    id: id(),
    // `projectId` is GONE — see `serviceProjects`. The column used to gate
    // access on a single project; with N-N tag scopes the row is decided
    // per-request from `service_projects` + `service_workspaces`.
    ownerUserId: integer('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    type: text('type', { enum: serviceType }).notNull().default('docker'),
    status: text('status', { enum: serviceStatus }).notNull().default('idle'),
    repoUrl: text('repo_url'),
    branch: text('branch').notNull().default('main'),
    commitSha: text('commit_sha'),
    sourceId: integer('source_id').references(() => sources.id, { onDelete: 'set null' }),
    // Image-based deploy (no repo): skip git+build and run this image directly.
    image: text('image'),
    // Watchtower-style digest watch: the auto-update sweep probes the registry
    // for this image's tag and enqueues a re-deploy when the digest moved.
    // Image-based services only (the resulting deployment routes to the
    // node's agent for remote services — see lib/autoUpdate.ts).
    autoUpdate: integer('auto_update', { mode: 'boolean' }).notNull().default(false),
    // Last registry manifest digest the sweep observed for this service's
    // tag. The FIRST observation is a baseline only — an update deploys from
    // the second change onward, so enabling the toggle never redeploys.
    autoUpdateDigest: text('auto_update_digest'),
    // Optional container path to mount a persistent named volume (nd-svc-<slug>-data).
    volumeMount: text('volume_mount'),
    port: integer('port'),
    // Direct host port mapping (e.g. 8080) for domain-less external access.
    publishedPort: integer('published_port'),
    healthPath: text('health_path').notNull().default('/'),
    // Runtime identifier: pm2 process name or docker container name.
    runtimeId: text('runtime_id'),
    // Resource limits (0 = unlimited). cpuShares maps to docker --cpu-shares,
    // memLimitMb maps to docker --memory (MiB).
    cpuShares: integer('cpu_shares').notNull().default(0),
    memLimitMb: integer('mem_limit_mb').notNull().default(0),
    // Template-defined container command (argv after the image). Only the
    // admin-controlled template registry sets it — not the create-service API.
    cmd: text('cmd', { mode: 'json' }).$type<string[]>(),
    // Bind-mount the host Docker socket (template flag only — docker control).
    dockerSocket: integer('docker_socket', { mode: 'boolean' }).notNull().default(false),
    // Durable Hub identity. The worker uses this to resume idempotent template
    // dependency provisioning after a process/host restart.
    templateId: text('template_id'),
    // Trusted Hub template mapping from application env names to managed DB
    // connection fields. Generic service requests cannot set this directly.
    templateDatabaseEnv: text('template_database_env', { mode: 'json' }).$type<Record<string, 'url' | 'host' | 'hostPort' | 'port' | 'username' | 'password' | 'database'>>(),
    // Remote server this service deploys to (null = this host). Agent-based.
    serverId: integer('server_id').references(() => servers.id, { onDelete: 'set null' }),
    // Compose deploys: the "main" service in the compose file (routing target).
    composeService: text('compose_service'),
    // Inline compose stacks: the YAML the user pasted (or a Hub template
    // shipped). This column — not the workspace file — is the source of
    // truth; the pipeline re-materialises it into
    // `<reposDir>/<serviceId>/docker-compose.yml` before every deploy, so a
    // wiped workspace, a rollback or a host migration cannot orphan a stack.
    composeContent: text('compose_content'),
    // Ephemeral PR / MR Preview Deployments settings
    previewDeploymentsEnabled: integer('preview_deployments_enabled', { mode: 'boolean' }).notNull().default(false),
    previewAutoDestroyOnClose: integer('preview_auto_destroy_on_close', { mode: 'boolean' }).notNull().default(true),
    previewDomainPattern: text('preview_domain_pattern'),
    previewMaxActive: integer('preview_max_active').notNull().default(5),
    isEphemeralPreview: integer('is_ephemeral_preview', { mode: 'boolean' }).notNull().default(false),
    previewParentServiceId: integer('preview_parent_service_id').references((): AnySQLiteColumn => services.id, { onDelete: 'cascade' }),
    prNumber: integer('pr_number'),
    /** Deployment lane (production / staging / …). Null = ungrouped. */
    environmentId: integer('environment_id').references((): AnySQLiteColumn => environments.id, { onDelete: 'set null' }),
    createdAt: ts('created_at'),
    updatedAt: tsUpdatable('updated_at'),
  },
  // Global slug uniqueness IS the invariant — the slug mints live container,
  // volume and Traefik router names (`nd-svc-<slug>`). Migration 0034 dropped
  // the narrower (projectId, slug) unique when projects went N-N; 0049
  // restores it at the global level (after de-duplicating legacy rows). The
  // application layer still checks first so users get a clean slug_taken 409
  // instead of a bare constraint error.
  (t) => ({
    slugUnique: uniqueIndex('services_slug_unique').on(t.slug),
    // SQLite does not auto-index FK columns; multi-server installs filter the
    // services list by the remote server on every panel page.
    serverIdx: index('services_server_idx').on(t.serverId),
  }),
);

export const buildConfigs = sqliteTable('build_configs', {
  id: id(),
  serviceId: integer('service_id')
    .notNull()
    .references(() => services.id, { onDelete: 'cascade' }),
  buildPack: text('build_pack', { enum: buildPack }).notNull().default('auto'),
  baseDir: text('base_dir').notNull().default('/'),
  installCmd: text('install_cmd'),
  buildCmd: text('build_cmd'),
  startCmd: text('start_cmd'),
  dockerfilePath: text('dockerfile_path'),
  // Static build pack: where the build output lands (relative to baseDir) and
  // whether the nginx conf gets SPA history fallback (try_files -> index.html).
  outputDir: text('output_dir'),
  staticSpa: integer('static_spa', { mode: 'boolean' }).notNull().default(true),
  // CI/CD Lifecycle Hooks
  preDeployCmd: text('pre_deploy_cmd'),
  postDeployCmd: text('post_deploy_cmd'),
  preStopCmd: text('pre_stop_cmd'),
  // Container restart policy (docker --restart). 'on-failure:N' caps the
  // restart loop; 'always'/'unless-stopped'/'no' pass through verbatim.
  restartPolicy: text('restart_policy').notNull().default('unless-stopped'),
  // Seconds to wait for graceful stop before SIGKILL (docker stop -t).
  stopGraceSeconds: integer('stop_grace_seconds').notNull().default(5),
  createdAt: ts('created_at'),
  updatedAt: tsUpdatable('updated_at'),
});

// ─── repository insights ───────────────────────────────────────────────────
// One row per repo-backed service: the latest framework analysis produced at
// deploy time (pipeline PREPARE) or by an on-demand refresh. Powers the
// "what's in this repo" card and the Framework tab. `data` stores the full
// RepoInsights JSON (packages/schemas/src/insights.ts); `frameworkId` is
// denormalized for cheap filtering.
export const repoInsights = sqliteTable(
  'repo_insights',
  {
    id: id(),
    serviceId: integer('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    frameworkId: text('framework_id').notNull(),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    commitSha: text('commit_sha'),
    createdAt: ts('created_at'),
    updatedAt: tsUpdatable('updated_at'),
  },
  (t) => ({ serviceIdIdx: uniqueIndex('repo_insights_service_idx').on(t.serviceId) }),
);

// ─── deployments ──────────────────────────────────────────────────────────
export const deployments = sqliteTable(
  'deployments',
  {
    id: id(),
    serviceId: integer('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    status: text('status', { enum: deploymentStatus }).notNull().default('queued'),
    commitSha: text('commit_sha'),
    // Resolved image digest (sha256:...) the runtime actually ran. Lets rollback
    // pin the exact image instead of re-pulling a mutable tag like `:latest`.
    imageDigest: text('image_digest'),
    message: text('message'),
    author: text('author'),
    trigger: text('trigger', { enum: deploymentTrigger }).notNull().default('user'),
    logPath: text('log_path'),
    // JSON snapshot of the effective build config + env key fingerprint at
    // deploy start — powers the config diff against the previous deployment.
    configSnapshot: text('config_snapshot'),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
    createdAt: ts('created_at'),
  },
  (t) => ({
    // Non-unique on purpose: `created_at` is second-precision (unixepoch), so a
    // second deploy of the same service within the same second would collide
    // with a UNIQUE constraint and 500 on trigger. History lists order by id
    // (monotonic) instead, so the index only needs to accelerate the filter.
    serviceCreatedIdx: index('deployments_service_created_idx').on(t.serviceId, t.createdAt),
    // The deploy worker polls WHERE status='queued' every 2s — index status.
    statusIdx: index('deployments_status_idx').on(t.status),
  }),
);

// ─── env vars & secrets ───────────────────────────────────────────────────
// scope='service' (default): per-service, serviceId set.
// scope='project': shared across every service in a project, serviceId null,
// scopeKey = projectId. Service-scope values win over project-scope at merge.
export const envScope = ['service', 'project'] as const;

export const envVars = sqliteTable(
  'env_vars',
  {
    id: id(),
    serviceId: integer('service_id').references(() => services.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: envScope }).notNull().default('service'),
    // Disambiguator for the unique index: serviceId for scope='service',
    // projectId for scope='project'. Both notNull so (scope, scopeKey, key)
    // stays truly unique across rows.
    scopeKey: integer('scope_key').notNull().default(0),
    key: text('key').notNull(),
    valueEncrypted: text('value_encrypted').notNull(),
    isSecret: integer('is_secret', { mode: 'boolean' }).notNull().default(true),
    createdAt: ts('created_at'),
    updatedAt: tsUpdatable('updated_at'),
  },
  (t) => ({
    serviceKeyIdx: uniqueIndex('env_vars_service_key_idx').on(t.serviceId, t.key),
    scopeKeyIdx: uniqueIndex('env_vars_scope_key_idx').on(t.scope, t.scopeKey, t.key),
  }),
);

// ─── git sources ──────────────────────────────────────────────────────────
export const sources = sqliteTable('sources', {
  id: id(),
  type: text('type', { enum: sourceType }).notNull(),
  name: text('name').notNull(),
  // OAuth/token or deploy key material — always encrypted at rest.
  tokenEncrypted: text('token_encrypted'),
  deployKeyEncrypted: text('deploy_key_encrypted'),
  // Registry-type sources: username for `docker login` (token = password).
  registryUsername: text('registry_username'),
  defaultBranch: text('default_branch').default('main'),
  createdAt: ts('created_at'),
  updatedAt: tsUpdatable('updated_at'),
});

export const domains = sqliteTable(
  'domains',
  {
    id: id(),
    serviceId: integer('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    hostname: text('hostname').notNull(),
    path: text('path').notNull().default('/'),
    ssl: integer('ssl', { mode: 'boolean' }).notNull().default(true),
    redirectWww: integer('redirect_www', { mode: 'boolean' }).notNull().default(false),
    // Custom response headers as a JSON array [{name, value}] → Traefik headers middleware.
    headers: text('headers'),
    // Basic Auth credentials (JSON array of "user:htpasswd_hash" or "user:pass")
    basicAuth: text('basic_auth'),
    // IP Allowlist (comma-separated CIDRs e.g. "1.2.3.4/32, 10.0.0.0/8")
    ipAllowlist: text('ip_allowlist'),
    // Rate limit: average requests/second (0 or null = disabled)
    rateLimitAverage: integer('rate_limit_average'),
    // Rate limit: burst peak requests allowed (0 or null = disabled)
    rateLimitBurst: integer('rate_limit_burst'),
    status: text('status', { enum: domainStatus }).notNull().default('pending'),
    // H-2 layer 2: proof that the claimant controls the DNS zone. A hostname
    // outside this instance's own zone stays `pending` — and unrouted — until
    // a TXT record at _ninedeploy-challenge.<hostname> matches this token.
    verificationToken: text('verification_token'),
    verifiedAt: integer('verified_at', { mode: 'timestamp' }),
    // External DNS record id (e.g. Cloudflare) when the provider integration
    // created the record — null for provider-less/manual DNS.
    dnsRecordId: text('dns_record_id'),
    createdAt: ts('created_at'),
    updatedAt: tsUpdatable('updated_at'),
  },
  (t) => ({
    hostPathIdx: uniqueIndex('domains_host_path_idx').on(t.hostname, t.path),
    serviceIdx: index('domains_service_idx').on(t.serviceId),
  }),
);

// ─── domain transfers (G-29) ───────────────────────────────────────────────
// One row per in-flight (or terminal) domain transfer. The
// flow is: source user (admin on the source service) inserts
// a `pending` row with a one-time URL token; target user
// (admin on the target service) calls accept with the
// token, which moves the `domains.service_id` and marks the
// transfer row `accepted`. `token_sha256` is the SHA-256 of
// the URL token — a leaked DB dump cannot be used to forge
// a transfer. The state machine (`pending` -> `accepted` /
// `cancelled` / `expired`) is enforced at the route layer.
export const domainTransferStatus = ['pending', 'accepted', 'cancelled', 'expired'] as const;

export const domainTransfers = sqliteTable(
  'domain_transfers',
  {
    id: id(),
    domainId: integer('domain_id')
      .notNull()
      .references(() => domains.id, { onDelete: 'cascade' }),
    sourceUserId: integer('source_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetEmail: text('target_email').notNull(),
    // Resolved on accept (when the user shows up); NULL
    // while the row is still `pending`.
    targetUserId: integer('target_user_id').references(() => users.id, { onDelete: 'set null' }),
    targetServiceId: integer('target_service_id').references(() => services.id, {
      onDelete: 'set null',
    }),
    tokenSha256: text('token_sha256').notNull(),
    status: text('status', { enum: domainTransferStatus }).notNull().default('pending'),
    // Unix epoch seconds; a `pending` row whose expires_at
    // is in the past is treated as `expired` by the routes
    // (lazy GC, no cron required).
    expiresAt: integer('expires_at').notNull(),
    acceptedAt: integer('accepted_at'),
    cancelledAt: integer('cancelled_at'),
    createdAt: ts('created_at'),
  },
  (t) => ({
    tokenIdx: uniqueIndex('domain_transfers_token_idx').on(t.tokenSha256),
    // Sweep: list pending rows that are about to expire so
    // the housekeeping job can flip them.
    statusIdx: index('domain_transfers_status_idx').on(t.status, t.expiresAt),
    // Target-side "show me transfers addressed to me" lookup.
    targetEmailIdx: index('domain_transfers_target_email_idx').on(t.targetEmail),
  }),
);

export const webhooks = sqliteTable('webhooks', {
  id: id(),
  sourceId: integer('source_id').references(() => sources.id, { onDelete: 'set null' }),
  serviceId: integer('service_id')
    .notNull()
    .references(() => services.id, { onDelete: 'cascade' }),
  branch: text('branch').notNull(),
  events: text('events', { mode: 'json' }).$type<string[]>().notNull().default(sql`'["push"]'`),
  // Optional newline/comma-separated globs — deploy only when a changed file matches (monorepos).
  watchPaths: text('watch_paths'),
  secretEncrypted: text('secret_encrypted').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: ts('created_at'),
}, (t) => ({
  // SQLite does not auto-index FK columns; every webhook delivery joins on
  // the service.
  serviceIdx: index('webhooks_service_idx').on(t.serviceId),
}));

// ─── backups & monitoring ─────────────────────────────────────────────────
export const backups = sqliteTable(
  'backups',
  {
    id: id(),
    // databaseId is nullable so volume-scope backups (scope='volumes') can
    // target a Docker volume without a corresponding DB row. Invariant
    // (enforced in the insert paths, NOT by a DB constraint — SQLite ALTER
    // cannot add a CHECK to an existing table, see migration 0035): a
    // scope='db'/'scheduled' row carries databaseId and volumeName=NULL; a
    // scope='volumes' row carries volumeName and databaseId=NULL.
    databaseId: integer('database_id').references(() => databases.id, { onDelete: 'cascade' }),
    // Docker volume name (managed: nd-svc-* / nd-db-*). Required for
    // scope='volumes' rows; NULL for scope='db'.
    volumeName: text('volume_name'),
    // Human-friendly snapshot name ('manual', 'schedule-2026-08-27', or an
    // operator-chosen tag at trigger time). NULL for legacy rows / db scope.
    label: text('label'),
    scope: text('scope', { enum: backupScope }).notNull(),
    status: text('status', { enum: backupStatus }).notNull().default('pending'),
    path: text('path').notNull(),
    // S3 object key when the encrypted envelope was uploaded to a destination.
    remoteKey: text('remote_key'),
    sizeBytes: integer('size_bytes').notNull().default(0),
    createdAt: ts('created_at'),
  },
  (t) => ({
    dbStatusIdx: index('backups_db_status_idx').on(t.databaseId, t.status),
    // Volume backups are listed by (volume, createdAt DESC) for the per-volume
    // route and retention sweep. The index is harmless for DB rows.
    volumeCreatedIdx: index('backups_volume_created_idx').on(t.volumeName, t.createdAt),
  }),
);

// ─── backup drills (G-17) ──────────────────────────────────────────────────
// One row per drill attempt. The drill reads a backup file and runs an
// engine-specific smoke check (pg_restore --list, redis-check-rdb, ...)
// to confirm the dump is at least parseable, without spinning up a real
// database container. `details_json` carries the engine-specific result
// (object counts, file size) so a future operator can see *what* the
// drill actually verified, not just that it passed.
export const backupDrillStatus = ['pending', 'running', 'passed', 'failed'] as const;

export const backupDrills = sqliteTable(
  'backup_drills',
  {
    id: id(),
    databaseId: integer('database_id')
      .notNull()
      .references(() => databases.id, { onDelete: 'cascade' }),
    backupId: integer('backup_id')
      .notNull()
      .references(() => backups.id, { onDelete: 'cascade' }),
    status: text('status', { enum: backupDrillStatus }).notNull().default('pending'),
    engine: text('engine').notNull(),
    durationMs: integer('duration_ms').notNull().default(0),
    error: text('error'),
    // Engine-specific details: pg_restore object counts, redis-check-rdb
    // stdout tail, mysql/mariadb header summary, etc. Nullable on early
    // rows that aborted before any output.
    detailsJson: text('details_json'),
    startedAt: ts('started_at'),
    completedAt: integer('completed_at'),
  },
  (t) => ({
    // Per-database drill history list (GET /v1/databases/:id/drills).
    dbStartedIdx: index('backup_drills_db_started_idx').on(t.databaseId, t.startedAt),
  }),
);

// ─── S3-compatible backup destinations ────────────────────────────────────
export const backupDestinations = sqliteTable('backup_destinations', {
  id: id(),
  name: text('name').notNull(),
  // S3-compatible endpoint, e.g. https://s3.eu-central-1.amazonaws.com or a MinIO URL.
  endpoint: text('endpoint').notNull(),
  region: text('region').notNull().default('us-east-1'),
  bucket: text('bucket').notNull(),
  prefix: text('prefix').notNull().default('ninedeploy'),
  accessKeyId: text('access_key_id').notNull(),
  secretKeyEncrypted: text('secret_key_encrypted').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: ts('created_at'),
  updatedAt: tsUpdatable('updated_at'),
});

export const metrics = sqliteTable(
  'metrics',
  {
    id: id(),
    serviceId: integer('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // cpu | memory | status | response_ms
    value: integer('value').notNull(),
    ts: ts('ts'),
  },
  // High-volume time-series table: every read filters serviceId + kind + ts>=,
  // and retention deletes by ts. A composite index makes both fast.
  (t) => ({ serviceKindTsIdx: index('metrics_service_kind_ts_idx').on(t.serviceId, t.kind, t.ts) }),
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: id(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entity: text('entity'),
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>(),
    ts: ts('ts'),
  },
  (t) => ({ entityTsIdx: index('audit_log_entity_ts_idx').on(t.entity, t.ts) }),
);

// ─── Build cache registry (G-01 PR-C) ─────────────────────────────────────
// One row per (key, backend, repo) triple. Bytes live in the registry
// itself; the row tracks the digest, the size, and the last-hit
// timestamp so the panel can render hit-rate / drop cold rows.
export const cacheRegistryBlobs = sqliteTable(
  'cache_registry_blobs',
  {
    id: id(),
    key: text('key').notNull(),
    backend: text('backend').notNull(),
    repo: text('repo').notNull(),
    digest: text('digest').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storedAt: tsUpdatable('stored_at'),
    lastHitAt: tsUpdatable('last_hit_at'),
    hits: integer('hits').notNull().default(0),
  },
  (t) => ({
    keyIdx: uniqueIndex('cache_registry_blobs_key_idx').on(t.key, t.backend, t.repo),
    lastHitIdx: index('cache_registry_blobs_last_hit_idx').on(t.lastHitAt),
  }),
);

export type CacheRegistryBlob = typeof cacheRegistryBlobs.$inferSelect;

// ─── Swarm stacks (G-10 PR #21) ──────────────────────────────────────────
// One row per stack the `SwarmOrchestrator` has applied. The driver
// also writes a working file under `/var/lib/ninedeploy/stacks/<name>/`
// for fast lookup; this row is the source of truth across a process
// restart because the swarm daemon is a separate process we do not
// own.
export const swarmStacks = sqliteTable(
  'swarm_stacks',
  {
    id: id(),
    name: text('name').notNull(),
    stateJson: text('state_json').notNull(),
    lastAppliedAt: tsUpdatable('last_applied_at'),
    createdAt: ts('created_at'),
    updatedAt: tsUpdatable('updated_at'),
  },
  (t) => ({
    nameIdx: uniqueIndex('swarm_stacks_name_idx').on(t.name),
    lastAppliedIdx: index('swarm_stacks_last_applied_idx').on(t.lastAppliedAt),
  }),
);

export type SwarmStack = typeof swarmStacks.$inferSelect;

// ─── SSO providers (G-22) ────────────────────────────────────────────────
// One row per configured OIDC or SAML provider. The `config_json`
// blob carries the issuer URL, client id / secret, SAML metadata
// URL, attribute mapping, and any provider-specific knobs. The
// driver never logs the secret fields.
export const ssoProviders = sqliteTable(
  'sso_providers',
  {
    id: id(),
    type: text('type', { enum: ['oidc', 'saml'] }).notNull(),
    name: text('name').notNull(),
    configJson: text('config_json').notNull(),
    createdAt: ts('created_at'),
    updatedAt: tsUpdatable('updated_at'),
  },
  (t) => ({
    nameIdx: uniqueIndex('sso_providers_name_idx').on(t.name),
  }),
);

export type SsoProvider = typeof ssoProviders.$inferSelect;

export const settings = sqliteTable(
  'settings',
  {
    key: text('key').notNull(),
    value: text('value', { mode: 'json' }).notNull(),
    updatedAt: tsUpdatable('updated_at'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.key] }) }),
);

// ─── managed databases ────────────────────────────────────────────────────
export const dbEngine = ['postgres', 'mysql', 'mariadb', 'redis', 'mongo', 'valkey', 'clickhouse', 'meilisearch', 'rabbitmq'] as const;
export const dbStatus = ['creating', 'running', 'stopped', 'error', 'deleting'] as const;

export const databases = sqliteTable(
  'databases',
  {
    id: id(),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'set null' }),
    // Stamped at creation so a member keeps access to a database they made even
    // when it belongs to no project. NULL on rows predating this column: those
    // fall back to the owning project's workspace, or admin-only.
    ownerUserId: integer('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    engine: text('engine', { enum: dbEngine }).notNull(),
    version: text('version'),
    status: text('status', { enum: dbStatus }).notNull().default('creating'),
    containerName: text('container_name'),
    internalHost: text('internal_host'),
    internalPort: integer('internal_port'),
    username: text('username'),
    passwordEncrypted: text('password_encrypted').notNull(),
    dbName: text('db_name'),
    volumeName: text('volume_name'),
    // Resource limits (0 = unlimited).
    cpuShares: integer('cpu_shares').notNull().default(0),
    memLimitMb: integer('mem_limit_mb').notNull().default(0),
    // Web Studio (GUI): Adminer / Redis Commander / pgweb container port & status
    webGuiEnabled: integer('web_gui_enabled', { mode: 'boolean' }).notNull().default(false),
    webGuiPort: integer('web_gui_port'),
    // Installed extensions (e.g. ['pgvector', 'postgis'] for PostgreSQL)
    extensions: text('extensions', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    // G-32: PgBouncer sidecar. Only meaningful for engine
    // 'postgres'; the route refuses to enable a sidecar for
    // MySQL / Redis / etc. The container is named by
    // convention `nd-pgb-<slug>` so `docker ps` can
    // discover it without a separate registry.
    pgbouncerEnabled: integer('pgbouncer_enabled', { mode: 'boolean' }).notNull().default(false),
    pgbouncerContainerName: text('pgbouncer_container_name'),
    pgbouncerPort: integer('pgbouncer_port').notNull().default(6432),
    // Set once this row's start has been made consistent with the volume's
    // contents (fresh init, or a retained volume adopted/re-keyed by THIS
    // row). NULL on rows predating the marker and on rows whose adoption has
    // not run yet: the retained-volume adoption gate keys off it, so a failed
    // first attempt retries the adoption on the next deploy instead of
    // booting the deleted installation's credentials.
    initializedAt: integer('initialized_at', { mode: 'timestamp' }),
    createdAt: ts('created_at'),
    updatedAt: tsUpdatable('updated_at'),
  },
  (t) => ({
    slugIdx: uniqueIndex('databases_slug_idx').on(t.slug),
    // SQLite does not auto-index FK columns; project listings join on it.
    projectIdx: index('databases_project_idx').on(t.projectId),
  }),
);

export const databaseAttachments = sqliteTable(
  'database_attachments',
  {
    id: id(),
    serviceId: integer('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    databaseId: integer('database_id')
      .notNull()
      .references(() => databases.id, { onDelete: 'cascade' }),
    envAlias: text('env_alias').notNull(),
    createdAt: ts('created_at'),
  },
  (t) => ({ uniq: uniqueIndex('db_attach_svc_db_idx').on(t.serviceId, t.databaseId) }),
);

// ─── service volume attachments ───────────────────────────────────────────
// Additional named volumes a service mounts alongside its primary volumeMount.
// One service can attach N volumes; the same volume can be attached to many
// services (shared). Persistence is handled by Docker named volumes — the
// attachment row only records (service, volume, path, readonly); detaching
// never deletes the underlying volume.
export const serviceVolumeAttachments = sqliteTable(
  'service_volume_attachments',
  {
    id: id(),
    serviceId: integer('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    // Docker volume name. Always starts with `nd-svc-` for managed volumes;
    // inventory lookups consult this column before the legacy
    // `nd-svc-<slug>-data` heuristic.
    volumeName: text('volume_name').notNull(),
    // Absolute container path the volume is mounted at inside the service.
    containerPath: text('container_path').notNull(),
    // Read-only mount (default false). Useful for config-only volumes.
    readOnly: integer('read_only', { mode: 'boolean' }).notNull().default(false),
    createdAt: ts('created_at'),
    updatedAt: tsUpdatable('updated_at'),
  },
  (t) => ({
    // A service cannot mount two volumes at the same path.
    pathIdx: uniqueIndex('svc_vol_attach_svc_path_idx').on(t.serviceId, t.containerPath),
    // A service cannot attach the same volume twice (each service×volume is unique).
    volumeIdx: uniqueIndex('svc_vol_attach_svc_volume_idx').on(t.serviceId, t.volumeName),
  }),
);

// ─── cloudflare tunnels ───────────────────────────────────────────────────
export const tunnelStatus = ['running', 'stopped', 'error'] as const;

export const tunnels = sqliteTable(
  'tunnels',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    tokenEncrypted: text('token_encrypted').notNull(),
    status: text('status', { enum: tunnelStatus }).notNull().default('running'),
    containerName: text('container_name').notNull(),
    createdAt: ts('created_at'),
    updatedAt: tsUpdatable('updated_at'),
  },
  (t) => ({ slugIdx: uniqueIndex('tunnels_slug_idx').on(t.slug) }),
);

// ─── notification channels ────────────────────────────────────────────────
export const channelType = ['telegram', 'webhook', 'discord', 'slack', 'ntfy', 'email', 'fcm'] as const;
export const notificationChannels = sqliteTable(
  'notification_channels',
  {
    id: id(),
    name: text('name').notNull(),
    type: text('type', { enum: channelType }).notNull(),
    targetEncrypted: text('target_encrypted').notNull(),
    eventFilter: text('event_filter').notNull().default(''),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    // Per-channel provider-specific knobs. Discord uses this for embed
    // title/description/color and webhook identity overrides; the
    // `dispatchChannel` switch reads the keys it cares about. Nullable
    // so channels created before G-18 PR-A keep working with their
    // existing plain-content payload.
    configJson: text('config_json'),
    createdAt: ts('created_at'),
    updatedAt: tsUpdatable('updated_at'),
  },
  (t) => ({ nameIdx: uniqueIndex('notification_channels_name_idx').on(t.name) }),
);

/**
 * Per-service notification subscriptions — the manifest's `notifications`
 * section (`onDeploy` / `onFailure` / `onAlert` channel names) resolves to
 * rows here. A rule ADDS deliveries for one service's events to a channel;
 * the channel's own global eventFilter keeps working exactly as before for
 * everything else (rules are additive, never subtractive).
 */
export const serviceNotificationChannels = sqliteTable(
  'service_notification_channels',
  {
    id: id(),
    serviceId: integer('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    channelId: integer('channel_id')
      .notNull()
      .references(() => notificationChannels.id, { onDelete: 'cascade' }),
    // deploy → all deploy.* outcomes; failure → deploy.failed only;
    // alert → alert.* events.
    scope: text('scope', { enum: ['deploy', 'failure', 'alert'] as const }).notNull(),
    createdAt: ts('created_at'),
  },
  (t) => ({
    ruleIdx: uniqueIndex('service_notification_channels_idx').on(t.serviceId, t.channelId, t.scope),
  }),
);

export const notificationLog = sqliteTable(
  'notification_log',
  {
    id: id(),
    channelId: integer('channel_id').references(() => notificationChannels.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    entity: text('entity'),
    status: text('status', { enum: ['sent', 'failed'] as const }).notNull().default('sent'),
    // Delivery attempts (retry with exponential backoff) for this notification.
    attempts: integer('attempts').notNull().default(1),
    error: text('error'),
    ts: ts('ts'),
  },
  (t) => ({ channelTsIdx: index('notification_log_channel_ts_idx').on(t.channelId, t.ts) }),
);

// ─── alerting ──────────────────────────────────────────────────────────────
export const alertMetric = ['cpu', 'memory', 'cert-expiry'] as const;
export const alertOperator = ['>', '<'] as const;
export const alertStateStatus = ['ok', 'breaching', 'firing'] as const;

export const alertRules = sqliteTable(
  'alert_rules',
  {
    id: id(),
    // Null = host-wide rule (evaluated against host metrics).
    serviceId: integer('service_id').references(() => services.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // cpu: percent (0-100); memory: MiB; cert-expiry: days remaining.
    metric: text('metric', { enum: alertMetric }).notNull(),
    operator: text('operator', { enum: alertOperator }).notNull().default('>'),
    threshold: integer('threshold').notNull(),
    // Number of consecutive 30s samples that must breach before firing.
    durationWindows: integer('duration_windows').notNull().default(1),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: ts('created_at'),
    updatedAt: tsUpdatable('updated_at'),
  },
  (t) => ({ nameIdx: uniqueIndex('alert_rules_name_idx').on(t.name) }),
);

// One row per rule tracking the breach lifecycle (detection → firing → recovery).
export const alertState = sqliteTable('alert_state', {
  ruleId: integer('rule_id')
    .notNull()
    .references(() => alertRules.id, { onDelete: 'cascade' })
    .unique(),
  status: text('status', { enum: alertStateStatus }).notNull().default('ok'),
  breachSince: integer('breach_since', { mode: 'timestamp' }),
  firedAt: integer('fired_at', { mode: 'timestamp' }),
  lastNotifiedAt: integer('last_notified_at', { mode: 'timestamp' }),
  lastValue: integer('last_value'),
  updatedAt: tsUpdatable('updated_at'),
});

// ─── relations ────────────────────────────────────────────────────────────
// ─── scheduled jobs (cron) ────────────────────────────────────────────────
export const scheduledJobs = sqliteTable(
  'scheduled_jobs',
  {
    id: id(),
    serviceId: integer('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // 5-field cron expression (minute hour dom month dow), user-local timezone.
    cron: text('cron').notNull(),
    // deploy → re-deploy the service; exec → run `command` inside the runtime
    // container; backup → snapshot the service's primary + every attached volume.
    kind: text('kind', { enum: jobKind }).notNull().default('deploy'),
    command: text('command'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastRunAt: integer('last_run_at', { mode: 'timestamp' }),
    createdAt: ts('created_at'),
    updatedAt: tsUpdatable('updated_at'),
  },
  (t) => ({ serviceIdx: index('scheduled_jobs_service_idx').on(t.serviceId) }),
);

export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: id(),
    jobId: integer('job_id')
      .notNull()
      .references(() => scheduledJobs.id, { onDelete: 'cascade' }),
    status: text('status', { enum: jobRunStatus }).notNull().default('running'),
    output: text('output').notNull().default(''),
    exitCode: integer('exit_code'),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
    createdAt: ts('created_at'),
  },
  (t) => ({ jobIdx: index('job_runs_job_idx').on(t.jobId) }),
);

// ─── remote servers (agent-based multi-server) ────────────────────────────
export const servers = sqliteTable('servers', {
  id: id(),
  name: text('name').notNull(),
  host: text('host').notNull(),
  port: integer('port').notNull().default(4600),
  status: text('status', { enum: serverStatus }).notNull().default('offline'),
  // Shared secret the agent presents. The raw token is encrypted at rest so
  // the core can use it for exec calls; sha256 hash would be one-way.
  tokenEncrypted: text('token_encrypted').notNull(),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
  createdAt: ts('created_at'),
  updatedAt: tsUpdatable('updated_at'),
});

export const passwordResetTokens = sqliteTable('password_reset_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  // sha256 of the raw token — the raw value exists only in the delivery message.
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  usedAt: integer('used_at', { mode: 'timestamp' }),
  requestedFrom: text('requested_from'),
  createdAt: tsUpdatable('created_at'),
}, (t) => [index('password_reset_tokens_user_idx').on(t.userId)]);

// ─── configuration center & plugins ──────────────────────────────────────────
export const configEntries = sqliteTable(
  'config_entries',
  {
    key: text('key').primaryKey(),
    pluginId: text('plugin_id'),
    value: text('value').notNull(),
    isSecret: integer('is_secret', { mode: 'boolean' }).notNull().default(false),
    category: text('category').notNull().default('general'),
    tags: text('tags', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    description: text('description'),
    updatedAt: tsUpdatable('updated_at'),
    updatedBy: integer('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    pluginIdx: index('config_entries_plugin_idx').on(t.pluginId),
    categoryIdx: index('config_entries_category_idx').on(t.category),
  }),
);

export const installedPlugins = sqliteTable(
  'installed_plugins',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    version: text('version').notNull(),
    description: text('description'),
    author: text('author'),
    icon: text('icon'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    isOfficial: integer('is_official', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: ['active', 'disabled', 'errored', 'installing'] })
      .notNull()
      .default('active'),
    error: text('error'),
    manifest: text('manifest', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    createdAt: ts('created_at'),
    updatedAt: tsUpdatable('updated_at'),
  },
  (t) => ({
    statusIdx: index('installed_plugins_status_idx').on(t.status),
  }),
);

// ─── log drains ───────────────────────────────────────────────────────────
export const logDrainType = ['syslog', 'loki', 'vector', 'datadog', 'http'] as const;
export const logDrainFormat = ['json', 'raw', 'rfc5424'] as const;

export const logDrains = sqliteTable(
  'log_drains',
  {
    id: id(),
    name: text('name').notNull(),
    type: text('type', { enum: logDrainType }).notNull().default('http'),
    url: text('url').notNull(),
    apiKeyEncrypted: text('api_key_encrypted'),
    serviceId: integer('service_id').references(() => services.id, { onDelete: 'cascade' }),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    format: text('format', { enum: logDrainFormat }).notNull().default('json'),
    headersJson: text('headers_json'),
    createdAt: ts('created_at'),
    updatedAt: tsUpdatable('updated_at'),
  },
  (t) => ({
    serviceIdx: index('log_drains_service_idx').on(t.serviceId),
  }),
);

export const passwordResetTokensRelations = relations(passwordResetTokens, ({ one }) => ({
  user: one(users, { fields: [passwordResetTokens.userId], references: [users.id] }),
}));

export const configEntriesRelations = relations(configEntries, ({ one }) => ({
  updatedByUser: one(users, { fields: [configEntries.updatedBy], references: [users.id] }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  apiTokens: many(apiTokens),
  webauthnCredentials: many(webauthnCredentials),
  sessions: many(sessions),
  ownedWorkspaces: many(workspaces),
  workspaceMemberships: many(workspaceMembers),
}));

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  owner: one(users, { fields: [workspaces.ownerId], references: [users.id] }),
  members: many(workspaceMembers),
  projects: many(projects),
}));

export const workspaceMembersRelations = relations(workspaceMembers, ({ one }) => ({
  workspace: one(workspaces, { fields: [workspaceMembers.workspaceId], references: [workspaces.id] }),
  user: one(users, { fields: [workspaceMembers.userId], references: [users.id] }),
}));

export const webauthnCredentialsRelations = relations(webauthnCredentials, ({ one }) => ({
  user: one(users, { fields: [webauthnCredentials.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const apiTokensRelations = relations(apiTokens, ({ one }) => ({
  user: one(users, { fields: [apiTokens.userId], references: [users.id] }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [projects.workspaceId], references: [workspaces.id] }),
  serviceProjects: many(serviceProjects),
}));

export const servicesRelations = relations(services, ({ one, many }) => ({
  buildConfig: one(buildConfigs),
  deployments: many(deployments),
  envVars: many(envVars),
  domains: many(domains),
  volumeAttachments: many(serviceVolumeAttachments),
  projectLinks: many(serviceProjects),
  workspaceLinks: many(serviceWorkspaces),
  labelLinks: many(serviceLabels),
}));

export const labelsRelations = relations(labels, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [labels.workspaceId], references: [workspaces.id] }),
  serviceLinks: many(serviceLabels),
}));

export const serviceProjectsRelations = relations(serviceProjects, ({ one }) => ({
  service: one(services, { fields: [serviceProjects.serviceId], references: [services.id] }),
  project: one(projects, { fields: [serviceProjects.projectId], references: [projects.id] }),
}));

export const serviceWorkspacesRelations = relations(serviceWorkspaces, ({ one }) => ({
  service: one(services, { fields: [serviceWorkspaces.serviceId], references: [services.id] }),
  workspace: one(workspaces, { fields: [serviceWorkspaces.workspaceId], references: [workspaces.id] }),
}));

export const serviceLabelsRelations = relations(serviceLabels, ({ one }) => ({
  service: one(services, { fields: [serviceLabels.serviceId], references: [services.id] }),
  label: one(labels, { fields: [serviceLabels.labelId], references: [labels.id] }),
}));

export const buildConfigsRelations = relations(buildConfigs, ({ one }) => ({
  service: one(services, { fields: [buildConfigs.serviceId], references: [services.id] }),
}));

export const deploymentsRelations = relations(deployments, ({ one }) => ({
  service: one(services, { fields: [deployments.serviceId], references: [services.id] }),
}));

export const envVarsRelations = relations(envVars, ({ one }) => ({
  service: one(services, { fields: [envVars.serviceId], references: [services.id] }),
}));

export const domainsRelations = relations(domains, ({ one }) => ({
  service: one(services, { fields: [domains.serviceId], references: [services.id] }),
}));

export const webhooksRelations = relations(webhooks, ({ one }) => ({
  service: one(services, { fields: [webhooks.serviceId], references: [services.id] }),
  source: one(sources, { fields: [webhooks.sourceId], references: [sources.id] }),
}));

export const metricsRelations = relations(metrics, ({ one }) => ({
  service: one(services, { fields: [metrics.serviceId], references: [services.id] }),
}));

export const databasesRelations = relations(databases, ({ one, many }) => ({
  project: one(projects, { fields: [databases.projectId], references: [projects.id] }),
  attachments: many(databaseAttachments),
}));

export const databaseAttachmentsRelations = relations(databaseAttachments, ({ one }) => ({
  service: one(services, { fields: [databaseAttachments.serviceId], references: [services.id] }),
  database: one(databases, { fields: [databaseAttachments.databaseId], references: [databases.id] }),
}));

export const serviceVolumeAttachmentsRelations = relations(serviceVolumeAttachments, ({ one }) => ({
  service: one(services, { fields: [serviceVolumeAttachments.serviceId], references: [services.id] }),
}));

export const notificationLogRelations = relations(notificationLog, ({ one }) => ({
  channel: one(notificationChannels, { fields: [notificationLog.channelId], references: [notificationChannels.id] }),
}));

export const alertRulesRelations = relations(alertRules, ({ one }) => ({
  service: one(services, { fields: [alertRules.serviceId], references: [services.id] }),
  state: one(alertState, { fields: [alertRules.id], references: [alertState.ruleId] }),
}));

export const alertStateRelations = relations(alertState, ({ one }) => ({
  rule: one(alertRules, { fields: [alertState.ruleId], references: [alertRules.id] }),
}));

export const logDrainsRelations = relations(logDrains, ({ one }) => ({
  service: one(services, { fields: [logDrains.serviceId], references: [services.id] }),
}));

// ─── type exports ─────────────────────────────────────────────────────────
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type ApiToken = typeof apiTokens.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMember = typeof workspaceMembers.$inferInsert;
export type OidcProvider = typeof oidcProviders.$inferSelect;
export type NewOidcProvider = typeof oidcProviders.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Service = typeof services.$inferSelect;
export type NewService = typeof services.$inferInsert;
export type Label = typeof labels.$inferSelect;
export type NewLabel = typeof labels.$inferInsert;
export type ServiceProject = typeof serviceProjects.$inferSelect;
export type ServiceWorkspace = typeof serviceWorkspaces.$inferSelect;
export type ServiceLabel = typeof serviceLabels.$inferSelect;
export type BuildConfig = typeof buildConfigs.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;
export type EnvVar = typeof envVars.$inferSelect;
export type Source = typeof sources.$inferSelect;
export type Domain = typeof domains.$inferSelect;
export type Webhook = typeof webhooks.$inferSelect;
export type Backup = typeof backups.$inferSelect;
export type Metric = typeof metrics.$inferSelect;
export type AuditLog = typeof auditLog.$inferSelect;
export type Setting = typeof settings.$inferSelect;
export type Database = typeof databases.$inferSelect;
export type NewDatabase = typeof databases.$inferInsert;
export type DatabaseAttachment = typeof databaseAttachments.$inferSelect;
export type ServiceVolumeAttachment = typeof serviceVolumeAttachments.$inferSelect;
export type NewServiceVolumeAttachment = typeof serviceVolumeAttachments.$inferInsert;
export type Tunnel = typeof tunnels.$inferSelect;
export type NotificationChannel = typeof notificationChannels.$inferSelect;
export type NotificationLog = typeof notificationLog.$inferSelect;
export type AlertRule = typeof alertRules.$inferSelect;
export type AlertState = typeof alertState.$inferSelect;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type BackupDestination = typeof backupDestinations.$inferSelect;
export type ScheduledJob = typeof scheduledJobs.$inferSelect;
export type JobRun = typeof jobRuns.$inferSelect;
export type ServerRow = typeof servers.$inferSelect;
export type WebauthnCredential = typeof webauthnCredentials.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type ConfigEntry = typeof configEntries.$inferSelect;
export type NewConfigEntry = typeof configEntries.$inferInsert;
export type InstalledPlugin = typeof installedPlugins.$inferSelect;
export type NewInstalledPlugin = typeof installedPlugins.$inferInsert;
export type LogDrain = typeof logDrains.$inferSelect;
export type NewLogDrain = typeof logDrains.$inferInsert;

