import { HttpError } from '../lib/errors.js';
import { capture, run } from '../lib/exec.js';

export interface ContainerFileEntry {
  name: string;
  type: 'file' | 'dir';
  sizeBytes: number;
  mode?: string | null;
  modifiedAt: string | null;
}

/** Validate container identifier. */
export function isManagedContainer(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/.test(name);
}

/** Choke-point guard: every container operation below must go through this. */
function assertManagedContainer(container: string): void {
  if (!isManagedContainer(container)) {
    throw new Error(`Refusing to operate on invalid container: ${container}`);
  }
}

/** Normalise a user-supplied path into a clean absolute container path (default '/'). */
export function safeContainerPath(input: string): string | null {
  if (input.includes('\0') || input.includes('\n')) return null;
  const raw = input.trim();
  if (!raw || raw === '/') return '/';
  const parts: string[] = [];
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }
    if (seg.length > 255) return null;
    parts.push(seg);
  }
  return parts.length ? `/${parts.join('/')}` : '/';
}

function toIso(mtime: string | undefined): string | null {
  const secs = Number(mtime);
  return Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000).toISOString() : null;
}

function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

function dirname(p: string): string {
  const idx = p.lastIndexOf('/');
  if (idx <= 0) return '/';
  return p.slice(0, idx);
}

/** List a directory inside a running container. */
export async function listContainerDir(container: string, path: string): Promise<ContainerFileEntry[]> {
  assertManagedContainer(container);
  const target = safeContainerPath(path);
  if (!target) throw new Error('invalid path');

  const out = await capture('docker', [
    'exec',
    container,
    'sh',
    '-c',
    `cd ${shellQuote(target)} 2>/dev/null && find . -mindepth 1 -maxdepth 1 -exec stat -c '%F|%s|%a|%Y|%n' {} + 2>/dev/null | sort`,
  ]);

  const entries: ContainerFileEntry[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [type, size, mode, mtime, ...nameParts] = line.split('|');
    const name = nameParts.join('|').split('/').pop()!.trim();
    if (!name) continue;
    if (type === 'directory') {
      entries.push({
        name,
        type: 'dir',
        sizeBytes: Number(size) || 0,
        mode: mode ? `0${mode}` : null,
        modifiedAt: toIso(mtime),
      });
    } else if (type === 'regular file' || type === 'symbolic link') {
      entries.push({
        name,
        type: 'file',
        sizeBytes: Number(size) || 0,
        mode: mode ? `0${mode}` : null,
        modifiedAt: toIso(mtime),
      });
    }
  }
  return entries;
}

/** Largest file the in-browser editor reads (and can therefore write back). */
export const CONTAINER_FILE_READ_CAP = 1024 * 1024;

/**
 * Read a file (base64 encoded) out of the container with a 1MB safety cap.
 *
 * r275: a file over the cap is REFUSED (413). The read used to be
 * `tail -c 1048576`, silently returning the last MiB of a larger file — and
 * the web editor then let the user save it, overwriting the whole file with
 * its tail. Reading one byte past the cap detects the overflow in a single
 * read, with no stat/read race.
 */
export async function readContainerFile(
  container: string,
  path: string,
): Promise<{ content: string; encoding: 'utf8' | 'base64' }> {
  assertManagedContainer(container);
  const target = safeContainerPath(path);
  if (!target || target === '/') throw new Error('invalid path');

  const out = await capture('docker', [
    'exec',
    container,
    'sh',
    '-c',
    `test -f ${shellQuote(target)} && head -c ${CONTAINER_FILE_READ_CAP + 1} ${shellQuote(target)} | base64`,
  ]);
  const content = out.trim();
  if (Buffer.byteLength(content.replace(/\s+/g, ''), 'base64') > CONTAINER_FILE_READ_CAP) {
    throw new HttpError(
      413,
      'file_too_large',
      'File is larger than 1 MB — too large to open in the editor (it was not read, so it cannot be overwritten).',
    );
  }
  return { content, encoding: 'base64' };
}

/** Write (overwrite) a file inside the container with base64 content. */
export async function writeContainerFile(
  container: string,
  path: string,
  base64: string,
  sink: (line: string) => void,
): Promise<void> {
  assertManagedContainer(container);
  const target = safeContainerPath(path);
  if (!target || target === '/') throw new Error('invalid path');

  await run(
    'docker',
    [
      'exec',
      '-i',
      container,
      'sh',
      '-c',
      `mkdir -p ${shellQuote(dirname(target))} && base64 -d > ${shellQuote(target)}`,
    ],
    {},
    sink,
    Buffer.from(base64, 'utf8'),
  );
}

/** Create a directory inside the container. */
export async function makeContainerDir(container: string, path: string): Promise<void> {
  assertManagedContainer(container);
  const target = safeContainerPath(path);
  if (!target || target === '/') throw new Error('invalid path');

  await capture('docker', ['exec', container, 'mkdir', '-p', '--', target]);
}

/** Delete a file or directory inside the container. */
export async function deleteContainerPath(
  container: string,
  path: string,
  sink: (line: string) => void,
): Promise<void> {
  assertManagedContainer(container);
  const target = safeContainerPath(path);
  if (!target || target === '/') throw new Error('cannot delete root');

  await run('docker', ['exec', container, 'rm', '-rf', '--', target], {}, sink);
}

export interface ContainerInspectResult {
  id: string;
  name: string;
  image: string;
  state: {
    status: string;
    running: boolean;
    startedAt: string;
    finishedAt: string;
    exitCode: number;
    error: string;
  };
  labels: Record<string, string>;
  traefikTags: Record<string, string>;
  env: string[];
  ports: Record<string, unknown>;
  mounts: Array<{ source: string; destination: string; mode: string; rw: boolean }>;
  networks: string[];
  resources: {
    memoryLimitBytes: number;
    memorySwapBytes: number;
    cpuShares: number;
    nanoCpus: number;
    restartPolicy: string;
  };
  raw: unknown;
}

