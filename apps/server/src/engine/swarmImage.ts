import { capture, run } from '../lib/exec.js';
import { withDeployDockerConfig } from '../lib/swarm.js';
function repository(ref: string): string {
  const bare = ref.split('@')[0]!.replace(/:[^/:]+$/, '');
  const parts = bare.split('/'), first = parts[0]!;
  let host = first.includes('.') || first.includes(':') || first === 'localhost' ? parts.shift()! : 'docker.io';
  if (host === 'index.docker.io' || host === 'registry-1.docker.io') host = 'docker.io';
  if (host === 'docker.io' && parts.length === 1) parts.unshift('library');
  return `${host}/${parts.join('/')}`;
}
/** Resolve mutable image releases before recording an exact native spec. A failed pin never falls back to a tag. */
export async function pinSwarmImage(ref: string, auth: { username: string; password: string; server?: string } | undefined, log: (line: string) => void): Promise<string> {
  if (/@sha256:[a-f0-9]{64}$/.test(ref)) return ref;
  return withDeployDockerConfig(auth, log, async config => {
    const prefix = config ? ['--config', config] : [];
    await run('docker', [...prefix, 'pull', ref], { timeoutMs: 10 * 60_000 }, log);
    const raw = await capture('docker', [...prefix, 'image', 'inspect', '--format', '{{json .RepoDigests}}', ref], { timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024 });
    let values: unknown;
    try { values = JSON.parse(raw); } catch { throw new Error('Swarm image digest is unconfirmed; no mutable tag will be submitted'); }
    if (!Array.isArray(values)) throw new Error('Swarm image digest is unconfirmed; no mutable tag will be submitted');
    const pinned = values.find((value): value is string => typeof value === 'string' && /@sha256:[a-f0-9]{64}$/.test(value) && repository(value) === repository(ref));
    if (!pinned) throw new Error('Swarm image digest does not match the requested repository; current service unchanged');
    return pinned;
  });
}
