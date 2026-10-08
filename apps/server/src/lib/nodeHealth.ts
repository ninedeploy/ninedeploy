import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { eq } from 'drizzle-orm';
import { servers, type DB } from '@ninedeploy/db';
import { config } from '../config.js';
import { agentOp, agentPing } from './agentClient.js';
import type { MetricSnapshot } from './alerting.js';
import { decrypt } from './crypto.js';
import { capture } from './exec.js';

/**
 * Inputs for the host-wide `disk` and `server_offline` alert metrics (0.12).
 *
 * Both are fleet-wide: one rule watches the panel host plus every remote
 * node, and the snapshot value is the WORST reading (highest disk %, longest
 * unseen node). `alert_state` holds one row per rule, so a per-node breakdown
 * rides in the snapshot's `detail` and is named in the fired notification.
 */

/** L07/F868: every docker CLI call the collector makes is bounded. */
export const DOCKER_INFO_TIMEOUT_MS = 10_000;
/** statfs on a hung network mount must not stall the collector tick. */
export const STATFS_TIMEOUT_MS = 5_000;
/** `docker info` is not re-run every 30 s tick; the data root rarely moves. */
export const DOCKER_ROOT_TTL_MS = 10 * 60_000;
/** Remote disk comes from the agent's `agent.stats` op (it also runs
 *  `docker stats` on the node), so it is sampled every 5 min, not every tick. */
export const REMOTE_DISK_EVERY_MS = 5 * 60_000;
/** A remote disk reading older than this is dropped (the node stopped answering). */
export const REMOTE_DISK_MAX_AGE_MS = 15 * 60_000;
/** agentOp's short-op budget is 10 min; a stats probe gets far less. */
export const REMOTE_STATS_TIMEOUT_MS = 30_000;

/** df's Use%: used / (used + available to unprivileged users), rounded up. */
export function usedPercent(total: number, free: number, avail: number): number | null {
  const used = total - free;
  const denom = used + avail;
  if (!Number.isFinite(denom) || denom <= 0 || used < 0) return null;
  return Math.min(100, Math.ceil((used / denom) * 100));
}

/** Parse one `df -kP` data row (the agent's `ND-DF` payload): fs total used avail cap mount. */
export function dfLinePercent(line: string): number | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 4) return null;
  const used = Number(parts[2]);
  const avail = Number(parts[3]);
  if (!Number.isFinite(used) || !Number.isFinite(avail)) return null;
  return usedPercent(used + avail, avail, avail);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, bound]).finally(() => clearTimeout(timer));
}

/** Percent used of the filesystem holding `dir`, or null when it cannot be read. */
export async function diskPercent(dir: string): Promise<number | null> {
  try {
    const st = await withTimeout(statfs(dir), STATFS_TIMEOUT_MS, `statfs ${dir}`);
    return usedPercent(Number(st.blocks), Number(st.bfree), Number(st.bavail));
  } catch {
    return null;
  }
}

let dockerRootCache: { path: string | null; at: number } | null = null;

/** Docker's data root as the daemon reports it (cached; null when unknown). */
export async function dockerDataRoot(now = Date.now()): Promise<string | null> {
  if (dockerRootCache && now - dockerRootCache.at < DOCKER_ROOT_TTL_MS) return dockerRootCache.path;
  let path: string | null = null;
  try {
    const out = (
      await capture('docker', ['info', '--format', '{{.DockerRootDir}}'], { timeoutMs: DOCKER_INFO_TIMEOUT_MS })
    ).trim();
    path = out && isAbsolute(out) ? out : null;
  } catch {
    path = null;
  }
  dockerRootCache = { path, at: now };
  return path;
}

/** Test seam: forget the cached docker data root. */
export function resetDockerRootCache(): void {
  dockerRootCache = null;
}

export interface DiskReading {
  /** Where the reading came from: `panel <dir>` or a node's name. */
  where: string;
  pct: number;
}

/**
 * The panel host's disk: the panel data dir, plus Docker's data root when it
 * is a different, locally visible path. In the container install the data dir
 * is a named volume, i.e. it already lives on Docker's data-root filesystem,
 * and the host path `docker info` reports is not mounted into the container —
 * so the data dir alone is the right reading there. On a bare-metal install
 * both paths are visible and both are measured.
 */
export async function panelDiskReadings(dataDir = config.paths.dataDir): Promise<DiskReading[]> {
  const dirs = [dataDir];
  const root = await dockerDataRoot();
  if (root && root !== dataDir && existsSync(root)) dirs.push(root);
  const out: DiskReading[] = [];
  for (const dir of dirs) {
    const pct = await diskPercent(dir);
    if (pct !== null) out.push({ where: `panel ${dir}`, pct });
  }
  return out;
}

/** Collapse readings into one `disk` snapshot (worst reading wins). */
export function diskSnapshot(readings: DiskReading[]): MetricSnapshot | null {
  if (readings.length === 0) return null;
  const sorted = [...readings].sort((a, b) => b.pct - a.pct);
  return {
    serviceId: null,
    kind: 'disk',
    value: sorted[0]!.pct,
    detail: sorted.map((r) => `${r.where} ${r.pct}%`).join(', '),
  };
}

export interface WatchedNode {
  id: number;
  name: string;
  lastSeenAt: Date | null;
}

/**
 * The `server_offline` snapshot: whole minutes (rounded up) the longest-unseen
 * node has gone without contact, so `> N` reads "unseen for more than N
 * minutes". Unseen time is counted from `watchSince` at the earliest — the
 * moment this panel process completed its first ping cycle — so a panel that
 * was itself down (an upgrade, a reboot) never fires for the time it was not
 * watching. Nodes that have never connected are not watched. The snapshot is
 * emitted even with no nodes (value 0), so deleting the node an alert fired
 * for recovers the rule instead of leaving it stuck.
 */
