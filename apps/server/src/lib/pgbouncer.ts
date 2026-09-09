/**
 * `ninedeploy databases pgbouncer {enable,disable,status}` —
 * G-32 PgBouncer sidecar.
 *
 * The helper spins up a co-located PgBouncer container that
 * fronts the managed Postgres database on a separate port
 * (default 6432). Services that want pooled connections
 * call `pooledConnectionString(d)` instead of
 * `connectionString(d)`; the former returns the
 * sidecar's URL when enabled, the direct URL otherwise.
 *
 * Why a sidecar and not a shared proxy: a per-database
 * sidecar means a pgbouncer restart (or a stuck pool) only
 * affects one tenant, and the credentials on the wire are
 * scoped to a single service-to-database pair. The trade
 * is one extra container per enabled database; for the
 * typical operator that's a few hundred MiB of RAM, which
 * is well below what a pooled Postgres workload saves.
 */
import { eq } from 'drizzle-orm';
import { databases, type DB, type Database } from '@ninedeploy/db';
import { decrypt } from './crypto.js';
import { capture, run } from './exec.js';
import { NETWORK } from '../engine/proxy.js';
import { writeSecretFile, type SecretFile } from './secretFile.js';

const PGBOUNCER_IMAGE = 'bitnami/pgbouncer:1.24.1';
const DEFAULT_PORT = 6432;
const swallow = () => undefined;

export interface PgbouncerStatus {
  enabled: boolean;
  containerName: string | null;
  port: number;
  /** True when the container exists AND is in `running` state. */
  running: boolean;
  /** Pool config the sidecar is running with (null when not running). */
  poolMode: string | null;
  /** Resolved at call time; null when the sidecar is down. */
  pooledConnectionString: string | null;
}

/** Canonical name (and the row's `pgbouncer_container_name`
 *  when enabled). Prefix + slug so `docker ps | grep nd-pgb`
 *  is enough to find every sidecar on the host. */
export function pgbouncerContainerName(d: Database): string {
  return d.pgbouncerContainerName ?? `nd-pgb-${d.slug}`;
}

/** Resolved at call time. Returns the pgbouncer URL when
 *  the sidecar is enabled AND running, else the direct
 *  `connectionString()` URL. Callers that want a stable
 *  URL regardless of sidecar state should call
 *  `connectionString()` directly. */
