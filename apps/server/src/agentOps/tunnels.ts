import { randomBytes } from 'node:crypto';
import { HELPER_IMAGE } from '../lib/inventory.js';
import { capture } from '../lib/exec.js';
import { deriveFrameKey, FRAME_SALT_BYTES, FrameOpener, FrameSealer, TUNNEL_HKDF_INFO } from '../lib/agentFrameCipher.js';
import { spawnValidated, spawnValidatedStream, type ValidatedStream } from '../lib/spawnValidated.js';
import { TUNNEL_FRAME, TUNNEL_FRAME_TYPES, TUNNEL_PROTOCOL_PREFIX } from '../lib/nodeTunnelProtocol.js';
import type { AgentOpContext, AgentOpModule } from './index.js';
import { RE_NAME, str } from './operands.js';

/**
 * G5.8 node tunnels, agent side: one TCP connection to a port of a service
 * container on this node, carried over an encrypted channel.
 *
 *  1. `tunnel.open {container, port, kind?}` (sealed only) checks that the
 *     container is a running container the panel started as that kind
 *     (`ninedeploy.managed=service`, the default, or `=database`) and parks
 *     a single-use channel for 30 s. The answer, inside
 *     the sealed reply, is `ND-TUNNEL {"channel","salt"}`.
 *  2. The panel connects `GET /agent/tunnel` offering
 *     `ninedeploy.agent-tunnel.<channel>`. Every frame both ways is
 *     AES-256-GCM under a key derived from the shared secret and the salt
 *     (tunnel-domain HKDF info); the panel's first frame (`resume`) proves it
 *     holds the key. Nothing connects before that.
 *  3. The connection is made from inside the container's own network
 *     namespace (`docker run --network container:<it> … nc 127.0.0.1
 *     <port>`), so it reaches the port whatever network the container is on,
 *     and nothing else: the helper has no other network, no capabilities and
 *     a read-only root.
 *
 * Either side closing ends the helper. The node owner turns tunnels off with
 * `NINEDEPLOY_AGENT_TUNNELS=off`. No tunnel byte is logged.
 */

const CAP = 'tunnel.tcp' as const;
/** A channel nobody attached within this window is dropped. */
export const TUNNEL_CHANNEL_TTL_MS = 30_000;
/** The panel's first frame must arrive within this window. */
const TUNNEL_AUTH_TIMEOUT_MS = 10_000;
/** Channels (pending + attached) one agent holds at a time. */
export const TUNNEL_MAX_CHANNELS = 32;
/** Hard cap on one tunnel's life (the panel closes idle ones sooner). */
const TUNNEL_HARD_CAP_MS = 24 * 3600 * 1000;
/** Stop reading the target while the panel socket holds more than this. */
const BACKPRESSURE_HIGH = 4 * 1024 * 1024;
/** Label on the helper container, so a crash leftover is recognisable. */
export const TUNNEL_HELPER_LABEL = 'ninedeploy.tunnel';

interface TunnelChannel {
  id: string;
  salt: Buffer;
  container: string;
  port: number;
  state: 'pending' | 'attached' | 'closed';
  timers: NodeJS.Timeout[];
  helper: ValidatedStream | null;
  helperName: string;
}

const channels = new Map<string, TunnelChannel>();

export const tunnelChannelCount = (): number => channels.size;

/** The `--format` the open check reads: managed label, running, and nothing else. */
export const TUNNEL_INSPECT_FORMAT = '{{index .Config.Labels "ninedeploy.managed"}}\t{{.State.Running}}';

function closeChannel(ch: TunnelChannel): void {
  if (ch.state === 'closed') return;
  ch.state = 'closed';
  for (const t of ch.timers) clearTimeout(t);
  channels.delete(ch.id);
  if (ch.helper) {
    ch.helper.kill();
    // `--rm` removes it once nc ends; this is the backstop for a stuck CLI.
    void spawnValidated('docker', ['rm', '-f', ch.helperName], () => undefined).catch(() => undefined);
  }
}

/** Close every channel (agent shutdown, tests). */
export function closeAllTunnelChannels(): void {
  for (const ch of [...channels.values()]) closeChannel(ch);
}

