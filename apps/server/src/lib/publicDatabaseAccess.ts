import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { and, eq, inArray, ne } from 'drizzle-orm';
import {
  type DB,
  type Database,
  type DatabasePublicAccess,
  databasePublicAccess,
  databases,
  services,
} from '@ninedeploy/db';
import {
  PUBLIC_ACCESS_ALLOWLIST_MAX,
  PUBLIC_ACCESS_PORT_MAX,
  PUBLIC_ACCESS_PORT_MIN,
  type PublicAccessStatus,
  type PublicAccessTlsMode,
  publicAccessEngines,
} from '@ninedeploy/schemas';
import { config } from '../config.js';
import {
  DBPUB_CONFIG_LABEL,
  DBPUB_CONTAINER_PREFIX,
  NETWORK,
  PUBLIC_DB_LABEL,
  TRAEFIK_IMAGE,
} from '../engine/dockerNames.js';
import { certificatesCovering, refreshCustomCertificates, renderCertificatesBlock } from './customCertificates.js';
import { ensureDockerImage } from './dockerPull.js';
import { badRequest, conflict, isUniqueViolation, unprocessable } from './errors.js';
import { capture, run, sleep } from './exec.js';
import { hostPathFor } from './hostPath.js';
import { reservedHostPorts } from './hostPort.js';
import { createKeyedOperationGuard } from './keyedOperationGuard.js';
import { getSettingString } from './settings.js';

/**
 * Public database access (0.14, DESIGN.md §1).
 *
 * A managed database never publishes a port of its own. When an operator turns
 * public access on, a dedicated Traefik container `nd-dbpub-<slug>` joins the
 * `ninedeploy` network, publishes ONE host port (`-p <port>:7000`) and proxies
 * TCP to `nd-db-<slug>:<engine port>` behind a required IP allow-list. The
 * panel's own Traefik is never touched, so a busy port or a bad config can only
 * ever fail this one database's public endpoint, never HTTP ingress.
 *
 * Everything is opt-in: a database without a `database_public_access` row (all
 * of them after the upgrade) has no sidecar and behaves exactly as in 0.13.
 */

/** The port the sidecar's single entrypoint listens on inside the container. */
export const DBPUB_ENTRYPOINT_PORT = 7000;
/** How long a fresh sidecar must survive before it counts as started. */
const SETTLE_MS = 1000;
const swallow = () => undefined;

/** Engines a TLS-terminating TCP router cannot front (their TLS is in-protocol). */
const NO_TERMINATE = new Set(['mysql', 'mariadb']);

/** In-container ports when a row has no `internal_port` (mirrors `engine/database.ts` ENGINES). */
const ENGINE_PORTS: Record<string, number> = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  redis: 6379,
  valkey: 6379,
  keydb: 6379,
  dragonfly: 6379,
  mongo: 27017,
};

/** Every operation on one database's sidecar runs under this guard. */
const guard = createKeyedOperationGuard<number>();

// ── validation ─────────────────────────────────────────────────────────────

/** True when a TCP sidecar can expose this engine. */
export function publicAccessSupported(engine: string): boolean {
  return (publicAccessEngines as readonly string[]).includes(engine);
}

/** Refuse (422) engines and TLS modes the sidecar cannot serve. */
export function assertPublicAccessEngine(engine: string, tlsMode: PublicAccessTlsMode): void {
  if (!publicAccessSupported(engine)) {
    const why =
      engine === 'clickhouse' || engine === 'meilisearch'
        ? 'it speaks HTTP: attach a domain to a service in front of it instead'
        : 'it is not supported by public access yet';
    throw unprocessable(`Public access is not available for ${engine} databases: ${why}`, 'unsupported_engine');
  }
  if (tlsMode === 'terminate' && NO_TERMINATE.has(engine)) {
    throw unprocessable(
      `TLS termination is not possible for ${engine}: its TLS is negotiated inside the protocol. Use tlsMode "none"; the client and server still negotiate TLS end to end.`,
      'unsupported_tls_mode',
    );
  }
}

