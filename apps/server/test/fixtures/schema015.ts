/**
 * The v0.15.1 drizzle schema for the six tables migration 0072 alters
 * (`databases`, `services`, `servers`, `sources`, `backups`, `deployments`),
 * vendored from `packages/db/src/schema.ts` at tag v0.15.1 (f8c5b231):
 * columns, types, modes, defaults and indexes exactly as 0.15 declares them.
 * Foreign-key callbacks and comments are dropped; they play no part in a read.
 *
 * Used by test/multiNodeUpgrade.test.ts to prove a ROLLBACK to 0.15 reads
 * every row a 0.16 database holds, and that 0.15's typed reads never see the
 * 0072 columns (design §8 step 6, D6: drizzle selects declared columns only,
 * so 0.15 cannot read `databases.server_id` even though the column exists).
 *
 * Frozen: never edit this to match a later schema.
 */
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const id = () => integer('id').primaryKey({ autoIncrement: true });
const ts = (name: string) =>
  integer(name, { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`);
const tsUpdatable = (name: string) =>
  integer(name, { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`)
    .$onUpdate(() => new Date());

const serviceType = ['pm2', 'docker', 'compose'] as const;
const serviceStatus = [
  'idle',
  'deploying',
  'running',
  'stopped',
  'error',
  'deleting',
] as const;
const deploymentStatus = [
  'queued',
  'building',
  'deploying',
  'running',
  'superseded',
  'failed',
  'cancelled',
] as const;
const deploymentTrigger = ['user', 'webhook', 'cli', 'schedule'] as const;
const sourceType = [
  'github',
  'gitlab',
  'gitea',
  'bitbucket',
  'custom',
  'registry',
  'github_app',
] as const;
const backupScope = ['db', 'scheduled', 'volumes', 'full'] as const;
const backupStatus = ['pending', 'running', 'completed', 'failed'] as const;
const serverStatus = ['offline', 'online', 'error', 'pending'] as const;
const dbEngine = ['postgres', 'mysql', 'mariadb', 'redis', 'mongo', 'valkey', 'clickhouse', 'meilisearch', 'rabbitmq'] as const;
const dbStatus = ['creating', 'running', 'stopped', 'error', 'deleting'] as const;

export const services015 = sqliteTable(
  'services',
  {
    id: id(),
    ownerUserId: integer('owner_user_id'),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    type: text('type', { enum: serviceType }).notNull().default('docker'),
    status: text('status', { enum: serviceStatus }).notNull().default('idle'),
    repoUrl: text('repo_url'),
    branch: text('branch').notNull().default('main'),
    commitSha: text('commit_sha'),
    sourceId: integer('source_id'),
    image: text('image'),
    autoUpdate: integer('auto_update', { mode: 'boolean' }).notNull().default(false),
    autoUpdateDigest: text('auto_update_digest'),
    volumeMount: text('volume_mount'),
    port: integer('port'),
    publishedPort: integer('published_port'),
    healthPath: text('health_path').notNull().default('/'),
    runtimeId: text('runtime_id'),
    cpuShares: integer('cpu_shares').notNull().default(0),
    cpuLimitMilli: integer('cpu_limit_milli').notNull().default(0),
    memLimitMb: integer('mem_limit_mb').notNull().default(0),
    replicas: integer('replicas').notNull().default(1),
    runtimeReplicas: integer('runtime_replicas').notNull().default(1),
    cmd: text('cmd', { mode: 'json' }).$type<string[]>(),
    dockerSocket: integer('docker_socket', { mode: 'boolean' }).notNull().default(false),
    templateId: text('template_id'),
    templateDatabaseEnv: text('template_database_env', { mode: 'json' }).$type<Record<string, 'url' | 'host' | 'hostPort' | 'port' | 'username' | 'password' | 'database'>>(),
    serverId: integer('server_id'),
    composeService: text('compose_service'),
    composeContent: text('compose_content'),
    previewDeploymentsEnabled: integer('preview_deployments_enabled', { mode: 'boolean' }).notNull().default(false),
    previewAutoDestroyOnClose: integer('preview_auto_destroy_on_close', { mode: 'boolean' }).notNull().default(true),
    previewDomainPattern: text('preview_domain_pattern'),
    previewMaxActive: integer('preview_max_active').notNull().default(5),
    isEphemeralPreview: integer('is_ephemeral_preview', { mode: 'boolean' }).notNull().default(false),
    previewParentServiceId: integer('preview_parent_service_id'),
    prNumber: integer('pr_number'),
    environmentId: integer('environment_id'),
    createdAt: ts('created_at'),
    updatedAt: tsUpdatable('updated_at'),
  },
  (t) => ({
    slugUnique: uniqueIndex('services_slug_unique').on(t.slug),
    serverIdx: index('services_server_idx').on(t.serverId),
  }),
);

export const deployments015 = sqliteTable(
  'deployments',
  {
    id: id(),
    serviceId: integer('service_id').notNull(),
    status: text('status', { enum: deploymentStatus }).notNull().default('queued'),
    commitSha: text('commit_sha'),
    imageDigest: text('image_digest'),
    message: text('message'),
    author: text('author'),
    trigger: text('trigger', { enum: deploymentTrigger }).notNull().default('user'),
    logPath: text('log_path'),
    configSnapshot: text('config_snapshot'),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
    createdAt: ts('created_at'),
  },
  (t) => ({
    serviceCreatedIdx: index('deployments_service_created_idx').on(t.serviceId, t.createdAt),
    statusIdx: index('deployments_status_idx').on(t.status),
    createdIdx: index('deployments_created_idx').on(t.createdAt),
  }),
);

export const sources015 = sqliteTable('sources', {
  id: id(),
  type: text('type', { enum: sourceType }).notNull(),
  name: text('name').notNull(),
  tokenEncrypted: text('token_encrypted'),
  deployKeyEncrypted: text('deploy_key_encrypted'),
  registryUsername: text('registry_username'),
  defaultBranch: text('default_branch').default('main'),
  createdAt: ts('created_at'),
  updatedAt: tsUpdatable('updated_at'),
  baseUrl: text('base_url'),
});

export const backups015 = sqliteTable(
  'backups',
  {
    id: id(),
    databaseId: integer('database_id'),
    volumeName: text('volume_name'),
    label: text('label'),
    scope: text('scope', { enum: backupScope }).notNull(),
    status: text('status', { enum: backupStatus }).notNull().default('pending'),
    path: text('path').notNull(),
    remoteKey: text('remote_key'),
    destinationId: integer('destination_id'),
    sizeBytes: integer('size_bytes').notNull().default(0),
    createdAt: ts('created_at'),
  },
  (t) => ({
    dbStatusIdx: index('backups_db_status_idx').on(t.databaseId, t.status),
    volumeCreatedIdx: index('backups_volume_created_idx').on(t.volumeName, t.createdAt),
  }),
);

export const databases015 = sqliteTable(
  'databases',
  {
    id: id(),
    projectId: integer('project_id'),
    ownerUserId: integer('owner_user_id'),
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
    cpuShares: integer('cpu_shares').notNull().default(0),
    cpuLimitMilli: integer('cpu_limit_milli').notNull().default(0),
    memLimitMb: integer('mem_limit_mb').notNull().default(0),
    webGuiEnabled: integer('web_gui_enabled', { mode: 'boolean' }).notNull().default(false),
    webGuiPort: integer('web_gui_port'),
    extensions: text('extensions', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    pgbouncerEnabled: integer('pgbouncer_enabled', { mode: 'boolean' }).notNull().default(false),
    pgbouncerContainerName: text('pgbouncer_container_name'),
    pgbouncerPort: integer('pgbouncer_port').notNull().default(6432),
    initializedAt: integer('initialized_at', { mode: 'timestamp' }),
    createdAt: ts('created_at'),
    updatedAt: tsUpdatable('updated_at'),
  },
  (t) => ({
    slugIdx: uniqueIndex('databases_slug_idx').on(t.slug),
    projectIdx: index('databases_project_idx').on(t.projectId),
  }),
);

export const servers015 = sqliteTable(
  'servers',
  {
    id: id(),
    name: text('name').notNull(),
    host: text('host').notNull(),
    port: integer('port').notNull().default(4600),
    status: text('status', { enum: serverStatus }).notNull().default('offline'),
    tokenEncrypted: text('token_encrypted').notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
    createdAt: ts('created_at'),
    updatedAt: tsUpdatable('updated_at'),
  },
  (t) => ({ hostPortUnique: uniqueIndex('servers_host_port_unique').on(t.host, t.port) }),
);

/** The 0.15 tables, keyed as `createDb({ schema })` expects. */
export const schema015 = {
  services: services015,
  deployments: deployments015,
  sources: sources015,
  backups: backups015,
  databases: databases015,
  servers: servers015,
};
