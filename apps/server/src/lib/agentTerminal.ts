import { isIPv6 } from 'node:net';
import { eq } from 'drizzle-orm';
import { type DB, servers } from '@ninedeploy/db';
import { agentOp, agentTransportSealed } from './agentClient.js';
import {
  decodeExit,
  deriveFrameKey,
  encodeResize,
  FRAME_SALT_BYTES,
  FRAME_TYPE,
  type FrameCipherError,
  FrameOpener,
  FrameSealer,
} from './agentFrameCipher.js';
import { decrypt, sha256 } from './crypto.js';
import type { TtyProcess } from './dockerTty.js';

/**
 * Node terminals, panel side (0.15, DESIGN §1.5, task T2b).
 *
 * A session whose target lives on a node (a service's primary placement or
 * fan-out target, or the node's host) runs through the node's agent:
 *
 *  1. `terminal.open` through the SEALED `agentOp` starts the exec (or the
 *     host-shell helper) on the node and answers a single-use channel id and
 *     a salt inside the sealed reply;
 *  2. the panel connects `ws://<node>/agent/terminal` (Node's global
 *     WebSocket; no new dependency) offering `ninedeploy.agent-terminal.<id>`;
 *  3. every frame both ways is AES-256-GCM under a per-channel key
 *     (lib/agentFrameCipher.ts); the panel's first frame is the initial size,
 *     which also proves to the agent that it holds the key.
 *
 * The result is a {@link TtyProcess}, so the session engine
 * (lib/terminalSessions.ts) runs a node session exactly like a local one:
 * the same caps, idle and duration limits, revalidation, terminate, byte
 * counts and end audit. Closing it (any end reason) closes the channel, and
 * the agent kills the process when its socket closes.
 */

/** Agent subprotocol prefix (see `AGENT_TERMINAL_PROTOCOL_PREFIX` in agent.ts). */
export const AGENT_TERMINAL_PROTOCOL_PREFIX = 'ninedeploy.agent-terminal.';
/** Agent route (see `AGENT_TERMINAL_PATH` in agent.ts). */
export const AGENT_TERMINAL_PATH = '/agent/terminal';
/** How long the panel waits for the agent's WebSocket to open. */
const CONNECT_TIMEOUT_MS = 10_000;
/** How long `kill()` waits for the channel to close before giving up on it. */
const CLOSE_WAIT_MS = 2000;

const agentWsUrl = (host: string, port: number): string => `ws://${isIPv6(host) ? `[${host}]` : host}:${port}${AGENT_TERMINAL_PATH}`;

