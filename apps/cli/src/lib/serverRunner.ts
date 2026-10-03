import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const randomBytes = crypto.randomBytes.bind(crypto);

export interface ServerRunnerOptions {
  port?: number | string;
  image?: string;
  secret?: string;
  containerName?: string;
  /** Group id owning the host docker socket; resolved when omitted. */
  dockerGid?: number | null;
}

/**
 * r247: the group that owns the host's docker socket, on Linux. The image
 * runs as the non-root `ninedeploy` user and the socket is typically
 * root:docker 0660, so without `--group-add <gid>` every `docker` call the
 * panel makes fails with "permission denied" (the compose file and the
 * Dockerfile both document this; the CLI's own `docker run` skipped it).
 * Docker Desktop (macOS/Windows) proxies the socket and needs nothing.
 */
export async function dockerSocketGid(platform: NodeJS.Platform = process.platform): Promise<number | null> {
  if (platform !== 'linux') return null;
  try {
    return (await fs.stat('/var/run/docker.sock')).gid;
  } catch {
    return null;
  }
}

export interface ContainerState {
  exists: boolean;
  running: boolean;
  status: string;
  id?: string;
}

/** Normalize server URLs (e.g. "localhost:3000" -> "http://localhost:3000"). */
export function normalizeServerUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return 'http://localhost:3000';
  // Scheme-less input defaults to http for localhost, https elsewhere — a
  // bare "panel.example.com" is almost certainly TLS-terminated, and the
  // bearer token must not ride plaintext HTTP to a remote host.
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(trimmed)
      ? `http://${trimmed}`
      : `https://${trimmed}`;
  return withProtocol.replace(/\/+$/, '');
}

/** Diagnoses common Docker errors and returns actionable recommendations. */
export function formatDockerError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/permission denied/i.test(msg) || /EACCES/i.test(msg)) {
    return 'Docker socket permission denied. On Linux, run: `sudo usermod -aG docker $USER` and log back in, or run with sudo.';
  }
  if (/already in use/i.test(msg) || /Conflict/i.test(msg)) {
    return "Container conflict: A 'ninedeploy' container already exists. Run `ninedeploy server stop` or `docker rm -f ninedeploy`.";
  }
  if (/port is already allocated|address already in use/i.test(msg)) {
    return 'Port conflict: The host port is already allocated. Use `--port <number>` to select another port.';
  }
  return msg;
}

/** Check whether the Docker CLI is available on the current machine. */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/** Probe if a NineDeploy server is responding on the given base URL. */
export async function isServerReachable(baseUrl: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const cleanUrl = normalizeServerUrl(baseUrl);
    const url = new URL('/health', cleanUrl);
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
    return res?.status === 200;
  } catch {
    return false;
  }
}

/** Get Docker container status for the NineDeploy daemon. */
export async function getContainerState(containerName = 'ninedeploy'): Promise<ContainerState> {
  try {
    const { stdout } = await execFileAsync('docker', [
      'inspect',
      '--format',
      '{{.Id}}|{{.State.Running}}|{{.State.Status}}',
      containerName,
    ]);
    const [id, runningStr, status] = stdout.trim().split('|');
    return {
      exists: true,
      running: runningStr === 'true',
      status: status || 'unknown',
      id: id ? id.slice(0, 12) : undefined,
    };
  } catch {
    return { exists: false, running: false, status: 'not found' };
  }
}

/** Start or run the NineDeploy server Docker container. */
export async function startServerContainer(
  opts: ServerRunnerOptions = {},
): Promise<{ port: number; newlyCreated: boolean }> {
  const containerName = opts.containerName ?? 'ninedeploy';
  const port = Number(opts.port ?? 3000);
  const image = opts.image ?? 'ghcr.io/ninedeploy/ninedeploy:latest';
  const secret = opts.secret ?? crypto.randomBytes(32).toString('hex');

  const state = await getContainerState(containerName);
  if (state.running) {
    return { port, newlyCreated: false };
  }

  if (state.exists) {
    try {
      await execFileAsync('docker', ['start', containerName]);
      return { port, newlyCreated: false };
    } catch (err) {
      throw new Error(formatDockerError(err));
    }
  }

  // The JWT secret travels via --env-file (0600 temp file), NOT `-e` argv:
  // values passed as `-e NAME=value` stay visible in `ps` and `docker inspect`
  // forever, while the env file exists only for the duration of `docker run`.
  const gid = opts.dockerGid !== undefined ? opts.dockerGid : await dockerSocketGid();
  const envFile = join(tmpdir(), `nd_env_${randomBytes(8).toString('hex')}`);
  await fs.writeFile(envFile, `NINEDEPLOY_JWT_SECRET=${secret}\n`, { mode: 0o600 });
  const args = [
    'run',
    '-d',
    '--name',
    containerName,
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    ...(gid != null ? ['--group-add', String(gid)] : []),
    '-v',
    'ninedeploy-data:/data',
    '-p',
    `${port}:3000`,
    '--env-file',
    envFile,
    '-e',
    'NINEDEPLOY_PORT=3000',
    image,
  ];

  try {
    await execFileAsync('docker', args);
    return { port, newlyCreated: true };
  } catch (err) {
    throw new Error(formatDockerError(err));
  } finally {
    await fs.unlink(envFile).catch(() => undefined);
  }
}

/** Stop the running NineDeploy server Docker container. */
export async function stopServerContainer(containerName = 'ninedeploy'): Promise<void> {
  try {
    await execFileAsync('docker', ['stop', containerName]);
  } catch (err) {
    throw new Error(formatDockerError(err));
  }
}

/** Get stdout logs from the NineDeploy server container. */
export async function getServerLogs(containerName = 'ninedeploy', lines = 50): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('docker', ['logs', '--tail', String(lines), containerName]);
    return stdout || stderr || '';
  } catch (err) {
    throw new Error(formatDockerError(err));
  }
}

/** Polling loop waiting for the server to report reachable. */
export async function waitForServerReady(
  baseUrl: string,
  maxAttempts = 30,
  intervalMs = 1000,
): Promise<boolean> {
  const cleanUrl = normalizeServerUrl(baseUrl);
  for (let i = 0; i < maxAttempts; i++) {
    if (await isServerReachable(cleanUrl, 1000)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