/** `tunnel.open {container, port, kind?}` → `ND-TUNNEL {"channel","salt"}`. */
async function tunnelOpenOp(params: Record<string, unknown>, onLine: (line: string) => void, ctx: AgentOpContext): Promise<number> {
  if (!ctx.sealed) throw new Error('Refusing to open a tunnel over the unencrypted transport: tunnel.open is accepted only inside a sealed request');
  const container = str(params, 'container');
  if (!container || container.length > 128 || !RE_NAME.test(container)) throw new Error('tunnel.open: invalid container');
  const port = params['port'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('tunnel.open: invalid port');
  const kind = params['kind'] ?? 'service';
  if (kind !== 'service' && kind !== 'database') throw new Error('tunnel.open: invalid kind');
  if (channels.size >= TUNNEL_MAX_CHANNELS) throw new Error(`Too many open tunnels on this node (at most ${TUNNEL_MAX_CHANNELS})`);
  const [label = '', running = ''] = (await capture('docker', ['inspect', '--format', TUNNEL_INSPECT_FORMAT, container], { timeoutMs: 30_000 })).trim().split('\t');
  if (label !== kind) throw new Error(`tunnel.open: ${container} is not a ${kind} container the panel started`);
  if (running !== 'true') throw new Error(`tunnel.open: ${container} is not running`);
  const id = randomBytes(16).toString('hex');
  const ch: TunnelChannel = {
    id,
    salt: randomBytes(FRAME_SALT_BYTES),
    container,
    port,
    state: 'pending',
    timers: [],
    helper: null,
    helperName: `nd-tunnel-${id.slice(0, 16)}`,
  };
  const ttl = setTimeout(() => {
    if (ch.state === 'pending') closeChannel(ch);
  }, TUNNEL_CHANNEL_TTL_MS);
  ttl.unref?.();
  ch.timers.push(ttl);
  channels.set(id, ch);
  onLine(`ND-TUNNEL ${JSON.stringify({ channel: id, salt: ch.salt.toString('base64') })}`);
  return 0;
}

export const tunnelOps: AgentOpModule = {
  name: 'agentOps/tunnels.ts',
  caps: [CAP],
  ops: {
    'tunnel.open': { cap: CAP, sealedOnly: true, run: (params, onLine, ctx) => tunnelOpenOp(params, onLine, ctx) },
  },
};

/** The argv of the helper that holds the TCP connection inside the target's network namespace. */
export function tunnelHelperArgv(name: string, container: string, port: number): string[] {
  return [
    'run', '--rm', '-i', '--init', '--name', name, '--label', `${TUNNEL_HELPER_LABEL}=1`,
    '--network', `container:${container}`,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '64m', '--pids-limit', '16',
    HELPER_IMAGE, 'nc', '127.0.0.1', String(port),
  ];
}

/** The parts of a `ws` socket the tunnel uses. */
export interface AgentTunnelSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', cb: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close' | 'error', cb: () => void): unknown;
}

/** The channel id a handshake offers, or null. */
export function tunnelChannelId(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  const entry = raw
    .split(',')
    .map((p) => p.trim())
    .find((p) => p.startsWith(TUNNEL_PROTOCOL_PREFIX));
  const id = entry?.slice(TUNNEL_PROTOCOL_PREFIX.length) ?? '';
  return /^[0-9a-f]{32}$/.test(id) ? id : null;
}

/** Test seam: how the helper is started. */
export const tunnelDeps = {
  spawnHelper: (argv: string[]): ValidatedStream => spawnValidatedStream('docker', argv, { timeoutMs: TUNNEL_HARD_CAP_MS, stdin: 'pipe' }),
};

/**
 * `GET /agent/tunnel`: attach a pending channel and bridge it. Anything but a
 * pending channel closes 1008. The helper starts only after the panel's first
 * frame opened under the channel key.
 */
