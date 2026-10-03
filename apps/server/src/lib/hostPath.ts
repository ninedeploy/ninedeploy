import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { capture } from './exec.js';

/**
 * r245: translate a path inside the panel's own container into the path the
 * Docker daemon sees on the host.
 *
 * `docker run -v <src>:<dst>` is resolved by the DAEMON, on the host. On a
 * bare-metal install the panel's paths are host paths and nothing changes.
 * In the container deployment (`docker-compose.prod.yml`) the data directory
 * is the `/data` mount of a named volume, so `-v /data/traefik:/etc/traefik`
 * made the daemon create an empty `/data/traefik` on the HOST: Traefik started
 * with no static or dynamic configuration and no domain was ever served.
 *
 * The fix asks the daemon for this container's own mounts and rewrites the
 * path through the longest matching destination. Anything that cannot be
 * resolved (not in a container, no socket, the path is not under a mount) is
 * returned unchanged, which is exactly the bare-metal behaviour.
 */

interface Mount {
  Source: string;
  Destination: string;
}

export interface HostPathDeps {
  inContainer: () => boolean;
  selfId: () => string;
  inspectMounts: (id: string) => Promise<Mount[]>;
}

const defaultDeps: HostPathDeps = {
  inContainer: () => existsSync('/.dockerenv'),
  selfId: () => hostname(),
  inspectMounts: async (id) => JSON.parse(await capture('docker', ['inspect', id, '--format', '{{json .Mounts}}'])) as Mount[],
};

let cached: Promise<Mount[]> | null = null;

/** Test hook: forget the memoized mount table. */
export function resetHostPathCache(): void {
  cached = null;
}

export async function hostPathFor(p: string, deps: HostPathDeps = defaultDeps): Promise<string> {
  if (!deps.inContainer()) return p;
  if (!cached) {
    const pending = deps.inspectMounts(deps.selfId()).catch(() => [] as Mount[]);
    cached = pending;
  }
  const mounts = await cached;
  let best: Mount | undefined;
  for (const m of mounts) {
    const dst = m.Destination.replace(/\/+$/, '');
    if (!dst || !m.Source) continue;
    if (p !== dst && !p.startsWith(`${dst}/`)) continue;
    if (!best || dst.length > best.Destination.replace(/\/+$/, '').length) best = m;
  }
  if (!best) return p;
  const dst = best.Destination.replace(/\/+$/, '');
  return `${best.Source.replace(/\/+$/, '')}${p.slice(dst.length)}`;
}
