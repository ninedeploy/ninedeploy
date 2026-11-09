import { and, eq, exists, inArray } from 'drizzle-orm';
import { deployments, services, settings, type DB, type Service } from '@ninedeploy/db';
import { restartLimitConfig, type RestartLimitConfig, type RestartLimitView } from '@ninedeploy/schemas';
import { pm2RestartCounts, pm2Stop } from '../engine/builders/pm2.js';
import { replicaNames } from '../engine/dockerNames.js';
import { capture } from './exec.js';
import { runtimeReplicaCounts } from './runtimeReplicaCounts.js';
import { getSettingJson, setSettingJson } from './settings.js';
import { settingRowsWithPrefix } from './settingRows.js';

/**
 * G1.3 restart-loop limit. Opt-in per service (`restart_limit:<id>`): a
 * docker service on the panel host whose containers restart `maxRestarts`
 * times within `windowMinutes`, or a PM2 service whose processes do, is stopped — as the Stop button would — and
 * `service.restart_limit` is audited, which notifies. A deploy in progress
 * is left alone (it restarts containers on purpose). Docker's own
 * `RestartCount` is the signal, or PM2's `restart_time` less the restarts the
 * panel asked for; a new container or process (a deploy) starts afresh.
 *
 * No migration: the limits are settings rows; the restart history is kept
 * in memory (a panel restart starts each window again).
 */

const PREFIX = 'restart_limit:';
const key = (serviceId: number) => `${PREFIX}${serviceId}`;

interface Stored extends RestartLimitConfig {
  trippedAt?: string | null;
}

function parseLimit(raw: Stored | null): Stored | null {
  const parsed = restartLimitConfig.safeParse(raw ? { maxRestarts: raw.maxRestarts, windowMinutes: raw.windowMinutes } : null);
  return parsed.success ? { ...parsed.data, trippedAt: raw?.trippedAt ?? null } : null;
}

export async function getRestartLimit(db: DB, serviceId: number): Promise<Stored | null> {
  return parseLimit(await getSettingJson<Stored>(db, key(serviceId), null));
}

const policyOwners = new WeakMap<DB, Map<number, object>>();
function replacePolicyOwner(db: DB, serviceId: number): void {
  let owners = policyOwners.get(db);
  if (!owners) {
    owners = new Map();
    policyOwners.set(db, owners);
  }
  owners.set(serviceId, {});
}

export async function setRestartLimit(db: DB, serviceId: number, limit: RestartLimitConfig | null): Promise<void> {
  if (limit === null) {
    await db.delete(settings).where(eq(settings.key, key(serviceId)));
    replacePolicyOwner(db, serviceId);
    history.delete(serviceId);
    return;
  }
  const prev = await getRestartLimit(db, serviceId);
  await setSettingJson(db, key(serviceId), { ...restartLimitConfig.parse(limit), trippedAt: prev?.trippedAt ?? null });
  replacePolicyOwner(db, serviceId);
}

/** Panel-host docker services and PM2 services; a Swarm service has no containers of its name, and nodes are not sampled. */
export function restartLimitSupported(svc: Pick<Service, 'type' | 'serverId' | 'orchestrator'>): boolean {
  return (svc.type === 'docker' || svc.type === 'pm2') && svc.serverId == null && svc.orchestrator !== 'swarm';
}

/** Per service: the last RestartCount seen per container id, and when restarts happened. */
const history = new Map<number, { counts: Map<string, number>; restarts: number[] }>();

export function restartLimitView(stored: Stored | null, serviceId: number, now = Date.now()): RestartLimitView {
  const h = history.get(serviceId);
  const since = now - (stored?.windowMinutes ?? 0) * 60_000;
  return {
    limit: stored ? { maxRestarts: stored.maxRestarts, windowMinutes: stored.windowMinutes } : null,
    recentRestarts: stored && h ? h.restarts.filter((t) => t >= since).length : 0,
    trippedAt: stored?.trippedAt ?? null,
  };
}

/**
 * Record a sample of `{containerId: RestartCount}` and say whether the limit
 * is reached. A container id seen for the first time only sets its baseline.
 */
export function recordRestarts(serviceId: number, sample: Map<string, number>, limit: RestartLimitConfig, now = Date.now()): boolean {
  const h = history.get(serviceId) ?? { counts: new Map<string, number>(), restarts: [] };
  history.set(serviceId, h);
  for (const [id, count] of sample) {
    const before = h.counts.get(id);
    if (before !== undefined && count > before) {
      for (let i = 0; i < Math.min(count - before, limit.maxRestarts); i++) h.restarts.push(now);
    }
    h.counts.set(id, count);
  }
  // Containers that are gone (a new deploy) drop out of the baseline.
  for (const id of [...h.counts.keys()]) if (!sample.has(id)) h.counts.delete(id);
  h.restarts = h.restarts.filter((t) => t >= now - limit.windowMinutes * 60_000);
  return h.restarts.length >= limit.maxRestarts;
}

