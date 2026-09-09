import type { databases, services, serviceVolumeAttachments } from '@ninedeploy/db';
import { capture } from './exec.js';

/**
 * Pinned helper image for throwaway privileged sidecars (`du -sb`, volume
 * file ops, config repair). A floating `:latest` let a registry-tag
 * compromise silently swap the image every privileged volume operation runs
 * through — pin a minor line and bump it deliberately.
 */
export const HELPER_IMAGE = 'alpine:3.21';

type ServiceRow = typeof services.$inferSelect;
type DatabaseRow = typeof databases.$inferSelect;
type VolumeAttachmentRow = typeof serviceVolumeAttachments.$inferSelect;

/** Owner reference for a managed volume, as consumed by topology/inventory views. */
export interface VolumeOwnerRef {
  kind: 'service' | 'database';
  refId: number;
  name: string;
  engine?: string;
  /** Owner's container name (service runtimeId / database container), for liveness probes. */
  containerName: string | null;
}

/** Resolve the owner (service/database) of a managed volume name — pure, no
 * docker calls, so callers that already loaded both tables can reuse it.
 *
 * Two ownership paths are consulted, in order:
 *  1. The `service_volume_attachments` table — explicit (service, volume)
 *     links. Wins over the legacy heuristic, and is the only path that can
 *     resolve user-created volumes that do NOT match the
 *     `nd-svc-<slug>-data` naming convention.
 *  2. The legacy `nd-svc-<slug>-data` / `nd-db-<slug>-data` naming — kept so
 *     pre-attachment services (which only set `service.volumeMount`) still
 *     resolve to the right owner. */
export function resolveVolumeOwner(
  svcs: ServiceRow[],
  dbs: DatabaseRow[],
  name: string,
  attachments: VolumeAttachmentRow[] = [],
): VolumeOwnerRef | null {
  // 1) explicit attachment link (any service may own the volume).
  const att = attachments.find((a) => a.volumeName === name);
  if (att) {
    const s = svcs.find((x) => x.id === att.serviceId);
    if (s) return { kind: 'service', refId: s.id, name: s.name, containerName: s.runtimeId };
    // Orphan attachment: row exists but service was deleted. Fall through.
  }
  if (name.startsWith('nd-svc-')) {
    const slug = name.replace('nd-svc-', '').replace(/-data$/, '');
    const s = svcs.find((x) => x.slug === slug);
    return s ? { kind: 'service', refId: s.id, name: s.name, containerName: s.runtimeId } : null;
  }
  if (name.startsWith('nd-db-')) {
    const slug = name.replace('nd-db-', '').replace(/-data$/, '');
    const d = dbs.find((x) => x.slug === slug);
    return d ? { kind: 'database', refId: d.id, name: d.name, engine: d.engine, containerName: d.containerName } : null;
  }
  return null;
}

/** Like {@link resolveVolumeOwner} but also reports the number of OTHER
 *  services that share the volume. Used by the inventory / topology views
 *  to surface a "shared with N" badge. */
export function resolveVolumeOwnerWithSharing(
  svcs: ServiceRow[],
  dbs: DatabaseRow[],
  name: string,
  attachments: VolumeAttachmentRow[],
): { owner: VolumeOwnerRef; sharedWith: number } | null {
  const owner = resolveVolumeOwner(svcs, dbs, name, attachments);
  if (!owner) return null;
  const sharedWith = attachments.filter((a) => a.volumeName === name).length - 1;
  return { owner, sharedWith: sharedWith > 0 ? sharedWith : 0 };
}

/** Names of NineDeploy-managed docker volumes (nd-svc- and nd-db- prefixed). */
export async function listManagedVolumeNames(): Promise<string[]> {
  const raw = await capture('docker', ['volume', 'ls', '--format', '{{.Name}}']);
  return raw
    .split('\n')
    .map((n) => n.trim())
    .filter((n) => n.startsWith('nd-svc-') || n.startsWith('nd-db-'));
}

/** User-defined docker networks (builtins like bridge/host/none excluded). */
export async function listUserNetworks(): Promise<Array<{ name: string; driver: string }>> {
  const raw = await capture('docker', ['network', 'ls', '--format', '{{.Name}}\t{{.Driver}}']);
  return raw
    .split('\n')
    .map((l) => l.trim().split('\t'))
    .filter((p) => p.length === 2 && p[0])
    .filter(([name]) => !['bridge', 'host', 'none'].includes(name!))
    .map(([name, driver]) => ({ name: name!, driver: driver! }));
}

/** Containers currently attached to a docker network. */
export async function networkMembers(network: string): Promise<string[]> {
  const raw = await capture('docker', ['network', 'inspect', network, '--format', '{{range .Containers}}{{.Name}} {{end}}']);
  return raw.split(/\s+/).filter(Boolean);
}

/** Whether a container with this exact name is running right now. Never throws —
 * a docker hiccup simply reads as "not running". */
export async function containerRunning(containerName: string | null | undefined): Promise<boolean> {
  if (!containerName) return false;
  try {
    const out = await capture('docker', ['ps', '--filter', `name=^${containerName}$`, '-q']);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}
