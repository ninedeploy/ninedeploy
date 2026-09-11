import { createReadStream, createWriteStream, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Database } from '@ninedeploy/db';
import { createBackupCipher, createBackupDecipher, decrypt } from '../lib/crypto.js';
import { ensureDockerImage, pullDockerImage } from '../lib/dockerPull.js';
import { capture, run } from '../lib/exec.js';
import { HELPER_IMAGE } from '../lib/inventory.js';
import { connectContainerToServiceBridge, ensureServiceBridge } from '../lib/serviceBridge.js';
import { writeSecretFile } from '../lib/secretFile.js';
import { NETWORK } from './proxy.js';

const swallow = () => {};
/** Static temp paths used inside managed containers for backup/restore staging. */
const DUMP_TMP = '/tmp/ninedeploy-dump';
const RESTORE_TMP = '/tmp/ninedeploy-restore';

/** Matches a versioned secret envelope ("v<ver>:…"). Backups written since the
 *  encryption change carry this prefix; anything else is a legacy plaintext dump. */
const ENVELOPE_RE = /^v\d+:/;
const STREAM_HEADER_PREFIX = 'NDBK1:';
const GCM_TAG_BYTES = 16;

/**
 * Encrypt a backup file in place (master-key envelope over base64-encoded dump
 * content — binary-safe). Plain dumps on disk would leak every DB credential
 * they contain to anyone who steals the data directory, defeating the at-rest
 * encryption of the credentials themselves.
 */