export function resetRestartHistory(serviceId?: number): void {
  if (serviceId === undefined) history.clear();
  else history.delete(serviceId);
}

export interface RestartLimitDeps {
  /** `{containerId: RestartCount}` of a service's containers (default: docker inspect). */
  sample?: (names: string[]) => Promise<Map<string, number>>;
  stop?: (names: string[]) => Promise<void>;
  /** The same for a PM2 service, by process name (default: pm2 describe / pm2 stop). */
  samplePm2?: (runtimeId: string) => Promise<Map<string, number>>;
  stopPm2?: (runtimeId: string) => Promise<void>;
  onTripped?: (svc: Service, limit: RestartLimitConfig, restarts: number) => void;
}

async function inspectRestarts(names: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const name of names) {
    try {
      const line = (await capture('docker', ['inspect', '--format', '{{.Id}}|{{.RestartCount}}', name], { timeoutMs: 15_000 })).trim();
      const [id, count] = line.split('|');
      if (id && Number.isFinite(Number(count))) out.set(id, Number(count));
    } catch {
      /* not there (a replica not started, a removed container) */
    }
  }
  return out;
}

/** One pass over every service with a limit. Returns the ids it stopped. */
export async function enforceRestartLimits(db: DB, deps: RestartLimitDeps = {}, now = Date.now()): Promise<number[]> {
  const rows = await settingRowsWithPrefix(db, PREFIX);
  const ids = rows.map((r) => Number(r.key.slice(PREFIX.length))).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return [];
  const busy = new Set(
    (
      await db
        .select({ id: deployments.serviceId })
        .from(deployments)
        .where(and(inArray(deployments.serviceId, ids), inArray(deployments.status, ['queued', 'building', 'deploying'])))
    ).map((r) => r.id),
  );
  const stopped: number[] = [];
  for (const id of ids) {
    const svc = await db.query.services.findFirst({ where: eq(services.id, id) });
    const owner = policyOwners.get(db)?.get(id);
    const policy = await db.query.settings.findFirst({ where: eq(settings.key, key(id)) });
    let limit: Stored | null = null;
    try {
      limit = parseLimit((typeof policy?.value === 'object' ? policy.value : JSON.parse(String(policy?.value))) as Stored | null);
    } catch { /* invalid stored policy */ }
    if (!svc || !limit || !policy) continue;
    const pm2 = svc.type === 'pm2';
    if (!restartLimitSupported(svc) || !svc.runtimeId || svc.status !== 'running') {
      history.delete(id);
      continue;
    }
    if (busy.has(id)) continue;
    const runtimeId = svc.runtimeId;
    const names = pm2 ? [runtimeId] : replicaNames(runtimeId, runtimeReplicaCounts(svc).capacity);
    const sample = pm2 ? await (deps.samplePm2 ?? pm2RestartCounts)(runtimeId) : await (deps.sample ?? inspectRestarts)(names);
    if (policyOwners.get(db)?.get(id) !== owner) continue;
    const ownsPolicy = and(eq(settings.key, key(id)), eq(settings.value, policy.value));
    const currentPolicy = await db.select({ key: settings.key }).from(settings).where(ownsPolicy);
    if (policyOwners.get(db)?.get(id) !== owner || currentPolicy.length === 0) continue;
    if (!recordRestarts(id, sample, limit, now)) continue;
    const sampledHistory = history.get(id);
    const restarts = history.get(id)?.restarts.length ?? limit.maxRestarts;
    // As the Stop button: `stopped` first, so the runtime reconcile does not revive it.
    const admitted = await db.update(services).set({ status: 'stopped', asleepAt: null })
      .where(and(eq(services.id, id), exists(db.select({ key: settings.key }).from(settings).where(ownsPolicy))))
      .returning({ id: services.id });
    if (admitted.length === 0) continue;
    if (pm2) await (deps.stopPm2 ?? pm2Stop)(runtimeId).catch(() => undefined);
    else await (deps.stop ?? (async (n: string[]) => void (await capture('docker', ['stop', '-t', '5', ...n]).catch(() => undefined))))(names);
    if (policyOwners.get(db)?.get(id) === owner) {
      await db.update(settings).set({
        value: { maxRestarts: limit.maxRestarts, windowMinutes: limit.windowMinutes, trippedAt: new Date(now).toISOString() } as unknown as boolean,
        updatedAt: new Date(),
      }).where(ownsPolicy);
    }
    if (policyOwners.get(db)?.get(id) === owner && history.get(id) === sampledHistory) history.delete(id);
    deps.onTripped?.(svc, { maxRestarts: limit.maxRestarts, windowMinutes: limit.windowMinutes }, restarts);
    stopped.push(id);
  }
  return stopped;
}
