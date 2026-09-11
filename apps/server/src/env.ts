import 'dotenv/config';
import { z } from 'zod';

/** The insecure dev-only JWT secret. Never permitted in production. */
export const INSECURE_JWT_SECRET = 'dev-insecure-secret-change-me';

/** Well-known placeholders that must never be accepted in production. */
const KNOWN_INSECURE_JWT_SECRETS = new Set([
  INSECURE_JWT_SECRET,
  // The value shipped in .env.example — a user copying it verbatim with
  // NODE_ENV=production would otherwise boot with a publicly known secret.
  'change-me-to-a-long-random-string',
]);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  NINEDEPLOY_HOST: z.string().default('0.0.0.0'),
  NINEDEPLOY_PORT: z.coerce.number().int().positive().default(3000),
  NINEDEPLOY_DATA_DIR: z.string().default('./.data'),
  NINEDEPLOY_DB_PATH: z.string().default('./.data/ninedeploy.db'),
  NINEDEPLOY_PUBLIC_URL: z.url().default('http://localhost:3000'),
  // Trust the reverse proxy for client IP derivation (Fastify trustProxy).
  // Every standard install fronts the panel with its own Traefik, so the
  // default trusts ONE hop — without it every rate-limit bucket and audit row
  // collapses onto the proxy's container IP. A hop count only ever trusts
  // loopback/private peers (config.ts, r100), so a directly-connected internet
  // client's X-Forwarded-For is ignored even with the default. Set "false" to
  // trust no proxy at all (e.g. untrusted clients on the same LAN), or a
  // larger hop count when extra proxies sit in front of Traefik.
  NINEDEPLOY_TRUST_PROXY: z
    .string()
    .regex(/^(true|false|\d+)$/, 'must be "true", "false" or a hop count')
    .default('1'),
  NINEDEPLOY_JWT_SECRET: z.string().min(16).default(INSECURE_JWT_SECRET),
  NINEDEPLOY_JWT_ACCESS_TTL: z.string().default('15m'),
  NINEDEPLOY_JWT_REFRESH_TTL: z.string().default('7d'),
  NINEDEPLOY_MASTER_KEY: z.string().optional(),
  // Let's Encrypt registration email — enables automatic HTTPS (Traefik ACME).
  NINEDEPLOY_ACME_EMAIL: z.string().optional(),
  // ACME directory URL override. Point at Let's Encrypt's STAGING endpoint
  // while testing to avoid the production rate limits:
  // https://acme-staging-v02.api.letsencrypt.org/directory
  NINEDEPLOY_ACME_CA_SERVER: z.string().optional(),
  // Template registry source override: an https URL or an absolute path to a
  // JSON registry bundle. Falls back to the bundled registry when unset.
  NINEDEPLOY_TEMPLATES_SOURCE: z.string().optional(),
  // ACME DNS-01 challenge (wildcard certificates). DB settings win over these.
  NINEDEPLOY_DNS_PROVIDER: z.string().optional(),
  NINEDEPLOY_DNS_TOKEN: z.string().optional(),
  // How many deployments the worker processes in parallel (1-8). The same
  // service is never deployed concurrently regardless of this value.
  NINEDEPLOY_DEPLOY_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  // Update-check source: a JSON endpoint returning {"tag_name": "vX.Y.Z", ...}
  // (GitHub Releases format). Defaults to the NineDeploy releases feed; set to
  // "disabled" to turn update checks off (air-gapped instances).
  NINEDEPLOY_UPDATE_CHECK_URL: z.string().optional(),
  // Number of volume backups to keep per volume (1-100). Older backups
  // (file + DB row) are pruned automatically after each successful backup.
  NINEDEPLOY_BACKUP_VOLUME_RETAIN_COUNT: z.coerce.number().int().min(1).max(100).default(10),
});

export type Env = z.infer<typeof schema>;

function parseEnv(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('❌ Invalid environment variables:\n', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  // Hard guard: the publicly-known default JWT secret would let anyone forge
  // tokens, so refuse to boot in production with it still in place. (Only
  // evaluated on a successful parse; on failure we already exited above.)
  if (parsed.success && parsed.data.NODE_ENV === 'production' && KNOWN_INSECURE_JWT_SECRETS.has(parsed.data.NINEDEPLOY_JWT_SECRET)) {
    // eslint-disable-next-line no-console
    console.error(
      '❌ NINEDEPLOY_JWT_SECRET must be set to a strong, unique secret in production. The insecure default is not allowed.',
    );
    process.exit(1);
  }
  // Same class of guard for the master key: a weak/short hex value (or a
  // placeholder copied from .env.example) would leave every stored secret
  // decryptable by anyone who knows it. Auto-generated master.key files are
  // fine — only an explicitly configured weak value is rejected.
  if (parsed.success && parsed.data.NODE_ENV === 'production') {
    // Both key sources are checked. NINEDEPLOY_MASTER_KEYS (the rotation
    // key-ring, read straight from process.env by lib/crypto.ts) previously
    // skipped this guard entirely, so an operator could rotate ONTO a weak key
    // and get no warning.
    const candidates: Array<[string, string]> = [];
    if (parsed.data.NINEDEPLOY_MASTER_KEY) {
      candidates.push(['NINEDEPLOY_MASTER_KEY', parsed.data.NINEDEPLOY_MASTER_KEY]);
    }
    for (const pair of (process.env['NINEDEPLOY_MASTER_KEYS'] ?? '').split(',')) {
      const sep = pair.indexOf(':');
      if (sep < 0) continue;
      candidates.push([`NINEDEPLOY_MASTER_KEYS version ${pair.slice(0, sep).trim()}`, pair.slice(sep + 1).trim()]);
    }
    for (const [label, key] of candidates) {
      // A real 32-byte hex key is 64 chars; `0`-only and placeholder values are
      // the failure modes actually seen in the wild. (The previous regex here
      // was `/^[0a-f]+$/i`, which reads as "all hex" but matches only the
      // characters 0 and a-f — a random key containing 1-9 slipped past it.)
      const weak =
        key.length < 64 ||
        !/^[0-9a-f]+$/i.test(key) ||
        /^0+$/.test(key) ||
        /change[-_]?me/i.test(key);
      if (weak) {
        // eslint-disable-next-line no-console
        console.error(
          `❌ ${label} must be a strong 32-byte hex secret (64 hex chars) in production. The configured value is too weak.`,
        );
        process.exit(1);
      }
    }
  }
  return parsed.data;
}

export const env = parseEnv();