async function encryptFileInPlace(file: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.enc`;
  const { cipher, header } = createBackupCipher();
  const output = createWriteStream(tmp, { mode: 0o600 });
  let headerWritten = false;
  const envelope = new Transform({
    transform(chunk, _encoding, callback) {
      if (!headerWritten) {
        this.push(header);
        headerWritten = true;
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (!headerWritten) this.push(header);
      this.push(cipher.getAuthTag());
      callback();
    },
  });
  try {
    await pipeline(createReadStream(file), cipher, envelope, output);
    renameSync(tmp, file);
  } catch (error) {
    output.destroy();
    try { unlinkSync(tmp); } catch { /* absent */ }
    throw error;
  }
}

interface StreamBackupLayout {
  dataStart: number;
  dataEnd: number;
  header: string;
  authTag: Buffer;
}

async function streamBackupLayout(file: string): Promise<StreamBackupLayout | null> {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    const prefix = Buffer.alloc(Math.min(128, stat.size));
    await handle.read(prefix, 0, prefix.length, 0);
    const newline = prefix.indexOf(0x0a);
    if (newline < 0) return null;
    const header = prefix.subarray(0, newline + 1).toString('utf8');
    if (!header.startsWith(STREAM_HEADER_PREFIX) || stat.size < newline + 1 + GCM_TAG_BYTES) return null;
    const authTag = Buffer.alloc(GCM_TAG_BYTES);
    await handle.read(authTag, 0, GCM_TAG_BYTES, stat.size - GCM_TAG_BYTES);
    return { dataStart: newline + 1, dataEnd: stat.size - GCM_TAG_BYTES - 1, header, authTag };
  } finally {
    await handle.close();
  }
}

async function fileHead(file: string, bytes = 32): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const head = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(head, 0, bytes, 0);
    return head.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Plaintext backup stream for downloads; current backups never enter the heap. */
export async function createBackupReadStream(file: string): Promise<Readable> {
  const layout = await streamBackupLayout(file);
  if (layout) {
    return createReadStream(file, { start: layout.dataStart, end: layout.dataEnd })
      .pipe(createBackupDecipher(layout.header, layout.authTag));
  }
  const head = await fileHead(file);
  if (ENVELOPE_RE.test(head)) return Readable.from(readBackupBytes(file));
  return createReadStream(file);
}

/** Read a backup file and return its PLAINTEXT bytes (envelope-aware). */
export function readBackupBytes(file: string): Buffer {
  // Single read: legacy files are returned as their raw bytes; envelope files
  // are base64-decoded after decryption. (Full-file buffering is inherent to
  // the single-line envelope format; multi-GB dumps are handled by the
  // container-side dump + docker cp path, not by growing this buffer.)
  const raw = readFileSync(file);
  if (ENVELOPE_RE.test(raw.toString('utf8').slice(0, 32))) {
    return Buffer.from(decrypt(raw.toString('utf8')), 'base64');
  }
  return raw;
}

/**
 * Prepare a backup file for restore: encrypted backups are decrypted to a
 * sibling temp file; legacy plaintext files are used as-is. Returns the path to
 * feed to `docker cp` and a cleanup function.
 */
async function stageForRestore(file: string): Promise<{ path: string; cleanup: () => void }> {
  const layout = await streamBackupLayout(file);
  if (layout) {
    const dec = `${file}.${process.pid}.${Date.now()}.dec`;
    await pipeline(
      createReadStream(file, { start: layout.dataStart, end: layout.dataEnd }),
      createBackupDecipher(layout.header, layout.authTag),
      createWriteStream(dec, { mode: 0o600 }),
    );
    return { path: dec, cleanup: () => { try { unlinkSync(dec); } catch { /* gone */ } } };
  }
  const head = await fileHead(file);
  if (!ENVELOPE_RE.test(head)) return { path: file, cleanup: () => undefined };
  const dec = `${file}.dec`;
  writeFileSync(dec, readBackupBytes(file), { mode: 0o600 });
  return { path: dec, cleanup: () => { try { unlinkSync(dec); } catch { /* gone */ } } };
}

interface EngineConfig {
  image: (version?: string) => string;
  port: number;
  /** Container path the managed volume is mounted at. A function for engines
   *  whose layout depends on the resolved version (postgres 18+). */
  volumePath: string | ((version?: string) => string);
  /** The engine's data directory inside the container. Defaults to the mount
   *  path; postgres 18+ splits them (single mount at /var/lib/postgresql,
   *  data under /var/lib/postgresql/<major>/docker). */
  dataDir?: (version?: string) => string;
  env: (password: string) => Record<string, string>;
  /** Engines that cannot take a password via env vars (redis/valkey) get it
   *  as a `--requirepass` container-command argument instead. */
  authViaArg?: boolean;
  username: () => string | undefined;
  dbName: () => string | undefined;
  connectionString: (host: string, port: number, user: string, password: string, dbName: string | undefined) => string;
}

/** RFC-3986-encode a userinfo/password segment so special chars can't break (or inject into) the URI. */
function enc(segment: string): string {
  return encodeURIComponent(segment);
}

// ── postgres 18+ cluster layout ────────────────────────────────────────────
//
// The official postgres 18+ (and pgvector pg18) images moved the data
// directory to a major-version-specific path (/var/lib/postgresql/<major>/docker,
// pg_ctlcluster-compatible) and REFUSE to start when they detect the classic
// /var/lib/postgresql/data mount — which is exactly what every deploy here
// used to mount. The container then crash-loops, its DNS name never
// registers, and the attached app dies with `getaddrinfo EAI_AGAIN` against
// the database hostname. For 18+ the volume must be mounted ONCE at
// /var/lib/postgresql and the data lives in the versioned subdirectory
// (docker-library/postgres#1259). Older majors keep the classic layout.

const POSTGRES_DEFAULT_MAJOR = 18;

export function postgresMajor(version?: string | null): number {
  if (version === 'vector' || version === 'pgvector') return 18;
  const parsed = Number.parseInt(String(version ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : POSTGRES_DEFAULT_MAJOR;
}

function postgresClusterLayout(version?: string | null): boolean {
  return postgresMajor(version) >= 18;
}

/** Layout for a CONCRETE postgres image. The re-key sidecar must match the
 *  image that owns the volume's data (recorded in the volume label) — that
 *  can be an older major than the row's configured version. */
function postgresImageLayout(image: string, fallbackVersion?: string | null): { mount: string; dataDir: string } {
  const tag = image.slice(image.lastIndexOf(':') + 1);
  const pgMatch = tag.match(/^pg(\d+)/);
  const major = pgMatch ? Number.parseInt(pgMatch[1]!, 10) : postgresMajor(Number.isNaN(Number.parseInt(tag, 10)) ? fallbackVersion : tag);
  return major >= 18
    ? { mount: '/var/lib/postgresql', dataDir: `/var/lib/postgresql/${major}/docker` }
    : { mount: '/var/lib/postgresql/data', dataDir: '/var/lib/postgresql/data' };
}

/** Resolve the volume mount path for a database row's engine + version. */
export function resolveVolumePath(cfg: EngineConfig, version?: string | null): string {
  return typeof cfg.volumePath === 'function' ? cfg.volumePath(version ?? undefined) : cfg.volumePath;
}

/** Resolve the engine's in-container data directory (defaults to the mount path). */
export function resolveDataDir(cfg: EngineConfig, version?: string | null): string {
  return cfg.dataDir ? cfg.dataDir(version ?? undefined) : resolveVolumePath(cfg, version);
}

/**
 * Default image versions per engine. The user can override per-database by
 * setting the `version` field on the row, which is forwarded to the image
 * factory below (e.g. `mysql:${version || default}`). This keeps the platform
 * on the latest stable GA while leaving the door open for older / LTS
 * installs without any code change.
 *
 * The defaults below are the latest GA minors as of Aug 2026, pulled from
 * Docker Hub. They are updated when a new GA is released; integration tests
 * cover the same majors so a bump that breaks the test image fails CI.
 */
export const ENGINES: Record<string, EngineConfig> = {
  postgres: {
    image: (v) => (v === 'vector' || v === 'pgvector' ? 'pgvector/pgvector:pg18' : `postgres:${v || '18'}`),
    port: 5432,
    volumePath: (v) => (postgresClusterLayout(v) ? '/var/lib/postgresql' : '/var/lib/postgresql/data'),
    dataDir: (v) => (postgresClusterLayout(v) ? `/var/lib/postgresql/${postgresMajor(v)}/docker` : '/var/lib/postgresql/data'),
    env: (p) => ({ POSTGRES_USER: 'nine', POSTGRES_PASSWORD: p, POSTGRES_DB: 'app' }),
    username: () => 'nine',
    dbName: () => 'app',
    connectionString: (h, prt, u, p, d) => `postgres://${enc(u)}:${enc(p)}@${h}:${prt}/${d}`,
  },
  mysql: {
    // MySQL 9.7 is the current Innovation release (Jul 2026); pin to `8.4`
    // on a database row for the current LTS track.
    image: (v) => `mysql:${v || '9.7'}`,
    port: 3306,
    volumePath: '/var/lib/mysql',
    env: (p) => ({ MYSQL_ROOT_PASSWORD: p, MYSQL_DATABASE: 'app' }),
    username: () => 'root',
    dbName: () => 'app',
    connectionString: (h, prt, u, p, d) => `mysql://${enc(u)}:${enc(p)}@${h}:${prt}/${d ?? 'app'}`,
  },
  mariadb: {
    image: (v) => `mariadb:${v || '12.3'}`,
    port: 3306,
    volumePath: '/var/lib/mysql',
    env: (p) => ({ MARIADB_ROOT_PASSWORD: p, MARIADB_DATABASE: 'app' }),
    username: () => 'root',
    dbName: () => 'app',
    connectionString: (h, prt, u, p, d) => `mariadb://${enc(u)}:${enc(p)}@${h}:${prt}/${d ?? 'app'}`,
  },
  redis: {
    image: (v) => `redis:${v || '8.8'}`,
    port: 6379,
    volumePath: '/data',
    env: () => ({}),
    authViaArg: true,
    username: () => undefined,
    dbName: () => undefined,
    connectionString: (h, prt, _u, p) => `redis://:${enc(p)}@${h}:${prt}`,
  },
  valkey: {
    image: (v) => `valkey/valkey:${v || '9.1'}`,
    port: 6379,
    volumePath: '/data',
    env: () => ({}),
    authViaArg: true,
    username: () => undefined,
    dbName: () => undefined,
    connectionString: (h, prt, _u, p) => `valkey://:${enc(p)}@${h}:${prt}`,
  },
  mongo: {
    // Mongo 8.0 is the current GA track (8.3 is newer but still pre-LTS);
    // pin to `7.0` on a database row for the previous LTS.
    image: (v) => `mongo:${v || '8.0'}`,
    port: 27017,
    volumePath: '/data/db',
    env: (p) => ({ MONGO_INITDB_ROOT_USERNAME: 'nine', MONGO_INITDB_ROOT_PASSWORD: p }),
    username: () => 'nine',
    dbName: () => undefined,
    connectionString: (h, prt, u, p) => `mongodb://${enc(u)}:${enc(p)}@${h}:${prt}`,
  },
  clickhouse: {
    // 25.8.32.x is the current stable line (Aug 2026). The image was
    // mistakenly published as `26.7` in an earlier commit — that tag does
    // not exist on Docker Hub, so it would have failed every image pull.
    image: (v) => `clickhouse/clickhouse-server:${v || '25.8'}`,
    port: 8123,
    volumePath: '/var/lib/clickhouse',
    env: (p) => ({ CLICKHOUSE_USER: 'nine', CLICKHOUSE_PASSWORD: p, CLICKHOUSE_DB: 'app' }),
    username: () => 'nine',
    dbName: () => 'app',
    connectionString: (h, prt, u, p, d) => `clickhouse://${enc(u)}:${enc(p)}@${h}:${prt}/${d ?? 'default'}`,
  },
  meilisearch: {
    image: (v) => `getmeili/meilisearch:${v || 'v1.53'}`,
    port: 7700,
    volumePath: '/meili_data',
    env: (p) => ({ MEILI_MASTER_KEY: p, MEILI_NO_ANALYTICS: 'true' }),
    username: () => undefined,
    dbName: () => undefined,
    connectionString: (h, prt, _u, p) => `http://:${enc(p)}@${h}:${prt}`,
  },
  rabbitmq: {
    image: (v) => `rabbitmq:${v || '4-management'}`,
    port: 5672,
    volumePath: '/var/lib/rabbitmq',
    env: (p) => ({ RABBITMQ_DEFAULT_USER: 'nine', RABBITMQ_DEFAULT_PASS: p }),
    username: () => 'nine',
    dbName: () => undefined,
    connectionString: (h, prt, u, p) => `amqp://${enc(u)}:${enc(p)}@${h}:${prt}/`,
  },
};

