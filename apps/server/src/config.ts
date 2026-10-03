import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './env.js';
import { isPrivateAddress } from './lib/egressGuard.js';

/* v8 ignore start */
const here = path.dirname(fileURLToPath(import.meta.url));
// Locate monorepo root: THREE levels up from apps/server/{src,dist} (src →
// server → apps → root). Two levels pointed at `apps/`, whose package.json
// never exists — the branch was dead and the data dir silently followed the
// process cwd (a restart from a different cwd provisioned a fresh .data with
// a NEW master key, making every stored secret undecryptable).
const repoRoot = existsSync(path.resolve(here, '../../../package.json')) ? path.resolve(here, '../../..') : process.cwd();

/** Resolve a possibly-relative path against the repoRoot if not absolute. */
const resolve = (p: string) => (p.startsWith('file:') ? p : path.isAbsolute(p) ? p : path.resolve(repoRoot, p));
/* v8 ignore stop */

const dataDir = resolve(env.NINEDEPLOY_DATA_DIR);
mkdirSync(dataDir, { recursive: true });

const dbFile = resolve(env.NINEDEPLOY_DB_PATH);
const dbUrl = dbFile.startsWith('file:') ? dbFile : `file:${dbFile}`;

const reposDir = path.join(dataDir, 'repos');
const logsDir = path.join(dataDir, 'logs');
const backupsDir = path.join(dataDir, 'backups');
// The docker CLI's config dir (DOCKER_CONFIG). Under the hardened systemd
// unit /root is read-only, and modern buildx insists on writing builder
// activity files there — the panel points the CLI at this writable dir
// instead (systemd/ninedeploy.service exports the matching env var).
const dockerConfigDir = path.join(dataDir, 'docker-config');
// PM2_HOME for the same reason: the server persists the PM2 process list
// (dump.pm2) there, and ~/.pm2 resolves under the read-only /root.
const pm2Home = path.join(dataDir, 'pm2');
for (const dir of [reposDir, logsDir, backupsDir, dockerConfigDir, pm2Home]) mkdirSync(dir, { recursive: true });

export const config = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  host: env.NINEDEPLOY_HOST,
  port: env.NINEDEPLOY_PORT,
  publicUrl: env.NINEDEPLOY_PUBLIC_URL.replace(/\/+$/, ''),
  // Fastify trustProxy: see the NINEDEPLOY_TRUST_PROXY note in env.ts. "true"
  // trusts every hop, "false" none. Fastify (unlike Express) has no numeric
  // hop form, so a hop count N becomes a function trusting the first N hops —
  // and only hops on the host's own network (r100). The address used to be
  // ignored, so on a panel reached WITHOUT the bundled Traefik (dev compose,
  // NINEDEPLOY_BIND=0.0.0.0, bare metal) an internet client counted as the
  // trusted proxy, and a fresh fake X-Forwarded-For per request reset every
  // per-IP login / forgot-password bucket. A public peer is now never a proxy.
  trustProxy:
    env.NINEDEPLOY_TRUST_PROXY === 'true'
      ? true
      : env.NINEDEPLOY_TRUST_PROXY === 'false'
        ? false
        : (addr: string, hop: number) => {
          const n = Number(env.NINEDEPLOY_TRUST_PROXY);
          return !Number.isNaN(n) && hop < n && isPrivateAddress(addr);
        },
  paths: {
    dataDir,
    dbFile,
    reposDir,
    logsDir,
    backupsDir,
    dockerConfigDir,
    pm2Home,
    masterKeyFile: path.join(dataDir, 'master.key'),
  },
  dbUrl,
  jwt: {
    secret: env.NINEDEPLOY_JWT_SECRET,
    accessTtl: env.NINEDEPLOY_JWT_ACCESS_TTL,
    refreshTtl: env.NINEDEPLOY_JWT_REFRESH_TTL,
  },
  wildcardDomain: process.env['NINEDEPLOY_WILDCARD_DOMAIN'] ?? '',
  // When set, Traefik's ACME resolver issues real Let's Encrypt certificates
  // for domains with the SSL toggle enabled (null disables automatic HTTPS).
  acmeEmail: env.NINEDEPLOY_ACME_EMAIL ?? null,
  acmeCaServer: env.NINEDEPLOY_ACME_CA_SERVER ?? null,
  templatesSource: env.NINEDEPLOY_TEMPLATES_SOURCE ?? null,
  deployConcurrency: env.NINEDEPLOY_DEPLOY_CONCURRENCY,
  dnsProvider: env.NINEDEPLOY_DNS_PROVIDER ?? null,
  dnsToken: env.NINEDEPLOY_DNS_TOKEN ?? null,
  // JSON endpoint returning {"tag_name": "vX.Y.Z", ...} (GitHub Releases format).
  // Set NINEDEPLOY_UPDATE_CHECK_URL=disabled to turn update checks off.
  updateCheckUrl: env.NINEDEPLOY_UPDATE_CHECK_URL ?? 'https://api.github.com/repos/NineDeploy/NineDeploy/releases/latest',
  /** How many volume backups to keep per volume (1-100). */
  volumeBackupRetainCount: env.NINEDEPLOY_BACKUP_VOLUME_RETAIN_COUNT,
} as const;
