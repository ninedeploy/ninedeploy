import { statfsSync } from 'node:fs';
import type { DB } from '@ninedeploy/db';
import type { AutoPruneConfig, AutoPruneRunResult, AutoPruneStatus } from '@ninedeploy/schemas';
import { getSettingJson, getSettingString, setSettingJson, setSettingString } from '../lib/settings.js';
import { run } from '../lib/exec.js';
import { replicaNames } from './dockerNames.js';
import { config } from '../config.js';

export const DEFAULT_AUTOPRUNE_CONFIG: AutoPruneConfig = {
  enabled: true,
  thresholdPercent: 85,
  pruneImages: true,
  pruneVolumes: false,
  pruneContainers: true,
  pruneBuildCache: true,
  maxAgeHours: 168, // 7 days
};

export function parseReclaimedBytes(output: string): number {
  const match = /Total reclaimed space:\s*([\d.]+)\s*([KMGT]?B)/i.exec(output);
  if (!match) return 0;
  const val = parseFloat(match[1]!);
  const unit = match[2]!.toUpperCase();
  const mult: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
    TB: 1024 * 1024 * 1024 * 1024,
  };
  return Math.round(val * (mult[unit] as number));
}

export function getDiskUsage(targetPath: string = config.paths.dataDir): {
  diskUsedPercent: number;
  diskTotalBytes: number;
  diskFreeBytes: number;
} {
  try {
    const stats = statfsSync(targetPath);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    const used = total - free;
    const diskUsedPercent = Math.round((used / Math.max(total, 1)) * 100);
    return {
      diskUsedPercent,
      diskTotalBytes: total,
      diskFreeBytes: free,
    };
  } catch {
    // Fallback for mocked environments or platforms without statfs
    return {
      diskUsedPercent: 45,
      diskTotalBytes: 100 * 1024 * 1024 * 1024,
      diskFreeBytes: 55 * 1024 * 1024 * 1024,
    };
  }
}

export async function getAutoPruneStatus(db: DB): Promise<AutoPruneStatus> {
  const disk = getDiskUsage();
  const storedConfig = await getSettingJson<AutoPruneConfig>(db, 'autoprune_config');
  const lastPrunedAt = await getSettingString(db, 'autoprune_last_at', '');
  const lastFreedStr = await getSettingString(db, 'autoprune_last_freed', '');
  const lastFreedBytes = lastFreedStr ? Number(lastFreedStr) : null;

  const cfg: AutoPruneConfig = {
    ...DEFAULT_AUTOPRUNE_CONFIG,
    ...(storedConfig ?? {}),
  };

  return {
    ...cfg,
    ...disk,
    lastPrunedAt: lastPrunedAt || null,
    lastFreedBytes: lastFreedBytes || null,
  };
}

export async function saveAutoPruneConfig(db: DB, input: Partial<AutoPruneConfig>): Promise<AutoPruneStatus> {
  const current = await getAutoPruneStatus(db);
  const updated: AutoPruneConfig = {
    enabled: input.enabled ?? current.enabled,
    thresholdPercent:
      input.thresholdPercent !== undefined
        ? input.thresholdPercent
        : current.thresholdPercent,
    pruneImages: input.pruneImages ?? current.pruneImages,
    pruneVolumes: input.pruneVolumes ?? current.pruneVolumes,
    pruneContainers: input.pruneContainers ?? current.pruneContainers,
    pruneBuildCache: input.pruneBuildCache ?? current.pruneBuildCache,
    maxAgeHours:
      input.maxAgeHours !== undefined ? input.maxAgeHours : current.maxAgeHours,
  };

  await setSettingJson(db, 'autoprune_config', updated);
  return {
    ...current,
    ...updated,
  };
}

export type AutoPruneRunner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

/**
 * Container names the panel still owns: every service runtime (and its
 * replicas) plus the fixed `nd-*` / `ninedeploy-*` infrastructure names
 * (databases, tunnels, pgbouncer, studio, Traefik).
 */
async function panelContainerNames(db: DB): Promise<Set<string>> {
  const names = new Set<string>();
  const rows = await db.query.services.findMany({ columns: { runtimeId: true, replicas: true } });
  for (const r of rows) {
    if (r.runtimeId) for (const n of replicaNames(r.runtimeId, r.replicas ?? 1)) names.add(n);
  }
  return names;
}

