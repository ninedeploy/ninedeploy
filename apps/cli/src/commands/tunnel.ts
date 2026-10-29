import net from 'node:net';
import process from 'node:process';
import type { NineDeployClient } from '../client.js';
import { c, error, info, success } from '../lib/format.js';
import { plain } from './sources.js';

/**
 * G5.8 `ninedeploy tunnel db <id> [--port <n>] [--bind <address>]`: offer a
 * database (on the panel host, or on a node with agent 0.18.7) on a local port. Each local connection opens its own
 * WebSocket to `/v1/databases/:id/tunnel`, which carries it byte for byte to
 * the database container, so the database port stays closed to the internet.
 * Needs the database's admin role; the database's own login applies on top.
 */

/** Frames stay well under the server's 1 MiB WebSocket payload cap. */
const MAX_FRAME = 64 * 1024;

/** The parts of a `ws` WebSocket the tunnel uses (injectable for tests). */
export interface TunnelSocket {
  readonly readyState: number;
  send(data: Uint8Array, opts: { binary: true }): void;
  close(code?: number): void;
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: Buffer, isBinary: boolean) => void): void;
  on(event: 'close', cb: (code: number, reason: Buffer) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}
export type TunnelSocketFactory = (url: string, protocols: string[]) => TunnelSocket;

export interface TunnelOptions {
  port?: string;
  bind?: string;
}

export interface TunnelDeps {
  socketFactory?: TunnelSocketFactory;
  /** The bearer and the tunnel URL (defaults: the CLI config, refreshed when about to expire). */
  credentials?: () => Promise<{ url: (path: string) => string; token: string }>;
  /** Resolves once the tunnel is listening (tests); the command itself runs until Ctrl-C. */
  onListening?: (address: { host: string; port: number }, server: net.Server) => void;
}

const OPEN = 1;

async function defaultCredentials(): Promise<{ url: (path: string) => string; token: string }> {
  const { loadConfig } = await import('../config.js');
  const { apiUrl, refreshAccessToken, tokenExpiresSoon } = await import('../client.js');
  if (tokenExpiresSoon(loadConfig().token)) await refreshAccessToken();
  return { url: (path) => apiUrl(path).replace(/^http/, 'ws'), token: loadConfig().token ?? '' };
}

async function defaultSocketFactory(): Promise<TunnelSocketFactory> {
  const { WebSocket } = await import('ws');
  return (url, protocols) => new WebSocket(url, protocols) as unknown as TunnelSocket;
}

/** Carry one local connection over one tunnel WebSocket. */
export function pipeConnection(local: net.Socket, ws: TunnelSocket, onRefused: (reason: string) => void): void {
  const pending: Buffer[] = [];
  const sendChunked = (chunk: Buffer) => {
    for (let at = 0; at < chunk.length; at += MAX_FRAME) ws.send(chunk.subarray(at, at + MAX_FRAME), { binary: true });
  };
  local.on('data', (chunk: Buffer) => {
    if (ws.readyState === OPEN) sendChunked(chunk);
    else pending.push(chunk);
  });
  ws.on('open', () => {
    for (const chunk of pending.splice(0)) sendChunked(chunk);
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) local.write(data);
  });
  ws.on('close', (code, reason) => {
    if (code === 1008) onRefused(String(reason ?? '') || 'refused');
    else if (code !== 1000 && code !== 1005) onRefused(`closed (${code}${String(reason ?? '') ? `: ${String(reason)}` : ''})`);
    local.destroy();
  });
  ws.on('error', () => local.destroy());
  local.on('close', () => {
    try {
      ws.close(1000);
    } catch {
      /* already closed */
    }
  });
  local.on('error', () => undefined);
}

/** Canonical decimal id only, as the server accepts it. */
function parseId(raw: string | undefined): number {
  const t = (raw ?? '').trim();
  return /^[1-9]\d*$/.test(t) && Number.isSafeInteger(Number(t)) ? Number(t) : 0;
}

