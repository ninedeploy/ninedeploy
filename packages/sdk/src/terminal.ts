// Terminal sessions over WebSocket (0.15 T6).
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import type {
  TerminalSessionCreated,
  TerminalTargetKind,
} from '@ninedeploy/schemas';
import { NineDeployError } from './errors.js';

/** Attach subprotocol (protocol v1) and the ticket's subprotocol prefix; mirror `@ninedeploy/schemas`. */
export const TERMINAL_SUBPROTOCOL = 'ninedeploy.terminal.v1';

export const TERMINAL_TICKET_PREFIX = 'ninedeploy.ticket.';

/** The server closes a socket whose frame exceeds 64 KiB (1009); input is sent in smaller pieces. */
export const TERMINAL_INPUT_CHUNK_BYTES = 32 * 1024;

/** Input typed before the shell is `ready` is held, up to this many bytes. */
export const TERMINAL_PENDING_INPUT_MAX = 64 * 1024;

/** What `attachInfo` needs from `terminals.create`'s answer. */
export type TerminalAttachSource = Pick<TerminalSessionCreated, 'ticket' | 'attachPath'>;

/** A page location, for a client whose `baseUrl` is relative (the dashboard). */
export interface WebSocketLocation {
  protocol: string;
  host: string;
}

export interface TerminalAttachInfo {
  url: string;
  /** `['ninedeploy.terminal.v1', 'ninedeploy.ticket.<ticket>']`: the server selects the first, so the ticket is never echoed. */
  protocols: string[];
}

/**
 * The attach WebSocket URL for `baseUrl` (absolute, or relative to
 * `location` / `globalThis.location`) and the v1 subprotocols.
 */
export function terminalAttachInfo(baseUrl: string, created: TerminalAttachSource, location?: WebSocketLocation): TerminalAttachInfo {
  if (!/^\/v1\/terminals\/\d+\/attach$/.test(created.attachPath)) {
    throw new NineDeployError(0, 'invalid_path', `Not a terminal attach path: ${created.attachPath}`);
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(created.ticket)) {
    throw new NineDeployError(0, 'invalid_ticket', 'The terminal ticket is malformed');
  }
  const base = baseUrl.replace(/\/+$/, '');
  let url: string;
  if (/^https?:\/\//i.test(base)) {
    url = `${base.replace(/^http/i, 'ws')}${created.attachPath}`;
  } else {
    const loc = location ?? (globalThis as { location?: WebSocketLocation }).location;
    if (!loc) throw new NineDeployError(0, 'no_base_url', 'A relative baseUrl needs a page location to build a WebSocket URL');
    const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
    url = `${proto}://${loc.host}${base}${created.attachPath}`;
  }
  return { url, protocols: [TERMINAL_SUBPROTOCOL, `${TERMINAL_TICKET_PREFIX}${created.ticket}`] };
}

/** A human sentence for an attach socket's close code. */
export function terminalCloseMessage(code: number): string {
  switch (code) {
    case 1000:
      return 'The shell exited.';
    case 1009:
      return 'A message was too large (over 64 KiB), so the session was closed.';
    case 4401:
      return 'The session ticket was invalid or expired. Open a new terminal.';
    case 4403:
      return 'Access was refused: the session was revoked, or this page is not a panel origin.';
    case 4408:
      return 'The session was closed after being idle too long.';
    case 4409:
      return 'The session reached its maximum length.';
    case 4410:
      return 'An operator terminated this session.';
    case 4429:
      return 'Too many terminals are open. Close one and try again.';
    case 4502:
      return 'The target could not be reached.';
    default:
      return `The connection was lost (code ${code}).`;
  }
}

/** The structural WebSocket the connection drives (browser `WebSocket`, Node's global one, or `ws`). */
export interface TerminalSocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type TerminalSocketFactory = (url: string, protocols: string[]) => TerminalSocketLike;

export interface TerminalReady {
  sessionId: number;
  target: { kind: TerminalTargetKind; label: string; serverId: number | null };
}

export interface TerminalHandlers {
  /** The shell runs; input typed before this was held and is flushed now. */
  onReady?: (ready: TerminalReady) => void;
  /** Shell output. */
  onData?: (bytes: Uint8Array) => void;
  /** A server notice (why a session failed, an ignored control message). */
  onNotice?: (message: string) => void;
  /** The server's `exit` message: the shell's exit code (null when unknown) and the end reason. */
  onExit?: (exit: { code: number | null; reason: string }) => void;
  /** The socket closed; `message` explains the close code. */
  onClose?: (close: { code: number; reason: string; message: string }) => void;
}

export interface TerminalConnectOptions {
  /** Defaults to `globalThis.WebSocket`. */
  socketFactory?: TerminalSocketFactory;
  /** For a relative `baseUrl` outside a browser page. */
  location?: WebSocketLocation;
  /** Keep-alive ping interval (ms); pings do not reset the idle timeout. 0 disables. Default 30s. */
  pingIntervalMs?: number;
}

