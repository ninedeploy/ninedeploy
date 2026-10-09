import { existsSync } from 'node:fs';
import type { DB } from '@ninedeploy/db';
import {
  databases,
  deployments,
  installedPlugins,
  oidcProviders,
  projects,
  repoInsights,
  serviceVolumeAttachments,
  services,
  tunnels,
  workspaces,
} from '@ninedeploy/db';
import type {
  DoctorActionKind,
  DoctorFinding,
  DoctorReport,
  DoctorTargetType,
} from '@ninedeploy/schemas';
import type { SlugRow, SlugTable } from '../lib/slugAudit.js';
import { auditSlugRows, slugTableInfo } from '../lib/slugAudit.js';
import { eq } from 'drizzle-orm';
import { getDiskUsage, executeAutoPrune } from './autoPrune.js';
import { removeVolume, startDatabase, volumeExists, volumeLabels } from './database.js';
import { parseHumanBytes, parseReclaimedBytes } from '../lib/imageInventory.js';
import {
  capture,
  run,
} from '../lib/exec.js';
import { conflict } from '../lib/errors.js';
import { getSettingString } from '../lib/settings.js';
import { config } from '../config.js';
import { SandboxPlugin } from '../kernel/sandbox/sandboxPlugin.js';
import { storedInsightsLeakSuspected } from './repoInsights.js';
import { isSwarmRuntimeId } from '../lib/swarm.js';
import {
  containerRunning,
  listManagedVolumeNames,
  listUserNetworks,
  networkMembers,
  resolveVolumeOwner,
  HELPER_IMAGE,
} from '../lib/inventory.js';

/** r228: runtimes this host's `docker ps` can see (not PM2, not a remote node). */
function isLocalContainerRuntime(s: { type: string; serverId?: number | null; runtimeId?: string | null }): boolean {
  // ── 0.16 T7 swarm ── a Swarm service has no container of its own name; Swarm keeps its tasks running (design §7.4: the doctor skips Swarm rows).
  if (isSwarmRuntimeId(s.runtimeId)) return false;
  // ── end 0.16 T7 ──
  return s.type !== 'pm2' && (s.serverId ?? null) === null;
}

/**
 * Doctor: one scan answers "what is dead, stale or bloated on this host, and
 * what can be done about it safely?" — leftover deploy junk (exited Hub
 * containers, orphaned volumes/networks), rows that no longer match runtime
 * reality (services "running" with no container, databases down or stuck,
 * deploys frozen in queued/building), and reclaimable bloat (dangling images,
 * build cache, disk pressure).
 *
 * SAFETY MODEL: a fix never trusts the report that showed the finding. Fix
 * re-scans, re-locates the finding by its deterministic id against FRESH
 * state, and only then executes — a volume that gained an owner, a container
 * that came back or a deploy that moved on makes the finding vanish and the
 * fix refuses with "already resolved". Destructive targets are additionally
 * name-family-guarded: only nd-/ninedeploy-/ndcmp- prefixed objects are ever
 * touched, so the Doctor cannot be talked into deleting foreign docker state.
 */

/** Containers/filesystems owned by NineDeploy. Anything outside these prefixes
 *  is invisible to Doctor actions regardless of what a report claimed. */
function isHubContainerName(name: string): boolean {
  return /^(nd-|ninedeploy-|ndcmp-)/.test(name);
}

const BUILT_IN_NETWORKS = new Set(['bridge', 'host', 'none']);
/** The shared control-plane mesh — databases live on it by design, never prunable. */
const SHARED_NETWORK = 'ninedeploy';

interface ContainerFact {
  name: string;
  state: string;
  image: string;
}

async function listAllContainers(): Promise<ContainerFact[]> {
  // F528: a failed `docker ps -a` must propagate. Swallowing it into [] made
  // every running service read as "container gone" (critical) and let the
  // sync_service fix flip healthy rows to error.
  const raw = await capture('docker', ['ps', '-a', '--format', '{{json .}}']);
  const out: ContainerFact[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as { Names?: string; State?: string; Image?: string };
      const name = (parsed.Names ?? '').replace(/^\//, '');
      if (name) out.push({ name, state: parsed.State ?? 'unknown', image: parsed.Image ?? '' });
    } catch {
      /* skip non-JSON line (CLI version differences) */
    }
  }
  return out;
}

interface DfFact {
  imagesBytes: number | null;
  volumesBytes: number | null;
  buildCacheBytes: number | null;
}