/**
 * The sidecar can only reach a database on the panel's own `ninedeploy`
 * network, so a row placed on a node (`databases.server_id`, multi-node) is
 * refused, never proxied to whatever answers locally under that name.
 *
 * D6 (multi-node T6): this guard used to read `serverId` through a cast,
 * before the column existed in the drizzle schema. drizzle selects declared
 * columns only, so on 0.14/0.15 the property is ALWAYS undefined — even with
 * the column present after a rollback — and the guard is inert there. 0.16
 * reads the declared column; what protects a node database after a rollback
 * to 0.15 is the NULL-name marker (design §5.8), not this function.
 */
export function assertOnPanelHost(d: Database): void {
  if (d.serverId != null) {
    throw unprocessable('Public access is not available for a database on a node yet; it runs on the panel host only.', 'remote_database');
  }
}

function ipv4Bytes(addr: string): number[] {
  return addr.split('.').map(Number);
}

function ipv6Bytes(addr: string): number[] {
  let text = addr;
  const tail: number[] = [];
  // An embedded dotted quad (`::ffff:192.0.2.1`) is the last 32 bits.
  const lastColon = text.lastIndexOf(':');
  if (text.slice(lastColon + 1).includes('.')) {
    tail.push(...ipv4Bytes(text.slice(lastColon + 1)));
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const [headText = '', tailText] = text.split('::');
  const head = headText ? headText.split(':') : [];
  const rest = tailText === undefined ? [] : tailText ? tailText.split(':') : [];
  const fill = tailText === undefined ? 0 : 8 - head.length - rest.length;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...rest].map((g) => Number.parseInt(g, 16));
  const bytes = groups.flatMap((g) => [g >> 8, g & 0xff]);
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** RFC 5952 text form: lowercase, no leading zeros, the longest zero run (≥2) as `::`. */
function formatIpv6(bytes: number[]): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i]! << 8) | bytes[i + 1]!);
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart < 0) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

function maskBytes(bytes: number[], prefix: number): number[] {
  return bytes.map((b, i) => {
    const bits = Math.max(0, Math.min(8, prefix - i * 8));
    return bits === 8 ? b : b & ((0xff << (8 - bits)) & 0xff);
  });
}

/**
 * One allow-list entry, parsed strictly with `node:net` and returned in its
 * canonical `network/prefix` form (host bits cleared). Never "cleaned" by
 * stripping characters: anything that is not exactly an address or a CIDR is
 * refused (the r630 lesson).
 */
export function normaliseAllowlistEntry(raw: string): string {
  const entry = typeof raw === 'string' ? raw.trim() : '';
  const bad = (why: string) => badRequest(`ipAllowlist: "${entry.slice(0, 64)}" ${why}`, 'invalid_allowlist');
  if (!entry || entry.length > 64) throw bad('is not an IP address or CIDR range');
  const parts = entry.split('/');
  if (parts.length > 2) throw bad('is not an IP address or CIDR range');
  const [addr = '', prefixText] = parts;
  // isIP accepts a zone index (`fe80::1%eth0`); a zone means nothing to a remote peer.
  const family = addr.includes('%') ? 0 : isIP(addr);
  if (family === 0) throw bad('is not an IP address or CIDR range');
  const max = family === 4 ? 32 : 128;
  let prefix = max;
  if (prefixText !== undefined) {
    if (!/^\d{1,3}$/.test(prefixText)) throw bad('has an invalid prefix length');
    prefix = Number(prefixText);
    if (prefix > max) throw bad(`has a prefix longer than /${max}`);
    if (prefix === 0) throw bad('allows every address on the internet (/0 is refused)');
  }
  let bytes = family === 4 ? ipv4Bytes(addr) : ipv6Bytes(addr);
  if (family === 6 && bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    // Go matches an IPv4 client against an IPv4-mapped range with the mask's
    // last 32 bits only, so `::ffff:0.0.0.0/96` would be a /0 in disguise.
    throw bad('is an IPv4-mapped IPv6 address: write the IPv4 form instead');
  }
  bytes = maskBytes(bytes, prefix);
  const text = family === 4 ? bytes.join('.') : formatIpv6(bytes);
  return `${text}/${prefix}`;
}

/** The whole allow-list: 1–100 distinct normalised entries, in the order given. */
export function normaliseAllowlist(entries: readonly string[]): string[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw badRequest('ipAllowlist: at least one address or range is required', 'invalid_allowlist');
  }
  const out: string[] = [];
  for (const e of entries) {
    const n = normaliseAllowlistEntry(e);
    if (!out.includes(n)) out.push(n);
  }
  if (out.length > PUBLIC_ACCESS_ALLOWLIST_MAX) {
    throw badRequest(`ipAllowlist: at most ${PUBLIC_ACCESS_ALLOWLIST_MAX} entries`, 'invalid_allowlist');
  }
  return out;
}