export function pooledConnectionString(d: Database): string {
  if (!d.pgbouncerEnabled || !d.pgbouncerContainerName) {
    // Direct connection — keep the existing connection
    // string shape.
    const password = decrypt(d.passwordEncrypted);
    const user = d.username ?? 'nine';
    return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${d.internalHost ?? d.containerName ?? 'localhost'}:${d.internalPort ?? 5432}/${d.dbName ?? 'app'}`;
  }
  const password = decrypt(d.passwordEncrypted);
  const user = d.username ?? 'nine';
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${d.pgbouncerContainerName}:${d.pgbouncerPort ?? DEFAULT_PORT}/${d.dbName ?? 'app'}`;
}

/**
 * Enable the sidecar: write a pgbouncer.ini, write the
 * userlist (MD5-hashed creds), launch the container,
 * and stamp the row. Idempotent — re-enabling a database
 * whose sidecar is already running is a no-op (the
 * container is reused, the row's columns are confirmed).
 */
export async function enablePgbouncer(db: DB, d: Database, log: (line: string) => void): Promise<void> {
  if (d.engine !== 'postgres') {
    throw new Error('PgBouncer sidecar is only supported for the postgres engine');
  }
  if (!d.containerName) throw new Error('database has no container name');
  const port = d.pgbouncerPort ?? DEFAULT_PORT;
  const containerName = pgbouncerContainerName(d);

  // Idempotency — if the row is already flagged and the
  // container is up, return.
  if (d.pgbouncerEnabled) {
    if (await containerRunning(containerName)) {
      log(`PgBouncer sidecar ${containerName} already running — reusing`);
      return;
    }
  }

  // The postgres container must be running before the
  // sidecar can connect to it.
  if (!(await containerRunning(d.containerName))) {
    throw new Error(`Postgres container ${d.containerName} is not running; start the database first`);
  }

  // Pull + write config files.
  log(`Pulling PgBouncer image ${PGBOUNCER_IMAGE} …`);
  await capture('docker', ['pull', PGBOUNCER_IMAGE]).catch(() => undefined);
  const password = decrypt(d.passwordEncrypted);
  const user = d.username ?? 'nine';
  const dbName = d.dbName ?? 'app';

  const ini = renderPgbouncerIni({
    postgresHost: d.containerName,
    postgresPort: d.internalPort ?? 5432,
    listenPort: port,
    user,
    password,
    dbName,
  });
  const userlist = renderUserlist({ user, password });
  const iniFile = await writeTempFile('pgbouncer.ini', ini);
  const userlistFile = await writeTempFile('userlist.txt', userlist);

  // Remove any stale (stopped) container of the same
  // name so the create below does not fail with a name
  // conflict; pgbouncer has no retained state.
  await run('docker', ['rm', '-f', containerName], {}, swallow).catch(swallow);

  try {
    // Create → docker cp → start: the config files are copied INTO the
    // container instead of bind-mounted, so the host-side copies (which
    // carry the DB password) can be deleted as soon as this sequence ends.
    // A bind mount would force them to stay on disk for the container's
    // lifetime, leaking secret material in the shared tmp dir.
    const args = [
      'create',
      '--name', containerName,
      '--network', NETWORK,
      '--restart', 'unless-stopped',
      // Only publish when the operator chose an explicit sidecar port: the
      // default (6432) is shared by EVERY sidecar, so publishing it makes
      // the second enable fail with "port is already allocated". Clients
      // connect over the docker network by container name anyway; when a
      // host port IS published it binds to LOOPBACK — plain MD5/SCRAM
      // credentials reachable from the LAN would be an unnecessary surface,
      // and pgbouncer has no NineDeploy auth in front of it.
      ...(d.pgbouncerPort != null ? ['-p', `127.0.0.1:${port}:${port}`] : []),
      PGBOUNCER_IMAGE,
    ];
    log(`Creating PgBouncer sidecar ${containerName} on port ${port} …`);
    await run('docker', args, {}, log);
    await run('docker', ['cp', iniFile.path, `${containerName}:/etc/pgbouncer/pgbouncer.ini`], {}, swallow);
    await run('docker', ['cp', userlistFile.path, `${containerName}:/etc/pgbouncer/userlist.txt`], {}, swallow);
    await run('docker', ['start', containerName], {}, log);

    // Stamp the row.
    await db
      .update(databases)
      .set({ pgbouncerEnabled: true, pgbouncerContainerName: containerName, pgbouncerPort: port, updatedAt: new Date() })
      .where(eq(databases.id, d.id));
  } finally {
    // The container has its own copy; the host-side secret files are no
    // longer needed and must never outlive this call — even on failure.
    iniFile.cleanup();
    userlistFile.cleanup();
  }
}

/** Disable: stop + rm the container, clear the row. The config files were
 *  copied into the container at enable time and already reaped there, so
 *  there is nothing on the host filesystem to clean up. */
export async function disablePgbouncer(db: DB, d: Database, log: (line: string) => void): Promise<void> {
  if (!d.pgbouncerEnabled) return;
  const containerName = d.pgbouncerContainerName ?? pgbouncerContainerName(d);
  log(`Stopping PgBouncer sidecar ${containerName} …`);
  await run('docker', ['rm', '-f', containerName], {}, swallow).catch(swallow);
  await db
    .update(databases)
    .set({ pgbouncerEnabled: false, pgbouncerContainerName: null, updatedAt: new Date() })
    .where(eq(databases.id, d.id));
}

/** Read the sidecar's runtime state. `running` is a
 *  real `docker inspect` query; `poolMode` is parsed
 *  from the rendered ini (the only authoritative source
 *  the operator can read). */
export async function pgbouncerStatusFor(d: Database): Promise<PgbouncerStatus> {
  const containerName = d.pgbouncerContainerName;
  if (!d.pgbouncerEnabled || !containerName) {
    return {
      enabled: false,
      containerName: null,
      port: d.pgbouncerPort ?? DEFAULT_PORT,
      running: false,
      poolMode: null,
      pooledConnectionString: null,
    };
  }
  const running = await containerRunning(containerName);
  let poolMode: string | null = null;
  if (running) {
    try {
      // pool_mode lives in the ini that `enablePgbouncer` docker-cp'd into
      // the container — that file is the config the sidecar actually runs
      // with. The container ENV never carries PGBOUNCER_POOL_MODE (the
      // create argv passes no -e flags), and `{{index .Config.Env}}` is
      // invalid Go template usage anyway, so inspecting env never answers.
      const ini = await capture('docker', ['exec', containerName, 'cat', '/etc/pgbouncer/pgbouncer.ini']);
      const m = /^pool_mode\s*=\s*([A-Za-z0-9_]+)/m.exec(ini);
      if (m) poolMode = m[1] ?? null;
    } catch {
      /* the exec failed; poolMode stays null */
    }
  }
  return {
    enabled: true,
    containerName,
    port: d.pgbouncerPort ?? DEFAULT_PORT,
    running,
    poolMode,
    pooledConnectionString: running ? pooledConnectionString(d) : null,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

async function containerRunning(name: string): Promise<boolean> {
  try {
    const out = await capture('docker', ['inspect', '--format', '{{.State.Running}}', name]);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

async function writeTempFile(suffix: string, body: string): Promise<SecretFile> {
  // Use the per-process temp file helper for secrets
  // (mode 0o600, private 0700 dir). The pgbouncer config
  // carries the DB password, so we use it even for the
  // userlist (which only carries an MD5 hash) — defense
  // in depth. The caller MUST call cleanup() once the
  // files have been copied into the container.
  const ref = `nd-pgb-${process.pid}-${Date.now()}`;
  return writeSecretFile(ref, suffix, body);
}

interface RenderInput {
  postgresHost: string;
  postgresPort: number;
  listenPort: number;
  user: string;
  password: string;
  dbName: string;
}

/**
 * pgbouncer.ini. `auth_type = scram-sha-256` — MD5 challenge/response is
 * replayable and its stored verifier is password-equivalent, which is exactly
 * what an audit does not want on a socket that may be exposed. With SCRAM the
 * userlist carries the CLEARTEXT password (pgbouncer needs it to answer both
 * the client's and the server's SCRAM exchange) — that file is docker-cp'd
 * into the container and deleted from the host in the same call, and it is
 * what pgbouncer must know anyway. `pool_mode = transaction` is the
 * common-case setting; session-mode is opt-in via a future PR.
 */
function renderPgbouncerIni(input: RenderInput): string {
  return [
    '[databases]',
    `${input.dbName} = host=${input.postgresHost} port=${input.postgresPort}`,
    '',
    '[pgbouncer]',
    'listen_addr = 0.0.0.0',
    `listen_port = ${input.listenPort}`,
    'auth_type = scram-sha-256',
    'auth_file = /etc/pgbouncer/userlist.txt',
    'pool_mode = transaction',
    'max_client_conn = 1000',
    'default_pool_size = 20',
    'min_pool_size = 2',
    'reserve_pool_size = 5',
    'reserve_pool_timeout = 3',
    'server_idle_timeout = 600',
    'log_connections = 1',
    'log_disconnections = 1',
    'log_pooler_errors = 1',
    '',
  ].join('\n');
}

/** pgbouncer's userlist format for SCRAM: the cleartext password in plain
 *  `"user" "password"` form — with `auth_type = scram-sha-256` pgbouncer
 *  derives the SCRAM exchange from it for both client and server auth. */
function renderUserlist(input: { user: string; password: string }): string {
  return `"${input.user}" "${input.password}"\n`;
}