async function dockerDiskFacts(): Promise<DfFact> {
  const out: DfFact = { imagesBytes: null, volumesBytes: null, buildCacheBytes: null };
  try {
    const raw = await capture('docker', ['system', 'df', '--format', '{{json .}}']);
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const row = JSON.parse(t) as { Type?: string; Size?: string };
        const bytes = row.Size ? parseHumanBytes(row.Size) : 0;
        if (row.Type === 'Images') out.imagesBytes = bytes;
        if (row.Type === 'Volumes') out.volumesBytes = bytes;
        if (row.Type === 'Build Cache') out.buildCacheBytes = bytes;
      } catch {
        /* skip unparseable line */
      }
    }
  } catch {
    /* best-effort host facts */
  }
  return out;
}

/** Size of one volume via a throwaway alpine sidecar; 0 when it cannot be read. */
async function volumeSizeBytes(name: string): Promise<number> {
  try {
    const out = await capture('docker', ['run', '--rm', '-v', `${name}:/v:ro`, HELPER_IMAGE, 'sh', '-c', 'du -sb /v']);
    return Number(out.trim().split(/\s+/)[0]) || 0;
  } catch {
    return 0;
  }
}

const STUCK_DEPLOY_HOURS = 6;
const STUCK_DATABASE_HOURS = 1;
const BUILD_CACHE_NOISE_BYTES = 1024 * 1024 * 1024;
const MAX_SIZED_ORPHAN_VOLUMES = 20;

function ageHours(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return 0;
  return (Date.now() - t) / 3_600_000;
}