const isInfraName = (name: string) => name.startsWith('nd-') || name.startsWith('ninedeploy');

/**
 * r166: remove stopped containers older than `maxAgeHours` that the panel does
 * NOT own. `docker container prune` could not tell them apart: a service the
 * user stopped from the panel is an exited container, so after a week at 85%
 * disk its container was deleted — the next "start" failed with "runtime
 * gone", and the following image prune took its rollback image too.
 */
async function pruneStoppedContainers(db: DB, runner: AutoPruneRunner, maxAgeHours: number): Promise<string> {
  const listed = await runner('docker', [
    'ps', '-a',
    '--filter', 'status=exited',
    '--filter', 'status=created',
    '--filter', 'status=dead',
    '--format', '{{.ID}}\t{{.Names}}\t{{.CreatedAt}}',
  ]);
  const owned = await panelContainerNames(db);
  const cutoff = Date.now() - maxAgeHours * 3_600_000;
  const victims: string[] = [];
  for (const line of listed.stdout.split('\n')) {
    const [id, name, createdAt] = line.trim().split('\t');
    if (!id || !name || !createdAt) continue;
    // `2026-09-18 08:12:13 +0300 +03` — the trailing zone abbreviation is not parseable.
    const created = Date.parse(createdAt.split(' ').slice(0, 3).join(' '));
    if (!Number.isFinite(created) || created > cutoff) continue;
    if (isInfraName(name) || owned.has(name)) continue;
    victims.push(id);
  }
  if (victims.length === 0) return '';
  await runner('docker', ['rm', ...victims]);
  return `Removed ${victims.length} stopped container${victims.length === 1 ? '' : 's'}`;
}

export async function executeAutoPrune(
  db: DB,
  overrideConfig?: Partial<AutoPruneConfig>,
  runner?: AutoPruneRunner,
): Promise<AutoPruneRunResult> {
  const defaultRunner: AutoPruneRunner = async (cmd, args) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    await run(cmd, args, {}, (line) => stdout.push(line), undefined);
    return { stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  };

  const actualRunner = runner ?? defaultRunner;
  const current = await getAutoPruneStatus(db);
  const cfg: AutoPruneConfig = {
    ...current,
    ...(overrideConfig ?? {}),
  };

  const filterUntil = `until=${cfg.maxAgeHours}h`;
  let totalFreed = 0;
  const details: AutoPruneRunResult['details'] = {};

  if (cfg.pruneImages) {
    try {
      const res = await actualRunner('docker', ['image', 'prune', '-af', '--filter', filterUntil]);
      totalFreed += parseReclaimedBytes(res.stdout);
      details.imagesFreed = res.stdout.trim() || 'No images pruned';
    } catch {
      details.imagesFreed = 'Prune images failed or skipped';
    }
  }

  if (cfg.pruneBuildCache) {
    try {
      const res = await actualRunner('docker', ['builder', 'prune', '-af', '--filter', filterUntil]);
      totalFreed += parseReclaimedBytes(res.stdout);
      details.buildCacheFreed = res.stdout.trim() || 'No build cache pruned';
    } catch {
      details.buildCacheFreed = 'Prune builder failed or skipped';
    }
  }

  if (cfg.pruneContainers) {
    try {
      const summary = await pruneStoppedContainers(db, actualRunner, cfg.maxAgeHours);
      details.containersFreed = summary || 'No containers pruned';
    } catch {
      details.containersFreed = 'Prune containers failed or skipped';
    }
  }

  if (cfg.pruneVolumes) {
    try {
      const res = await actualRunner('docker', ['volume', 'prune', '-f']);
      totalFreed += parseReclaimedBytes(res.stdout);
      details.volumesFreed = res.stdout.trim() || 'No volumes pruned';
    } catch {
      details.volumesFreed = 'Prune volumes failed or skipped';
    }
  }

  const nowIso = new Date().toISOString();
  await setSettingString(db, 'autoprune_last_at', nowIso);
  await setSettingString(db, 'autoprune_last_freed', String(totalFreed));

  const afterDisk = getDiskUsage();

  return {
    ok: true,
    freedBytes: totalFreed,
    diskUsedPercentAfter: afterDisk.diskUsedPercent,
    details,
  };
}