export function offlineSnapshot(nodes: WatchedNode[], now: Date, watchSince: Date): MetricSnapshot {
  const unseen = nodes
    .filter((n) => n.lastSeenAt !== null)
    .map((n) => {
      const since = Math.max(n.lastSeenAt!.getTime(), watchSince.getTime());
      return { name: n.name, minutes: Math.max(0, Math.ceil((now.getTime() - since) / 60_000)) };
    })
    .filter((n) => n.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes);
  return {
    serviceId: null,
    kind: 'server_offline',
    value: unseen[0]?.minutes ?? 0,
    ...(unseen.length > 0 ? { detail: unseen.map((n) => `${n.name} unseen ${n.minutes} min`).join(', ') } : {}),
  };
}

export interface NodeHealthDeps {
  ping: (host: string, port: number, token: string) => Promise<void>;
  stats: (db: DB, serverId: number) => Promise<string[]>;
  panelDisk: () => Promise<DiskReading[]>;
}

const defaultDeps: NodeHealthDeps = {
  ping: agentPing,
  stats: async (db, serverId) =>
    (
      await withTimeout(
        // tolerateExit: agent.stats exits non-zero when `docker stats` fails
        // on the node, but its ND-DF line is still valid.
        agentOp(db, serverId, 'agent.stats', {}, () => undefined, { tolerateExit: true }),
        REMOTE_STATS_TIMEOUT_MS,
        'agent.stats',
      )
    ).lines,
  panelDisk: () => panelDiskReadings(),
};

/**
 * One watcher per collector. Each `cycle` (every collector tick):
 *  1. pings every registered (non-pending) node with the sealed agent.ping and
 *     stamps `servers.last_seen_at` on success — nodes added by SSH bootstrap
 *     or manual registration run without NINEDEPLOY_MASTER_URL and never
 *     heartbeat, so the panel's own probe is what keeps them "seen";
 *  2. refreshes each reachable node's disk reading every REMOTE_DISK_EVERY_MS;
 *  3. returns the `disk` and `server_offline` snapshots.
 */
export function createNodeHealthWatch(deps: Partial<NodeHealthDeps> = {}) {
  const d: NodeHealthDeps = { ...defaultDeps, ...deps };
  let watchSince: Date | null = null;
  const remoteDisk = new Map<number, { name: string; pct: number; at: number }>();
  const lastDiskPoll = new Map<number, number>();
  const inFlight = new Set<number>();

  async function pollDisk(db: DB, node: { id: number; name: string }, nowMs: number): Promise<void> {
    if (inFlight.has(node.id)) return;
    const last = lastDiskPoll.get(node.id);
    if (last !== undefined && nowMs - last < REMOTE_DISK_EVERY_MS) return;
    lastDiskPoll.set(node.id, nowMs);
    inFlight.add(node.id);
    try {
      const lines = await d.stats(db, node.id);
      const df = lines.find((l) => l.startsWith('ND-DF '));
      const pct = df ? dfLinePercent(df.slice('ND-DF '.length)) : null;
      if (pct !== null) remoteDisk.set(node.id, { name: node.name, pct, at: nowMs });
    } catch {
      /* unreachable / old agent: the reading ages out */
    } finally {
      inFlight.delete(node.id);
    }
  }

  return {
    async cycle(db: DB, now = new Date()): Promise<MetricSnapshot[]> {
      const nowMs = now.getTime();
      const out: MetricSnapshot[] = [];

      let rows: Array<{ id: number; name: string; host: string; port: number; status: string; tokenEncrypted: string; lastSeenAt: Date | null }> = [];
      let nodesKnown = true;
      try {
        rows = await db.query.servers.findMany();
      } catch {
        nodesKnown = false;
      }
      // A pending node was announced but never approved — not part of the fleet.
      const nodes = rows.filter((r) => r.status !== 'pending');
      const ids = new Set(nodes.map((n) => n.id));
      // A deleted (or un-approved) node must not keep a reading alive.
      for (const id of [...remoteDisk.keys()]) if (!ids.has(id)) remoteDisk.delete(id);
      for (const id of [...lastDiskPoll.keys()]) if (!ids.has(id)) lastDiskPoll.delete(id);

      const reachable = await Promise.all(
        nodes.map(async (n) => {
          try {
            await d.ping(n.host, n.port, decrypt(n.tokenEncrypted));
          } catch {
            return null;
          }
          try {
            await db.update(servers).set({ lastSeenAt: now }).where(eq(servers.id, n.id));
          } catch {
            /* the reading below still counts this tick */
          }
          n.lastSeenAt = now;
          return n;
        }),
      );
      await Promise.all(
        reachable.filter((n): n is (typeof nodes)[number] => n !== null).map((n) => pollDisk(db, n, nowMs)),
      );

      const readings = await d.panelDisk().catch(() => [] as DiskReading[]);
      for (const r of remoteDisk.values()) {
        if (nowMs - r.at <= REMOTE_DISK_MAX_AGE_MS) readings.push({ where: r.name, pct: r.pct });
      }
      const disk = diskSnapshot(readings);
      if (disk) out.push(disk);

      // The first completed cycle starts the offline clock (see offlineSnapshot).
      if (nodesKnown) {
        watchSince ??= now;
        out.push(offlineSnapshot(nodes, now, watchSince));
      }
      return out;
    },
  };
}
