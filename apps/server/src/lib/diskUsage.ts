import { type DB, serviceVolumeAttachments, services } from '@ninedeploy/db';
import { capture } from './exec.js';
import { primaryServiceVolumeName } from './retainedSlugVolume.js';
import { type MetricInput, persistServiceMetrics } from './serviceMetricHistory.js';

/**
 * Disk use per service for the usage report (ROADMAP item 9): once an hour,
 * the size of the volumes each service mounts (its primary data volume and
 * its attached volumes) is stored as a `disk` metric (bytes), next to the
 * collector's CPU and memory samples and kept as long as they are.
 *
 * The panel host's sizes come from one `docker system df -v`; a node's from
 * its agent (`docker.volumeSize`), one call per volume. A volume that cannot
 * be measured makes the service's sample unavailable for that hour; a partial
 * volume total must never be stored as the complete service total.
 */

/** How often disk is sampled: each sample stands for this long in the usage report. */
export const DISK_SAMPLE_SECONDS = 3600;

const UNITS: Record<string, number> = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15 };

/** Docker's decimal human size (`1.234GB`, `0B`) in bytes; null when unreadable. */
export function parseDockerSize(value: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([kKMGTP]?B)$/.exec(value.trim());
  if (!m) return null;
  const unit = UNITS[m[2]!];
  return unit === undefined ? null : Math.round(Number(m[1]) * unit);
}

/** Every panel-host volume's size, by name (one `docker system df -v`). */
export async function panelVolumeSizes(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const raw = await capture('docker', ['system', 'df', '-v', '--format', '{{json .Volumes}}'], { timeoutMs: 120_000, maxOutputBytes: 8 << 20 });
  let list: unknown;
  try {
    list = JSON.parse(raw.trim() || '[]');
  } catch {
    return out;
  }
  for (const v of Array.isArray(list) ? list : []) {
    const name = (v as { Name?: unknown }).Name;
    const size = (v as { Size?: unknown }).Size;
    if (typeof name !== 'string' || typeof size !== 'string') continue;
    const bytes = parseDockerSize(size);
    if (bytes !== null) out.set(name, bytes);
  }
  return out;
}

export interface DiskSamplerDeps {
  panelSizes?: () => Promise<Map<string, number>>;
  /** A node volume's size in bytes, or null when it cannot be measured. */
  nodeSize?: (serverId: number, volume: string) => Promise<number | null>;
}

/** One hourly sample: the bytes each service's volumes hold. Returns how many services were sampled. */
export async function sampleServiceDisk(db: DB, deps: DiskSamplerDeps = {}, now = new Date()): Promise<number> {
  const rows = await db.select({ id: services.id, slug: services.slug, serverId: services.serverId, volumeMount: services.volumeMount }).from(services);
  const attachments = await db.select({ serviceId: serviceVolumeAttachments.serviceId, volumeName: serviceVolumeAttachments.volumeName }).from(serviceVolumeAttachments);
  const volumesOf = new Map<number, Set<string>>();
  for (const s of rows) if (s.volumeMount) volumesOf.set(s.id, new Set([primaryServiceVolumeName(s.slug)]));
  for (const a of attachments) {
    const set = volumesOf.get(a.serviceId) ?? new Set<string>();
    set.add(a.volumeName);
    volumesOf.set(a.serviceId, set);
  }
  if (volumesOf.size === 0) return 0;

  let panel: Map<string, number> | null = null;
  const sample: MetricInput[] = [];
  for (const s of rows) {
    const volumes = volumesOf.get(s.id);
    if (!volumes) continue;
    let total = 0;
    let complete = true;
    for (const volume of volumes) {
      let bytes: number | null = null;
      if (s.serverId == null) {
        if (panel === null) panel = await (deps.panelSizes ?? panelVolumeSizes)().catch(() => new Map<string, number>());
        bytes = panel.get(volume) ?? null;
      } else if (deps.nodeSize) {
        bytes = await deps.nodeSize(s.serverId, volume).catch(() => null);
      }
      if (bytes === null) { complete = false; continue; }
      total += bytes;
    }
    if (complete) sample.push({ serviceId: s.id, kind: 'disk', value: total, ts: now });
  }
  if (sample.length) await persistServiceMetrics(db, sample);
  return sample.length;
}
