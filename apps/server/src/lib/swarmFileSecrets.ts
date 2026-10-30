import { createHmac } from 'node:crypto';
import { config } from '../config.js';
import { capture } from './exec.js';
import type { NodeServiceFile } from './serviceFiles.js';

/**
 * File mounts for a Swarm service (ROADMAP item 10). Each file becomes a
 * Swarm secret, mounted read-only at its path in every task
 * (`ContainerSpec.Secrets`). Secrets, not configs: the contents are
 * encrypted in the Swarm's raft log and no API call reads them back, as the
 * panel keeps them encrypted at rest.
 *
 * A secret cannot change, so its name carries a version derived from the
 * content: `<stack>-f<file id>-<12 hex>`, an HMAC under a key of this panel
 * (never a plain hash: names are visible in `docker secret ls` and deploy
 * logs, and a bare hash would confirm a guessed low-entropy file). An
 * unchanged file reuses its secret, and an edited one gets a new name and ID,
 * which changes the service spec (and its journal fingerprint) and rolls the
 * tasks.
 *
 * Docker refuses to remove a secret the current spec uses, but not one only
 * the previous spec (the rollback target) uses, so pruning keeps both.
 */

/** Labels every file secret carries: the stack it belongs to, and the file. */
export const FILE_SECRET_STACK_LABEL = 'ninedeploy.swarm.stack';
export const FILE_SECRET_FILE_LABEL = 'ninedeploy.file';

export interface SwarmFileSecret {
  secretId: string;
  secretName: string;
  /** The absolute path in the container. */
  target: string;
}

const RE_SECRET_ID = /^[a-z0-9]{25}$/;

/** The naming key: domain-separated from the panel's signing secret. */
const namingKey = (): Buffer => createHmac('sha256', config.jwt.secret).update('nd-swarm-file-secret-v1').digest();

export const fileSecretName = (stack: string, file: Pick<NodeServiceFile, 'id' | 'content'>): string =>
  `${stack}-f${file.id}-${createHmac('sha256', namingKey()).update(`${stack}\0${file.id}\0`).update(file.content).digest('hex').slice(0, 12)}`;

async function secretId(name: string): Promise<string | null> {
  const out = await capture('docker', ['secret', 'inspect', '--format', '{{.ID}}', name], { timeoutMs: 30_000, maxOutputBytes: 256 }).catch(() => null);
  const id = out?.trim() ?? '';
  return RE_SECRET_ID.test(id) ? id : null;
}

/** Create (or reuse) the secret of each file; resolves them in path order. */
export async function ensureSwarmFileSecrets(stack: string, files: readonly NodeServiceFile[], log: (line: string) => void): Promise<SwarmFileSecret[]> {
  const out: SwarmFileSecret[] = [];
  for (const file of [...files].sort((a, b) => a.containerPath.localeCompare(b.containerPath))) {
    const name = fileSecretName(stack, file);
    let id = await secretId(name);
    if (!id) {
      await capture(
        'docker',
        ['secret', 'create', '--label', `${FILE_SECRET_STACK_LABEL}=${stack}`, '--label', `${FILE_SECRET_FILE_LABEL}=${file.id}`, name, '-'],
        { timeoutMs: 60_000, maxOutputBytes: 1024 },
        Buffer.from(file.content, 'utf8'),
      ).catch(async (err: unknown) => {
        // Created by a concurrent attempt in the meantime: the name is the content, so it is the same secret.
        if (!(await secretId(name))) throw err;
      });
      id = await secretId(name);
      if (!id) throw new Error(`Swarm secret ${name} could not be confirmed`);
      log(`Swarm: file ${file.containerPath} (#${file.id}) stored as a new Swarm secret`);
    }
    out.push({ secretId: id, secretName: name, target: file.containerPath });
  }
  return out;
}

/** The secret names a native service spec mounts. */
export function specSecretNames(spec: unknown): string[] {
  const secrets = (spec as { TaskTemplate?: { ContainerSpec?: { Secrets?: Array<{ SecretName?: unknown }> } } } | null)?.TaskTemplate?.ContainerSpec?.Secrets;
  return Array.isArray(secrets) ? secrets.flatMap((s) => (typeof s?.SecretName === 'string' ? [s.SecretName] : [])) : [];
}

/**
 * Remove the stack's file secrets that `keep` does not name. Best effort:
 * Docker refuses a secret a service still uses, and a failure only leaves an
 * unused secret for the next deploy to remove. Returns the names removed.
 */
export async function pruneSwarmFileSecrets(stack: string, keep: ReadonlySet<string>, log: (line: string) => void): Promise<string[]> {
  const listing = await capture('docker', ['secret', 'ls', '--filter', `label=${FILE_SECRET_STACK_LABEL}=${stack}`, '--format', '{{.Name}}'], {
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
  }).catch(() => '');
  const removed: string[] = [];
  for (const name of listing.split('\n').map((l) => l.trim())) {
    // Only this stack's file secrets, by their exact name shape.
    if (!name || keep.has(name) || !name.startsWith(`${stack}-f`) || !/-f\d+-[a-f0-9]{12}$/.test(name)) continue;
    try {
      await capture('docker', ['secret', 'remove', name], { timeoutMs: 30_000, maxOutputBytes: 1024 });
      removed.push(name);
    } catch {
      /* still in use (a task, a rollback in flight): the next deploy tries again */
    }
  }
  if (removed.length) log(`Swarm: removed ${removed.length} file secret(s) no deploy uses any more`);
  return removed;
}

/**
 * After a converged deploy: remove the stack's file secrets that neither the
 * service's spec nor its previous spec (the rollback target) mounts, nor this
 * deploy. When the service cannot be read, nothing is removed.
 */
export async function pruneUnusedFileSecrets(stack: string, runtimeId: string, current: readonly string[], log: (line: string) => void): Promise<string[]> {
  const out = await capture('docker', ['service', 'inspect', '--format', '{{json .Spec}}\n{{json .PreviousSpec}}', runtimeId], {
    timeoutMs: 30_000,
    maxOutputBytes: 4 << 20,
  }).catch(() => null);
  if (out === null) return [];
  const keep = new Set(current);
  for (const line of out.split('\n').filter(Boolean)) {
    try {
      for (const name of specSecretNames(JSON.parse(line))) keep.add(name);
    } catch {
      return []; // an unreadable spec: keep everything
    }
  }
  return pruneSwarmFileSecrets(stack, keep, log);
}