/** Studio image for the given database engine.
 *
 *  Privileged third-party images are pinned to IMMUTABLE references — a
 *  floating `:latest` let a registry-tag compromise swap the image every
 *  studio start runs through (Redis Commander additionally holds live
 *  database credentials). The redis-commander ref is digest-pinned because
 *  the project publishes no version tags to Docker Hub; bump the digest
 *  deliberately (registry-1.docker.io manifest of `latest` as of 2026-09). */
export function studioImageForEngine(engine: string): { image: string; containerPort: number } {
  if (engine === 'redis' || engine === 'valkey') {
    return {
      image: 'rediscommander/redis-commander@sha256:19cd0c49f418779fa2822a0496c5e6516d0c792effc39ed20089e6268477e40a',
      containerPort: 8081,
    };
  }
  return { image: 'adminer:6.0.1', containerPort: 8080 };
}

/** Check if database studio container is running. */
export async function isDatabaseStudioRunning(d: Database): Promise<boolean> {
  const name = `nd-studio-${d.slug}`;
  return containerRunning(name);
}

/** Start database web studio container on shared network. */
export async function startDatabaseStudio(d: Database, port: number, log: (line: string) => void): Promise<void> {
  const name = `nd-studio-${d.slug}`;
  if (await containerRunning(name)) return;
  await run('docker', ['rm', '-f', name], {}, swallow).catch(() => undefined);
  const studio = studioImageForEngine(d.engine);
  log(`Preparing Web Studio image ${studio.image} …`);
  await ensureDockerImage(studio.image, log);
  const args = [
    'run', '-d', '--name', name, '--network', NETWORK, '--restart', 'unless-stopped',
    // Bind the Studio to LOOPBACK only. Adminer / Redis Commander speak plain
    // HTTP with no NineDeploy authentication in front of them, and Redis
    // Commander pre-holds the database's credentials — publishing them on all
    // interfaces turned every host port into an unauthenticated, network-
    // reachable database client. Loopback keeps the panel's iframe usable on
    // the host while closing the exposure to the outside network.
    '-p', `127.0.0.1:${port}:${studio.containerPort}`,
  ];
  if (d.engine === 'redis' || d.engine === 'valkey') {
    const host = d.internalHost || d.containerName || '';
    const redisPort = defaultPort(d.engine);
    // Managed Redis/Valkey always authenticates (a randomToken password on
    // the `default` ACL user), and REDIS_HOSTS cannot carry a password — the
    // studio would boot and list zero databases. Authenticated single
    // connections go through REDIS_URL instead; a passwordless instance
    // (local dev) keeps the simple host-list form.
    const password = d.passwordEncrypted ? decrypt(d.passwordEncrypted) : '';
    if (password) {
      args.push('-e', `REDIS_URL=redis://default:${encodeURIComponent(password)}@${encodeURIComponent(host)}:${redisPort}/0`);
    } else {
      args.push('-e', `REDIS_HOSTS=local:${host}:${redisPort}`);
    }
  }
  args.push(studio.image);
  log(`Starting Web Studio for ${d.name} on :${port} …`);
  await run('docker', args, {}, log);
}

