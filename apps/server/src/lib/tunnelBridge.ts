import type net from 'node:net';
import type { Duplex } from 'node:stream';
import type { WebSocket } from '@fastify/websocket';

/**
 * G5.8 the byte bridge shared by database and service tunnels: one WebSocket
 * carries one TCP connection, binary frames both ways. Close codes: 1008
 * refused, 1011 the target connection failed, 1000 either side ended.
 */

/** Open tunnels per user (database and service together): a client opens one per local connection. */
export const MAX_TUNNELS_PER_USER = 32;
/** A tunnel with no traffic in either direction for this long is closed. */
export const TUNNEL_IDLE_MS = 30 * 60_000;
const RECHECK_MS = 60_000;
/** Pause the target side while this much is waiting to reach the client. */
const HIGH_WATER = 4 * 1024 * 1024;

const open = new Map<number, number>();

/** A scoped API token may open a tunnel only when it may also write the resource kind. */
export function tokenMayWrite(scopes: string[] | null, kind: 'databases' | 'services'): boolean {
  if (scopes === null) return true;
  return scopes.includes('write') || scopes.includes('operator') || scopes.some((s) => new RegExp(`^nd://scope/(write|admin)/${kind}$`).test(s));
}

/** Take a slot for the user, or null at the cap. Taken before any await, so parallel opens cannot all pass. */
export function reserveTunnel(userId: number): (() => void) | null {
  if ((open.get(userId) ?? 0) >= MAX_TUNNELS_PER_USER) return null;
  open.set(userId, (open.get(userId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    open.set(userId, Math.max(0, (open.get(userId) ?? 1) - 1));
  };
}

/** What a client may send before its target is connected (a database startup packet, a request line). */
export const EARLY_BYTES_MAX = 1024 * 1024;

/**
 * Hold the messages a client sends while the route is still awaiting (the
 * access checks, the address, or a node's tunnel channel). @fastify/websocket
 * drops a message nobody listens to, and a client that speaks first (psql, an
 * HTTP request) then waited forever. Call it before the handler's first await;
 * the returned function stops holding and hands over what arrived.
 */
export function holdEarlyMessages(socket: WebSocket): () => { chunks: Buffer[]; refused: string | null } {
  const chunks: Buffer[] = [];
  let size = 0;
  let refused: string | null = null;
  const onMessage = (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (refused) return;
    if (!isBinary) {
      refused = 'binary frames only';
      return;
    }
    const chunk = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    size += chunk.length;
    if (size > EARLY_BYTES_MAX) refused = 'too much data before the tunnel opened';
    else chunks.push(chunk);
  };
  socket.on('message', onMessage);
  return () => {
    socket.off('message', onMessage);
    return { chunks, refused };
  };
}

export interface BridgeOptions {
  socket: WebSocket;
  /** The target side: a TCP socket, or (G5.8 nodes) a tunnel stream through the node's agent. */
  tcp: net.Socket | Duplex;
  release: () => void;
  /** Resolves false when access was revoked; checked every minute. */
  stillAllowed: () => Promise<boolean>;
  /** Called once, with the totals, when the tunnel ends. */
  onClose: (summary: { seconds: number; bytesIn: number; bytesOut: number; reason: string }) => void;
  label: string;
  /** Bytes the client sent before the bridge existed ({@link holdEarlyMessages}), written to the target first. */
  early?: Buffer[];
}

export function bridgeTunnel(o: BridgeOptions): void {
  const { socket, tcp } = o;
  const started = Date.now();
  let bytesIn = 0;
  let bytesOut = 0;
  let lastActivity = Date.now();
  let closed = false;
  if ('setNoDelay' in tcp) tcp.setNoDelay(true);

  const finish = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    o.release();
    tcp.destroy();
    try {
      socket.close(code, reason);
    } catch {
      /* already closed */
    }
    o.onClose({ seconds: Math.round((Date.now() - started) / 1000), bytesIn, bytesOut, reason });
  };

  tcp.on('data', (chunk: Buffer) => {
    bytesOut += chunk.length;
    lastActivity = Date.now();
    socket.send(chunk, { binary: true });
    if (socket.bufferedAmount > HIGH_WATER) tcp.pause();
  });
  tcp.on('error', () => finish(1011, `${o.label} connection failed`));
  tcp.on('close', () => finish(1000, `${o.label} closed the connection`));

  socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (!isBinary) return finish(1008, 'binary frames only');
    const chunk = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    bytesIn += chunk.length;
    lastActivity = Date.now();
    if (!tcp.write(chunk)) {
      socket.pause();
      tcp.once('drain', () => socket.resume());
    }
  });
  for (const chunk of o.early ?? []) {
    bytesIn += chunk.length;
    tcp.write(chunk);
  }
  socket.on('close', () => finish(1000, 'client closed the tunnel'));
  socket.on('error', () => finish(1011, 'tunnel error'));

  // Re-check access, resume a paused target side, and close idle tunnels.
  let lastCheck = Date.now();
  const timer = setInterval(() => {
    if (tcp.isPaused() && socket.bufferedAmount <= HIGH_WATER / 2) tcp.resume();
    if (Date.now() - lastActivity > TUNNEL_IDLE_MS) return finish(1000, 'idle');
    if (Date.now() - lastCheck < RECHECK_MS) return;
    lastCheck = Date.now();
    o.stillAllowed()
      .then((ok) => {
        if (!ok) finish(1008, 'access revoked');
      })
      .catch(() => finish(1011, 'access check failed'));
  }, 250);
  timer.unref();
}