/** Inspect container metadata and parsed labels/traefik tags. */
export async function inspectContainer(container: string): Promise<ContainerInspectResult> {
  assertManagedContainer(container);
  const out = await capture('docker', ['inspect', container]);
  const parsed = JSON.parse(out);
  const data = parsed[0];
  if (!data) throw new Error('container inspect empty');

  const labels: Record<string, string> = data.Config?.Labels ?? {};
  const traefikTags: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (k.startsWith('traefik.')) {
      traefikTags[k] = String(v);
    }
  }

  return {
    id: data.Id ?? '',
    name: (data.Name ?? '').replace(/^\//, ''),
    image: data.Config?.Image ?? '',
    state: {
      status: data.State?.Status ?? 'unknown',
      running: Boolean(data.State?.Running),
      startedAt: data.State?.StartedAt ?? '',
      finishedAt: data.State?.FinishedAt ?? '',
      exitCode: data.State?.ExitCode ?? 0,
      error: data.State?.Error ?? '',
    },
    labels,
    traefikTags,
    env: data.Config?.Env ?? [],
    ports: data.NetworkSettings?.Ports ?? {},
    mounts: (data.Mounts ?? []).map((m: any) => ({
      source: m.Source ?? '',
      destination: m.Destination ?? '',
      mode: m.Mode ?? '',
      rw: Boolean(m.RW),
    })),
    networks: Object.keys(data.NetworkSettings?.Networks ?? {}),
    resources: {
      memoryLimitBytes: data.HostConfig?.Memory ?? 0,
      memorySwapBytes: data.HostConfig?.MemorySwap ?? 0,
      cpuShares: data.HostConfig?.CpuShares ?? 0,
      nanoCpus: data.HostConfig?.NanoCpus ?? 0,
      restartPolicy: data.HostConfig?.RestartPolicy?.Name ?? 'no',
    },
    raw: data,
  };
}

/** Generate runtime Docker Compose YAML and Traefik tags manifest for container. */
export async function getContainerComposeManifest(container: string): Promise<{
  yaml: string;
  inspect: ContainerInspectResult;
}> {
  const inspect = await inspectContainer(container);
  const serviceName = inspect.name.replace(/[^a-zA-Z0-9_-]/g, '-');

  const lines: string[] = [
    `# NineDeploy Runtime Generated Compose Manifest`,
    `# Generated for container: ${inspect.name}`,
    `# Status: ${inspect.state.status.toUpperCase()}`,
    `services:`,
    `  ${serviceName}:`,
    `    image: ${inspect.image}`,
    `    container_name: ${inspect.name}`,
    `    restart: ${inspect.resources.restartPolicy || 'unless-stopped'}`,
  ];

  // cpu-shares is a scheduling WEIGHT (default 1024), not a CPU cap — it must
  // not be rendered as `cpus:`, which would impose a hard limit the container
  // never had. The hard cap lives in NanoCpus; swap is only meaningful when it
  // differs from the memory limit (compose memswap_limit = memory + swap).
  if (inspect.resources.cpuShares > 0) {
    lines.push(`    cpu_shares: ${inspect.resources.cpuShares}`);
  }
  if (inspect.resources.memoryLimitBytes > 0 || inspect.resources.nanoCpus > 0 || inspect.resources.memorySwapBytes > inspect.resources.memoryLimitBytes) {
    lines.push(`    deploy:`);
    lines.push(`      resources:`);
    lines.push(`        limits:`);
    if (inspect.resources.memoryLimitBytes > 0) {
      lines.push(`          memory: ${Math.round(inspect.resources.memoryLimitBytes / (1024 * 1024))}M`);
    }
    if (inspect.resources.memorySwapBytes > inspect.resources.memoryLimitBytes) {
      lines.push(`          memory_swap: ${Math.round(inspect.resources.memorySwapBytes / (1024 * 1024))}M`);
    }
    if (inspect.resources.nanoCpus > 0) {
      lines.push(`          cpus: '${inspect.resources.nanoCpus / 1e9}'`);
    }
  }

  if (inspect.networks.length > 0) {
    lines.push(`    networks:`);
    for (const net of inspect.networks) {
      lines.push(`      - ${net}`);
    }
  }

  if (inspect.mounts.length > 0) {
    lines.push(`    volumes:`);
    for (const m of inspect.mounts) {
      lines.push(`      - ${m.source}:${m.destination}${m.rw ? '' : ':ro'}`);
    }
  }

  if (Object.keys(inspect.labels).length > 0) {
    lines.push(`    labels:`);
    for (const [k, v] of Object.entries(inspect.labels)) {
      // JSON double-quote escaping = valid YAML double-quoted scalar: label
      // values may contain quotes/backslashes that break hand-written quoting.
      lines.push(`      - ${JSON.stringify(`${k}=${v}`)}`);
    }
  }

  if (inspect.env.length > 0) {
    lines.push(`    environment:`);
    for (const e of inspect.env) {
      // Env comes from `docker inspect` verbatim — plain scalars like
      // `CONFIG={"a":1}` or `TOKEN=abc: def` are YAML syntax errors or get
      // re-typed. Quote every entry; JSON escapes are YAML-compatible.
      lines.push(`      - ${JSON.stringify(e)}`);
    }
  }

  if (inspect.networks.length > 0) {
    lines.push(`networks:`);
    for (const net of inspect.networks) {
      lines.push(`  ${net}:`);
      lines.push(`    external: true`);
    }
  }

  return {
    yaml: lines.join('\n'),
    inspect,
  };
}