/** Stop database web studio container. */
export async function stopDatabaseStudio(d: Database, log: (line: string) => void): Promise<void> {
  const name = `nd-studio-${d.slug}`;
  log(`Stopping Web Studio ${name} …`);
  await run('docker', ['rm', '-f', name], {}, swallow).catch(() => undefined);
}

/** Whether a container exists and is currently in the `running` state. */
export async function containerRunning(name: string): Promise<boolean> {
  try {
    const out = await capture('docker', ['inspect', name, '--format', '{{.State.Status}}']);
    return out.trim() === 'running';
  } catch {
    return false;
  }
}

/** Run a managed database container on the shared network with a persistent volume. */
export async function startDatabase(
  d: Database,
  log: (line: string) => void,
  opts: { labels?: Record<string, string> } = {},
): Promise<void> {
  const cfg = ENGINES[d.engine];
  if (!cfg) throw new Error(`Unknown engine: ${d.engine}`);
  if (!d.containerName || !d.volumeName) throw new Error('database has no container/volume name');

  // Idempotency: if the database is already running, do nothing (e.g. on server
  // restart). This avoids a `docker run` name-conflict failure.
  if (await containerRunning(d.containerName)) {
    log(`${d.containerName} already running — reusing`);
    return;
  }

  // Never let `docker run` perform an implicit pull. Docker 29/containerd can
  // fail that hidden pull with code 125 when overlayfs snapshot metadata is
  // stale; the shared pull helper detects and safely recovers that condition.
  const image = cfg.image(d.version ?? undefined);
  log(`Pulling database image ${image} …`);
  await pullDockerImage(image, log);

  // Ensure the volume exists BEFORE `docker run` so it can be stamped with its
  // provenance labels at creation: a volume implicitly created by `-v` would
  // come up anonymous of origin, and a retained volume must stay traceable to
  // the database that made it even after its row is deleted.
  if (await volumeExists(d.volumeName)) {
    log(`Reusing retained volume ${d.volumeName} (previous data restored)`);
  } else {
    await createDockerVolume(d.volumeName, log, databaseVolumeLabels(d, opts.labels));
  }

  // Remove any stale (stopped) container of the same name so `docker run` does
  // not fail with a name conflict; the retained volume preserves the data.
  await run('docker', ['rm', '-f', d.containerName], {}, swallow).catch(() => undefined);

  const password = decrypt(d.passwordEncrypted);
  const args = ['run', '-d', '--name', d.containerName, '--network', NETWORK, '--restart', 'unless-stopped'];
  if (d.cpuShares > 0) args.push('--cpu-shares', String(d.cpuShares));
  if (d.memLimitMb > 0) args.push('--memory', `${d.memLimitMb}m`);
  args.push('-v', `${d.volumeName}:${resolveVolumePath(cfg, d.version)}`);
  // Pass secrets via a 0600 env-file instead of `-e KEY=value` on the argv —
  // argv is visible to every local user via `ps`.
  const vars = cfg.env(password);
  const envFile = Object.keys(vars).length > 0
    ? writeSecretFile('nd-db', 'database.env', `${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n')}\n`)
    : null;
  if (envFile) args.push('--env-file', envFile.path);
  // redis/valkey have no password env var — the password is passed as the
  // container command's `--requirepass` argument (visible via docker inspect,
  // but the container refuses unauthenticated connections on the shared
  // network, closing the "any container can FLUSHALL" gap).
  if (cfg.authViaArg) args.push('--requirepass', password);
  args.push(image);

  log(`Starting ${d.engine} database ${d.name} (${d.containerName}) …`);
  let startFailed = false;
  let startError: unknown;
  try {
    await run('docker', args, {}, log);
  } catch (err) {
    startFailed = true;
    startError = err;
  } finally {
    envFile?.cleanup();
  }

  if (startFailed) {
    // Docker can return 125 after the daemon has already created and started
    // the container (for example when its response path races with containerd).
    // Reconcile against daemon state before reporting a false failure and
    // leaving the persisted DB row in `error`.
    if (await containerRunning(d.containerName)) {
      log(`${d.containerName} is running despite docker run failure — adopting it`);
      return;
    }
    throw startError;
  }
}

/**
 * Join a running managed database to the per-slug bridge of every service it
 * is attached to. The DB stays on the shared `ninedeploy` mesh as a baseline
 * (so the operator can still reach it for management even when no service is
 * up); the per-slug bridges are added on top.
 *
 * `serviceSlugs` should come from the caller's view of the database's
 * current attachments. Passing an empty array is a no-op.
 */
export async function attachDatabaseToServiceBridges(
  d: Database,
  serviceSlugs: string[],
  log: (line: string) => void,
): Promise<void> {
  if (!d.containerName || serviceSlugs.length === 0) return;
  for (const slug of serviceSlugs) {
    await ensureServiceBridge(slug, log);
    await connectContainerToServiceBridge(d.containerName, slug, log);
  }
}

/** Whether a named Docker volume exists. */
export async function volumeExists(name: string): Promise<boolean> {
  try {
    const out = await capture('docker', ['volume', 'inspect', name]);
    return !out.includes('No such volume');
  } catch {
    return false;
  }
}

