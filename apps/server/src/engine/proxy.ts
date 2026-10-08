import { hostPathFor } from '../lib/hostPath.js';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { domains, serviceTargets, servers, services, type DB } from '@ninedeploy/db';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { capture, run, sleep } from '../lib/exec.js';
import { getSettingString } from '../lib/settings.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { ensureDockerImage } from '../lib/dockerPull.js';
import { hostsCollide, wwwCompanionHost } from '../lib/domainVerification.js';
import { hashBasicAuthEntry, parseBasicAuth } from '../lib/htpasswd.js';
import { reapTraefikNetworks } from '../lib/serviceBridge.js';
import {
  TRAFFIC_LOG_CONTAINER_DIR,
  TRAFFIC_LOG_FILE,
  trafficAnalyticsEnabled,
  trafficLogDir,
} from '../lib/trafficAnalytics.js';
import {
  cachedCustomCertificates,
  certificateHostnames,
  certificatesCovering,
  hostsFullyCovered,
  type LoadedCertificate,
  refreshCustomCertificates,
  renderCertificateEntries,
  servableCertificates,
} from '../lib/customCertificates.js';
import { MAX_REPLICAS, NETWORK, replicaNames, TRAEFIK_CONTAINER, TRAEFIK_IMAGE } from './dockerNames.js';

// Defined in a leaf module and re-exported here: `proxy` and `serviceBridge`
// import each other, and a constant declared in one of them is in its temporal
// dead zone for the other. See engine/dockerNames.ts.
export { NETWORK, TRAEFIK_CONTAINER, TRAEFIK_IMAGE } from './dockerNames.js';
// r636: the parser moved next to the hashing it now feeds; kept exported here.
export { parseBasicAuth } from '../lib/htpasswd.js';

/**
 * Whitelists for Traefik rule operands. Hostnames may contain DNS chars plus a
 * leading wildcard (`*.example.com`); paths may contain URL-safe chars. Anything
 * else — backticks, `)`, newlines, braces — is stripped so a crafted hostname or
 * path can never break out of the `Host(...)`/`PathPrefix(...)` rule or inject
 * arbitrary YAML into the dynamic config.
 */
const HOST_RE = /[^A-Za-z0-9.\-*]/g;
const PATH_RE = /[^A-Za-z0-9.\-/_]/g;

/**
 * Explicit priority for the dashboard's own router.
 *
 * Traefik's default priority is the rule's length, so any service router with a
 * longer rule on the panel hostname would silently win. Well above any rule a
 * hostname + path could produce (a 253-char host plus a path is still far short
 * of this), so the control plane always keeps its own domain.
 */
const PANEL_ROUTER_PRIORITY = 100_000;

/**
 * F521: base priority for an exact-host router that a rendered wildcard also
 * covers. Left at the default (the rule's length), `HostRegexp(...example\.com$)`
 * out-ranks `Host(admin.example.com)` and takes all of its traffic, past its
 * basicAuth / ipAllowList. Above any wildcard rule (host ≤ 253, path ≤ 200 at
 * the schema boundary) and, plus the exact rule's length, below the panel's.
 */
const EXACT_OVER_WILDCARD_PRIORITY = 10_000;

/**
 * r637: the one middleware every plain-HTTP twin of an SSL router uses. Not
 * permanent: a 301/308 is cached by browsers for good, and turning a
 * domain's SSL toggle off must take effect.
 */
const HTTPS_REDIRECT_MW = 'mw_https_redirect';

/**
 * r630: rows the proxy refuses to render, keyed `<id>:<hostname>`. The render
 * runs on every deploy and routing change, so each refusal is audited once
 * per process rather than once per write.
 */
const renderRefusalsAudited = new Set<string>();

function auditRenderRefusal(db: DB, d: { id: number; serviceId: number; hostname: string | null }, reason: string): void {
  const key = `${d.id}:${d.hostname ?? ''}`;
  if (renderRefusalsAudited.has(key)) return;
  renderRefusalsAudited.add(key);
  void audit(db, null, 'domain.render_skipped', String(d.hostname ?? `#${d.id}`).slice(0, 253), {
    domainId: d.id,
    serviceId: d.serviceId,
    reason,
  });
}