/** Listen locally and carry each connection over its own tunnel WebSocket to `path`. Null when it cannot listen. */
async function serveTunnel(path: string, host: string, requested: number | undefined, preferred: number, deps: TunnelDeps): Promise<number | null> {
  const creds = await (deps.credentials ?? defaultCredentials)();
  const factory = deps.socketFactory ?? (await defaultSocketFactory());
  const url = creds.url(path);
  const open = () => factory(url, ['ninedeploy.tunnel.v1', `ninedeploy.bearer.${creds.token}`]);

  let reported = '';
  const server = net.createServer((local) => {
    pipeConnection(local, open(), (reason) => {
      // One line per distinct refusal: a client retrying would print it for every attempt.
      if (reason === reported) return;
      reported = reason;
      error(`Tunnel refused: ${plain(reason)}`);
    });
  });

  const listen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve((server.address() as net.AddressInfo).port);
      });
    });
  // Default: the preferred port when it is free locally, else any free one.
  let port: number;
  try {
    port = await listen(requested ?? preferred);
  } catch (err) {
    if (requested !== undefined) {
      error(`Cannot listen on ${host}:${requested}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    port = await listen(0);
  }
  tunnelServers.set(port, server);
  return port;
}

const tunnelServers = new Map<number, net.Server>();

/** Hand the listening server to a test, or run until Ctrl-C. */
async function untilInterrupted(host: string, port: number, deps: TunnelDeps): Promise<void> {
  const server = tunnelServers.get(port)!;
  tunnelServers.delete(port);
  if (host !== '127.0.0.1' && host !== '::1') console.log(`  ${c.yellow(`⚠ Bound to ${host}: anyone who can reach this address can use the tunnel.`)}`);
  info(c.dim('Ctrl-C closes the tunnel.'));
  deps.onListening?.({ host, port }, server);
  if (deps.onListening) return;
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => {
      server.close();
      resolve();
    });
  });
}

export async function tunnelDb(client: NineDeployClient, idRaw: string, opts: TunnelOptions = {}, deps: TunnelDeps = {}): Promise<void> {
  const id = parseId(idRaw);
  if (!id) return error('Usage: ninedeploy tunnel db <id> [--port <n>] [--bind <address>]');
  const requested = opts.port === undefined ? undefined : Number(opts.port);
  if (requested !== undefined && !(Number.isInteger(requested) && requested >= 0 && requested <= 65535)) {
    return error('--port must be 0-65535 (0 picks a free one)');
  }
  const host = opts.bind ?? '127.0.0.1';
  if (net.isIP(host) === 0) return error('--bind must be an IP address');

  let detail: Awaited<ReturnType<NineDeployClient['databases']['get']>>;
  try {
    detail = await client.databases.get(id);
  } catch (err) {
    return error(plain(err instanceof Error ? err.message : String(err)));
  }
  const port = await serveTunnel(`/v1/databases/${id}/tunnel`, host, requested, detail.port ?? 0, deps);
  if (port === null) return;

  success(`Tunnel to ${plain(detail.name)} (${plain(detail.engine)}) listening on ${host}:${port}`);
  info(`Connect your client to ${host}:${port} with the database's own credentials (Database page → Credentials).`);
  await untilInterrupted(host, port, deps);
}

export interface ServiceTunnelOptions extends TunnelOptions {
  /** The container port (default: the service port). */
  target?: string;
  replica?: string;
}

/**
 * G5.8 `ninedeploy tunnel service <id> [--target <port>] [--replica <n>]
 * [--port <n>] [--bind <address>]`: offer a port of a docker service (on
 * the panel host, or on a node with agent 0.18.7) locally, for an admin port, a debugger or a service with no domain.
 * Needs the service's admin role.
 */
export async function tunnelService(client: NineDeployClient, idRaw: string, opts: ServiceTunnelOptions = {}, deps: TunnelDeps = {}): Promise<void> {
  const id = parseId(idRaw);
  if (!id) return error('Usage: ninedeploy tunnel service <id> [--target <port>] [--replica <n>] [--port <n>] [--bind <address>]');
  const requested = opts.port === undefined ? undefined : Number(opts.port);
  if (requested !== undefined && !(Number.isInteger(requested) && requested >= 0 && requested <= 65535)) {
    return error('--port must be 0-65535 (0 picks a free one)');
  }
  const target = opts.target === undefined ? undefined : Number(opts.target);
  if (target !== undefined && !(Number.isInteger(target) && target >= 1 && target <= 65535)) return error('--target must be a container port, 1-65535');
  const replica = opts.replica === undefined ? undefined : Number(opts.replica);
  if (replica !== undefined && !(Number.isInteger(replica) && replica >= 1)) return error('--replica must be 1 or more');
  const host = opts.bind ?? '127.0.0.1';
  if (net.isIP(host) === 0) return error('--bind must be an IP address');

  let svc: Awaited<ReturnType<NineDeployClient['services']['get']>>;
  try {
    svc = await client.services.get(id);
  } catch (err) {
    return error(plain(err instanceof Error ? err.message : String(err)));
  }
  const containerPort = target ?? svc.port ?? undefined;
  if (!containerPort) return error('The service has no port; name the container port with --target <port>.');
  const query = new URLSearchParams({ port: String(containerPort), ...(replica ? { replica: String(replica) } : {}) });
  const port = await serveTunnel(`/v1/services/${id}/tunnel?${query.toString()}`, host, requested, containerPort, deps);
  if (port === null) return;

  success(`Tunnel to ${plain(svc.name)}:${containerPort}${replica ? ` (replica ${replica})` : ''} listening on ${host}:${port}`);
  info('It reaches the container directly, past what the service domains enforce.');
  await untilInterrupted(host, port, deps);
}