/** Addresses only this host can reach. */
function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * r575: the panel itself speaks plain HTTP on NINEDEPLOY_HOST:NINEDEPLOY_PORT
 * (TLS is Traefik's job, on :443). The bare-metal default binds 0.0.0.0, so a
 * fresh install answers http://<public-ip>:3000 and every login, refresh
 * token and API token that crosses it travels in cleartext. The default is
 * NOT changed (operators reach their panel that way today) — the Doctor says
 * so instead. Inside a container the listen address says nothing about
 * exposure (the compose file publishes the port on loopback by default), so
 * the check is a bare-metal one. Exported for its unit test; wired below.
 */
export function panelExposureFinding(
  host: string | undefined,
  port: number | undefined,
  inContainer: boolean,
): DoctorFinding | null {
  if (inContainer || !host || isLoopbackHost(host)) return null;
  const where = `${host}:${port ?? 3000}`;
  return {
    id: 'panel_plaintext_exposure',
    kind: 'panel_plaintext_exposure',
    severity: 'warn',
    title: `The panel listens on ${where} over plain HTTP`,
    detail:
      `NINEDEPLOY_HOST=${host} makes the panel's own port reachable from the network, and it speaks plain HTTP — ` +
      'passwords, session and API tokens that cross it can be read in transit. Reach the panel through HTTPS instead ' +
      '(attach a domain to it via Traefik on :443, or a tunnel), then set NINEDEPLOY_HOST=127.0.0.1 in .env and restart ' +
      'the service (sudo systemctl restart ninedeploy). If the port must stay open, firewall it to a trusted network.',
    target: { type: 'host', name: where, id: null },
    action: null,
    sizeBytes: null,
  };
}

/**
 * r600: sandbox plugins installed before 0.10.38 keep loading on a Node
 * without network permission support (refusing them would break working
 * installs on upgrade) — but the operator must know the "sandbox" does not
 * cover the network there. Only ENABLED sandbox rows count. Exported for its
 * unit test; wired below.
 */
export function sandboxNetworkFinding(
  rows: ReadonlyArray<{ id: string; enabled: boolean; manifest: unknown }>,
  networkDenied: boolean,
  nodeVersion: string = process.version,
): DoctorFinding | null {
  if (networkDenied) return null;
  const ids = rows
    .filter((r) => r.enabled && (r.manifest as Record<string, unknown> | null)?.['source'] === 'sandbox')
    .map((r) => r.id);
  if (ids.length === 0) return null;
  return {
    id: 'sandbox_plugin_network',
    kind: 'sandbox_plugin_network',
    severity: 'warn',
    title: `${ids.length} sandbox plugin(s) have unrestricted network access on Node ${nodeVersion}`,
    detail:
      `The plugin sandbox denies filesystem, child-process and worker access, but Node ${nodeVersion} has no ` +
      `network permission scope (it exists from Node 25), so ${ids.join(', ')} can open sockets and make HTTP ` +
      'requests from this host — including to private addresses. Upgrade Node.js to 25 or newer (the Docker image ' +
      'runs Node 26), or disable the plugins you do not fully trust in Settings → Plugins. New sandbox installs are ' +
      'refused on this Node unless NINEDEPLOY_ALLOW_SANDBOX_NETWORK=1 is set.',
    target: { type: 'host', name: ids.join(','), id: null },
    action: null,
    sizeBytes: null,
  };
}

/**
 * r620: stored repository analyses whose `nodeVersion` is not a Node version.
 * Before 0.10.41 a symlinked `.nvmrc` in a repo could make the panel store
 * (and show) host file content there — its own environment included. The
 * API no longer returns such values, but if one exists the secrets it may
 * have exposed must be treated as compromised. Exported for its unit test.
 */
export function insightsLeakFinding(serviceIds: readonly number[]): DoctorFinding | null {
  if (serviceIds.length === 0) return null;
  return {
    id: 'repo_insights_leak',
    kind: 'repo_insights_leak',
    severity: 'critical',
    title: `Repository analysis stored data that is not a Node version (${serviceIds.length} service(s))`,
    detail:
      'Before 0.10.41, a repository could make the panel read a host file through a symlinked .nvmrc and show its ' +
      "content as the Node version — including the panel's own environment (JWT secret, master key when set via env). " +
      `Stored analyses for service id(s) ${serviceIds.join(', ')} hold such content. Treat these secrets as exposed: ` +
      'set a new NINEDEPLOY_JWT_SECRET (signs every session out), add a new master key to NINEDEPLOY_MASTER_KEYS and run ' +
      '`ninedeploy system rotate-keys`, rotate any registry/git/S3 credentials stored in the panel, review ' +
      'who owns those services, then re-run repository analysis (or redeploy) so the stored rows are rewritten.',
    target: { type: 'host', name: serviceIds.join(','), id: null },
    action: null,
    sizeBytes: null,
  };
}

/**
 * r655: a remote template registry fetched over plain http. Settings has only
 * accepted https for new values, but a value stored before that — or set via
 * NINEDEPLOY_TEMPLATES_SOURCE — still loads, unauthenticated and without
 * integrity. It keeps working (refusing it would empty the Hub on upgrade);
 * the operator is told. Exported for its unit test; wired below.
 */
export function templatesSourceFinding(source: string | null): DoctorFinding | null {
  if (!source || !/^http:\/\//i.test(source)) return null;
  return {
    id: 'templates_source_plaintext',
    kind: 'templates_source_plaintext',
    severity: 'warn',
    title: 'The Hub template registry is fetched over plain HTTP',
    detail:
      `The template source ${source} is downloaded without TLS, so anyone on the network path can replace the ` +
      'catalog the Hub deploys from (images, commands, environment defaults). Switch it to an https:// URL in ' +
      'Settings → Hub (or NINEDEPLOY_TEMPLATES_SOURCE), or point it at a bundle file inside the data directory.',
    target: { type: 'host', name: 'templates_source', id: null },
    action: null,
    sizeBytes: null,
  };
}

export async function scanDoctor(db: DB): Promise<DoctorReport> {
  const findings: DoctorFinding[] = [];
  const finding = (
    f: Pick<DoctorFinding, 'id' | 'kind' | 'severity' | 'title' | 'detail'> & {
      target: DoctorFinding['target'];
      action?: DoctorActionKind | null;
      sizeBytes?: number | null;
    },
  ): void => {
    findings.push({ ...f, action: f.action ?? null, sizeBytes: f.sizeBytes ?? null });
  };

  const [allContainers, df] = await Promise.all([listAllContainers(), dockerDiskFacts()]);
  const containerByName = new Map(allContainers.map((c) => [c.name, c]));

  const [svcs, dbs, volumeAttachments, activeDeploys] = await Promise.all([
    db.select().from(services),
    db.select().from(databases),
    db.select().from(serviceVolumeAttachments),
    db.select().from(deployments),
  ]);
  const activeDeployRows = activeDeploys.filter((d) => d.status === 'queued' || d.status === 'building');
  const runtimeIds = new Set(svcs.map((s) => s.runtimeId).filter((r): r is string => Boolean(r)));
  const dbContainerNames = new Set(dbs.map((d) => d.containerName).filter(Boolean) as string[]);
  // F529: a compose runtimeId names only the stack's MAIN container; its
  // siblings are `ndcmp-<slug>-<service>-<n>`. A prefix can over-claim (slug
  // `web` vs `web-api`) — the safe side for a removal offer.
  const composePrefixes = svcs.filter((s) => s.slug).map((s) => `ndcmp-${s.slug}-`);
  const swarmTaskPrefixes = svcs.filter((s) => isSwarmRuntimeId(s.runtimeId)).map((s) => `${s.runtimeId}.`);

  // ── containers: dead Hub junk + rows that lie about reality ─────────────
  for (const c of allContainers) {
    if (!isHubContainerName(c.name)) continue;
    if (c.state === 'running' || c.state === 'restarting') continue;
    if (runtimeIds.has(c.name) || dbContainerNames.has(c.name)) continue;
    if (composePrefixes.some((p) => c.name.startsWith(p))) continue;
    // 0.16 T7: an exited Swarm task (`nd-<slug>_web.<slot>.<task>`) is Swarm's task history, not deploy junk.
    if (swarmTaskPrefixes.some((p) => c.name.startsWith(p))) continue;
    finding({
      id: `exited_container:${c.name}`,
      kind: 'exited_container',
      severity: 'info',
      title: `Exited container ${c.name}`,
      detail: `Left over from a previous deploy (image ${c.image}, state ${c.state}). No service or database row claims it.`,
      target: { type: 'container', name: c.name, id: null },
      action: 'remove_container',
    });
  }

  for (const s of svcs) {
    if (s.status !== 'running' || !s.runtimeId) continue;
    // r228: only a LOCAL docker runtime is visible in this host's container
    // list. A PM2 process name and a container on a remote node were always
    // "gone" here — reported critical, and the one-click sync then flipped a
    // healthy service to `error`.
    if (!isLocalContainerRuntime(s)) continue;
    const c = containerByName.get(s.runtimeId);
    if (c && (c.state === 'running' || c.state === 'restarting')) continue;
    finding({
      id: `service_runtime_desync:${s.id}`,
      kind: 'service_runtime_desync',
      severity: 'critical',
      title: `Service "${s.name}" claims to be running but its container is ${c ? c.state : 'gone'}`,
      detail: `The panel will keep routing (or 502) against a runtime that is not there. Sync the row to reality, then redeploy the service.`,
      target: { type: 'service', name: s.name, id: s.id },
      action: 'sync_service',
    });
  }

  for (const d of dbs) {
    if (!d.containerName) continue;
    const c = containerByName.get(d.containerName);
    const up = c ? c.state === 'running' || c.state === 'restarting' : await containerRunning(d.containerName);
    if (d.status === 'running' && !up) {
      finding({
        id: `database_down:${d.id}`,
        kind: 'database_down',
        severity: 'warn',
        title: `Database "${d.name}" is marked running but the container is ${c ? c.state : 'gone'}`,
        detail: 'Every attached service is failing its connections. Start it again from here or the database panel.',
        target: { type: 'database', name: d.name, id: d.id },
        action: 'start_database',
      });
    }
    if (d.status === 'creating' && ageHours((d as unknown as { updatedAt?: Date | string }).updatedAt ?? d.createdAt) >= STUCK_DATABASE_HOURS) {
      finding({
        id: `database_stuck:${d.id}`,
        kind: 'database_stuck',
        severity: 'warn',
        title: `Database "${d.name}" has been stuck creating for ${Math.round(ageHours((d as unknown as { updatedAt?: Date | string }).updatedAt ?? d.createdAt))}h`,
        detail: 'Provisioning never finished. Mark it errored so it can be retried or deleted cleanly.',
        target: { type: 'database', name: d.name, id: d.id },
        action: 'mark_database_error',
      });
    }
  }

  for (const dep of activeDeployRows) {
    if (ageHours(dep.createdAt) < STUCK_DEPLOY_HOURS) continue;
    finding({
      id: `stuck_deployment:${dep.id}`,
      kind: 'stuck_deployment',
      severity: 'warn',
      title: `Deployment #${dep.id} stuck in "${dep.status}" for ${Math.round(ageHours(dep.createdAt))}h`,
      detail: 'No live worker can still be progressing on it. Cancel it so the service can deploy again.',
      target: { type: 'deployment', name: `#${dep.id}`, id: dep.id },
      action: 'cancel_deployment',
    });
  }

  // ── volumes: managed names nobody owns any more ──────────────────────────
  const orphanVolumes = (await listManagedVolumeNames())
    .map((name) => ({ name, owner: resolveVolumeOwner(svcs, dbs, name, volumeAttachments) }))
    .filter((v) => v.owner === null);
  let sized = 0;
  for (const v of orphanVolumes) {
    let sizeBytes: number | null = null;
    let origin = '';
    if (sized < MAX_SIZED_ORPHAN_VOLUMES) {
      sized++;
      sizeBytes = await volumeSizeBytes(v.name);
    }
    const labels = await volumeLabels(v.name);
    if (labels['ninedeploy.managed'] === 'database') {
      const prev = labels['ninedeploy.database.name'] ?? labels['ninedeploy.database.slug'];
      origin = prev ? ` Previously "${prev}"${labels['ninedeploy.database.engine'] ? ` (${labels['ninedeploy.database.engine']})` : ''}.` : '';
    }
    finding({
      id: `orphan_volume:${v.name}`,
      kind: 'orphan_volume',
      severity: 'warn',
      title: `Retained volume ${v.name} has no owner`,
      detail: `No service or database row claims it, so it is pure disk weight — but the DATA survives deletion of its owner.${origin} Deleting is irreversible.`,
      target: { type: 'volume', name: v.name, id: null },
      action: 'delete_volume',
      sizeBytes,
    });
  }

  // ── networks: per-slug bridges / compose projects with nothing left ─────
  let userNetworks: Array<{ name: string; driver: string }> = [];
  try {
    userNetworks = await listUserNetworks();
  } catch {
    /* daemon hiccup — network findings are best-effort */
  }
  const serviceSlugs = new Set(svcs.map((s) => s.slug));
  for (const net of userNetworks) {
    if (net.name === SHARED_NETWORK || BUILT_IN_NETWORKS.has(net.name)) continue;
    // Compose networks are `ndcmp-<slug>_default` (lib/serviceBridge.ts) —
    // strip the project suffix before the ownership check or every healthy
    // compose stack reads as an orphan, and a stopped-but-existing stack's
    // network becomes an actionable delete.
    const slug = net.name.startsWith('nd-svc-')
      ? net.name.slice('nd-svc-'.length)
      : net.name.startsWith('ndcmp-')
        ? net.name.slice('ndcmp-'.length).replace(/_default$/, '')
        : null;
    if (slug === null) continue;
    if (serviceSlugs.has(slug)) continue;
    let members: string[] = [];
    try {
      members = await networkMembers(net.name);
    } catch {
      continue; // already gone
    }
    finding({
      id: `orphan_network:${net.name}`,
      kind: 'orphan_network',
      severity: 'info',
      title: `Network ${net.name} has no owner${members.length ? ` but still holds ${members.length} container(s)` : ''}`,
      detail: members.length
        ? `Containers (${members.slice(0, 5).join(', ')}${members.length > 5 ? ', …' : ''}) still sit on it; nothing in the panel claims the network any more.`
        : 'An empty leftover from a deleted service or compose project.',
      target: { type: 'network', name: net.name, id: null },
      action: members.length ? null : 'remove_network',
    });
  }

  // ── bloat: dangling images, build cache, disk pressure ───────────────────
  let danglingBytes = 0;
  let danglingCount = 0;
  try {
    const raw = await capture('docker', ['images', '--format', '{{json .}}']);
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const img = JSON.parse(t) as { Repository?: string; Size?: string };
        if (img.Repository === '<none>') {
          danglingCount++;
          danglingBytes += img.Size ? parseHumanBytes(img.Size) : 0;
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* best-effort */
  }
  if (danglingCount > 0) {
    finding({
      id: 'dangling_images',
      kind: 'dangling_images',
      severity: 'info',
      title: `${danglingCount} dangling image layer(s) (~${Math.round(danglingBytes / (1024 * 1024))} MB)`,
      detail: 'Untagged leftovers of past builds. Removing them can never break a running container.',
      target: { type: 'image', name: null, id: null },
      action: 'prune_dangling_images',
      sizeBytes: danglingBytes,
    });
  }
  if ((df.buildCacheBytes ?? 0) > BUILD_CACHE_NOISE_BYTES) {
    finding({
      id: 'build_cache',
      kind: 'build_cache',
      severity: 'info',
      title: `Builder cache holds ~${Math.round((df.buildCacheBytes ?? 0) / (1024 * 1024 * 1024))} GB`,
      detail: 'Old build layers older than 7 days can be dropped without affecting current deploys.',
      target: { type: 'host', name: 'build-cache', id: null },
      action: 'prune_build_cache',
      sizeBytes: df.buildCacheBytes,
    });
  }

  const disk = getDiskUsage();
  if (disk.diskUsedPercent >= 80) {
    finding({
      id: 'disk_pressure',
      kind: 'disk_pressure',
      severity: disk.diskUsedPercent >= 90 ? 'critical' : 'warn',
      title: `Disk is ${disk.diskUsedPercent}% full (${Math.round(disk.diskFreeBytes / (1024 * 1024 * 1024))} GB free)`,
      detail: 'Free space first: delete orphan volumes / dangling images above, or run the age-filtered auto-prune.',
      target: { type: 'host', name: 'disk', id: null },
      action: 'run_autoprune',
    });
  }

  // r575: plaintext panel port on a non-loopback address.
  const exposure = panelExposureFinding(config.host, config.port, existsSync('/.dockerenv'));
  if (exposure) findings.push(exposure);

  // r600: grandfathered sandbox plugins on a Node that cannot deny network.
  const pluginRows = await db
    .select({ id: installedPlugins.id, enabled: installedPlugins.enabled, manifest: installedPlugins.manifest })
    .from(installedPlugins);
  const sandboxNet = sandboxNetworkFinding(pluginRows, SandboxPlugin.networkDenied());
  if (sandboxNet) findings.push(sandboxNet);

  // r620: stored analyses that captured host file content through a symlink.
  const insightRows = await db.select().from(repoInsights);
  const leak = insightsLeakFinding(insightRows.filter(storedInsightsLeakSuspected).map((r) => r.serviceId));
  if (leak) findings.push(leak);

  // r655: a plaintext remote template registry (stored before https-only, or env).
  const templatesSource = (await getSettingString(db, 'templates_source', null).catch(() => null))
    ?? config.templatesSource ?? null;
  const plaintextTemplates = templatesSourceFinding(templatesSource);
  if (plaintextTemplates) findings.push(plaintextTemplates);

  // ── stored slugs that violate the canonical contract ────────────────────
  // r028/r029 fixed slugify() for NEW rows; this catches rows already written
  // by older builds. A stored slug the `slug` schema rejects is a record the
  // API refuses to round-trip (PATCH of its own value 400s).
  const slugRows = await Promise.all([
    db.select({ id: services.id, slug: services.slug, name: services.name }).from(services),
    db.select({ id: databases.id, slug: databases.slug, name: databases.name }).from(databases),
    db.select({ id: tunnels.id, slug: tunnels.slug, name: tunnels.name }).from(tunnels),
    db.select({ id: projects.id, slug: projects.slug, name: projects.name }).from(projects),
    db.select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name }).from(workspaces),
    db
      .select({ id: oidcProviders.id, slug: oidcProviders.slug, name: oidcProviders.name })
      .from(oidcProviders),
  ]);
  const slugTargets: Array<{ table: SlugTable; targetType: DoctorTargetType; rows: SlugRow[] }> = [
    { table: 'services', targetType: 'service', rows: slugRows[0] },
    { table: 'databases', targetType: 'database', rows: slugRows[1] },
    { table: 'tunnels', targetType: 'tunnel', rows: slugRows[2] },
    { table: 'projects', targetType: 'project', rows: slugRows[3] },
    { table: 'workspaces', targetType: 'workspace', rows: slugRows[4] },
    { table: 'oidc_providers', targetType: 'oidc_provider', rows: slugRows[5] },
  ];
  for (const { table, targetType, rows } of slugTargets) {
    for (const v of auditSlugRows(table, rows)) {
      finding({
        id: `invalid_slug:${table}:${v.id}`,
        kind: 'invalid_slug',
        severity: 'warn',
        title: `Invalid slug on ${slugTableInfo(table).label} #${v.id}`,
        detail: v.dockerBound
          ? // Not auto-repairable: the slug is also the live Docker identity.
            // Rewriting the row alone would strand `nd-svc-<slug>-data` (which
            // holds the service's real data) and its bridge under the old name.
            `${slugTableInfo(table).label} #${v.id} stores slug ${JSON.stringify(v.current)} (${v.reason}), which the canonical slug contract rejects. This slug is also the container/bridge/volume name, so it cannot be renamed by the Doctor without orphaning live storage — rename the ${slugTableInfo(table).label} so its slug is regenerated, or correct it directly and recreate the bridge and volume under the new name.`
          : `${slugTableInfo(table).label} #${v.id} stores slug ${JSON.stringify(v.current)} (${v.reason}), which the canonical slug contract rejects. Repair rewrites it to ${JSON.stringify(v.recommended)}.`,
        target: { type: targetType, name: v.current, id: v.id },
        // Only DB-only identifiers get an automated repair.
        action: v.dockerBound || v.recommended === null ? null : 'repair_slug',
      });
    }
  }

  const totals = {
    findings: findings.length,
    critical: findings.filter((f) => f.severity === 'critical').length,
    warn: findings.filter((f) => f.severity === 'warn').length,
    info: findings.filter((f) => f.severity === 'info').length,
    reclaimableBytes: findings.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0),
  };

  return {
    generatedAt: new Date().toISOString(),
    healthy: totals.critical === 0 && totals.warn === 0,
    totals: { ...totals, findings: findings.length },
    host: {
      ...disk,
      dockerImagesBytes: df.imagesBytes,
      dockerVolumesBytes: df.volumesBytes,
      dockerBuildCacheBytes: df.buildCacheBytes,
    },
    findings,
  };
}

