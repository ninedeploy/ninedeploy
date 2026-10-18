import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { count, eq } from 'drizzle-orm';
import { type DB, serviceFiles } from '@ninedeploy/db';
import { config } from '../config.js';
import { decrypt } from './crypto.js';
import { hostPathFor } from './hostPath.js';

/**
 * 0.16.3 file mounts on the panel host. Each deploy writes the service's files
 * into its own directory, `<data>/service-files/<slug>/d<deployment>/<file id>`,
 * and the container bind-mounts each one read-only. A fresh directory per
 * deployment keeps the outgoing container (blue-green) on the content it
 * started with; older directories are pruned.
 */

/** Why a deploy with file mounts is refused where it would run. */
export const FILE_MOUNTS_PANEL_ONLY =
  'File mounts work for docker services on the panel host only in this release; remove the files (Service → Volumes → Files) or run the service on the panel host.';

/** Deployment directories kept per service: the new one and the two before it. */
const KEEP_DEPLOYMENTS = 3;

export function serviceFilesDir(slug: string): string {
  return path.join(config.paths.dataDir, 'service-files', slug);
}

export async function serviceFileCount(db: DB, serviceId: number): Promise<number> {
  const [row] = await db.select({ n: count() }).from(serviceFiles).where(eq(serviceFiles.serviceId, serviceId));
  return row?.n ?? 0;
}

/**
 * A service with file mounts that would not run as a panel-host docker
 * container (a node, Swarm, a compose stack, pm2) is refused rather than
 * started without its files.
 */
export async function fileMountRefusal(
  db: DB,
  service: { id: number; type: string; serverId?: number | null; orchestrator?: string | null },
): Promise<string | null> {
  const onPanel = service.type === 'docker' && service.serverId == null && service.orchestrator !== 'swarm';
  if (onPanel) return null;
  return (await serviceFileCount(db, service.id)) > 0 ? FILE_MOUNTS_PANEL_ONLY : null;
}

export interface FileMount {
  /** The file as the Docker daemon sees it. */
  hostPath: string;
  containerPath: string;
}

/** Write this deployment's files and return the mounts; [] (and nothing written) for a service without files. */
export async function prepareFileMounts(
  db: DB,
  service: { id: number; slug: string },
  deploymentId: number,
  log: (line: string) => void,
): Promise<FileMount[]> {
  const rows = await db.select().from(serviceFiles).where(eq(serviceFiles.serviceId, service.id));
  if (rows.length === 0) return [];
  const root = serviceFilesDir(service.slug);
  const dir = path.join(root, `d${deploymentId}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The content can hold secrets: every directory down to the files is the
  // panel user's alone, so no other host account can reach them. The files
  // stay 0644 for the container: the daemon resolves a bind source as root,
  // and inside the container only the file's own mode counts, not its host
  // parents'. chmod as well, since mkdir's mode is narrowed by the umask and
  // never applied to a directory that already exists.
  for (const d of [path.dirname(root), root, dir]) chmodSync(d, 0o700);
  const mounts: FileMount[] = [];
  for (const row of rows) {
    const file = path.join(dir, String(row.id));
    writeFileSync(file, decrypt(row.contentEncrypted), { mode: 0o644 });
    // A umask may have narrowed the mode; the container's user (any uid) must read it.
    chmodSync(file, 0o644);
    mounts.push({ hostPath: await hostPathFor(file), containerPath: row.containerPath });
  }
  pruneDeploymentDirs(root, deploymentId);
  log(`File mounts: ${mounts.map((m) => m.containerPath).join(', ')} (read-only)`);
  return mounts;
}

/** Drop all but the newest KEEP_DEPLOYMENTS directories (never `current`). */
function pruneDeploymentDirs(root: string, current: number): void {
  const ids = readdirSync(root)
    .map((name) => /^d(\d+)$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => b - a);
  for (const id of ids.slice(KEEP_DEPLOYMENTS)) {
    if (id !== current) rmSync(path.join(root, `d${id}`), { recursive: true, force: true });
  }
}

/** Remove every written copy of a deleted service's files. */
export function removeServiceFilesDir(slug: string): void {
  rmSync(serviceFilesDir(slug), { recursive: true, force: true });
}
