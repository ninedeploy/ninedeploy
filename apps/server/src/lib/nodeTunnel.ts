import { isIPv6 } from 'node:net';
import { Duplex } from 'node:stream';
import { eq } from 'drizzle-orm';
import { type DB, servers } from '@ninedeploy/db';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { assertNodeCapability } from './agentCapabilities.js';
import { deriveFrameKey, FRAME_SALT_BYTES, FrameOpener, FrameSealer, TUNNEL_HKDF_INFO } from './agentFrameCipher.js';
import type { ChannelSocket, ChannelSocketFactory } from './agentTerminal.js';
import { decrypt, sha256 } from './crypto.js';
import { TUNNEL_FRAME, TUNNEL_FRAME_TYPES, TUNNEL_PATH, TUNNEL_PROTOCOL_PREFIX } from './nodeTunnelProtocol.js';

/**
 * G5.8 node tunnels, panel side: the sealed `tunnel.open` op, then the
 * encrypted `/agent/tunnel` channel (agentOps/tunnels.ts), as a Duplex the
 * tunnel bridge (lib/tunnelBridge.ts) treats like a TCP socket.
 */

const CONNECT_TIMEOUT_MS = 10_000;
const OPEN = 1;
/** Ask the agent to stop sending while this much waits unread here. */
const READ_HIGH_WATER = 1024 * 1024;
/** Stop accepting writes while the agent socket holds more than this. */
const WRITE_HIGH_WATER = 4 * 1024 * 1024;

/** The `ND-TUNNEL {"channel","salt"}` line of a `tunnel.open` answer. */
export function parseTunnelChannel(lines: readonly string[]): { channel: string; salt: Buffer } | null {
  for (const line of lines) {
    if (!line.startsWith('ND-TUNNEL ')) continue;
    try {
      const v = JSON.parse(line.slice('ND-TUNNEL '.length)) as { channel?: unknown; salt?: unknown };
      if (typeof v.channel !== 'string' || !/^[0-9a-f]{32}$/.test(v.channel) || typeof v.salt !== 'string') return null;
      const salt = Buffer.from(v.salt, 'base64');
      return salt.length === FRAME_SALT_BYTES ? { channel: v.channel, salt } : null;
    } catch {
      return null;
    }
  }
  return null;
}