/** The `ND-TERMINAL {"channel","salt"}` line of a `terminal.open` answer. */
export function parseTerminalChannel(lines: string[]): { channel: string; salt: Buffer } | null {
  for (const line of lines) {
    if (!line.startsWith('ND-TERMINAL ')) continue;
    try {
      const v = JSON.parse(line.slice('ND-TERMINAL '.length)) as { channel?: unknown; salt?: unknown };
      if (typeof v.channel !== 'string' || !/^[0-9a-f]{32}$/.test(v.channel) || typeof v.salt !== 'string') return null;
      const salt = Buffer.from(v.salt, 'base64');
      return salt.length === FRAME_SALT_BYTES ? { channel: v.channel, salt } : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The parts of a WHATWG WebSocket the channel uses (Node's global one; a fake in tests). */
export interface ChannelSocket {
  readonly readyState: number;
  binaryType: string;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'close' | 'error', cb: () => void): void;
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
}

export type ChannelSocketFactory = (url: string, protocols: string[]) => ChannelSocket;

const defaultSocketFactory: ChannelSocketFactory = (url, protocols) => new WebSocket(url, protocols) as unknown as ChannelSocket;

const OPEN = 1;

function messageBytes(data: unknown): Buffer | null {
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/** A process on a node, reached through an encrypted agent channel. */
export class AgentChannelTty implements TtyProcess {
  readonly mode: 'exec' | 'host';
  private readonly tx: FrameSealer;
  private readonly rx: FrameOpener;
  private dataListeners: Array<(chunk: Buffer) => void> = [];
  private endListeners: Array<(code: number | null) => void> = [];
  private early: Buffer[] = [];
  private ended = false;
  private exitCode: number | null = null;
  private closed: Promise<void>;
  private markClosed!: () => void;
  /** Why the channel failed, if it did (never sent anywhere; for the panel log and tests). */
  failure: FrameCipherError['code'] | 'protocol' | null = null;

  constructor(
    private readonly socket: ChannelSocket,
    key: Buffer,
    kind: 'container' | 'host',
  ) {
    this.mode = kind === 'host' ? 'host' : 'exec';
    this.tx = new FrameSealer(key, 'panel');
    this.rx = new FrameOpener(key, 'agent');
    this.closed = new Promise((resolve) => {
      this.markClosed = resolve;
    });
    socket.addEventListener('message', (ev) => this.onMessage(ev.data));
    socket.addEventListener('close', () => this.finish());
    socket.addEventListener('error', () => this.finish());
  }

  private send(frame: Buffer): void {
    if (this.ended || this.socket.readyState !== OPEN) return;
    try {
      this.socket.send(frame);
    } catch {
      /* closing: the close event ends the session */
    }
  }

  private onMessage(data: unknown): void {
    if (this.ended) return;
    const bytes = messageBytes(data);
    if (!bytes) {
      this.failure = 'protocol';
      this.abort();
      return;
    }
    let frame: { type: number; payload: Buffer };
    try {
      frame = this.rx.open(bytes);
    } catch (err) {
      this.failure = (err as FrameCipherError).code ?? 'protocol';
      this.abort();
      return;
    }
    if (frame.type === FRAME_TYPE.data) this.emitData(frame.payload);
    else if (frame.type === FRAME_TYPE.exit) this.exitCode = decodeExit(frame.payload);
    else if (frame.type === FRAME_TYPE.close) this.abort();
    else {
      // resize / pause / resume are the panel's to send.
      this.failure = 'protocol';
      this.abort();
    }
  }

  private emitData(chunk: Buffer): void {
    if (chunk.length === 0) return;
    if (this.dataListeners.length === 0) {
      if (this.early.reduce((n, b) => n + b.length, 0) < 1024 * 1024) this.early.push(chunk);
      return;
    }
    for (const cb of this.dataListeners) cb(chunk);
  }

  private abort(): void {
    try {
      this.socket.close(1000);
    } catch {
      /* already closing */
    }
    this.finish();
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.markClosed();
    for (const cb of this.endListeners.splice(0)) cb(this.exitCode);
  }

  /** Send the first frame: the initial size, which authenticates the channel to the agent. */
  start(cols: number, rows: number): void {
    this.resize(cols, rows);
  }

  write(data: Buffer): void {
    if (this.ended) return;
    for (const frame of this.tx.sealData(data)) this.send(frame);
  }

  resize(cols: number, rows: number): void {
    this.send(this.tx.seal(FRAME_TYPE.resize, encodeResize(cols, rows)));
  }

  pause(): void {
    this.send(this.tx.seal(FRAME_TYPE.pause));
  }

  resume(): void {
    this.send(this.tx.seal(FRAME_TYPE.resume));
  }

  onData(cb: (chunk: Buffer) => void): void {
    this.dataListeners.push(cb);
    if (this.early.length) cb(Buffer.concat(this.early.splice(0)));
  }

  onEnd(cb: (code: number | null) => void): void {
    if (this.ended) cb(this.exitCode);
    else this.endListeners.push(cb);
  }

  /** Close the channel; the agent kills the process when its socket closes. Idempotent, never throws. */
  async kill(): Promise<void> {
    if (!this.ended) {
      this.send(this.tx.seal(FRAME_TYPE.close));
      try {
        this.socket.close(1000);
      } catch {
        /* already closing */
      }
    }
    await Promise.race([
      this.closed,
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, CLOSE_WAIT_MS);
        t.unref?.();
      }),
    ]);
    this.finish();
  }
}

export interface NodeTerminalTarget {
  kind: 'service' | 'host' | 'database' | 'container';
  serverId: number | null;
  containerName: string | null;
}

/**
 * Open a resolved node target: the sealed `terminal.open` op, then the
 * encrypted channel. Throws with a message the attach route shows the
 * operator (close 4502). The capability was checked when the session was
 * created; the agent re-checks everything (sealed, host switch, container).
 */
export async function openNodeTerminalTty(
  db: DB,
  target: NodeTerminalTarget,
  opts: { sessionId: number; cols: number; rows: number; socketFactory?: ChannelSocketFactory },
): Promise<TtyProcess> {
  const serverId = target.serverId;
  if (serverId === null) throw new Error('not a node target');
  if (target.kind !== 'service' && target.kind !== 'host') throw new Error(`${target.kind} targets do not run on nodes`);
  const row = await db.query.servers.findFirst({ where: eq(servers.id, serverId) });
  if (!row) throw new Error(`node #${serverId} no longer exists`);
  // Defence in depth: create already refused this, but the transport is
  // re-probed per process and a terminal is never opened in clear.
  if (!(await agentTransportSealed(db, serverId))) {
    throw new Error(`the panel reaches node "${row.name}" only over the unencrypted transport`);
  }
  const kind = target.kind === 'host' ? 'host' : 'container';
  const params: Record<string, unknown> = { kind, cols: opts.cols, rows: opts.rows, sessionId: opts.sessionId };
  if (kind === 'container') {
    if (!target.containerName) throw new Error('the target has no container');
    params['container'] = target.containerName;
  }
  const res = await agentOp(db, serverId, 'terminal.open', params, () => undefined);
  const channel = parseTerminalChannel(res.lines);
  if (!channel) throw new Error(`the agent on node "${row.name}" answered terminal.open without a channel`);
  const key = deriveFrameKey(sha256(decrypt(row.tokenEncrypted)), channel.salt);

  const socket = (opts.socketFactory ?? defaultSocketFactory)(agentWsUrl(row.host, row.port), [
    `${AGENT_TERMINAL_PROTOCOL_PREFIX}${channel.channel}`,
  ]);
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
    const timer = setTimeout(() => done(new Error(`the agent on node "${row.name}" did not open the terminal channel in time`)), CONNECT_TIMEOUT_MS);
    timer.unref?.();
    socket.addEventListener('open', () => done());
    socket.addEventListener('error', () => done(new Error(`could not connect to the terminal channel on node "${row.name}"`)));
    socket.addEventListener('close', () => done(new Error(`the agent on node "${row.name}" refused the terminal channel`)));
  });
  const tty = new AgentChannelTty(socket, key, kind);
  tty.start(opts.cols, opts.rows);
  return tty;
}