/** Atomically replace `file`'s contents: write to a sibling temp file then rename. */
function writeAtomic(file: string, content: string, mode?: number): void {
  // Unique temp name per write: both writes are fully synchronous (no yield
  // point in Node), but a second process — or a stale `.tmp` from a crashed
  // run — must never collide with this write.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  // r363: the directory is only created by ensureTraefik, which runs AFTER
  // ensureNetwork — so a boot while Docker was unreachable never created it,
  // the boot-time route write failed with ENOENT, and once the watchdog
  // brought Traefik up it served an empty placeholder: every domain 404'd
  // until the next deploy or domain change happened to rewrite the file.
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
    renameSync(tmp, file);
  } catch (err) {
    // A failed rename (a full disk, a Windows lock on the mounted file) used
    // to leave the temp file behind for good.
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Ensure the shared `ninedeploy` network exists (idempotent). */
export async function ensureNetwork(log: (line: string) => void): Promise<void> {
  try {
    const list = await capture('docker', ['network', 'ls', '--filter', `name=^${NETWORK}$`, '--format', '{{.Name}}']);
    if (list.includes(NETWORK)) return;
    await run('docker', ['network', 'create', NETWORK], {}, log);
    log(`network '${NETWORK}' created`);
  } catch (err) {
    log(`network warning: ${err instanceof Error ? err.message : err}`);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * DNS providers supported for the ACME DNS-01 challenge (wildcard certs).
 * Each maps to the single env var Traefik/lego expects in the container.
 */
export const DNS_PROVIDERS: Record<string, string> = {
  cloudflare: 'CF_DNS_API_TOKEN',
  digitalocean: 'DO_AUTH_TOKEN',
  hetzner: 'HETZNER_API_TOKEN',
  linode: 'LINODE_TOKEN',
  gandi: 'GANDI_API_KEY',
  duckdns: 'DUCKDNS_TOKEN',
};

export interface DnsConfig {
  provider: string;
  token: string | null;
  /** Bare apex (e.g. example.com) whose `*.apex` wildcard cert we request. */
  wildcardApex: string | null;
}

/**
 * Resolve the DNS-01 challenge config: DB settings win, the
 * `NINEDEPLOY_DNS_*` env vars are the fallback. The token is stored
 * ENCRYPTED (settings key `dns_token_encrypted`) and only decrypted here.
 * Never throws — a missing settings table must not break config generation.
 */
export async function getDnsConfig(db: DB): Promise<DnsConfig> {
  const envCfg: DnsConfig = {
    provider: config.dnsProvider ?? '',
    token: config.dnsToken ?? null,
    wildcardApex: config.wildcardDomain ? config.wildcardDomain.replace(/^\*\./, '') : null,
  };
  try {
    const provider = (await getSettingString(db, 'dns_provider', null)) ?? envCfg.provider;
    const encToken = await getSettingString(db, 'dns_token_encrypted', null);
    const apex = (await getSettingString(db, 'wildcard_domain', null)) ?? envCfg.wildcardApex ?? null;
    const token = encToken
      ? decrypt(encToken)
      : provider === envCfg.provider
        ? envCfg.token
        : null;
    return { provider, token, wildcardApex: apex ? apex.replace(/^\*\./, '') : null };
  } catch {
    return envCfg;
  }
}

/** Encrypt a DNS token for at-rest storage in the settings table. */
export function encryptDnsToken(token: string): string {
  return encrypt(token);
}

/**
 * Render the Traefik static config. When an ACME email is configured, a
 * Let's Encrypt resolver is attached to the `websecure` entry point. With a
 * DNS provider configured the resolver uses the DNS-01 challenge (required
 * for wildcard certificates); otherwise HTTP-01 on :80 lets the per-domain
 * SSL toggle issue real certificates. Without an email the resolver is
 * omitted so an unconfigured instance keeps working (routing still
 * functions; `ssl` domains fall back to Traefik's default self-signed cert).
 *
 * 0.14: the file provider reads a DIRECTORY (`/etc/traefik/dynamic`) rather
 * than one file, on the panel and on every node alike. The panel keeps three
 * files there — the generated `ninedeploy.yml`, `certificates.yml` and the
 * operator's `custom.yml` — and the node agent has always written its routes
 * to `dynamic/ninedeploy.yml`. Through 0.13 the shared rendering said
 * `filename: /etc/traefik/dynamic.yml`, a path nothing on a node writes, so
 * node proxies loaded no routes at all (D1, test/lib/nodeProxyD1.test.ts).
 *
 * `logLevel` exists for the custom-config preflight container only.
 *
 * 0.15: `accessLog: 'file'` (traffic analytics, opt-in) replaces the
 * stdout `accessLog: {}` with {@link TRAFFIC_ACCESS_LOG_BLOCK}. The default,
 * `'stdout'`, renders byte-for-byte what 0.14 rendered, so an upgrade with
 * analytics off never changes the fingerprint and never recreates Traefik
 * (golden: test/trafficStaticGolden.test.ts). Node proxies and the custom
 * config preflight never pass `'file'`.
 */
export function renderStaticConfig(
  acmeEmail: string | null,
  dns: DnsConfig | null = null,
  opts: { logLevel?: 'INFO' | 'ERROR'; accessLog?: TraefikAccessLogMode } = {},
): string {
  const useDns = !!(dns?.provider && dns.token && DNS_PROVIDERS[dns.provider]);
  const challenge = useDns
    ? `      dnsChallenge:
        provider: ${dns!.provider}
        delayBeforeCheck: 30
`
    : `      httpChallenge:
        entryPoint: web
`;
  // Optional ACME directory override (e.g. Let's Encrypt STAGING while
  // testing — production rate limits are unforgiving).
  const caServer = config.acmeCaServer ? `      caServer: ${config.acmeCaServer}\n` : '';
  const acme = acmeEmail
    ? `certificatesResolvers:
  letsencrypt:
    acme:
      email: ${acmeEmail}
${caServer}      storage: /etc/traefik/acme.json
${challenge}`
    : '';
  return `# Managed by NineDeploy — do not edit by hand.
entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"
    http3: {}
providers:
  file:
    directory: ${TRAEFIK_DYNAMIC_DIR}
    watch: true
api:
  dashboard: false
log:
  level: ${opts.logLevel ?? 'INFO'}
${opts.accessLog === 'file' ? TRAFFIC_ACCESS_LOG_BLOCK : 'accessLog: {}\n'}${acme}`;
}

/** Where Traefik writes its access log: stdout (0.14 and analytics off) or the analytics file. */
export type TraefikAccessLogMode = 'stdout' | 'file';

/**
 * 0.15 traffic analytics (DESIGN §2.2): a JSON access log in a file the panel
 * tails, holding only what the rollups need. `fields.defaultMode: drop` drops
 * every field that is not explicitly kept — no client address, no path or
 * query string, no user — and `headers.defaultMode: drop` drops every header.
 * Option names per Traefik v3's access-log reference (`filePath`, `format`,
 * `fields.defaultMode`, `fields.names`, `fields.headers.defaultMode`); the
 * DinD smoke verifies a written line carries `RouterName` and no `ClientAddr`.
 */
export const TRAFFIC_ACCESS_LOG_BLOCK = `accessLog:
  filePath: ${TRAFFIC_LOG_CONTAINER_DIR}/${TRAFFIC_LOG_FILE}
  format: json
  fields:
    defaultMode: drop
    names:
      StartUTC: keep
      RouterName: keep
      ServiceName: keep
      RequestHost: keep
      RequestMethod: keep
      DownstreamStatus: keep
      DownstreamContentSize: keep
      Duration: keep
      OriginDuration: keep
    headers:
      defaultMode: drop
`;

/** Every static input that decides the panel Traefik's config, read from the database. */
export interface TraefikInputs {
  acmeEmail: string | null;
  dns: DnsConfig | null;
  accessLog: TraefikAccessLogMode;
}

/**
 * 0.15 recreate-flap guard: the ONE way callers gather `ensureTraefik`'s
 * inputs. A caller that read the ACME email and DNS config but forgot the
 * analytics switch would render the stdout config while analytics is on, and
 * every heal would flip Traefik between the two configs (a recreate each
 * time). `ensureTraefik`'s fourth parameter is required for the same reason;
 * test/trafficStaticGolden.test.ts asserts every caller passes these inputs.
 *
 * The ACME email and DNS reads fall back exactly as the callers did before.
 * The analytics read is NOT defaulted: guessing "off" on a transient database
 * error with analytics on would recreate Traefik, so the error propagates and
 * the heal is retried (boot logs it, the watchdog retries in 5 minutes).
 */
export async function traefikInputs(db: DB): Promise<TraefikInputs> {
  const acmeEmail = await getAcmeEmail(db).catch(() => null);
  const dns = await getDnsConfig(db).catch(() => null);
  const accessLog: TraefikAccessLogMode = (await trafficAnalyticsEnabled(db)) ? 'file' : 'stdout';
  return { acmeEmail, dns, accessLog };
}

/** Where every NineDeploy-managed Traefik (panel and nodes) reads its dynamic files. */
export const TRAEFIK_DYNAMIC_DIR = '/etc/traefik/dynamic';

/** Path helpers for the Traefik config directory under the data dir. */
const dir = () => path.join(config.paths.dataDir, 'traefik');
const staticPath = () => path.join(dir(), 'traefik.yml');
/** 0.14: the directory the file provider watches (`<data>/traefik/dynamic`). */
export const traefikDynamicDir = () => path.join(dir(), 'dynamic');
/** The generated routes — byte-for-byte what 0.13 wrote to `dynamic.yml`. */
export const generatedConfigPath = () => path.join(traefikDynamicDir(), 'ninedeploy.yml');
/** Uploaded certificates (inline PEM); present only while some are servable. */
export const certificatesConfigPath = () => path.join(traefikDynamicDir(), 'certificates.yml');
/** The operator's custom dynamic config; present only when one is saved. */
export const customConfigPath = () => path.join(traefikDynamicDir(), 'custom.yml');
/**
 * 0.13's single route file. Kept on disk for a rollback, never created by
 * 0.14, and only mirrored while the running Traefik may still be reading it
 * (see {@link legacyMirrorActive}).
 */
export const legacyDynamicPath = () => path.join(dir(), 'dynamic.yml');
/** Files in the dynamic directory that hold private keys or operator input. */
const PRIVATE_FILE_MODE = 0o600;
// ACME account key + issued certificates live here; persisted under the data
// dir so renewals survive container recreates.
const acmePath = () => path.join(dir(), 'acme.json');
// DNS provider credentials for the ACME DNS-01 challenge. Written as a docker
// --env-file (0600) so the token never appears in `ps` argv or the config dir
// mounts; docker injects the vars into the Traefik container at start.
const dnsEnvPath = () => path.join(dir(), 'dns.env');
const TRAEFIK_CONFIG_LABEL = 'ninedeploy.traefik.config-sha';

/** Render the docker --env-file content for the DNS-01 provider token. */
function renderDnsEnvFile(dns: DnsConfig): string | null {
  if (!dns.provider || !dns.token) return null;
  const varName = DNS_PROVIDERS[dns.provider];
  if (!varName) return null;
  return `${varName}=${dns.token}\n`;
}

/**
 * True when the operator enabled sticky-session routing for `serviceId`.
 *
 * Sticky-session is per-service, not per-domain: a single toggle affects
 * every domain the service has. The flag lives in the settings table
 * under `sticky_session:<serviceId>:enabled` (string `"true"` / `"1"`,
 * anything else is treated as off) so the toggle does not require a
 * database migration.
 *
 * Mirrors `getDnsConfig`/`getAcmeEmail` — never throws, a missing row is
 * a feature off.
 */
export async function getStickyEnabledForService(db: DB, serviceId: number): Promise<boolean> {
  try {
    const raw = await getSettingString(db, `sticky_session:${serviceId}:enabled`, null);
    return raw === 'true' || raw === '1';
  } catch {
    return false;
  }
}

/**
 * Resolve the ACME account email: the DB setting (Settings → Security) wins,
 * with the `NINEDEPLOY_ACME_EMAIL` env var as the backward-compatible default.
 * Never throws — a missing settings table must not break config generation.
 */
export async function getAcmeEmail(db: DB): Promise<string | null> {
  try {
    return (await getSettingString(db, 'acme_email', null)) ?? config.acmeEmail ?? null;
  } catch {
    return config.acmeEmail ?? null;
  }
}

export interface CertificateInfo {
  domain: string;
  expiresAt: Date | null;
  /** 0.14: `acme` (Traefik's acme.json) or `custom` (an operator upload). */
  source?: 'acme' | 'custom';
  /** Issuer / subject DN on one line, when the PEM parsed. */
  issuer?: string | null;
  subject?: string | null;
  sans?: string[];
  notBefore?: Date | null;
}

/**
 * Extract the newest ASN.1 UTCTime from a PEM certificate. A cert's Validity
 * block contains exactly two UTCTimes (notBefore, notAfter) as plain ASCII
 * `YYMMDDHHMMSSZ` runs inside the DER bytes; the max is always notAfter.
 */
export function parseCertExpiry(pem: string): Date | null {
  const body = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  // Buffer.from(base64) never throws — invalid chars are skipped; an all-junk
  // input just decodes to zero bytes, handled below.
  const der = Buffer.from(body, 'base64');
  if (der.length === 0) return null;
  let best: Date | null = null;
  for (let i = 0; i + 13 <= der.length; i++) {
    if (der[i + 12] !== 0x5a /* 'Z' */) continue;
    const run = der.subarray(i, i + 13).toString('latin1');
    if (!/^\d{12}Z$/.test(run)) continue;
    const nums = [run.slice(0, 2), run.slice(2, 4), run.slice(4, 6), run.slice(6, 8), run.slice(8, 10), run.slice(10, 12)].map(Number) as [number, number, number, number, number, number];
    const [yy, mm, dd, hh, mi, ss] = nums;
    // RFC 5280: years 00-49 → 20xx, 50-99 → 19xx.
    const year = yy + (yy < 50 ? 2000 : 1900);
    // Any 12 digits yield a finite Date (out-of-range fields roll over), so
    // no NaN guard is needed here.
    const date = new Date(Date.UTC(year, mm - 1, dd, hh, mi, ss));
    if (!best || date > best) best = date;
  }
  return best;
}

/**
 * Read the issued certificates out of Traefik's acme.json storage.
 * Shape: { <resolver>: { Certificates: [{ domain: { main }, certificate: PEM }] } }.
 * Returns [] when ACME is unused or the file is absent/corrupt.
 *
 * 0.14: followed by one entry per hostname of every uploaded certificate
 * (`source: 'custom'`), from the cache each render refreshes — so the
 * collector's expiry alert, the domain index, the inventory and the kernel
 * driver all see uploads without knowing about them.
 */
export function readCertificates(): CertificateInfo[] {
  return [...readAcmeCertificates(), ...customCertificateInfos()];
}

/** acme.json PEMs are base64 of the PEM text (Traefik stores `[]byte`). */
function acmePemText(stored: string): string {
  if (stored.includes('-----BEGIN')) return stored;
  try {
    return Buffer.from(stored, 'base64').toString('utf8');
  } catch {
    return stored;
  }
}

/** D4: the real issuer/subject of an ACME certificate, when its PEM parses. */
function acmeMetadata(stored: string): Pick<CertificateInfo, 'issuer' | 'subject' | 'sans' | 'notBefore'> {
  try {
    const leaf = acmePemText(stored).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
    if (!leaf) return {};
    const x = new X509Certificate(leaf);
    const dn = (v: string | undefined) => (v ? v.split('\n').filter(Boolean).join(', ') : null);
    return { issuer: dn(x.issuer), subject: dn(x.subject), sans: certificateHostnames(x), notBefore: x.validFromDate };
  } catch {
    return {};
  }
}

function readAcmeCertificates(): CertificateInfo[] {
  try {
    if (!existsSync(acmePath())) return [];
    const raw = JSON.parse(readFileSync(acmePath(), 'utf-8')) as Record<
      string,
      { Certificates?: Array<{ domain?: { main?: string }; certificate?: string }> }
    >;
    const out: CertificateInfo[] = [];
    for (const resolver of Object.values(raw)) {
      for (const cert of resolver.Certificates ?? []) {
        const domain = cert.domain?.main;
        if (!domain || !cert.certificate) continue;
        // T2-A: Traefik stores the PEM base64-encoded (a Go []byte); fed raw,
        // parseCertExpiry found no timestamp and every ACME certificate
        // reported no expiry, so the cert-expiry alert could never fire.
        out.push({ domain, expiresAt: parseCertExpiry(acmePemText(cert.certificate)), source: 'acme', ...acmeMetadata(cert.certificate) });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function customCertificateInfos(): CertificateInfo[] {
  return cachedCustomCertificates().flatMap((c) =>
    c.hostnames.map((domain) => ({
      domain,
      expiresAt: c.notAfter,
      source: 'custom' as const,
      issuer: c.issuer,
      subject: c.subject,
      sans: [...c.hostnames],
      notBefore: c.notBefore,
    })),
  );
}

/** Whether `container` is attached to `network`. */
async function onNetwork(container: string, network: string): Promise<boolean> {
  try {
    const out = await capture('docker', ['inspect', container, '--format', '{{json .NetworkSettings.Networks}}']);
    return out.includes(`"${network}"`);
  } catch {
    return false;
  }
}

/** Whether the running container actually booted with the desired static inputs. */
async function hasConfigFingerprint(container: string, fingerprint: string): Promise<boolean> {
  try {
    const out = await capture('docker', [
      'inspect', container, '--format', `{{ index .Config.Labels "${TRAEFIK_CONFIG_LABEL}" }}`,
    ]);
    return out.trim() === fingerprint;
  } catch {
    return false;
  }
}

/**
 * r350: the host directory a running Traefik container serves `/etc/traefik`
 * from. The config fingerprint covers what is IN the static config, not where
 * it is mounted from — so a container created by another data dir (a moved
 * install, a second checkout, a test run on a developer box) kept serving that
 * directory's routes after this panel "ensured" it, and every route this panel
 * wrote landed in a file the proxy never read.
 */
function normalizeMountSource(value: string): string {
  let out = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[A-Za-z]:\//.test(out)) out = out.toLowerCase();
  return out;
}

async function mountsConfigDir(container: string, hostDir: string): Promise<boolean> {
  try {
    const out = await capture('docker', [
      'inspect', container, '--format',
      '{{range .Mounts}}{{if eq .Destination "/etc/traefik"}}{{.Source}}{{end}}{{end}}',
    ]);
    return normalizeMountSource(out) === normalizeMountSource(hostDir);
  } catch {
    return false;
  }
}

/** Ensure the Traefik reverse-proxy container is running on the shared network (idempotent). */
async function ensureTraefikUnlocked(
  log: (line: string) => void,
  acmeEmail: string | null = config.acmeEmail ?? null,
  dns: DnsConfig | null = null,
  opts: TraefikStaticOptions = { accessLog: 'stdout' },
): Promise<boolean> {
  mkdirSync(dir(), { recursive: true });
  mkdirSync(traefikDynamicDir(), { recursive: true });
  // 0.14 (M8): the routes move from `dynamic.yml` to `dynamic/ninedeploy.yml`.
  // Copy the legacy file into place BEFORE the static change below recreates
  // the container, so the new Traefik starts with every existing route and
  // there is no 404 window between its start and the boot-time render.
  migrateLegacyRoutes();
  const staticOpts = { accessLog: opts?.accessLog ?? 'stdout' } as const;
  const renderedStaticConfig = renderStaticConfig(acmeEmail, dns, staticOpts);
  const configFingerprint = traefikConfigFingerprint(acmeEmail, dns, staticOpts);
  const staticConfigChanged =
    !existsSync(staticPath()) || readFileSync(staticPath(), 'utf8') !== renderedStaticConfig;
  if (staticConfigChanged) writeAtomic(staticPath(), renderedStaticConfig);
  // r363: an empty placeholder has no routes — report it so the caller
  // renders the real ones instead of serving 404s until the next deploy.
  const seededPlaceholder = !existsSync(generatedConfigPath());
  if (seededPlaceholder) writeFileSync(generatedConfigPath(), 'http:\n  routers:\n  services:\n');
  if (acmeEmail) {
    if (!existsSync(acmePath())) {
      // Seed the ACME storage file so the bind mount below is a FILE and not an
      // auto-created directory (Docker creates a directory when the host path of
      // a bind mount does not exist, which would break Traefik).
      writeFileSync(acmePath(), '{}', { mode: 0o600 });
    } else {
      try {
        chmodSync(acmePath(), 0o600);
      } catch {
        /* ignore */
      }
    }
  }

  try {
    const running = (await capture('docker', ['ps', '-q', '-f', `name=^${TRAEFIK_CONTAINER}$`])).trim();
    const runningOnNetwork = !!running && await onNetwork(TRAEFIK_CONTAINER, NETWORK);
    const runningCurrentConfig = runningOnNetwork && await hasConfigFingerprint(TRAEFIK_CONTAINER, configFingerprint);
    const hostConfigDir = await hostPathFor(dir());
    const runningOurDir = runningCurrentConfig && await mountsConfigDir(TRAEFIK_CONTAINER, hostConfigDir);
    if (runningOurDir && !staticConfigChanged) {
      // The fingerprint matched the directory-provider static config: the
      // running Traefik no longer reads the legacy file.
      legacyMirror = false;
      log('traefik already running on shared network');
      return seededPlaceholder;
    }
    if (runningCurrentConfig && !runningOurDir) {
      log(`traefik serves another config directory; recreating it on ${hostConfigDir}`);
    } else if (runningOnNetwork && (!runningCurrentConfig || staticConfigChanged)) {
      log('traefik static configuration changed; recreating container to apply it');
    }
    // 0.15 D5: probe the log driver before the old proxy is removed, so the
    // probe never lengthens the ingress gap.
    const logOptArgs = traefikLogOptArgs(await dockerLoggingDriver());
    // Prepare the replacement before removing a currently serving proxy. A
    // registry/containerd failure must not turn a config refresh into an
    // avoidable ingress outage.
    await ensureDockerImage(TRAEFIK_IMAGE, log);
    // Recreate so it joins the network (the only publicly exposed service).
    await run('docker', ['rm', '-f', TRAEFIK_CONTAINER], {}, () => {}).catch(() => undefined);

    log('starting traefik container …');
    // Mount the whole config DIRECTORY, not the individual files. A single-file
    // bind mount pins the inode at container start, so our atomic config update
    // (temp file + rename → new inode) would never be seen by the container on
    // Linux — Traefik would silently keep reading the original file forever.
    // With a directory mount, the rename is visible and the file watcher fires.
    const runArgs = [
      'run', '-d', '--name', TRAEFIK_CONTAINER, '--restart', 'unless-stopped',
      '--network', NETWORK,
      '--label', `${TRAEFIK_CONFIG_LABEL}=${configFingerprint}`,
      '--add-host', 'host.docker.internal:host-gateway',
      '-p', '80:80', '-p', '443:443',
      // r245: resolved to the HOST path when the panel itself runs in a container.
      '-v', `${hostConfigDir}:/etc/traefik:ro`,
    ];
    if (acmeEmail) {
      // ACME needs a writable storage file for the account key + certificates.
      // Mount just that single file read-write (Traefik writes it; we never
      // atomically rename it, so the pinned-inode caveat does not apply) while
      // keeping the config directory read-only.
      runArgs.push('-v', `${await hostPathFor(acmePath())}:/etc/traefik/acme.json`);
    }
    const dnsEnv = dns ? renderDnsEnvFile(dns) : null;
    if (dnsEnv) {
      // The token reaches the container via --env-file: the docker CLI reads
      // the file on the host (argv carries only the path, never the secret).
      writeFileSync(dnsEnvPath(), dnsEnv, { mode: 0o600 });
      runArgs.push('--env-file', dnsEnvPath());
    }
    // 0.15 traffic analytics: the access-log directory is mounted exactly
    // when the static config writes to it. The fingerprint covers the static
    // text, so the mount needs no fingerprint of its own. Created here, by the
    // panel, so in docker mode the panel's uid owns it and can rename and
    // delete the root-written log inside it.
    if (staticWritesAccessLogFile(renderedStaticConfig)) {
      mkdirSync(trafficLogDir(), { recursive: true });
      runArgs.push('-v', `${await hostPathFor(trafficLogDir())}:${TRAFFIC_LOG_CONTAINER_DIR}`);
    }
    // 0.15 D5 (owner decision O7): bound Docker's own copy of Traefik's
    // stdout (the 0.14 access log goes there). Only on drivers that take
    // these options — another driver would make `docker run` fail and take
    // ingress down. NOT fingerprinted: it applies at the next natural
    // recreate and never forces one.
    runArgs.push(...logOptArgs);
    runArgs.push(TRAEFIK_IMAGE);
    await run(
      'docker',
      runArgs,
      {},
      log,
    );
    // Model B: re-attach Traefik to every per-slug bridge that exists right
    // now. A Traefik restart must not silently lose routing to services that
    // joined their private bridges while the previous instance was down.
    await reapTraefikNetworks(log);
    await sleep(1000);

    // `docker run -d` only confirms that the container process was created.
    // Invalid config, occupied ports, or mount errors can make it exit
    // immediately afterwards, so prove both liveness and mesh attachment
    // before allowing the application readiness hook to succeed.
    const state = await capture('docker', [
      'inspect', TRAEFIK_CONTAINER,
      '--format', '{{.State.Running}}|{{json .NetworkSettings.Networks}}',
    ]);
    if (!state.startsWith('true|') || !state.includes(`"${NETWORK}"`)) {
      const logs = await capture('docker', ['logs', '--tail', '50', TRAEFIK_CONTAINER]).catch(() => 'logs unavailable');
      throw new Error(`traefik container did not stay running on network '${NETWORK}': ${logs.trim()}`);
    }
    legacyMirror = false;
    log('traefik started (http :80 / https :443) on shared network');
    return true;
  } catch (err) {
    log(`traefik warning: ${err instanceof Error ? err.message : err}`);
    log('domain routing will be unavailable until traefik can bind :80/:443');
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * 0.14: until this process has seen the panel's Traefik running on the
 * directory-provider static config, the container serving traffic may still
 * be a 0.13 one reading `dynamic.yml` (the boot recreate failed — an image
 * pull error keeps the old container up, by design). While that is possible,
 * every route write is mirrored into the legacy file, but only if it already
 * exists, so a failed recreate costs freshness, never routes. Once the new
 * container is confirmed the legacy file is left alone, as the design says.
 */
let legacyMirror = true;

/** Whether route writes are still mirrored into the legacy `dynamic.yml` (exported for tests). */
export function legacyMirrorActive(): boolean {
  return legacyMirror;
}

/**
 * The one-time 0.13 → 0.14 route move (M8). Copies `dynamic.yml` to
 * `dynamic/ninedeploy.yml` when the new file is missing — the first 0.14 boot
 * — or when the legacy file was written after it and differs, which only a
 * rollback to 0.13 (or a 0.13 archive import) does: a re-upgrade must not
 * start Traefik on the routes from before the rollback. Atomic, and never
 * throws: a failed copy falls back to the placeholder plus the boot render.
 */
function migrateLegacyRoutes(): void {
  try {
    const legacy = legacyDynamicPath();
    if (!existsSync(legacy)) return;
    const target = generatedConfigPath();
    const content = readFileSync(legacy, 'utf8');
    if (existsSync(target)) {
      if (statSync(legacy).mtimeMs <= statSync(target).mtimeMs) return;
      if (readFileSync(target, 'utf8') === content) return;
    }
    writeAtomic(target, content);
  } catch {
    /* best effort — the boot render rewrites the routes right after */
  }
}

// Container recreation is a multi-step read/remove/run sequence. Keep the
// entire sequence exclusive so concurrent startup/admin refreshes cannot both
// remove and recreate the singleton container.
let traefikEnsureTail: Promise<void> = Promise.resolve();

/** The static options `ensureTraefik` renders with (0.15: the access-log mode). */
export interface TraefikStaticOptions {
  accessLog: TraefikAccessLogMode;
}

/**
 * Ensure the panel's Traefik runs with the given static inputs, recreating it
 * when they changed. 0.15: `opts` is REQUIRED so a caller cannot forget the
 * analytics switch; callers pass the result of {@link traefikInputs}:
 * `const t = await traefikInputs(db); await ensureTraefik(log, t.acmeEmail, t.dns, t)`.
 */
export function ensureTraefik(
  log: (line: string) => void,
  acmeEmail: string | null = config.acmeEmail ?? null,
  dns: DnsConfig | null = null,
  opts: TraefikStaticOptions,
): Promise<boolean> {
  const runEnsure = traefikEnsureTail.then(() => ensureTraefikUnlocked(log, acmeEmail, dns, opts));
  traefikEnsureTail = runEnsure.then(() => undefined, () => undefined);
  return runEnsure;
}

/** Whether a rendered static config writes the access log to the analytics file. */
export function staticWritesAccessLogFile(staticConfig: string): boolean {
  return /^ {2}filePath: /m.test(staticConfig);
}

/** Docker log drivers that accept `max-size` / `max-file` (D5). */
const ROTATING_LOG_DRIVERS = new Set(['json-file', 'local']);

/** D5: `--log-opt` rotation for Traefik's container log, only on a driver that accepts it. */
export function traefikLogOptArgs(driver: string | null): string[] {
  return driver && ROTATING_LOG_DRIVERS.has(driver)
    ? ['--log-opt', 'max-size=20m', '--log-opt', 'max-file=3']
    : [];
}

let loggingDriverCache: string | null = null;

/**
 * The Docker daemon's default logging driver (`docker info`), cached for the
 * process once known. `null` when Docker did not answer — then no log option
 * is added (and nothing is cached, so the next recreate asks again).
 */
export async function dockerLoggingDriver(): Promise<string | null> {
  if (loggingDriverCache) return loggingDriverCache;
  try {
    const out = String((await capture('docker', ['info', '--format', '{{.LoggingDriver}}'])) ?? '').trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(out)) return null;
    loggingDriverCache = out;
    return out;
  } catch {
    return null;
  }
}

/** Test hook: forget the cached logging driver. */
export function resetDockerLoggingDriverCache(): void {
  loggingDriverCache = null;
}

/** Fingerprint every static input that requires a Traefik container recreate. */
export function traefikConfigFingerprint(
  acmeEmail: string | null,
  dns: DnsConfig | null,
  opts: { accessLog?: TraefikAccessLogMode } = {},
): string {
  const dnsEnv = dns ? renderDnsEnvFile(dns) : null;
  return createHash('sha256')
    .update(renderStaticConfig(acmeEmail, dns, { accessLog: opts.accessLog }))
    .update('\0')
    .update(dnsEnv ?? '')
    .digest('hex');
}

/**
 * Regenerate the Traefik dynamic config from the DB: one router+service per
 * domain pointing at the service's published port. Called after deploys and
 * domain changes.
 *
 * Each run is a read-all-domains-then-write sequence triggered from many
 * places (deploy finalize, domain CRUD, settings apply, service delete).
 * Without serialization, two overlapping runs each miss the other's change
 * and the later file drops the earlier router until the next trigger — the
 * same tail-queue as `ensureTraefik` makes every run observe the settled DB
 * state. (`writeAtomic` already keeps each individual write crash-safe.)
 */
let dynamicConfigTail: Promise<void> = Promise.resolve();

/** Options for {@link writeDynamicConfig}. */
export interface DynamicConfigOptions {
  /**
   * r521: the node whose proxy MUST take this write. A deploy of a
   * node-pinned service passes its node: the write then throws when that
   * node's proxy could not be updated, so the pipeline's PROXY_SWAP fails and
   * the previous runtime is kept (the r398 guarantee the panel host already
   * had). Every other node's refresh stays best-effort.
   */
  requireNode?: number;
}

export function writeDynamicConfig(db: DB, opts: DynamicConfigOptions = {}): Promise<void> {
  const run = dynamicConfigTail.then(() => writeDynamicConfigUnlocked(db, opts));
  dynamicConfigTail = run.then(() => undefined, () => undefined);
  return run;
}

async function writeDynamicConfigUnlocked(db: DB, opts: DynamicConfigOptions): Promise<void> {
  // The render refreshes the uploaded-certificate cache; the certificates
  // file is written from it FIRST, so a router that just switched to
  // `tls: {}` never appears before the certificate it relies on.
  const routes = await renderDynamicConfig(db, { serverId: null });
  writeCertificatesFile(cachedCustomCertificates());
  writeAtomic(generatedConfigPath(), routes);
  if (legacyMirror && existsSync(legacyDynamicPath())) {
    try {
      writeAtomic(legacyDynamicPath(), routes);
    } catch {
      /* the mirror is a courtesy to a container that may already be gone */
    }
  }
  await refreshNodeProxies(db, opts.requireNode);
}

/**
 * Write (or remove) the panel's `dynamic/certificates.yml` from these
 * certificates. Only unexpired ones are served (an expired upload must not
 * shadow ACME or the default certificate), capped at 100, mode 0600 because
 * it carries private keys inline.
 */
function writeCertificatesFile(certs: readonly LoadedCertificate[]): void {
  const servable = servableCertificates(certs);
  const file = certificatesConfigPath();
  if (servable.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  const body =
    '# Managed by NineDeploy — uploaded TLS certificates. Do not edit by hand.\n' +
    `tls:\n  certificates:\n${renderCertificateEntries(servable).join('')}`;
  writeAtomic(file, escapeTemplateDelims(body), PRIVATE_FILE_MODE);
}

/**
 * M12: rebuild `certificates.yml` from the database (the source of truth),
 * e.g. at boot before Traefik is (re)started. Never throws.
 */
export async function materialiseCertificatesFile(db: DB): Promise<void> {
  try {
    mkdirSync(traefikDynamicDir(), { recursive: true });
    writeCertificatesFile(await refreshCustomCertificates(db));
  } catch {
    /* the next route write retries */
  }
}

/** Per-node cooldown for the best-effort refresh audit — a dead node must not
 *  write an audit row on every domain edit. In-memory on purpose (r521). */
const NODE_SYNC_AUDIT_COOLDOWN_MS = 10 * 60_000;
const lastNodeSyncAuditAt = new Map<number, number>();

/**
 * Push the refreshed routing to every node that runs at least one service.
 *
 * This lives INSIDE `writeDynamicConfig` on purpose. Routing changes arrive
 * from a dozen places — deploys, domain create/update/delete, the domain index,
 * webhooks, service edits, the kernel's proxy driver — and every one of them
 * already funnels through here. Fanning out at each call site instead would
 * mean the next new one silently leaves the fleet stale, which is the exact
 * failure this codebase keeps repeating.
 *
 * The import is dynamic to keep `lib/nodeProxy.ts` free to import this module
 * statically (it reuses `renderStaticConfig` / `renderDynamicConfig`, so the
 * two would otherwise form an ESM cycle). By the time this runs, both modules
 * are fully evaluated, so there is no temporal-dead-zone hazard of the kind
 * `test/importCycles.test.ts` exists to catch.
 *
 * Best-effort for every node but `requireNode`: a node that cannot be reached
 * keeps serving its previous config, and the panel's own routing must not
 * fail because a worker is down — such a failure is audited instead (r521:
 * it used to vanish entirely). The REQUIRED node is different: it is the one
 * a deploy just started a new container on, and swallowing its failure made
 * `routingFlipped` true and the pipeline stop the still-routed previous
 * container on the node — an outage reported as a successful deploy.
 */
async function refreshNodeProxies(db: DB, requireNode?: number): Promise<void> {
  let results: Array<{ serverId: number; ok: boolean; reason?: string }> = [];
  try {
    // Ask which NODES exist, not which services are pinned: a node whose last
    // service was just deleted still needs its route table cleared, and a
    // single-host install pays one trivial select over an empty table.
    const nodes = await db.select({ id: servers.id }).from(servers);
    if (requireNode != null && !nodes.some((n) => n.id === requireNode)) {
      throw new Error(`node #${requireNode} is not registered`);
    }
    if (nodes.length === 0) return;
    const { syncAllNodeProxies } = await import('../lib/nodeProxy.js');
    results = await syncAllNodeProxies(db, nodes.map((n) => n.id));
  } catch (err) {
    if (requireNode != null) {
      throw new Error(`the proxy on node #${requireNode} could not be updated: ${err instanceof Error ? err.message : String(err)}`);
    }
    /* a fleet refresh must never fail the panel's own routing write */
    return;
  }
  let requiredFailure: string | undefined;
  for (const r of results) {
    if (r.ok) {
      lastNodeSyncAuditAt.delete(r.serverId);
      continue;
    }
    const reason = r.reason ?? 'unknown error';
    if (r.serverId === requireNode) {
      requiredFailure = reason;
      continue;
    }
    const now = Date.now();
    if (now - (lastNodeSyncAuditAt.get(r.serverId) ?? 0) < NODE_SYNC_AUDIT_COOLDOWN_MS) continue;
    lastNodeSyncAuditAt.set(r.serverId, now);
    void audit(db, null, 'server.proxy_sync_failed', `node #${r.serverId}`, {
      serverId: r.serverId,
      reason: reason.slice(0, 500),
    });
  }
  if (requiredFailure !== undefined) {
    throw new Error(`the proxy on node #${requireNode} could not be updated: ${requiredFailure}`);
  }
}

/**
 * Render the Traefik dynamic configuration for ONE proxy.
 *
 * `serverId: null` renders the panel host's own proxy: the services that run
 * here, plus the panel dashboard router. A numeric `serverId` renders the
 * configuration for that node's proxy — only the services pinned to it, and no
 * panel router (the dashboard lives on the panel host).
 *
 * The scoping is load-bearing, not a convenience. Remote services now get a
 * `runtimeId` like any other, and the upstream a router points at is the
 * CONTAINER NAME resolved over the local Docker network. Rendering every
 * service into every proxy would make the panel's Traefik advertise routes for
 * containers that live on another machine and answer 502 for each one, while
 * the node's own proxy did the same in reverse.
 */
export async function renderDynamicConfig(
  db: DB,
  opts: { serverId: number | null } = { serverId: null },
): Promise<string> {
  const forNode = opts.serverId != null;
  const all = await db.select().from(domains);
  // Multi-server fan-out: a service with a `service_targets` row on THIS node
  // also routes here, through the target's own container (not the primary's).
  const targetsOnNode = forNode
    ? await db.select().from(serviceTargets).where(eq(serviceTargets.serverId, opts.serverId!))
    : [];
  const targetRuntimeByService = new Map(
    targetsOnNode.filter((t) => t.runtimeId).map((t) => [t.serviceId, t.runtimeId as string]),
  );
  const servicesById = new Map(
    (await db.select().from(services))
      .filter((s) =>
        forNode
          ? s.serverId === opts.serverId || targetRuntimeByService.has(s.id)
          : s.serverId == null,
      )
      .map((s) => [s.id, s]),
  );
  const acmeEmail = await getAcmeEmail(db);
  const dns = await getDnsConfig(db);
  const dnsReady = !!(dns.provider && dns.token && DNS_PROVIDERS[dns.provider]);
  // 0.14 (M9): uploaded certificates. With none stored this is `[]` and every
  // branch below renders exactly what 0.13 rendered.
  const customCerts = await refreshCustomCertificates(db);
  const now = new Date();
  /** Hosts this proxy routes — a node inlines only certificates covering them. */
  const routedHosts = new Set<string>();

  const routers: string[] = [];
  const svcBlocks: string[] = [];
  const middlewares: string[] = [];
  const seen = new Set<string>();
  // r637: emitted once, only when some router uses it — an unreferenced
  // middleware is harmless, but an empty `middlewares:` section is not.
  let httpsRedirectUsed = false;
  // F521: the wildcard hosts this render will route (same gates as the loop).
  const wildcardHosts = all
    .filter((o) => {
      const w = String(o.hostname ?? '').trim();
      const osvc = servicesById.get(o.serviceId);
      return o.status === 'active' && w.startsWith('*.') && w.replace(HOST_RE, '') === w && !!osvc?.port && !!osvc.runtimeId;
    })
    .map((o) => String(o.hostname).trim());

  for (const d of all) {
    // H-2 layer 2: a domain awaiting DNS ownership proof must not route. This
    // is the enforcement point — the create-time check only decides what gets
    // written, this decides what Traefik is ever told about.
    if (d.status !== 'active') continue;
    const svc = servicesById.get(d.serviceId);
    if (!svc?.port || !svc.runtimeId) continue; // need a running container to route to
    const key = `${svc.slug}_${d.id}`;
    // Sanitize operands against rule/YAML injection (see HOST_RE/PATH_RE).
    const stored = String(d.hostname ?? '').trim();
    const host = stored.replace(HOST_RE, '');
    if (!host) continue; // every char was stripped → the hostname is unusable/unsafe
    // r630: a host that only became valid BY the stripping is not the host
    // that was claimed. Every ownership check compared the stored string, so
    // `*_.apps.example.com` passed as an ordinary name and rendered as the
    // `*.apps.example.com` catch-all; `vic_tim.…` rendered as `victim.…`.
    // New rows can no longer be stored like that (`isRoutableHostname`), but
    // rows written before are refused here — skipped and audited, never
    // allowed to break the file.
    if (host !== stored) {
      auditRenderRefusal(db, d, 'hostname contains characters a Traefik rule cannot carry; it was never routable as stored');
      continue;
    }
    const cleanPath = String(d.path ?? '').replace(PATH_RE, '');
    const entry = d.ssl ? 'websecure' : 'web';
    // Per-domain middlewares: www→apex redirect + custom response headers + basicAuth + ipAllowlist + rateLimit.
    const mwList: string[] = [];

    // www→apex redirect. The router must claim BOTH hosts of the pair or the
    // feature is dead on the wire: a request for the `www.` form matches no
    // router, so the redirect middleware never runs AND Traefik never asks
    // ACME for a `www.` certificate (the browser sees the default cert).
    // The rule is only extended when no other active row already routes the
    // companion host — Traefik ranks routers by rule length, so the extended
    // rule would silently steal that row's traffic.
    // r633: and never over ANOTHER service's row on it, whatever its state:
    // a pending or not-yet-deployed claim is still someone else's claim, and
    // rows saved before the companion was claim-checked are guarded here.
    const companion = d.redirectWww && !host.startsWith('*.') ? wwwCompanionHost(host) : null;
    const companionTaken =
      companion != null &&
      all.some((o) => {
        if (o.id === d.id || !hostsCollide(String(o.hostname ?? ''), companion)) return false;
        if (o.serviceId !== d.serviceId) return true;
        if (o.status !== 'active') return false;
        const osvc = servicesById.get(o.serviceId);
        return !!osvc?.port && !!osvc.runtimeId;
      });
    const wwwPair = companion != null && !companionTaken;
    // The apex form of the pair — `www.` stripped when that left a real host.
    const stripped = host.replace(/^www\./, '');
    const apexHost = host.startsWith('*.') || !stripped.includes('.') ? host : stripped;
    if (companion != null) {
      const mw = `mw_${key}_www`;
      mwList.push(mw);
      // The regex must match ONLY the www form: matching the apex too would
      // redirect it to itself — an infinite loop, since redirectRegex fires
      // on every match without comparing old and new URL.
      middlewares.push(
        `    ${mw}:\n` +
          '      redirectRegex:\n' +
          `        regex: "${yamlDoubleQuoted(`^https?://www\\.${escapeRegexp(apexHost)}(.*)`)}"\n` +
          `        replacement: "https://${apexHost}$1"\n`,
      );
    }
    // TLS routers reference the ACME resolver when automatic HTTPS is enabled;
    // otherwise keep the old behavior (Traefik's default self-signed cert).
    // A www pair lists both domains SEPARATELY — Traefik orders one
    // certificate per `domains` entry, so a `www.` host whose DNS never
    // points here fails only its own issuance and leaves the apex intact.
    // 0.14: a domain whose every routed host an unexpired upload covers is
    // served that certificate — `tls: {}`, no resolver, so Traefik never
    // orders an ACME certificate in its place. A www pair needs both names.
    const routerHosts = wwwPair ? [apexHost, `www.${apexHost}`] : [host];
    for (const rh of routerHosts) routedHosts.add(rh);
    const customCovered = d.ssl && hostsFullyCovered(routerHosts, customCerts, now);
    const tlsBlock = d.ssl
      ? customCovered
        ? '\n      tls: {}'
        : acmeEmail
          ? wwwPair
            ? '\n      tls:\n        certResolver: letsencrypt\n        domains:\n' +
              `          - main: "${apexHost}"\n          - main: "www.${apexHost}"\n`
            : '\n      tls:\n        certResolver: letsencrypt'
          : '\n      tls: {}'
      : '';
    // Traefik's Host() matcher is literal — a wildcard hostname needs a
    // HostRegexp rule instead (`*.example.com` → one label + the suffix).
    let hostMatcher = host.startsWith('*.')
      ? `HostRegexp(\`^[a-zA-Z0-9-]+\\.${escapeRegexp(host.slice(2))}$\`)`
      : `Host(\`${host}\`)`;
    if (wwwPair) hostMatcher = `Host(\`${apexHost}\`) || Host(\`www.${apexHost}\`)`;
    const headerList = parseHeaders(d.headers);
    if (headerList.length > 0) {
      const mw = `mw_${key}_headers`;
      mwList.push(mw);
      const lines = headerList
        .map((h) => `          ${yamlKey(h.name)}: "${yamlValue(h.value)}"`)
        .join('\n');
      middlewares.push(`    ${mw}:\n      headers:\n        customResponseHeaders:\n${lines}\n`);
    }
    // r636: Traefik compares only hashed htpasswd secrets — a plaintext entry
    // (every row saved before hashing on write) refused every login. Hashed
    // here with a salt derived from the entry, so re-renders are byte-stable.
    const authUsers = parseBasicAuth(d.basicAuth).map((e) => hashBasicAuthEntry(e, true));
    if (authUsers.length > 0) {
      const mw = `mw_${key}_auth`;
      mwList.push(mw);
      const lines = authUsers.map((u) => `        - "${yamlDoubleQuoted(u)}"`).join('\n');
      middlewares.push(`    ${mw}:\n      basicAuth:\n        users:\n${lines}\n`);
    }
    const ipList = parseIpAllowlist(d.ipAllowlist);
    if (ipList.length > 0) {
      const mw = `mw_${key}_ip`;
      mwList.push(mw);
      const lines = ipList.map((ip) => `        - "${yamlDoubleQuoted(ip)}"`).join('\n');
      middlewares.push(`    ${mw}:\n      ipAllowList:\n        sourceRange:\n${lines}\n`);
    }
    if (d.rateLimitAverage && d.rateLimitAverage > 0) {
      const mw = `mw_${key}_ratelimit`;
      mwList.push(mw);
      const avg = d.rateLimitAverage;
      const burst = d.rateLimitBurst && d.rateLimitBurst > 0 ? d.rateLimitBurst : avg;
      middlewares.push(`    ${mw}:\n      rateLimit:\n        average: ${avg}\n        burst: ${burst}\n`);
    }
    // Traefik v3's rule grammar forbids mixing `&&` and `||` without
    // parentheses — a pair rule joined to a PathPrefix must be wrapped.
    const needParens = hostMatcher.includes('||') && cleanPath && cleanPath !== '/';
    const fullRule =
      (needParens ? `(${hostMatcher})` : hostMatcher) +
      (cleanPath && cleanPath !== '/' ? ` && PathPrefix(\`${cleanPath}\`)` : '');
    // F521: an exact host a wildcard also covers states its precedence.
    const ruleHosts = wwwPair ? [apexHost, `www.${apexHost}`] : [host];
    const priority =
      !host.startsWith('*.') && wildcardHosts.some((w) => ruleHosts.some((rh) => hostsCollide(w, rh)))
        ? `      priority: ${EXACT_OVER_WILDCARD_PRIORITY + fullRule.length}\n`
        : '';

    routers.push(
      `    ${key}:\n` +
        `      rule: "${yamlDoubleQuoted(fullRule)}"\n` +
        `      service: svc_${key}\n` +
        priority +
        (mwList.length ? `      middlewares:\n${mwList.map((m) => `        - ${m}`).join('\n')}\n` : '') +
        `      entryPoints:\n        - ${entry}` +
        tlsBlock,
    );
    // r637: an SSL domain's router listens on `websecure` only, so plain
    // http://host answered 404 — nothing ever sent a visitor to HTTPS. Its
    // twin on `web` (same rule, so the same precedence against neighbouring
    // routers) redirects instead. ACME's HTTP-01 challenge is answered by
    // Traefik's internal router ahead of any of these, so issuance is
    // unaffected. Domains with SSL off keep serving plain HTTP.
    if (d.ssl) {
      httpsRedirectUsed = true;
      routers.push(
        `    ${key}_http:\n` +
          `      rule: "${yamlDoubleQuoted(fullRule)}"\n` +
          `      service: svc_${key}\n` +
          priority +
          `      middlewares:\n        - ${HTTPS_REDIRECT_MW}\n` +
          '      entryPoints:\n        - web',
      );
    }
    if (!seen.has(`svc_${key}`)) {
      seen.add(`svc_${key}`);
      // PM2 processes run on the HOST: their runtimeId is a PM2 process name,
      // which no DNS server inside the Traefik container can resolve (every
      // request would 502 forever). Route them through the host gateway,
      // same as the panel router below.
      const upstreamHost =
        svc.type === 'pm2' ? 'host.docker.internal' : (targetRuntimeByService.get(svc.id) ?? svc.runtimeId);
      // Replicas (docker services with `replicas > 1`): every generation
      // container — the primary plus its -r2..-rN clones — becomes one
      // loadBalancer server, and a healthCheck block makes Traefik drop a
      // dead replica from rotation instead of blackholing its share of
      // requests (the file provider caches name→IP, so a crashed replica
      // would otherwise keep receiving traffic until the next reload).
      // Render what actually RUNS (runtimeReplicas, written by the deploy
      // that achieved it), never the desired count: a replica that failed
      // to start — or the window between saving a higher count and the
      // next deploy — must not linger as an unresolvable 502 backend.
      const replicaCount =
        svc.type === 'docker' ? Math.max(1, Math.min(svc.runtimeReplicas ?? svc.replicas ?? 1, MAX_REPLICAS)) : 1;
      const healthPath = String(svc.healthPath ?? '/').replace(PATH_RE, '') || '/';
      const servers = replicaNames(upstreamHost, replicaCount)
        .map((n) => `          - url: "http://${n}:${svc.port}"`)
        .join('\n');
      // r638: `healthCheck` is a key of `loadBalancer` (8 spaces). It was
      // indented like a `servers` list item (10), which is not valid YAML —
      // Traefik refused the whole file the moment any service ran replicas.
      const healthCheck =
        replicaCount > 1
          ? `\n        healthCheck:\n          path: "${yamlDoubleQuoted(healthPath)}"\n          interval: "10s"\n          timeout: "5s"`
          : '';
      // G-28 sticky session. r631: Traefik v3 has NO `sticky` middleware —
      // stickiness is a property of the service's load balancer. The block
      // used to be emitted as `middlewares.mw_sticky_<id>.sticky`, and the
      // file provider refuses the WHOLE dynamic config over an unknown
      // middleware type: one service admin flipping the toggle froze routing
      // for the entire instance. Same setting key, no migration; stored
      // toggles start working (and stop breaking the file) on upgrade.
      // Only `name` + `httpOnly` — both present since Traefik v2 — so an
      // older pinned `traefik:3` image cannot reject an option it predates.
      const sticky = (await getStickyEnabledForService(db, svc.id))
        ? '        sticky:\n          cookie:\n            name: "ninedeploy_sticky"\n            httpOnly: true\n'
        : '';
      svcBlocks.push(
        `    svc_${key}:\n` +
          `      loadBalancer:\n` +
          sticky +
          `        servers:\n` +
          servers +
          healthCheck,
      );
    }
  }

  // NineDeploy Panel Dashboard domain (Settings -> Security or NINEDEPLOY_DOMAIN).
  // The dashboard runs on the PANEL host, so a node's proxy must never claim
  // its hostname — that would blackhole the control plane behind whichever
  // node answered DNS first.
  let panelDomain: string | null = forNode ? null : null;
  if (!forNode) {
    try {
      panelDomain = (await getSettingString(db, 'panel_domain', null)) ?? process.env['NINEDEPLOY_DOMAIN'] ?? null;
    } catch {
      panelDomain = process.env['NINEDEPLOY_DOMAIN'] ?? null;
    }
  }
  if (panelDomain) {
    const host = String(panelDomain).replace(HOST_RE, '');
    if (host) {
      const hostMatcher = `Host(\`${host}\`)`;
      // 0.14: the panel domain follows the same rule as any domain — an
      // unexpired upload covering it replaces the resolver.
      const panelCovered = certificatesCovering(host, customCerts, now).length > 0;
      const tlsBlock =
        acmeEmail && !panelCovered ? '\n      tls:\n        certResolver: letsencrypt' : '\n      tls: {}';
      // r637: a router with a `tls` section serves HTTPS only — Traefik
      // ignores it for plain-HTTP requests, so listing `web` here never made
      // http://panel work; it answered 404. With a real certificate (ACME
      // configured) plain HTTP now redirects to the TLS router. Without one
      // the config is left exactly as it was: redirecting an operator onto a
      // self-signed certificate is not a fix to make for them.
      // 0.14: an uploaded certificate is a real one too, so it earns the redirect.
      const redirectPanel = !!acmeEmail || panelCovered;

      routers.push(
        '    ninedeploy_panel:\n' +
          `      rule: "${yamlDoubleQuoted(hostMatcher)}"\n` +
          '      service: svc_ninedeploy_panel\n' +
          // Traefik ranks routers by RULE LENGTH when no priority is set, so a
          // service router with a longer rule on the same host — `Host(x) &&
          // PathPrefix(/v1)` against this bare `Host(x)` — would out-rank the
          // control plane and receive its traffic, Authorization headers
          // included. `modules/domains.ts` refuses to create such a domain, but
          // the proxy states the precedence itself rather than depending on
          // that check (and on rows that predate it).
          `      priority: ${PANEL_ROUTER_PRIORITY}\n` +
          '      entryPoints:\n' +
          '        - websecure' +
          (redirectPanel ? '' : '\n        - web') +
          tlsBlock,
      );
      if (redirectPanel) {
        httpsRedirectUsed = true;
        routers.push(
          '    ninedeploy_panel_http:\n' +
            `      rule: "${yamlDoubleQuoted(hostMatcher)}"\n` +
            '      service: svc_ninedeploy_panel\n' +
            `      middlewares:\n        - ${HTTPS_REDIRECT_MW}\n` +
            `      priority: ${PANEL_ROUTER_PRIORITY}\n` +
            '      entryPoints:\n        - web',
        );
      }

      svcBlocks.push(
        '    svc_ninedeploy_panel:\n' +
          '      loadBalancer:\n' +
          '        servers:\n' +
          `          - url: "http://host.docker.internal:${config.port}"`,
      );
    }
  }

  // A configured wildcard apex requests ONE wildcard certificate up front via
  // the DNS-01 resolver (Traefik does not derive wildcard certs from
  // HostRegexp routers on its own). The bare apex rides along as a SAN.
  let tlsCerts = '';
  const apex = (dns.wildcardApex ?? '').replace(HOST_RE, '');
  if (dnsReady && acmeEmail && apex) {
    tlsCerts =
      'tls:\n' +
      '  certificates:\n' +
      '    - certResolver: letsencrypt\n' +
      '      domains:\n' +
      `        - main: "*.${apex}"\n` +
      `          sans:\n            - "${apex}"\n`;
  }
  // 0.14: a NODE serves inline the uploads covering hosts it routes (the
  // agent writes a single file); the panel gets them in `certificates.yml`.
  // Appended to the same `tls.certificates` list — a second `tls:` key would
  // be a duplicate mapping key.
  if (forNode) {
    const entries = renderCertificateEntries(
      servableCertificates(customCerts, now).filter((c) =>
        [...routedHosts].some((h) => certificatesCovering(h, [c], now).length > 0),
      ),
    );
    if (entries.length) tlsCerts = (tlsCerts || 'tls:\n  certificates:\n') + entries.join('');
  }

  if (httpsRedirectUsed) {
    middlewares.push(`    ${HTTPS_REDIRECT_MW}:\n      redirectScheme:\n        scheme: https\n        permanent: false\n`);
  }

  // Traefik v3's file provider rejects empty sections (`middlewares: {}`
  // fails with "cannot be a standalone element"), so emit each section only
  // when it has content. Also reject a bare `http:\n` — it causes the same error.
  const section = (name: string, blocks: string[]): string =>
    blocks.length ? `  ${name}:\n${blocks.join('\n')}\n` : '';

  // Only emit the http: key when there's at least one section or tls config.
  const hasContent = routers.length > 0 || middlewares.length > 0 || svcBlocks.length > 0 || tlsCerts.length > 0;
  const yaml = hasContent
    ? '# Managed by NineDeploy — regenerated on deploy/domain changes.\n' +
        'http:\n' +
        section('routers', routers) +
        section('middlewares', middlewares) +
        section('services', svcBlocks) +
        tlsCerts
    : '';

  return escapeTemplateDelims(yaml);
}

/**
 * F520: Traefik's file provider runs the dynamic file through Go text/template
 * (sprig func map, `env` included) BEFORE decoding the YAML, so a tenant's
 * header value `{{ env `CF_DNS_API_TOKEN` }}` was executed and a bare `{{`
 * made Traefik refuse the whole file. Every `{{` is re-emitted as the action
 * {{`{{`}}, which prints the two braces literally.
 */
export function escapeTemplateDelims(text: string): string {
  return text.replaceAll('{{', '{{`{{`}}');
}

/** Parse the domain `headers` JSON column into sanitized {name, value} pairs. */
export function parseHeaders(raw: string | null | undefined): Array<{ name: string; value: string }> {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Array<{ name: string; value: string }> = [];
  for (const item of parsed) {
    const h = item as Partial<{ name: unknown; value: unknown }>;
    if (typeof h?.name !== 'string' || typeof h?.value !== 'string') continue;
    const name = h.name.replace(/[^A-Za-z0-9-]/g, '');
    if (!name) continue;
    // Strip YAML-breaking characters from the value: quotes/backslashes plus
    // every control character (\p{Cc} = C0, C1 and DEL) — go-yaml v3 rejects
    // the whole stream over a raw control byte, even inside a quoted scalar.
    out.push({ name, value: h.value.replace(/["\\\p{Cc}]/gu, '') });
  }
  return out;
}

/** Parse the domain `ipAllowlist` column into sanitized CIDR / IP strings. */
export function parseIpAllowlist(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let entries: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      entries = parsed.map(String);
    } else {
      entries = String(parsed).split(/[\n,]+/);
    }
  } catch {
    entries = raw.split(/[\n,]+/);
  }
  const out: string[] = [];
  for (const item of entries) {
    const sanitized = item.trim().replace(/[^0-9a-fA-F:./]/g, '');
    if (sanitized.length > 0) {
      out.push(sanitized);
    }
  }
  return out;
}

/** Header names become YAML keys — quote anything that could be misread. */
function yamlKey(name: string): string {
  return `"${name}"`;
}

function yamlValue(value: string): string {
  return value;
}

/** Escape regex metacharacters in a (already sanitized) domain suffix. */
function escapeRegexp(s: string): string {
  return s.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
}

/** Escape a value for a double-quoted YAML scalar (backslash + quote). */
function yamlDoubleQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