function messageBytes(data: unknown): Buffer | null {
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/** One tunnel through a node agent, as a byte stream. Ends when either side closes. */
export class NodeTunnelStream extends Duplex {
  private readonly tx: FrameSealer;
  private readonly rx: FrameOpener;
  private agentPaused = false;
  private askedPause = false;
  private finished = false;
  private pendingWrite: ((error?: Error) => void) | null = null;
  private pressure: NodeJS.Timeout | undefined;

  constructor(
    private readonly socket: ChannelSocket & { readonly bufferedAmount?: number },
    key: Buffer,
  ) {
    super({ readableHighWaterMark: READ_HIGH_WATER });
    this.tx = new FrameSealer(key, 'panel');
    this.rx = new FrameOpener(key, 'agent', TUNNEL_FRAME_TYPES);
    socket.addEventListener('message', (ev) => this.onMessage(ev.data));
    socket.addEventListener('close', () => this.end_(null));
    socket.addEventListener('error', () => this.end_(new Error('the node tunnel failed')));
    // The first frame authenticates the channel; the agent connects only then.
    this.sendFrame(this.tx.seal(TUNNEL_FRAME.resume));
  }

  private sendFrame(frame: Buffer): boolean {
    if (this.finished || this.socket.readyState !== OPEN) return false;
    try {
      this.socket.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  private onMessage(data: unknown): void {
    if (this.finished) return;
    const bytes = messageBytes(data);
    let frame: { type: number; payload: Buffer };
    try {
      if (!bytes) throw new Error('not binary');
      frame = this.rx.open(bytes);
    } catch {
      this.end_(new Error('the node tunnel sent a bad frame'));
      return;
    }
    switch (frame.type) {
      case TUNNEL_FRAME.data:
        if (frame.payload.length && !this.push(frame.payload) && !this.askedPause) {
          this.askedPause = true;
          this.sendFrame(this.tx.seal(TUNNEL_FRAME.pause));
        }
        return;
      case TUNNEL_FRAME.pause:
        this.agentPaused = true;
        return;
      case TUNNEL_FRAME.resume:
        this.agentPaused = false;
        this.flushWrite();
        return;
      default:
        this.end_(null);
        return;
    }
  }

  private flushWrite(): void {
    if (this.agentPaused || (this.socket.bufferedAmount ?? 0) > WRITE_HIGH_WATER) return;
    const cb = this.pendingWrite;
    this.pendingWrite = null;
    clearInterval(this.pressure);
    this.pressure = undefined;
    cb?.();
  }

  override _read(): void {
    if (this.askedPause && !this.finished) {
      this.askedPause = false;
      this.sendFrame(this.tx.seal(TUNNEL_FRAME.resume));
    }
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    if (this.finished) {
      cb(new Error('the node tunnel is closed'));
      return;
    }
    for (const frame of this.tx.sealData(chunk)) {
      if (!this.sendFrame(frame)) {
        cb(new Error('could not send data through the node tunnel'));
        return;
      }
    }
    if (!this.agentPaused && (this.socket.bufferedAmount ?? 0) <= WRITE_HIGH_WATER) {
      cb();
      return;
    }
    // Hold the callback (and with it the writer) until the agent can take more.
    this.pendingWrite = cb;
    this.pressure ??= setInterval(() => this.flushWrite(), 50);
    this.pressure.unref?.();
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    if (!this.finished) {
      this.sendFrame(this.tx.seal(TUNNEL_FRAME.close));
      this.finished = true;
      try {
        this.socket.close(1000);
      } catch {
        /* already closing */
      }
    }
    clearInterval(this.pressure);
    const pending = this.pendingWrite;
    this.pendingWrite = null;
    pending?.(err ?? new Error('the node tunnel is closed'));
    cb(err);
  }

  private end_(err: Error | null): void {
    if (this.finished) return;
    this.finished = true;
    clearInterval(this.pressure);
    const pending = this.pendingWrite;
    this.pendingWrite = null;
    pending?.(err ?? new Error('the node tunnel is closed'));
    try {
      this.socket.close(1000);
    } catch {
      /* already closing */
    }
    if (err) this.destroy(err);
    else {
      this.push(null);
      // The bridge treats `close` as the end of the target side.
      this.destroy();
    }
  }
}

const agentWsUrl = (host: string, port: number): string => `ws://${isIPv6(host) ? `[${host}]` : host}:${port}${TUNNEL_PATH}`;

const defaultSocketFactory: ChannelSocketFactory = (url, protocols) => new WebSocket(url, protocols) as unknown as ChannelSocket;

/** Refuses (422) a node whose agent cannot carry tunnels, or reaches it only unsealed. */
export async function assertNodeTunnels(db: DB, serverId: number): Promise<void> {
  await assertNodeCapability(db, serverId, { cap: 'tunnel.tcp', feature: 'open tunnels to node services and databases', sealedRequired: true });
}

/**
 * Open a tunnel to `container:port` on a node: the sealed `tunnel.open`,
 * then the encrypted channel. Throws with a message the route shows.
 */
export async function openNodeTunnel(
  db: DB,
  serverId: number,
  target: { container: string; port: number; kind?: 'service' | 'database' },
  opts: { socketFactory?: ChannelSocketFactory } = {},
): Promise<NodeTunnelStream> {
  const row = await db.query.servers.findFirst({ where: eq(servers.id, serverId) });
  if (!row) throw new Error(`node #${serverId} no longer exists`);
  await assertNodeTunnels(db, serverId);
  if (!(await agentTransportSealed(db, serverId))) throw new Error(`the panel reaches node "${row.name}" only over the unencrypted transport`);
  const res = await agentOp(db, serverId, 'tunnel.open', { container: target.container, port: target.port, ...(target.kind === 'database' ? { kind: 'database' } : {}) }, () => undefined);
  const channel = parseTunnelChannel(res.lines);
  if (!channel) throw new Error(`the agent on node "${row.name}" answered tunnel.open without a channel`);
  const key = deriveFrameKey(sha256(decrypt(row.tokenEncrypted)), channel.salt, TUNNEL_HKDF_INFO);
  const socket = (opts.socketFactory ?? defaultSocketFactory)(agentWsUrl(row.host, row.port), [`${TUNNEL_PROTOCOL_PREFIX}${channel.channel}`]);
  socket.binaryType = 'arraybuffer';
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        try {
          socket.close();
        } catch {
          /* never opened */
        }
        reject(err);
      } else resolve();
    };
    const timer = setTimeout(() => done(new Error(`the agent on node "${row.name}" did not open the tunnel channel in time`)), CONNECT_TIMEOUT_MS);
    timer.unref?.();
    socket.addEventListener('open', () => done());
    socket.addEventListener('error', () => done(new Error(`could not connect to the tunnel channel on node "${row.name}"`)));
    socket.addEventListener('close', () => done(new Error(`the agent on node "${row.name}" refused the tunnel channel`)));
  });
  return new NodeTunnelStream(socket, key);
}