// ── retained-volume provenance + adoption ──────────────────────────────────
//
// A database volume intentionally outlives its Hub row (deleting a database
// keeps the data). That retention has a sharp edge: engines that store
// credentials INSIDE the data directory (postgres, mysql, mongo, …) only honor
// POSTGRES_PASSWORD-style env vars during FIRST initialization, so a new row
// remounting a retained volume boots a server whose real password belongs to
// the deleted installation. The app then crash-loops on auth failures and the
// deploy dies at its healthcheck with no hint why. These helpers make the
// retained volume traceable (labels) and re-keyable (per-engine reset) so a
// redeploy over old data either works or explains itself.

/** Label namespace stamped on managed database volumes at creation. */
const MANAGED_VOLUME_LABEL = 'ninedeploy.managed';

/** Labels describing the database that created a volume. `extra` carries
 *  caller-specific provenance (e.g. the provisioning template id). */
function databaseVolumeLabels(d: Database, extra: Record<string, string> = {}): Record<string, string> {
  const cfg = ENGINES[d.engine];
  if (!cfg) throw new Error(`Unknown engine: ${d.engine}`);
  return {
    [MANAGED_VOLUME_LABEL]: 'database',
    'ninedeploy.database.slug': d.slug,
    'ninedeploy.database.name': d.name,
    'ninedeploy.database.engine': d.engine,
    // The exact image that initialized the cluster: maintenance sidecars must
    // match the data directory's major version, not today's default.
    'ninedeploy.database.image': cfg.image(d.version ?? undefined),
    'ninedeploy.database.container': d.containerName ?? '',
    'ninedeploy.owner': String(d.ownerUserId ?? ''),
    ...extra,
  };
}