export function attachTunnelChannel(socket: AgentTunnelSocket, protocolHeader: string | string[] | undefined, tokenHash: string): void {
  const OPEN = 1;
  const id = tunnelChannelId(protocolHeader);
  const ch = id ? channels.get(id) : undefined;
  if (!ch || ch.state !== 'pending') {
    socket.close(1008, 'unknown tunnel channel');
    return;
  }
  ch.state = 'attached';
  const key = deriveFrameKey(tokenHash, ch.salt, TUNNEL_HKDF_INFO);
  const rx = new FrameOpener(key, 'panel', TUNNEL_FRAME_TYPES);
  const tx = new FrameSealer(key, 'agent');
  let authed = false;
  let panelPaused = false;
  let pressurePaused = false;
  let askedPause = false;
  let drain: NodeJS.Timeout | undefined;

  const send = (frame: Buffer) => {
    if (socket.readyState !== OPEN) return;
    try {
      socket.send(frame);
    } catch {
      /* closed: the close handler ends the channel */
    }
  };
  const shut = (code: number, reason: string) => {
    clearInterval(drain);
    if (ch.state !== 'closed' && socket.readyState === OPEN) send(tx.seal(TUNNEL_FRAME.close, Buffer.from(reason.slice(0, 120), 'utf8')));
    try {
      if (socket.readyState === OPEN) socket.close(code, reason.slice(0, 120));
    } catch {
      /* already closed */
    }
    closeChannel(ch);
  };
  const applyPause = () => {
    if (!ch.helper) return;
    if (panelPaused || pressurePaused) ch.helper.stdout.pause();
    else ch.helper.stdout.resume();
  };
  const authTimer = setTimeout(() => {
    if (!authed) shut(1008, 'channel not authenticated');
  }, TUNNEL_AUTH_TIMEOUT_MS);
  authTimer.unref?.();
  ch.timers.push(authTimer);

  const start = () => {
    const helper = tunnelDeps.spawnHelper(tunnelHelperArgv(ch.helperName, ch.container, ch.port));
    ch.helper = helper;
    helper.stdout.on('data', (chunk: Buffer) => {
      if (ch.state === 'closed') return;
      for (const frame of tx.sealData(chunk)) send(frame);
      if (!pressurePaused && socket.bufferedAmount > BACKPRESSURE_HIGH) {
        pressurePaused = true;
        applyPause();
        drain = setInterval(() => {
          if (socket.readyState !== OPEN || socket.bufferedAmount <= BACKPRESSURE_HIGH / 4) {
            clearInterval(drain);
            pressurePaused = false;
            applyPause();
          }
        }, 50);
        drain.unref?.();
      }
    });
    void helper.exit.then(({ code }) => shut(1000, code === 0 ? 'the service closed the connection' : 'the connection to the service failed'));
  };

  socket.on('message', (data, isBinary) => {
    if (ch.state === 'closed') return;
    if (!isBinary) return shut(1008, 'text frames are not part of this protocol');
    const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data as Buffer[]) : Buffer.from(data as ArrayBuffer);
    let frame: { type: number; payload: Buffer };
    try {
      frame = rx.open(bytes);
    } catch {
      return shut(1008, 'bad frame');
    }
    if (!authed) {
      authed = true;
      clearTimeout(authTimer);
      start();
    }
    switch (frame.type) {
      case TUNNEL_FRAME.data: {
        const stdin = ch.helper?.stdin;
        // The service reads slower than the panel sends: ask the panel to wait.
        if (frame.payload.length && stdin && !stdin.write(frame.payload) && !askedPause) {
          askedPause = true;
          send(tx.seal(TUNNEL_FRAME.pause));
          stdin.once('drain', () => {
            askedPause = false;
            send(tx.seal(TUNNEL_FRAME.resume));
          });
        }
        return;
      }
      case TUNNEL_FRAME.pause:
        panelPaused = true;
        applyPause();
        return;
      case TUNNEL_FRAME.resume:
        panelPaused = false;
        applyPause();
        return;
      case TUNNEL_FRAME.close:
      default:
        return shut(1000, 'closed by the panel');
    }
  });
  socket.on('close', () => shut(1000, ''));
  socket.on('error', () => shut(1011, ''));
}