/**
 * The host port: 1024–65535, not one NineDeploy itself listens on, not another
 * database's public port and not a service's published port. A port some
 * other host process holds is only discovered by `docker run` (→ 409).
 */
export async function assertPublicPortAvailable(db: DB, port: number, databaseId: number): Promise<void> {
  if (!Number.isInteger(port) || port < PUBLIC_ACCESS_PORT_MIN || port > PUBLIC_ACCESS_PORT_MAX) {
    throw badRequest(`port: must be an integer from ${PUBLIC_ACCESS_PORT_MIN} to ${PUBLIC_ACCESS_PORT_MAX}`, 'invalid_port');
  }
  if (reservedHostPorts().includes(port)) {
    throw badRequest(`port: ${port} is reserved by NineDeploy (panel, Traefik or SSH)`, 'invalid_port');
  }
  const other = await db.query.databasePublicAccess.findFirst({
    where: and(eq(databasePublicAccess.publicPort, port), ne(databasePublicAccess.databaseId, databaseId)),
  });
  if (other) throw conflict(`Host port ${port} is already used by another database's public access`);
  const svc = await db.query.services.findFirst({ where: eq(services.publishedPort, port) });
  if (svc) throw conflict(`Host port ${port} is already published by a service`);
}

// ── rendering ──────────────────────────────────────────────────────────────

/**
 * Static config. The single `db` entrypoint gets no read timeout: Traefik v3
 * defaults it to 60s, which would cut idle pooled database connections.
 */
export const PUBLIC_DB_STATIC_CONFIG = `# Managed by NineDeploy — do not edit by hand.
global:
  checkNewVersion: false
  sendAnonymousUsage: false
entryPoints:
  db:
    address: ":${DBPUB_ENTRYPOINT_PORT}"
    transport:
      respondingTimeouts:
        readTimeout: 0
providers:
  file:
    directory: /etc/traefik/dynamic
    watch: true
log:
  level: INFO
`;

export interface DynamicConfigInput {
  /** `host:port` of the database on the `ninedeploy` network. */
  target: string;
  /** Normalised allow-list entries. */
  allowlist: readonly string[];
  tlsMode: PublicAccessTlsMode;
  /** Uploaded certificates covering the TLS hostname (terminate mode only). */
  certificates?: ReadonlyArray<{ certPem: string; keyPem: string }>;
}

const q = (s: string) => JSON.stringify(s);

/**
 * `dynamic/routes.yml`. In terminate mode without a covering upload the router
 * still terminates, with Traefik's default self-signed certificate
 * (`sslmode=require` works, `verify-full` does not). With one, the covering
 * certificates are inlined and the first becomes this sidecar's default, so a
 * client that sends no SNI (an IP literal) gets it too.
 */
export function renderPublicDbDynamicConfig(input: DynamicConfigInput): string {
  const terminate = input.tlsMode === 'terminate';
  const lines = [
    '# Managed by NineDeploy — do not edit by hand.',
    'tcp:',
    '  routers:',
    '    db:',
    '      entryPoints: [db]',
    '      rule: "HostSNI(`*`)"',
    '      service: db',
    '      middlewares: [db-allow]',
    ...(terminate ? ['      tls: {}'] : []),
    '  middlewares:',
    '    db-allow:',
    '      ipAllowList:',
    '        sourceRange:',
    ...input.allowlist.map((e) => `          - ${q(e)}`),
    '  services:',
    '    db:',
    '      loadBalancer:',
    '        servers:',
    `          - address: ${q(input.target)}`,
  ];
  let out = `${lines.join('\n')}\n`;
  const certs = terminate ? (input.certificates ?? []) : [];
  const block = renderCertificatesBlock(certs);
  if (block) {
    const first = certs[0]!;
    out +=
      block +
      '  stores:\n    default:\n      defaultCertificate:\n' +
      `        certFile: ${q(first.certPem)}\n        keyFile: ${q(first.keyPem)}\n`;
  }
  return out;
}

/** sha256 over everything that requires recreating the container. */
export function sidecarFingerprint(port: number, image: string = TRAEFIK_IMAGE): string {
  return createHash('sha256').update(`${PUBLIC_DB_STATIC_CONFIG}\n${port}\n${image}`).digest('hex');
}