/** Read a volume's labels; `{}` when the volume is absent or unlabeled. */
export async function volumeLabels(name: string): Promise<Record<string, string>> {
  try {
    const out = await capture('docker', ['volume', 'inspect', '--format', '{{json .Labels}}', name]);
    const parsed = JSON.parse(out.trim()) as Record<string, string> | null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Engines whose credentials live outside the data directory: the volume can
 *  be remounted under a new row with no re-key step at all. */
const CREDENTIALS_OUTSIDE_VOLUME = new Set(['redis', 'valkey']);
/** Engines with an implemented automatic credential re-key (see below). */
const REKEYABLE = new Set(['postgres']);

/** Human-readable origin of a retained volume for error messages. */
function volumeProvenance(labels: Record<string, string>): string {
  if (labels[MANAGED_VOLUME_LABEL] !== 'database') return '';
  const name = labels['ninedeploy.database.name'] ?? labels['ninedeploy.database.slug'];
  const engine = labels['ninedeploy.database.engine'];
  return ` (previously ${name ? `"${name}"` : 'a NineDeploy database'}${engine ? `, ${engine}` : ''})`;
}

/**
 * Re-key a retained postgres data directory to `password` WITHOUT knowing the
 * old credentials: a throwaway sidecar running the cluster's own image opens
 * the data directory in single-user mode and rewrites the role's password.
 * Single-user mode bypasses pg_hba authentication entirely, which is the point
 * — the old password is exactly what nobody has anymore. The session ends at
 * EOF, so success is verified by a follow-up catalog probe keyed to the ALTER
 * itself (single-user mode reports statement errors without failing the
 * process, so an unverified exit code would silently succeed).
 */
async function resetPostgresVolumePassword(
  d: Database,
  image: string,
  log: (line: string) => void,
): Promise<void> {
  const cfg = ENGINES.postgres;
  if (!cfg) throw new Error('postgres engine config missing');
  const password = decrypt(d.passwordEncrypted);
  const user = cfg.username()!;
  // Two single quotes escape one inside a SQL string literal; the passwords
  // this Hub generates are base64url anyway, so this is belt-and-braces.
  const sqlPassword = password.replace(/'/g, "''");
  const sql = [
    `ALTER ROLE ${user} WITH PASSWORD '${sqlPassword}' VALID UNTIL 'infinity';`,
    `SELECT 'NINEDEPLOY_REKEY_OK' FROM pg_roles WHERE rolname = '${user}' AND rolvaliduntil = 'infinity'::timestamptz;`,
    '\\q',
  ].join('\n');
  await ensureDockerImage(image, log);
  // The sidecar image comes from the volume's provenance label — it can be an
  // older major than the row's configured version, and the data directory must
  // match the IMAGE's layout (postgres 18+ moved it under /var/lib/postgresql).
  const { mount: mountPath, dataDir } = postgresImageLayout(image, d.version);
  log(`Re-keying retained volume ${d.volumeName} (${user} @ ${image}) …`);
  const out = await capture(
    'docker',
    ['run', '--rm', '-i', '-v', `${d.volumeName}:${mountPath}`, image, 'postgres', '--single', '-D', dataDir, 'postgres'],
    { timeoutMs: 300_000, heartbeatMs: 20_000, heartbeatLabel: `Re-keying retained volume ${d.volumeName}`, onProgress: log },
    Buffer.from(`${sql}\n`),
  );
  if (!out.includes('NINEDEPLOY_REKEY_OK')) {
    throw new Error(`the verification probe did not confirm the new password (sidecar output: ${out.trim().slice(-400) || 'empty'})`);
  }
}

export type RetainedVolumeAdoption = { action: 'fresh' | 'rekeyed' | 'no-rekey-needed' };

/**
 * Whether starting `d` could still mount a volume whose credentials belong to
 * someone else. The marker `initializedAt` retires the gate: it is stamped
 * once THIS row's start has been made consistent with the volume's contents,
 * so a failed first attempt (the row flips to 'error', marker stays NULL)
 * retries the adoption on the next deploy instead of silently booting the
 * deleted installation's credentials. Healthy 'running'/'stopped' rows —
 * including pre-marker rows that have always owned their volume — skip the
 * gate so restarts never trip the non-rekeyable-engine refusal.
 */
export function needsVolumeAdoption(d: Pick<Database, 'status' | 'initializedAt'>): boolean {
  return d.initializedAt == null && (d.status === 'creating' || d.status === 'error');
}

/**
 * Prepare a retained volume under `d.volumeName` for a BRAND-NEW database row.
 * Callers must invoke this right after inserting the fresh row (whose password
 * is what the app will receive) and before `startDatabase`. Without it, the
 * reinstall-over-old-data case boots a server re-keyed to a password the
 * deleted installation owned and the deployment dies at its healthcheck.
 *
 * Refuses — with the volume's provenance — what cannot be made consistent:
 * another engine's data directory, or engines with no re-key implementation.
 */
export async function adoptRetainedVolume(
  d: Database,
  log: (line: string) => void,
): Promise<RetainedVolumeAdoption> {
  if (!d.volumeName || !(await volumeExists(d.volumeName))) return { action: 'fresh' };

  const labels = await volumeLabels(d.volumeName);
  const provenance = volumeProvenance(labels);
  const labeledEngine = labels['ninedeploy.database.engine'];
  if (labeledEngine && labeledEngine !== d.engine) {
    throw new Error(
      `Retained volume "${d.volumeName}" holds ${labeledEngine} data${provenance}, not ${d.engine} — pick a different database name or delete the volume`,
    );
  }

  if (CREDENTIALS_OUTSIDE_VOLUME.has(d.engine)) {
    log(`Retained volume ${d.volumeName} reused — ${d.engine} credentials live on the container, nothing to re-key`);
    return { action: 'no-rekey-needed' };
  }

  if (!REKEYABLE.has(d.engine)) {
    throw new Error(
      `Retained volume "${d.volumeName}" still holds ${d.engine} data${provenance} whose credentials NineDeploy cannot re-key automatically. Starting it would boot a server no app can authenticate to. Delete the volume to start fresh (Volumes panel, or \`docker volume rm ${d.volumeName}\`), or point this database at a different volume`,
    );
  }

  const clusterImage = labels['ninedeploy.database.image'] ?? ENGINES.postgres?.image(d.version ?? undefined) ?? 'postgres';
  try {
    await resetPostgresVolumePassword(d, clusterImage, log);
  } catch (err) {
    throw new Error(
      `Retained volume "${d.volumeName}" holds postgres data${provenance} but re-keying it failed: ${err instanceof Error ? err.message : err}. The data directory may come from an incompatible postgres major (the attempt used ${clusterImage}). Delete the volume to start fresh (Volumes panel, or \`docker volume rm ${d.volumeName}\`)`,
    );
  }
  return { action: 'rekeyed' };
}


/** Stop + remove the database container, but KEEP its volume so data survives. */
export async function stopDatabase(d: Database, log: (line: string) => void): Promise<void> {
  if (d.containerName) {
    log(`Stopping ${d.containerName} (volume retained) …`);
    await run('docker', ['rm', '-f', d.containerName], {}, () => {}).catch(() => undefined);
  }
}

/** Permanently delete a named volume (destructive — the real cleanup). */
export async function removeVolume(name: string, log: (line: string) => void): Promise<void> {
  log(`Deleting volume ${name} …`);
  await run('docker', ['volume', 'rm', name], {}, log).catch(() => undefined);
}

// ── managed volume snapshot / restore ─────────────────────────────────────
//
// A named Docker volume can only be read through a container that mounts it:
// the panel may itself be containerised and has no path to the daemon's
// storage directory. These helpers therefore create a throwaway sidecar,
// tar inside it, and move the archive across with `docker cp` — the same
// shape the database dump/restore paths above already use, and the reason
// neither side bind-mounts a host directory (which would have to be resolvable
// by the daemon rather than by this process).

/** Sidecar image for the tar work. Same PINNED tag the rest of the volume
 *  tooling already prepares (see lib/inventory HELPER_IMAGE), so the pull is
 *  usually a no-op and the tag cannot float under us. */
const VOLUME_TAR_IMAGE = HELPER_IMAGE;
/** Archive path inside the sidecar. */
const VOLUME_TMP_ARCHIVE = '/tmp/ninedeploy-volume.tar.gz';

/** Create a named Docker volume. Idempotent: `docker volume create` returns the
 *  existing volume unchanged when the name is already taken (labels are only
 *  applied at creation — Docker has no post-hoc volume label update). */
export async function createDockerVolume(
  name: string,
  log: (line: string) => void = swallow,
  labels: Record<string, string> = {},
): Promise<void> {
  log(`Creating volume ${name} …`);
  const args = ['volume', 'create'];
  for (const [key, value] of Object.entries(labels)) {
    if (value !== '') args.push('--label', `${key}=${value}`);
  }
  args.push(name);
  await run('docker', args, {}, log);
}

/** Snapshot a named volume into a gzipped tarball on the host. */
export async function backupVolume(
  name: string,
  destFile: string,
  log: (line: string) => void,
): Promise<void> {
  await ensureDockerImage(VOLUME_TAR_IMAGE, log);
  log(`Snapshotting volume ${name} …`);
  const cid = (
    await capture('docker', [
      'create',
      '-v', `${name}:/v:ro`,
      VOLUME_TAR_IMAGE,
      'tar', '-czf', VOLUME_TMP_ARCHIVE, '-C', '/v', '.',
    ])
  ).trim();
  try {
    await run('docker', ['start', '-a', cid], {}, log);
    await run('docker', ['cp', `${cid}:${VOLUME_TMP_ARCHIVE}`, destFile], {}, log);
  } finally {
    await run('docker', ['rm', '-f', cid], {}, swallow).catch(() => undefined);
  }
  log(`Snapshot written to ${destFile}`);
}

/**
 * Restore a gzipped tarball back into a named volume.
 *
 * The volume is emptied first. Extracting over the existing contents would
 * merge the two, silently keeping files the snapshot does not contain and
 * leaving the volume in a state that never existed.
 */
export async function restoreVolume(
  name: string,
  srcFile: string,
  log: (line: string) => void,
): Promise<void> {
  await ensureDockerImage(VOLUME_TAR_IMAGE, log);
  log(`Restoring volume ${name} …`);
  const cid = (
    await capture('docker', [
      'create',
      '-v', `${name}:/v`,
      VOLUME_TAR_IMAGE,
      'sh', '-c',
      `rm -rf /v/..?* /v/.[!.]* /v/* 2>/dev/null; tar -xzf ${VOLUME_TMP_ARCHIVE} -C /v`,
    ])
  ).trim();
  try {
    await run('docker', ['cp', srcFile, `${cid}:${VOLUME_TMP_ARCHIVE}`], {}, log);
    await run('docker', ['start', '-a', cid], {}, log);
  } finally {
    await run('docker', ['rm', '-f', cid], {}, swallow).catch(() => undefined);
  }
  log(`Volume ${name} restored`);
}

/** Build the connection string a service uses to reach this database. */
export function connectionString(d: Database): string {
  const cfg = ENGINES[d.engine];
  if (!cfg) throw new Error(`Unknown engine: ${d.engine}`);
  const password = decrypt(d.passwordEncrypted);
  const user = cfg.username() ?? '';
  return cfg.connectionString(d.internalHost ?? d.containerName ?? '', d.internalPort ?? cfg.port, user, password, cfg.dbName());
}

export const defaultPort = (engine: string): number => ENGINES[engine]?.port ?? 0;

// ── storage + backup / restore ────────────────────────────────────────────

/** Live on-disk size of a managed database (bytes), via engine-specific query. */
export async function databaseSize(d: Database): Promise<number> {
  const cfg = ENGINES[d.engine];
  if (!cfg || !d.containerName) return 0;
  try {
    if (d.engine === 'postgres') {
      const out = await capture('docker', ['exec', d.containerName, 'psql', '-U', cfg.username()!, '-d', cfg.dbName()!, '-tAc', "SELECT pg_database_size(current_database())"]);
      return Number(out.trim()) || 0;
    }
    if (d.engine === 'redis' || d.engine === 'valkey') {
      const pass = decrypt(d.passwordEncrypted);
      const out = await capture('docker', ['exec', d.containerName, 'redis-cli', '-a', pass, '--no-auth-warning', 'INFO', 'memory']);
      const m = /used_memory:(\d+)/.exec(out);
      return m ? Number(m[1]) : 0;
    }
    if (d.engine === 'mysql' || d.engine === 'mariadb') {
      const pass = decrypt(d.passwordEncrypted);
      const client = d.engine === 'mysql' ? 'mysql' : 'mariadb';
      const out = await capture('docker', [
        'exec', d.containerName, client, '-uroot', `--password=${pass}`, '-N',
        '-e', 'SELECT IFNULL(SUM(data_length+index_length),0) FROM information_schema.tables',
      ]);
      return Number(out.trim()) || 0;
    }
    if (d.engine === 'mongo') {
      // Managed mongo always has a root user (MONGO_INITDB_ROOT_*), so the
      // stats command needs the same credentials the dump/restore paths use —
      // an unauthenticated dbStats is rejected and the size silently reads 0.
      const pass = decrypt(d.passwordEncrypted);
      const out = await capture('docker', [
        'exec', d.containerName, 'mongosh',
        '-u', cfg.username()!, '-p', pass, '--authenticationDatabase', 'admin',
        '--quiet', '--eval', 'db.getSiblingDB("app").stats().dataSize',
      ]);
      return Number(out.match(/[\d.]+/)?.[0]) || 0;
    }
  } catch {
    /* engine not ready yet */
  }
  return 0;
}

/**
 * Dump a managed database to `file` (host path). Implemented with arg arrays +
 * `docker cp` only — never a host `sh -c` — so a crafted password or path can
 * never break out into shell execution. Passwords travel as a docker argv
 * `--password=` value (visible to a local admin via `docker inspect`, but not
 * shell-injectable) rather than an interpolated shell string.
 */
export async function backupDatabase(d: Database, file: string, log: (line: string) => void): Promise<void> {
  const cfg = ENGINES[d.engine];
  if (!cfg || !d.containerName) throw new Error('database not runnable');
  const cn = d.containerName;
  if (d.engine === 'postgres') {
    // Dump to a file INSIDE the container, then `docker cp` it out — the
    // whole dump never sits in this process's memory (a `capture`d stdout
    // string would OOM the server on large databases).
    await run('docker', ['exec', cn, 'pg_dump', '-U', cfg.username()!, '-d', cfg.dbName()!, `--file=${DUMP_TMP}`], {}, log);
    await run('docker', ['cp', `${cn}:${DUMP_TMP}`, file], {}, log);
    await run('docker', ['exec', cn, 'rm', '-f', DUMP_TMP], {}, swallow);
  } else if (d.engine === 'mysql' || d.engine === 'mariadb') {
    const pass = decrypt(d.passwordEncrypted);
    const dumper = d.engine === 'mysql' ? 'mysqldump' : 'mariadb-dump';
    // --single-transaction: InnoDB dumps run inside one consistent snapshot
    // instead of taking per-table locks — without it a scheduled backup blocks
    // writes on the live databases it is supposed to protect, and a multi-DB
    // dump is not even a point-in-time-consistent restore. --quick streams
    // row-by-row instead of buffering each table.
    await run('docker', ['exec', cn, dumper, '-uroot', `--password=${pass}`, '--single-transaction', '--quick', '--all-databases', `--result-file=${DUMP_TMP}`], {}, log);
    await run('docker', ['cp', `${cn}:${DUMP_TMP}`, file], {}, log);
    await run('docker', ['exec', cn, 'rm', '-f', DUMP_TMP], {}, swallow);
  } else if (d.engine === 'redis' || d.engine === 'valkey') {
    const pass = decrypt(d.passwordEncrypted);
    await run('docker', ['exec', cn, 'redis-cli', '-a', pass, '--no-auth-warning', 'SAVE'], {}, log);
    await run('docker', ['cp', `${cn}:/data/dump.rdb`, file], {}, log);
  } else if (d.engine === 'mongo') {
    // mongodump can write its binary archive straight to a file via
    // --archive=<path> — no shell, no stdout plumbing. Auth is mandatory (the
    // container is initialized with a root user), so credentials travel via
    // argv exactly like the mysqldump path.
    const pass = decrypt(d.passwordEncrypted);
    await run('docker', [
      'exec', cn, 'mongodump',
      '-u', cfg.username()!, '-p', pass, '--authenticationDatabase', 'admin',
      `--archive=${DUMP_TMP}`, '--gzip',
    ], {}, log);
    await run('docker', ['cp', `${cn}:${DUMP_TMP}`, file], {}, log);
    await run('docker', ['exec', cn, 'rm', '-f', DUMP_TMP], {}, swallow);
  } else {
    throw new Error(`backup not supported for ${d.engine}`);
  }
  // Everything on disk is encrypted with the master key: a stolen data dir
  // must not leak the (otherwise encrypted-at-rest) DB credentials via dumps.
  await encryptFileInPlace(file);
}

/**
 * Restore a managed database from `file` (host path). The dump is copied into
 * the container at a static temp path, restored via a file-reading flag, then
 * removed — no host shell, no stdin plumbing, no interpolation. Encrypted
 * backups are transparently decrypted to a temp sibling first; legacy
 * plaintext backups (pre-encryption) restore as-is.
 */
export async function restoreDatabase(d: Database, file: string, log: (line: string) => void): Promise<void> {
  const cfg = ENGINES[d.engine];
  if (!cfg || !d.containerName) throw new Error('database not runnable');
  const cn = d.containerName;
  // Validate the engine BEFORE touching the filesystem so an unsupported engine
  // fails with the right error even for a nonexistent path.
  if (
    d.engine !== 'postgres' &&
    d.engine !== 'mysql' &&
    d.engine !== 'mariadb' &&
    d.engine !== 'mongo' &&
    d.engine !== 'redis' &&
    d.engine !== 'valkey'
  ) {
    throw new Error(`restore not supported for ${d.engine}`);
  }

  const staged = await stageForRestore(file);
  try {
    if (d.engine === 'redis' || d.engine === 'valkey') {
      // Stop BEFORE copying: a graceful redis shutdown SAVEs the in-memory
      // dataset to dump.rdb, so a copy-then-restart order lets the dying
      // process overwrite the backup we just staged — the "restored" server
      // then reloads its own old data. Stop first so nothing can rewrite it.
      await run('docker', ['stop', cn], {}, log);
      await run('docker', ['cp', staged.path, `${cn}:/data/dump.rdb`], {}, log);
      await run('docker', ['start', cn], {}, log);
    } else {
      await run('docker', ['cp', staged.path, `${cn}:${RESTORE_TMP}`], {}, log);
      if (d.engine === 'postgres') {
        // ON_ERROR_STOP: bare `psql -f` continues past statement errors and
        // still exits 0, which would report a partially-applied dump as a
        // successful restore.
        await run('docker', ['exec', cn, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', cfg.username()!, '-d', cfg.dbName()!, '-f', RESTORE_TMP], {}, log);
      } else if (d.engine === 'mysql' || d.engine === 'mariadb') {
        const pass = decrypt(d.passwordEncrypted);
        const client = d.engine === 'mysql' ? 'mysql' : 'mariadb';
        await run('docker', ['exec', cn, client, '-uroot', `--password=${pass}`, '-e', `source ${RESTORE_TMP}`], {}, log);
      } else {
        // mongo
        const pass = decrypt(d.passwordEncrypted);
        await run(
          'docker',
          [
            'exec',
            cn,
            'mongorestore',
            '-u',
            cfg.username()!,
            '-p',
            pass,
            '--authenticationDatabase',
            'admin',
            `--archive=${RESTORE_TMP}`,
            '--gzip',
            '--drop',
          ],
          {},
          log,
        );
      }
    }
  } finally {
    staged.cleanup();
    if (d.engine !== 'redis' && d.engine !== 'valkey') {
      await run('docker', ['exec', cn, 'rm', '-f', RESTORE_TMP], {}, swallow).catch(() => undefined);
    }
  }
}

/** Restart an existing database container. */
export async function restartDatabase(d: Database, log: (line: string) => void): Promise<void> {
  if (!d.containerName) throw new Error('database not runnable');
  await run('docker', ['restart', d.containerName], {}, log);
}

/** Fetch recent logs from the database container. */
export async function databaseLogs(d: Database, lines = 100): Promise<string[]> {
  if (!d.containerName) return [];
  try {
    const raw = await capture('docker', ['logs', '--tail', String(lines), d.containerName]);
    return raw.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