export interface TerminalConnection {
  /** True once the server sent `ready`. */
  readonly ready: boolean;
  /** Send input (held until `ready`, then sent in frames below the server's cap). */
  write: (data: string | Uint8Array) => void;
  /** Resize the terminal (clamped to 10–500 × 5–200; the last size before `ready` is sent on `ready`). */
  resize: (cols: number, rows: number) => void;
  close: () => void;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(n)));

/** Timers and TextEncoder exist wherever the SDK runs; typed structurally (no DOM or Node lib types). */
const runtime = globalThis as unknown as {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  TextEncoder: new () => { encode: (text: string) => Uint8Array };
};

function defaultSocketFactory(): TerminalSocketFactory {
  const Ctor = (globalThis as { WebSocket?: new (url: string, protocols: string[]) => TerminalSocketLike }).WebSocket;
  if (!Ctor) throw new NineDeployError(0, 'no_websocket', 'No WebSocket implementation is available; pass socketFactory');
  return (url, protocols) => new Ctor(url, protocols);
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  const view = data as ArrayBufferView;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/**
 * Attach to a terminal session over protocol v1 (`ninedeploy.terminal.v1`).
 *
 * Binary frames carry input and output; text frames carry the JSON control
 * messages. Input written before the server's `ready` is held (up to 64 KiB)
 * and flushed on `ready`, because the server may drop input that arrives
 * while it is still starting the shell.
 */
export function connectTerminal(info: TerminalAttachInfo, handlers: TerminalHandlers = {}, options: TerminalConnectOptions = {}): TerminalConnection {
  const factory = options.socketFactory ?? defaultSocketFactory();
  const socket = factory(info.url, info.protocols);
  socket.binaryType = 'arraybuffer';
  const encoder = new runtime.TextEncoder();
  let ready = false;
  let closed = false;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let size: { cols: number; rows: number } | null = null;
  let ping: unknown;

  const sendInput = (bytes: Uint8Array) => {
    for (let at = 0; at < bytes.length; at += TERMINAL_INPUT_CHUNK_BYTES) {
      socket.send(bytes.subarray(at, at + TERMINAL_INPUT_CHUNK_BYTES));
    }
  };
  const sendResize = (cols: number, rows: number) => socket.send(JSON.stringify({ t: 'resize', cols, rows }));

  socket.onmessage = (event) => {
    if (typeof event.data !== 'string') {
      handlers.onData?.(toBytes(event.data));
      return;
    }
    let msg: { t?: unknown; message?: unknown; code?: unknown; reason?: unknown; sessionId?: unknown; target?: unknown };
    try {
      msg = JSON.parse(event.data) as typeof msg;
    } catch {
      return;
    }
    if (msg.t === 'ready') {
      ready = true;
      if (size) sendResize(size.cols, size.rows);
      const held = pending;
      pending = [];
      pendingBytes = 0;
      for (const bytes of held) sendInput(bytes);
      handlers.onReady?.({ sessionId: msg.sessionId as number, target: msg.target as TerminalReady['target'] });
      const every = options.pingIntervalMs ?? 30_000;
      if (every > 0) {
        ping = runtime.setInterval(() => {
          if (!closed) socket.send(JSON.stringify({ t: 'ping' }));
        }, every);
      }
    } else if (msg.t === 'notice') {
      handlers.onNotice?.(String(msg.message));
    } else if (msg.t === 'exit') {
      handlers.onExit?.({ code: typeof msg.code === 'number' ? msg.code : null, reason: String(msg.reason) });
    }
  };
  socket.onclose = (event) => {
    closed = true;
    ready = false;
    runtime.clearInterval(ping);
    handlers.onClose?.({ code: event.code, reason: event.reason, message: terminalCloseMessage(event.code) });
  };
  socket.onerror = () => {
    /* the close event follows and carries the code */
  };

  return {
    get ready() {
      return ready;
    },
    write: (data) => {
      if (closed) return;
      const bytes = typeof data === 'string' ? encoder.encode(data) : data;
      if (bytes.length === 0) return;
      if (ready) {
        sendInput(bytes);
        return;
      }
      if (pendingBytes + bytes.length > TERMINAL_PENDING_INPUT_MAX) return;
      pending.push(bytes);
      pendingBytes += bytes.length;
    },
    resize: (cols, rows) => {
      size = { cols: clamp(cols, 10, 500), rows: clamp(rows, 5, 200) };
      if (ready && !closed) sendResize(size.cols, size.rows);
    },
    close: () => {
      if (closed) return;
      closed = true;
      runtime.clearInterval(ping);
      socket.close(1000, 'client closed');
    },
  };
}