export interface DoctorFixResult {
  fixed: true;
  id: string;
  action: DoctorActionKind;
  log: string[];
}

/**
 * Execute the repair for `findingId` — located against a FRESH scan, so a
 * stale report cannot drive an action at a target that stopped qualifying.
 * Returns null when the finding is gone (already fixed or state moved on).
 */
export async function fixDoctorFinding(
  db: DB,
  findingId: string,
  log: (line: string) => void,
): Promise<DoctorFixResult | null> {
  const report = await scanDoctor(db);
  const finding = report.findings.find((f) => f.id === findingId);
  if (!finding || !finding.action) return null;
  const out: string[] = [];
  const collect = (line: string) => {
    out.push(line);
    log(line);
  };

  switch (finding.action) {
    // "State moved on" refusals throw conflict() — the caller's report is stale
    // by definition, and the API contract (module docs + CHANGELOG) promises a
    // 409 with the reason, not a 500. Genuine docker failures below stay plain
    // Errors so they surface as 500s.
    case 'remove_container': {
      const name = finding.target.name ?? '';
      if (!isHubContainerName(name)) throw new Error('refusing to remove a non-Hub container');
      const c = (await listAllContainers()).find((x) => x.name === name);
      if (!c) throw conflict(`Container ${name} is already gone — re-scan and retry.`);
      if (c.state === 'running') throw conflict(`Container ${name} is running again — something claimed it, so it is no longer removable here.`);
      await run('docker', ['rm', '-f', name], {}, collect);
      break;
    }
    case 'delete_volume': {
      const name = finding.target.name ?? '';
      if (!name.startsWith('nd-svc-') && !name.startsWith('nd-db-')) throw new Error('refusing to remove a non-managed volume');
      const [svcs, dbs, atts] = await Promise.all([
        db.select().from(services),
        db.select().from(databases),
        db.select().from(serviceVolumeAttachments),
      ]);
      if (resolveVolumeOwner(svcs, dbs, name, atts)) throw conflict(`Volume ${name} gained an owner — refusing to delete it.`);
      await removeVolume(name, collect);
      // removeVolume tolerates a failed `docker volume rm` (e.g. the volume is
      // still mounted by a container); reporting success while the volume
      // survived would be a lie, so verify the removal actually landed.
      if (await volumeExists(name)) {
        throw conflict(`Volume ${name} could not be deleted — it is likely still in use by a container. Remove the container first, then re-scan.`);
      }
      break;
    }
    case 'remove_network': {
      const name = finding.target.name ?? '';
      if (name === SHARED_NETWORK || BUILT_IN_NETWORKS.has(name)) throw conflict(`Network ${name} is protected and can never be removed here.`);
      await run('docker', ['network', 'rm', name], {}, collect);
      break;
    }
    case 'prune_dangling_images': {
      const outText = await capture('docker', ['image', 'prune', '-f']);
      collect(`image prune: ${parseReclaimedBytes(outText)} bytes reclaimed`);
      break;
    }
    case 'prune_build_cache': {
      const outText = await capture('docker', ['builder', 'prune', '-af', '--filter', 'until=168h']);
      collect(`builder prune: ${parseReclaimedBytes(outText)} bytes reclaimed`);
      break;
    }
    case 'run_autoprune': {
      const result = await executeAutoPrune(db);
      collect(`auto-prune freed ${result.freedBytes} bytes (disk now ${result.diskUsedPercentAfter}%)`);
      break;
    }
    case 'start_database': {
      const id = finding.target.id;
      if (id == null) throw new Error('missing database id');
      const [row] = await db.select().from(databases).where(eq(databases.id, id));
      if (!row) throw conflict(`Database #${id} is gone — re-scan and retry.`);
      await startDatabase(row, collect);
      break;
    }
    case 'mark_database_error': {
      const id = finding.target.id;
      if (id == null) throw new Error('missing database id');
      await db.update(databases).set({ status: 'error' }).where(eq(databases.id, id));
      collect(`database #${id} marked errored`);
      break;
    }
    case 'sync_service': {
      const id = finding.target.id;
      if (id == null) throw new Error('missing service id');
      const [row] = await db.select().from(services).where(eq(services.id, id));
      if (!row) throw conflict(`Service #${id} is gone — re-scan and retry.`);
      if (!isLocalContainerRuntime(row)) {
        throw conflict(`Service "${row.name}" does not run in a local container — the doctor cannot judge its runtime.`);
      }
      if (row.runtimeId && (await containerRunning(row.runtimeId))) {
        throw conflict(`Container ${row.runtimeId} is back up — the service no longer needs a sync. Re-scan instead.`);
      }
      await db.update(services).set({ status: 'error' }).where(eq(services.id, id));
      collect(`service "${row.name}" synced to error — redeploy it from the service page`);
      break;
    }
    case 'repair_slug': {
      // finding.id is `invalid_slug:<table>:<rowId>`. Re-derive the target from
      // the id and re-audit from FRESH rows, so a stale report can never write
      // a slug that has meanwhile become valid (or collide with a new sibling).
      const parts = finding.id.split(':');
      const table = parts[1] as SlugTable | undefined;
      const rowId = Number(parts[2]);
      if (!table || !Number.isInteger(rowId)) throw new Error(`malformed invalid_slug id: ${finding.id}`);
      // Only pure-DB identifiers are repairable here. A service/database/tunnel
      // slug is also its bridge/container/volume name, so rewriting the row
      // would orphan live storage — those findings carry action: null and can
      // never reach this branch, but the target list below is the real gate.
      const targets: Array<{ table: SlugTable; load: () => Promise<SlugRow[]>; write: (slug: string) => Promise<void> }> = [
        {
          table: 'projects',
          load: () => db.select({ id: projects.id, slug: projects.slug, name: projects.name }).from(projects),
          write: (slug) => db.update(projects).set({ slug }).where(eq(projects.id, rowId)).then(() => undefined),
        },
        {
          table: 'workspaces',
          load: () => db.select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name }).from(workspaces),
          write: (slug) => db.update(workspaces).set({ slug }).where(eq(workspaces.id, rowId)).then(() => undefined),
        },
        {
          table: 'oidc_providers',
          load: () => db.select({ id: oidcProviders.id, slug: oidcProviders.slug, name: oidcProviders.name }).from(oidcProviders),
          write: (slug) => db.update(oidcProviders).set({ slug }).where(eq(oidcProviders.id, rowId)).then(() => undefined),
        },
      ];
      const target = targets.find((t) => t.table === table);
      if (!target) {
        throw conflict(`${table} slugs name live Docker objects and cannot be repaired by renaming the row alone.`);
      }
      const rows = await target.load();
      const fresh = auditSlugRows(table, rows).find((v) => v.id === rowId);
      if (!fresh) throw conflict(`${table} #${rowId} no longer holds an invalid slug — re-scan instead.`);
      if (fresh.recommended === null) {
        throw conflict(`${table} #${rowId} has no collision-free replacement slug — fix it manually.`);
      }
      await target.write(fresh.recommended);
      collect(`${table} #${rowId} slug ${JSON.stringify(fresh.current)} -> ${JSON.stringify(fresh.recommended)}`);
      break;
    }
    case 'cancel_deployment': {
      const id = finding.target.id;
      if (id == null) throw new Error('missing deployment id');
      const [row] = await db.select().from(deployments).where(eq(deployments.id, id));
      if (!row) throw conflict(`Deployment #${id} is gone — re-scan and retry.`);
      if (row.status !== 'queued' && row.status !== 'building') {
        throw conflict(`Deployment #${id} moved to "${row.status}" on its own — re-scan instead of cancelling.`);
      }
      await db.update(deployments).set({ status: 'cancelled', finishedAt: new Date() }).where(eq(deployments.id, id));
      collect(`deployment #${id} cancelled`);
      break;
    }
  }

  return { fixed: true, id: finding.id, action: finding.action, log: out };
}