export function sidecarName(slug: string): string {
  return `${DBPUB_CONTAINER_PREFIX}${slug}`;
}

/** `<data>/dbproxy/<slug>`; the slug is re-checked so it can never leave that directory. */
export function sidecarConfigDir(slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) throw new Error(`invalid database slug for a sidecar directory: ${slug}`);
  return path.join(config.paths.dataDir, 'dbproxy', slug);
}

const staticPathFor = (dir: string) => path.join(dir, 'traefik.yml');
const dynamicPathFor = (dir: string) => path.join(dir, 'dynamic', 'routes.yml');

export interface SidecarRunSpec {
  name: string;
  databaseId: number;
  port: number;
  fingerprint: string;
  /** The config directory as the Docker daemon sees it (`hostPathFor`). */
  hostDir: string;
  /** `uid:gid` the sidecar runs as (the owner of its 0600 config files). */
  user?: string | null;
}

/** The `docker run` argv for one sidecar. */
export function sidecarRunArgs(spec: SidecarRunSpec): string[] {
  return [
    'run', '-d',
    '--name', spec.name,
    '--network', NETWORK,
    '--restart', 'unless-stopped',
    '--memory', '128m',
    '--memory-swap', '128m',
    '--cpus', '0.5',
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    // The config files are 0600 and owned by the panel's user; with every
    // capability dropped even root could not read them unless it owns them.
    ...(spec.user ? ['--user', spec.user] : []),
    '--label', `${PUBLIC_DB_LABEL}=${spec.databaseId}`,
    '--label', `${DBPUB_CONFIG_LABEL}=${spec.fingerprint}`,
    '-p', `${spec.port}:${DBPUB_ENTRYPOINT_PORT}`,
    '-v', `${spec.hostDir}:/etc/traefik:ro`,
    TRAEFIK_IMAGE,
  ];
}

function panelUser(): string | null {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
  return uid === undefined || gid === undefined ? null : `${uid}:${gid}`;
}

// ── files ──────────────────────────────────────────────────────────────────

