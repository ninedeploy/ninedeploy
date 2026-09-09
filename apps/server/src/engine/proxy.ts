import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { domains, servers, services, type DB } from '@ninedeploy/db';
import { config } from '../config.js';
import { capture, run, sleep } from '../lib/exec.js';
import { getSettingString } from '../lib/settings.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { ensureDockerImage } from '../lib/dockerPull.js';
import { reapTraefikNetworks } from '../lib/serviceBridge.js';
import { NETWORK, TRAEFIK_CONTAINER, TRAEFIK_IMAGE } from './dockerNames.js';

// Defined in a leaf module and re-exported here: `proxy` and `serviceBridge`
// import each other, and a constant declared in one of them is in its temporal
// dead zone for the other. See engine/dockerNames.ts.
export { NETWORK, TRAEFIK_CONTAINER, TRAEFIK_IMAGE } from './dockerNames.js';

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

/** Atomically replace `file`'s contents: write to a sibling temp file then rename. */
function writeAtomic(file: string, content: string): void {
  // Unique temp name per write: both writes are fully synchronous (no yield
  // point in Node), but a second process — or a stale `.tmp` from a crashed
  // run — must never collide with this write.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
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
 */
export function renderStaticConfig(acmeEmail: string | null, dns: DnsConfig | null = null): string {
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
    filename: /etc/traefik/dynamic.yml
    watch: true
api:
  dashboard: false
log:
  level: INFO
accessLog: {}
${acme}`;
}

/** Path helpers for the Traefik config directory under the data dir. */
const dir = () => path.join(config.paths.dataDir, 'traefik');
const staticPath = () => path.join(dir(), 'traefik.yml');
const dynamicPath = () => path.join(dir(), 'dynamic.yml');
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
 */
export function readCertificates(): CertificateInfo[] {
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
        out.push({ domain, expiresAt: parseCertExpiry(cert.certificate) });
      }
    }
    return out;
  } catch {
    return [];
  }
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

/** Ensure the Traefik reverse-proxy container is running on the shared network (idempotent). */
async function ensureTraefikUnlocked(
  log: (line: string) => void,
  acmeEmail: string | null = config.acmeEmail ?? null,
  dns: DnsConfig | null = null,
): Promise<void> {
  mkdirSync(dir(), { recursive: true });
  const renderedStaticConfig = renderStaticConfig(acmeEmail, dns);
  const configFingerprint = traefikConfigFingerprint(acmeEmail, dns);
  const staticConfigChanged =
    !existsSync(staticPath()) || readFileSync(staticPath(), 'utf8') !== renderedStaticConfig;
  if (staticConfigChanged) writeAtomic(staticPath(), renderedStaticConfig);
  if (!existsSync(dynamicPath())) writeFileSync(dynamicPath(), 'http:\n  routers:\n  services:\n');
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
    if (runningCurrentConfig && !staticConfigChanged) {
      log('traefik already running on shared network');
      return;
    }
    if (runningOnNetwork && (!runningCurrentConfig || staticConfigChanged)) {
      log('traefik static configuration changed; recreating container to apply it');
    }
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
      '-v', `${dir()}:/etc/traefik:ro`,
    ];
    if (acmeEmail) {
      // ACME needs a writable storage file for the account key + certificates.
      // Mount just that single file read-write (Traefik writes it; we never
      // atomically rename it, so the pinned-inode caveat does not apply) while
      // keeping the config directory read-only.
      runArgs.push('-v', `${acmePath()}:/etc/traefik/acme.json`);
    }
    const dnsEnv = dns ? renderDnsEnvFile(dns) : null;
    if (dnsEnv) {
      // The token reaches the container via --env-file: the docker CLI reads
      // the file on the host (argv carries only the path, never the secret).
      writeFileSync(dnsEnvPath(), dnsEnv, { mode: 0o600 });
      runArgs.push('--env-file', dnsEnvPath());
    }
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
    log('traefik started (http :80 / https :443) on shared network');
  } catch (err) {
    log(`traefik warning: ${err instanceof Error ? err.message : err}`);
    log('domain routing will be unavailable until traefik can bind :80/:443');
    throw err instanceof Error ? err : new Error(String(err));
  }
}

// Container recreation is a multi-step read/remove/run sequence. Keep the
// entire sequence exclusive so concurrent startup/admin refreshes cannot both
// remove and recreate the singleton container.
let traefikEnsureTail: Promise<void> = Promise.resolve();

export function ensureTraefik(
  log: (line: string) => void,
  acmeEmail: string | null = config.acmeEmail ?? null,
  dns: DnsConfig | null = null,
): Promise<void> {
  const runEnsure = traefikEnsureTail.then(() => ensureTraefikUnlocked(log, acmeEmail, dns));
  traefikEnsureTail = runEnsure.then(() => undefined, () => undefined);
  return runEnsure;
}

/** Fingerprint every static input that requires a Traefik container recreate. */
export function traefikConfigFingerprint(acmeEmail: string | null, dns: DnsConfig | null): string {
  const dnsEnv = dns ? renderDnsEnvFile(dns) : null;
  return createHash('sha256')
    .update(renderStaticConfig(acmeEmail, dns))
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

export function writeDynamicConfig(db: DB): Promise<void> {
  const run = dynamicConfigTail.then(() => writeDynamicConfigUnlocked(db));
  dynamicConfigTail = run.then(() => undefined, () => undefined);
  return run;
}

async function writeDynamicConfigUnlocked(db: DB): Promise<void> {
  writeAtomic(dynamicPath(), await renderDynamicConfig(db, { serverId: null }));
  await refreshNodeProxies(db);
}

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
 * Never throws: a node that cannot be reached keeps serving its previous
 * config, and the panel's own routing must not fail because a worker is down.
 */
async function refreshNodeProxies(db: DB): Promise<void> {
  try {
    // Ask which NODES exist, not which services are pinned: a node whose last
    // service was just deleted still needs its route table cleared, and a
    // single-host install pays one trivial select over an empty table.
    const nodes = await db.select({ id: servers.id }).from(servers);
    if (nodes.length === 0) return;
    const { syncAllNodeProxies } = await import('../lib/nodeProxy.js');
    await syncAllNodeProxies(db, nodes.map((n) => n.id));
  } catch {
    /* a fleet refresh must never fail the panel's own routing write */
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
  const servicesById = new Map(
    (await db.select().from(services))
      .filter((s) => (forNode ? s.serverId === opts.serverId : s.serverId == null))
      .map((s) => [s.id, s]),
  );
  const acmeEmail = await getAcmeEmail(db);
  const dns = await getDnsConfig(db);
  const dnsReady = !!(dns.provider && dns.token && DNS_PROVIDERS[dns.provider]);

  const routers: string[] = [];
  const svcBlocks: string[] = [];
  const middlewares: string[] = [];
  const seen = new Set<string>();
  // Sticky middleware blocks are keyed by SERVICE, not domain — track what has
  // been emitted so a multi-domain service cannot produce a duplicate key.
  const stickyEmitted = new Set<number>();

  for (const d of all) {
    // H-2 layer 2: a domain awaiting DNS ownership proof must not route. This
    // is the enforcement point — the create-time check only decides what gets
    // written, this decides what Traefik is ever told about.
    if (d.status !== 'active') continue;
    const svc = servicesById.get(d.serviceId);
    if (!svc?.port || !svc.runtimeId) continue; // need a running container to route to
    const key = `${svc.slug}_${d.id}`;
    // Sanitize operands against rule/YAML injection (see HOST_RE/PATH_RE).
    const host = String(d.hostname ?? '').replace(HOST_RE, '');
    if (!host) continue; // every char was stripped → the hostname is unusable/unsafe
    const cleanPath = String(d.path ?? '').replace(PATH_RE, '');
    const entry = d.ssl ? 'websecure' : 'web';
    // TLS routers reference the ACME resolver when automatic HTTPS is enabled;
    // otherwise keep the old behavior (Traefik's default self-signed cert).
    const tlsBlock = d.ssl
      ? acmeEmail
        ? '\n      tls:\n        certResolver: letsencrypt'
        : '\n      tls: {}'
      : '';
    // Traefik's Host() matcher is literal — a wildcard hostname needs a
    // HostRegexp rule instead (`*.example.com` → one label + the suffix).
    const hostMatcher = host.startsWith('*.')
      ? `HostRegexp(\`^[a-zA-Z0-9-]+\\.${escapeRegexp(host.slice(2))}$\`)`
      : `Host(\`${host}\`)`;

    // Per-domain middlewares: www→apex redirect + custom response headers + basicAuth + ipAllowlist + rateLimit.
    const mwList: string[] = [];
    const apexHost = host.startsWith('*.') ? host : host.replace(/^www\./, '');
    if (d.redirectWww && !host.startsWith('*.')) {
      const mw = `mw_${key}_www`;
      mwList.push(mw);
      middlewares.push(
        `    ${mw}:\n` +
          '      redirectRegex:\n' +
          `        regex: "${yamlDoubleQuoted(`^https?://(?:www\\.)?${escapeRegexp(apexHost)}(.*)`)}"\n` +
          `        replacement: "https://${apexHost}$1"\n`,
      );
    }
    const headerList = parseHeaders(d.headers);
    if (headerList.length > 0) {
      const mw = `mw_${key}_headers`;
      mwList.push(mw);
      const lines = headerList
        .map((h) => `          ${yamlKey(h.name)}: "${yamlValue(h.value)}"`)
        .join('\n');
      middlewares.push(`    ${mw}:\n      headers:\n        customResponseHeaders:\n${lines}\n`);
    }
    const authUsers = parseBasicAuth(d.basicAuth);
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
    // G-28 sticky session — one middleware per service so every domain the
    // service owns shares the same cookie. Every router references
    // `mw_sticky_<id>`, but the block itself is emitted AT MOST ONCE per
    // render: YAML forbids duplicate mapping keys, and Traefik's file
    // provider (go-yaml v3) refuses the whole dynamic config over one, which
    // would silently freeze that proxy's route table.
    if (await getStickyEnabledForService(db, svc.id)) {
      const stickyKey = `mw_sticky_${svc.id}`;
      mwList.push(stickyKey);
      if (!stickyEmitted.has(svc.id)) {
        stickyEmitted.add(svc.id);
        middlewares.push(
          `    ${stickyKey}:\n` +
            '      sticky:\n' +
            '        cookie:\n' +
            '          name: "ninedeploy_sticky"\n' +
            '          maxAge: 86400\n',
        );
      }
    }

    const fullRule =
      hostMatcher + (cleanPath && cleanPath !== '/' ? ` && PathPrefix(\`${cleanPath}\`)` : '');

    routers.push(
      `    ${key}:\n` +
        `      rule: "${yamlDoubleQuoted(fullRule)}"\n` +
        `      service: svc_${key}\n` +
        (mwList.length ? `      middlewares:\n${mwList.map((m) => `        - ${m}`).join('\n')}\n` : '') +
        `      entryPoints:\n        - ${entry}` +
        tlsBlock,
    );
    if (!seen.has(`svc_${key}`)) {
      seen.add(`svc_${key}`);
      // PM2 processes run on the HOST: their runtimeId is a PM2 process name,
      // which no DNS server inside the Traefik container can resolve (every
      // request would 502 forever). Route them through the host gateway,
      // same as the panel router below.
      const upstreamHost = svc.type === 'pm2' ? 'host.docker.internal' : svc.runtimeId;
      svcBlocks.push(
        `    svc_${key}:\n` +
          `      loadBalancer:\n` +
          `        servers:\n` +
          `          - url: "http://${upstreamHost}:${svc.port}"`,
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
      const tlsBlock = acmeEmail
        ? '\n      tls:\n        certResolver: letsencrypt'
        : '\n      tls: {}';

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
          '        - websecure\n' +
          '        - web' +
          tlsBlock,
      );

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

  return yaml;
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

/** Parse the domain `basicAuth` column into sanitized user:hash entries. */
export function parseBasicAuth(raw: string | null | undefined): string[] {
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
    // Controls must go: go-yaml v3 refuses the whole dynamic config over a
    // raw control byte, quoted or not. \p{Cc} covers C0, C1 and DEL
    // (superset of the old \r\n\0 strip).
    const trimmed = item.trim().replace(/\p{Cc}/gu, '');
    if (trimmed.includes(':')) {
      out.push(trimmed);
    }
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
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** Escape a value for a double-quoted YAML scalar (backslash + quote). */
function yamlDoubleQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