function writeAtomic(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function readIfExists(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

/** Write what differs; true when the dynamic file changed. */
function writeConfigFiles(dir: string, dynamic: string): boolean {
  if (readIfExists(staticPathFor(dir)) !== PUBLIC_DB_STATIC_CONFIG) writeAtomic(staticPathFor(dir), PUBLIC_DB_STATIC_CONFIG);
  if (readIfExists(dynamicPathFor(dir)) === dynamic) return false;
  writeAtomic(dynamicPathFor(dir), dynamic);
  return true;
}

function removeConfigDir(slug: string): void {
  try {
    rmSync(sidecarConfigDir(slug), { recursive: true, force: true });
  } catch {
    /* best effort: a leftover directory holds no running state */
  }
}

// ── docker ─────────────────────────────────────────────────────────────────

interface SidecarState {
  running: boolean;
  fingerprint: string | null;
}

async function inspectSidecar(name: string): Promise<SidecarState | null> {
  try {
    const out = await capture('docker', [
      'inspect', name, '--format', `{{.State.Running}}|{{ index .Config.Labels "${DBPUB_CONFIG_LABEL}" }}`,
    ]);
    const [running, fp] = out.trim().split('|');
    return { running: running === 'true', fingerprint: fp && fp !== '<no value>' ? fp : null };
  } catch {
    return null;
  }
}

function normaliseMountSource(value: string): string {
  let out = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[A-Za-z]:\//.test(out)) out = out.toLowerCase();
  return out;
}

async function removeContainer(name: string): Promise<void> {
  await run('docker', ['rm', '-f', name], {}, swallow).catch(swallow);
}

const PORT_BUSY = /port is already allocated|address already in use|bind for .* failed/i;

/** Pull (when missing), replace and start one sidecar; throws unless it stays up. */
async function startSidecar(spec: SidecarRunSpec, log: (line: string) => void): Promise<void> {
  await ensureDockerImage(TRAEFIK_IMAGE, log);
  await removeContainer(spec.name);
  const output: string[] = [];
  try {
    await run('docker', sidecarRunArgs(spec), { timeoutMs: 120_000 }, (line) => {
      output.push(line);
      log(line);
    });
  } catch (err) {
    const dockerMessage = output.filter((l) => l.trim()).slice(-5).join(' ').trim();
    await removeContainer(spec.name);
    if (PORT_BUSY.test(dockerMessage)) {
      throw conflict(`Host port ${spec.port} is not available: ${dockerMessage}`);
    }
    throw new Error(dockerMessage || (err instanceof Error ? err.message : String(err)));
  }
  await sleep(SETTLE_MS);
  const state = await inspectSidecar(spec.name);
  if (!state?.running) {
    const logs = await capture('docker', ['logs', '--tail', '20', spec.name]).catch(() => 'logs unavailable');
    await removeContainer(spec.name);
    if (PORT_BUSY.test(logs)) throw conflict(`Host port ${spec.port} is not available: ${logs.trim()}`);
    throw new Error(`the public access proxy did not stay running: ${logs.trim().slice(-500)}`);
  }
}

// ── state ──────────────────────────────────────────────────────────────────

export async function getPublicAccessRow(db: DB, databaseId: number): Promise<DatabasePublicAccess | null> {
  return (
    (await db.query.databasePublicAccess.findFirst({ where: eq(databasePublicAccess.databaseId, databaseId) })) ?? null
  );
}

function targetFor(d: Database): string {
  const host = d.containerName ?? `nd-db-${d.slug}`;
  const port = d.internalPort ?? ENGINE_PORTS[d.engine] ?? 0;
  return `${host}:${port}`;
}

interface Desired {
  port: number;
  allowlist: string[];
  tlsMode: PublicAccessTlsMode;
  tlsHostname: string | null;
}

function renderFor(d: Database, desired: Desired): string {
  const certificates =
    desired.tlsMode === 'terminate' && desired.tlsHostname ? certificatesCovering(desired.tlsHostname) : [];
  return renderPublicDbDynamicConfig({
    target: targetFor(d),
    allowlist: desired.allowlist,
    tlsMode: desired.tlsMode,
    certificates,
  });
}

const desiredOf = (row: DatabasePublicAccess): Desired => ({
  port: row.publicPort,
  allowlist: Array.isArray(row.ipAllowlist) ? row.ipAllowlist : [],
  tlsMode: row.tlsMode,
  tlsHostname: row.tlsHostname ?? null,
});

async function specFor(d: Database, port: number): Promise<SidecarRunSpec> {
  return {
    name: sidecarName(d.slug),
    databaseId: d.id,
    port,
    fingerprint: sidecarFingerprint(port),
    hostDir: await hostPathFor(sidecarConfigDir(d.slug)),
    user: panelUser(),
  };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 1000);

export interface PublicAccessInput {
  port: number;
  ipAllowlist: readonly string[];
  tlsMode: PublicAccessTlsMode;
  tlsHostname?: string | null;
}

/** Errors raised after an apply started changing the sidecar (not validation refusals). */
const applyFailures = new WeakSet<object>();

/** True when `err` came from a started apply (worth `database.public_access.apply_failed`). */
export function isApplyFailure(err: unknown): boolean {
  return typeof err === 'object' && err !== null && applyFailures.has(err);
}

export interface ApplyResult {
  row: DatabasePublicAccess;
  previous: DatabasePublicAccess | null;
  /** `hot`: only the dynamic file changed (allow-list / TLS on the same port). */
  mode: 'started' | 'hot';
}

/**
 * Enable or change public access, synchronously. Same port and a running
 * sidecar with the current fingerprint → rewrite `routes.yml` only (Traefik
 * hot-reloads it). Otherwise write the configs and (re)create the sidecar; on
 * any failure the previous sidecar (if there was one) is restored and the
 * row keeps its previous configuration, with `last_error` set.
 */
export async function applyPublicAccess(
  db: DB,
  d: Database,
  input: PublicAccessInput,
  opts: { userId: number | null; log: (line: string) => void },
): Promise<ApplyResult> {
  assertOnPanelHost(d);
  assertPublicAccessEngine(d.engine, input.tlsMode);
  const desired: Desired = {
    port: input.port,
    allowlist: normaliseAllowlist(input.ipAllowlist),
    tlsMode: input.tlsMode,
    tlsHostname: input.tlsHostname ? input.tlsHostname.toLowerCase() : null,
  };
  return guard(d.id, async () => {
    await assertPublicPortAvailable(db, desired.port, d.id);
    const previous = await getPublicAccessRow(db, d.id);
    if (desired.tlsMode === 'terminate') await refreshCustomCertificates(db);
    const dir = sidecarConfigDir(d.slug);
    const name = sidecarName(d.slug);
    const dynamic = renderFor(d, desired);
    const values = {
      enabled: true,
      publicPort: desired.port,
      tlsMode: desired.tlsMode,
      tlsHostname: desired.tlsHostname,
      ipAllowlist: desired.allowlist,
      containerName: name,
      appliedAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    };
    const save = async () => {
      const [row] = await db
        .insert(databasePublicAccess)
        .values({ databaseId: d.id, createdByUserId: opts.userId, ...values })
        .onConflictDoUpdate({ target: databasePublicAccess.databaseId, set: values })
        .returning();
      return row!;
    };

    const state = await inspectSidecar(name);
    if (
      previous?.enabled &&
      previous.publicPort === desired.port &&
      state?.running &&
      state.fingerprint === sidecarFingerprint(desired.port)
    ) {
      writeConfigFiles(dir, dynamic);
      opts.log(`public access for ${d.name}: configuration reloaded in place`);
      return { row: await save(), previous, mode: 'hot' as const };
    }

    const previousDynamic = readIfExists(dynamicPathFor(dir));
    try {
      writeConfigFiles(dir, dynamic);
      await startSidecar(await specFor(d, desired.port), opts.log);
      let row: DatabasePublicAccess;
      try {
        row = await save();
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict(`Host port ${desired.port} is already used by another database's public access`);
        throw err;
      }
      opts.log(`public access for ${d.name}: ${name} publishes port ${desired.port}`);
      return { row, previous, mode: 'started' as const };
    } catch (err) {
      await removeContainer(name);
      if (previous?.enabled) {
        try {
          writeAtomic(dynamicPathFor(dir), previousDynamic ?? renderFor(d, desiredOf(previous)));
          await startSidecar(await specFor(d, previous.publicPort), opts.log);
          opts.log(`public access for ${d.name}: restored the previous proxy on port ${previous.publicPort}`);
        } catch (restoreErr) {
          opts.log(`public access for ${d.name}: restoring the previous proxy failed: ${message(restoreErr)}`);
        }
      } else {
        removeConfigDir(d.slug);
      }
      if (previous) {
        await db
          .update(databasePublicAccess)
          .set({ lastError: message(err), updatedAt: new Date() })
          .where(eq(databasePublicAccess.databaseId, d.id))
          .catch(swallow);
      }
      if (typeof err === 'object' && err !== null) applyFailures.add(err);
      throw err;
    }
  });
}

/**
 * Turn public access off: remove the sidecar and its config directory and set
 * `enabled = false`. The configuration stays in the row for a later re-enable.
 * Returns the row as it was, or null when none existed.
 */
export async function disablePublicAccess(
  db: DB,
  d: Database,
  log: (line: string) => void,
): Promise<DatabasePublicAccess | null> {
  return guard(d.id, async () => {
    const row = await getPublicAccessRow(db, d.id);
    if (!row) return null;
    await removeContainer(row.containerName ?? sidecarName(d.slug));
    removeConfigDir(d.slug);
    await db
      .update(databasePublicAccess)
      .set({ enabled: false, containerName: null, lastError: null, updatedAt: new Date() })
      .where(eq(databasePublicAccess.databaseId, d.id));
    log(`public access for ${d.name}: disabled`);
    return row;
  });
}

/**
 * Database delete hook (M6): remove the sidecar and its configs BEFORE the row
 * transaction; the FK cascade then removes the access row. Never throws — a
 * leftover container is an orphan the watchdog removes. A database that never
 * had public access (no row, no config directory) costs no Docker call.
 */
export async function removePublicAccessSidecar(
  db: DB,
  d: Database,
  log: (line: string) => void,
): Promise<void> {
  await guard(d.id, async () => {
    const row = await getPublicAccessRow(db, d.id);
    if (!row && !existsSync(sidecarConfigDir(d.slug))) return;
    await removeContainer(row?.containerName ?? sidecarName(d.slug));
    removeConfigDir(d.slug);
    log(`public access sidecar for ${d.name} removed`);
  }).catch((err: unknown) => log(`public access sidecar removal failed: ${message(err)}`));
}

/** Bring one enabled row's sidecar to its desired state (under the guard). */
async function ensureOne(db: DB, databaseId: number, log: (line: string) => void): Promise<'ok' | 'started' | 'failed' | 'skipped'> {
  const row = await getPublicAccessRow(db, databaseId);
  if (!row?.enabled) return 'skipped';
  const d = await db.query.databases.findFirst({ where: eq(databases.id, databaseId) });
  if (!d) return 'skipped';
  try {
    assertOnPanelHost(d);
    assertPublicAccessEngine(d.engine, row.tlsMode);
    const desired = desiredOf(row);
    writeConfigFiles(sidecarConfigDir(d.slug), renderFor(d, desired));
    const state = await inspectSidecar(sidecarName(d.slug));
    if (state?.running && state.fingerprint === sidecarFingerprint(desired.port)) {
      if (row.lastError) {
        await db.update(databasePublicAccess).set({ lastError: null }).where(eq(databasePublicAccess.databaseId, d.id));
      }
      return 'ok';
    }
    await startSidecar(await specFor(d, desired.port), log);
    await db
      .update(databasePublicAccess)
      .set({ containerName: sidecarName(d.slug), lastError: null, appliedAt: new Date(), updatedAt: new Date() })
      .where(eq(databasePublicAccess.databaseId, d.id));
    log(`public access for ${d.name}: sidecar (re)started on port ${desired.port}`);
    return 'started';
  } catch (err) {
    log(`public access for ${d.name}: reconcile failed: ${message(err)}`);
    await db
      .update(databasePublicAccess)
      .set({ lastError: message(err), updatedAt: new Date() })
      .where(eq(databasePublicAccess.databaseId, d.id))
      .catch(swallow);
    return 'failed';
  }
}

export interface ReconcileResult {
  started: number;
  failed: number;
  orphansRemoved: number;
}

/**
 * Boot and watchdog reconcile: every enabled row's sidecar runs with the
 * current fingerprint and config, and every `ninedeploy.public-db` container
 * that no enabled row accounts for is removed. Each database is handled under
 * its operation guard, so a concurrent apply is never undone half-way.
 */
export async function reconcilePublicAccess(db: DB, log: (line: string) => void): Promise<ReconcileResult> {
  const result: ReconcileResult = { started: 0, failed: 0, orphansRemoved: 0 };
  await refreshCustomCertificates(db);
  const rows = await db
    .select({ id: databasePublicAccess.databaseId })
    .from(databasePublicAccess)
    .where(eq(databasePublicAccess.enabled, true));
  for (const { id } of rows) {
    const outcome = await guard(id, () => ensureOne(db, id, log));
    if (outcome === 'started') result.started++;
    if (outcome === 'failed') result.failed++;
  }

  let listing: string;
  try {
    listing = await capture('docker', [
      'ps', '-a', '--filter', `label=${PUBLIC_DB_LABEL}`, '--format', `{{.Names}}|{{.Label "${PUBLIC_DB_LABEL}"}}`,
    ]);
  } catch (err) {
    log(`public access orphan sweep skipped: ${message(err)}`);
    return result;
  }
  // Only a sidecar serving a directory under THIS panel's data dir is ours to
  // remove (the r350 lesson): another install, a second checkout or a test run
  // on the same daemon labels its sidecars the same way.
  const ownRoot = normaliseMountSource(await hostPathFor(path.join(config.paths.dataDir, 'dbproxy')));
  for (const line of listing.split('\n')) {
    const [name, idText] = line.trim().split('|');
    if (!name) continue;
    const source = await capture('docker', [
      'inspect', name, '--format', '{{range .Mounts}}{{if eq .Destination "/etc/traefik"}}{{.Source}}{{end}}{{end}}',
    ]).catch(() => '');
    if (!normaliseMountSource(source).startsWith(`${ownRoot}/`)) continue;
    const id = Number(idText);
    const keep = async () => {
      if (!Number.isSafeInteger(id) || id <= 0) return false;
      const row = await getPublicAccessRow(db, id);
      if (!row?.enabled) return false;
      const d = await db.query.databases.findFirst({ where: eq(databases.id, id) });
      return !!d && sidecarName(d.slug) === name;
    };
    const removed = await (Number.isSafeInteger(id) && id > 0 ? guard(id, async () => !(await keep())) : Promise.resolve(true));
    if (removed) {
      await removeContainer(name);
      result.orphansRemoved++;
      log(`public access: removed orphan sidecar ${name}`);
    }
  }
  return result;
}

/**
 * A custom certificate was uploaded, replaced or deleted (M15): re-render the
 * TLS-terminating sidecars' `routes.yml`. Only files whose content changes are
 * rewritten, so an unrelated certificate costs nothing; Traefik reloads the
 * file in place. Returns the number of sidecars re-rendered.
 */
export async function rerenderTlsSidecars(db: DB, log: (line: string) => void): Promise<number> {
  await refreshCustomCertificates(db);
  const rows = await db
    .select({ id: databasePublicAccess.databaseId })
    .from(databasePublicAccess)
    .where(and(eq(databasePublicAccess.enabled, true), eq(databasePublicAccess.tlsMode, 'terminate')));
  let changed = 0;
  for (const { id } of rows) {
    const did = await guard(id, async () => {
      const row = await getPublicAccessRow(db, id);
      const d = await db.query.databases.findFirst({ where: eq(databases.id, id) });
      if (!row?.enabled || row.tlsMode !== 'terminate' || !d) return false;
      return writeConfigFiles(sidecarConfigDir(d.slug), renderFor(d, desiredOf(row)));
    }).catch((err: unknown) => {
      log(`public access TLS re-render failed for database #${id}: ${message(err)}`);
      return false;
    });
    if (did) changed++;
  }
  if (changed) log(`public access: re-rendered ${changed} TLS sidecar config(s) after a certificate change`);
  return changed;
}

// ── read side ──────────────────────────────────────────────────────────────

/** `tlsHostname`, else the panel domain, else the host of the public URL. */
export async function resolvePublicHost(db: DB, tlsHostname: string | null | undefined): Promise<string | null> {
  if (tlsHostname) return tlsHostname;
  try {
    const panelDomain = (await getSettingString(db, 'panel_domain', null)) ?? process.env['NINEDEPLOY_DOMAIN'] ?? null;
    if (panelDomain) return panelDomain;
  } catch {
    /* fall through to the public URL */
  }
  try {
    return new URL(config.publicUrl).hostname || null;
  } catch {
    return null;
  }
}

/** The GET (and PUT) response for one database. */
export async function publicAccessStatus(db: DB, d: Database): Promise<PublicAccessStatus> {
  const row = await getPublicAccessRow(db, d.id);
  const supported = publicAccessSupported(d.engine);
  if (!row) {
    return {
      supported,
      configured: false,
      enabled: false,
      port: null,
      tlsMode: 'none',
      tlsHostname: null,
      ipAllowlist: [],
      status: 'off',
      lastError: null,
      appliedAt: null,
      publicHost: await resolvePublicHost(db, null),
    };
  }
  let status: PublicAccessStatus['status'] = 'off';
  if (row.enabled) {
    const state = await inspectSidecar(row.containerName ?? sidecarName(d.slug));
    status = state?.running ? 'running' : 'error';
  }
  return {
    supported,
    configured: true,
    enabled: row.enabled,
    port: row.publicPort,
    tlsMode: row.tlsMode,
    tlsHostname: row.tlsHostname ?? null,
    ipAllowlist: Array.isArray(row.ipAllowlist) ? row.ipAllowlist : [],
    status,
    lastError: row.lastError ?? null,
    appliedAt: row.appliedAt ? row.appliedAt.toISOString() : null,
    publicHost: await resolvePublicHost(db, row.tlsHostname),
  };
}

/** `{ enabled, port }` per database id for the database serializer (M7). Never throws. */
export async function publicAccessSummaries(
  db: DB,
  databaseIds: readonly number[],
): Promise<Map<number, { enabled: boolean; port: number }>> {
  const out = new Map<number, { enabled: boolean; port: number }>();
  if (databaseIds.length === 0) return out;
  try {
    const rows = await db.query.databasePublicAccess.findMany({
      where: inArray(databasePublicAccess.databaseId, [...databaseIds]),
    });
    for (const r of Array.isArray(rows) ? rows : []) {
      if (databaseIds.includes(r.databaseId)) out.set(r.databaseId, { enabled: r.enabled, port: r.publicPort });
    }
  } catch {
    /* an unreadable table renders as "not configured", exactly 0.13's view */
  }
  return out;
}
