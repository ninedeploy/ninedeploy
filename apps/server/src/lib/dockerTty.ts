import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { buildEnv } from './exec.js';

/**
 * A real TTY in a container (or on the host) without native dependencies
 * (0.15, DESIGN §1.3). Shared by the panel's terminal engine and, from T2b,
 * the node agent.
 *
 * The Docker Engine API is spoken directly over the daemon's socket with
 * `node:http`: `POST /containers/{name}/exec` with `Tty: true`, then
 * `POST /exec/{id}/start` with `Connection: Upgrade` / `Upgrade: tcp`, which
 * hijacks the HTTP connection into a raw duplex stream. With `Tty: true` the
 * stream is not multiplexed, so it is the terminal byte stream itself, and
 * `POST /exec/{id}/resize` resizes the PTY.
 *
 * D1: the 0.14 web terminal got a PTY only by wrapping `docker exec -t` in
 * `python3 -c 'import pty'`, and the runtime image installs no python3, so
 * every docker install got pipe mode (no prompt, echo or line editing). This
 * module needs neither python nor a TTY-capable stdio.
 *
 * Transport selection mirrors what the docker CLI would reach:
 *   1. `DOCKER_HOST` unset (default socket) or `unix://` / `npipe://`: the socket;
 *   2. `tcp://` without TLS: plain HTTP to that host;
 *   3. anything else (TLS, `ssh://`, a non-default `DOCKER_CONTEXT`): `cli`,
 *      the caller falls back to `docker exec -i` pipe mode (container shells)
 *      or refuses (host shells, which need the Engine API).
 */

// ── transport ───────────────────────────────────────────────────────────────

export type EngineTransport = { kind: 'socket'; socketPath: string } | { kind: 'tcp'; host: string; port: number };
export type DockerTransport = EngineTransport | { kind: 'cli'; reason: string };

const DEFAULT_UNIX_SOCKET = '/var/run/docker.sock';
const DEFAULT_WINDOWS_PIPE = '\\\\.\\pipe\\docker_engine';

const truthy = (v: string | undefined) => v !== undefined && v.trim() !== '' && v.trim() !== '0';

/**
 * Which way the Engine API is reachable. `env` is the process environment
 * (Docker's own variables: they are not NineDeploy configuration).
 */
export function dockerTransport(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): DockerTransport {
  const host = (env['DOCKER_HOST'] ?? '').trim();
  if (!host) {
    const context = (env['DOCKER_CONTEXT'] ?? '').trim();
    if (context && context !== 'default') return { kind: 'cli', reason: `DOCKER_CONTEXT=${context} is a CLI context` };
    if (platform === 'win32') return { kind: 'socket', socketPath: DEFAULT_WINDOWS_PIPE };
    if (!exists(DEFAULT_UNIX_SOCKET)) return { kind: 'cli', reason: `${DEFAULT_UNIX_SOCKET} does not exist` };
    return { kind: 'socket', socketPath: DEFAULT_UNIX_SOCKET };
  }
  if (host.startsWith('unix://')) {
    const socketPath = host.slice('unix://'.length);
    return socketPath ? { kind: 'socket', socketPath } : { kind: 'cli', reason: 'DOCKER_HOST names no socket path' };
  }
  if (host.startsWith('npipe://')) {
    // npipe:////./pipe/docker_engine → \\.\pipe\docker_engine
    const pipe = host.slice('npipe://'.length).replace(/\//g, '\\');
    return pipe ? { kind: 'socket', socketPath: pipe } : { kind: 'cli', reason: 'DOCKER_HOST names no pipe' };
  }
  if (host.startsWith('tcp://')) {
    if (truthy(env['DOCKER_TLS_VERIFY']) || truthy(env['DOCKER_TLS'])) {
      return { kind: 'cli', reason: 'DOCKER_HOST uses TLS' };
    }
    try {
      const url = new URL(`http://${host.slice('tcp://'.length)}`);
      if (!url.hostname) return { kind: 'cli', reason: 'DOCKER_HOST names no host' };
      return { kind: 'tcp', host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : 2375 };
    } catch {
      return { kind: 'cli', reason: 'DOCKER_HOST is not a valid tcp:// address' };
    }
  }
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(host)?.[1] ?? 'unknown';
  return { kind: 'cli', reason: `DOCKER_HOST uses ${scheme}://` };
}

export const isEngineTransport = (t: DockerTransport): t is EngineTransport => t.kind !== 'cli';

// ── raw Engine API requests ─────────────────────────────────────────────────

/** A non-2xx answer from the Engine API (`message` is the daemon's own text). */
export class DockerEngineError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DockerEngineError';
  }
}

export interface EngineResponse {
  status: number;
  body: string;
}

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function baseOptions(t: EngineTransport): http.RequestOptions {
  return t.kind === 'socket' ? { socketPath: t.socketPath } : { host: t.host, port: t.port };
}

function errorText(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
  } catch {
    /* not JSON */
  }
  return body.trim().slice(0, 300) || `Docker Engine API answered ${status}`;
}

/** One Engine API call. Rejects on transport errors; resolves with any HTTP status. */
export function engineRequest(
  t: EngineTransport,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<EngineResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      ...baseOptions(t),
      method,
      path,
      headers: {
        Host: 'docker',
        ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Docker Engine API ${method} ${path} timed out`)));
    req.on('error', reject);
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size <= MAX_RESPONSE_BYTES) chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.end(payload);
  });
}

/** `engineRequest` that throws `DockerEngineError` unless the status is 2xx (or listed in `ok`). */
export async function engineCall(
  t: EngineTransport,
  method: string,
  path: string,
  body?: unknown,
  ok: number[] = [],
  timeoutMs?: number,
): Promise<EngineResponse> {
  const res = await engineRequest(t, method, path, body, timeoutMs);
  if ((res.status < 200 || res.status >= 300) && !ok.includes(res.status)) {
    throw new DockerEngineError(res.status, errorText(res.status, res.body));
  }
  return res;
}

/**
 * POST that hijacks the connection (`Upgrade: tcp`, answered `101`) and
 * resolves with the raw duplex stream. Bytes that arrived with the 101 answer
 * are pushed back so the caller reads them first.
 */
export function engineHijack(t: EngineTransport, path: string, body?: unknown): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = http.request({
      ...baseOptions(t),
      method: 'POST',
      path,
      headers: {
        Host: 'docker',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Connection: 'Upgrade',
        Upgrade: 'tcp',
      },
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`Docker Engine API attach ${path} timed out`)));
    req.on('error', reject);
    req.on('upgrade', (_res, socket, head) => {
      req.setTimeout(0);
      socket.setTimeout?.(0);
      if (head.length > 0) socket.unshift(head);
      resolve(socket);
    });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        reject(new DockerEngineError(status, errorText(status, Buffer.concat(chunks).toString('utf8'))));
      });
    });
    req.end(payload);
  });
}

const enc = encodeURIComponent;

// ── container inspection ────────────────────────────────────────────────────

export interface ContainerSummary {
  id: string;
  running: boolean;
  hostname: string | null;
  labels: Record<string, string>;
}

/** `GET /containers/{name}/json`; null when the container does not exist. */
export async function inspectContainer(t: EngineTransport, name: string): Promise<ContainerSummary | null> {
  const res = await engineCall(t, 'GET', `/containers/${enc(name)}/json`, undefined, [404]);
  if (res.status === 404) return null;
  const j = JSON.parse(res.body) as {
    Id?: string;
    State?: { Running?: boolean };
    Config?: { Hostname?: string; Labels?: Record<string, string> | null };
  };
  return {
    id: j.Id ?? '',
    running: j.State?.Running === true,
    hostname: j.Config?.Hostname ?? null,
    labels: j.Config?.Labels ?? {},
  };
}

/** Containers carrying `label` (any value), stopped ones included. */
export async function listContainersWithLabel(
  t: EngineTransport,
  label: string,
): Promise<Array<{ id: string; labels: Record<string, string> }>> {
  const filters = enc(JSON.stringify({ label: [label] }));
  const res = await engineCall(t, 'GET', `/containers/json?all=1&filters=${filters}`);
  const rows = JSON.parse(res.body) as Array<{ Id: string; Labels?: Record<string, string> | null }>;
  return rows.map((r) => ({ id: r.Id, labels: r.Labels ?? {} }));
}

/** `DELETE /containers/{id}?force=1`; a missing container (or one already being removed) is fine. */
export async function forceRemoveContainer(t: EngineTransport, id: string): Promise<void> {
  await engineCall(t, 'DELETE', `/containers/${enc(id)}?force=1`, undefined, [404, 409]);
}

// ── the shell command and its PID marker ────────────────────────────────────

/**
 * The shell started in a container. The OSC 777 marker reports the shell's
 * in-container PID (`$$` survives the `exec`); the server strips it from the
 * stream and uses it to HUP the shell when the session ends, because moby
 * keeps an exec process running after its attach connection is dropped.
 */
export const SHELL_CMD = [
  '/bin/sh',
  '-c',
  'printf "\\033]777;nd-pid;%s\\007" $$; if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi',
] as const;

const MARKER = Buffer.from('\x1b]777;nd-pid;', 'latin1');
/** The marker is the shell's first output: stop looking after this many bytes. */
const MARKER_SEARCH_BYTES = 8192;
const MARKER_MAX_BYTES = MARKER.length + 16;

/**
 * Removes the first OSC 777 PID marker from a byte stream, across chunk
 * boundaries, and records the PID. Every other byte passes through unchanged
 * and in order.
 */
export class OscPidStripper {
  pid: number | null = null;
  private pending: Buffer = Buffer.alloc(0);
  private done = false;
  private scanned = 0;

  feed(chunk: Buffer): Buffer {
    if (this.done) return chunk;
    const buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = Buffer.alloc(0);
    const start = buf.indexOf(MARKER);
    if (start >= 0) {
      const end = buf.indexOf(0x07, start + MARKER.length);
      if (end < 0) {
        if (buf.length - start > MARKER_MAX_BYTES) {
          this.done = true; // not our marker after all
          return buf;
        }
        this.pending = buf.subarray(start);
        return buf.subarray(0, start);
      }
      const text = buf.subarray(start + MARKER.length, end).toString('latin1');
      this.done = true;
      if (!/^\d{1,10}$/.test(text)) return buf;
      this.pid = Number(text);
      return Buffer.concat([buf.subarray(0, start), buf.subarray(end + 1)]);
    }
    // Hold back a tail that could be the beginning of the marker.
    let keep = 0;
    for (let k = Math.min(MARKER.length - 1, buf.length); k > 0; k--) {
      if (buf.subarray(buf.length - k).equals(MARKER.subarray(0, k))) {
        keep = k;
        break;
      }
    }
    this.scanned += buf.length - keep;
    if (this.scanned > MARKER_SEARCH_BYTES) {
      this.done = true;
      return buf;
    }
    this.pending = buf.subarray(buf.length - keep);
    return buf.subarray(0, buf.length - keep);
  }

  /** Bytes still held back (end of stream). */
  flush(): Buffer {
    const rest = this.pending;
    this.pending = Buffer.alloc(0);
    this.done = true;
    return rest;
  }
}

// ── the TTY process abstraction ─────────────────────────────────────────────

/** A running interactive process with a terminal attached. */
export interface TtyProcess {
  /** What runs: `exec` in a container, the `host` helper, or `cli` pipe mode. */
  readonly mode: 'exec' | 'host' | 'cli';
  write(data: Buffer): void;
  /** Resize the PTY; errors are swallowed (pipe mode ignores it). */
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  onData(cb: (chunk: Buffer) => void): void;
  /** Called once when the process's stream ended (the exit code, or null when unknown). */
  onEnd(cb: (exitCode: number | null) => void): void;
  /** Stop the process (HUP then KILL, or remove the helper). Idempotent, never throws. */
  kill(): Promise<void>;
}

type Listener<T> = (v: T) => void;

/** Shared plumbing: data and end fan-out, once-only end. */
abstract class BaseTty implements TtyProcess {
  abstract readonly mode: 'exec' | 'host' | 'cli';
  private dataListeners: Array<Listener<Buffer>> = [];
  private endListeners: Array<Listener<number | null>> = [];
  private ended = false;
  private endCode: number | null = null;
  protected killed = false;

  abstract write(data: Buffer): void;
  abstract resize(cols: number, rows: number): void;
  abstract pause(): void;
  abstract resume(): void;
  abstract kill(): Promise<void>;

  /** Output that arrived before anyone listened (the first prompt, while the helper was still starting). */
  private early: Buffer[] = [];

  onData(cb: Listener<Buffer>): void {
    this.dataListeners.push(cb);
    if (this.early.length) {
      const held = Buffer.concat(this.early.splice(0));
      cb(held);
    }
  }

  onEnd(cb: Listener<number | null>): void {
    if (this.ended) cb(this.endCode);
    else this.endListeners.push(cb);
  }

  protected emitData(chunk: Buffer): void {
    if (chunk.length === 0) return;
    if (this.dataListeners.length === 0) {
      // Bounded: nothing legitimate prints a megabyte before the bridge listens.
      if (this.early.reduce((n, b) => n + b.length, 0) < 1024 * 1024) this.early.push(chunk);
      return;
    }
    for (const cb of this.dataListeners) cb(chunk);
  }

  protected emitEnd(code: number | null): void {
    if (this.ended) return;
    this.ended = true;
    this.endCode = code;
    for (const cb of this.endListeners.splice(0)) cb(code);
  }

  get hasEnded(): boolean {
    return this.ended;
  }
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

export interface ExecTtyOptions {
  container: string;
  cmd: readonly string[];
  /** `KEY=value` pairs (credentials for database clients ride here, never in argv). */
  env?: string[];
  cols: number;
  rows: number;
  /** HUP → KILL grace (default 5s). */
  killGraceMs?: number;
}

/** An exec session in a container over the Engine API. */
class EngineExecTty extends BaseTty {
  readonly mode = 'exec' as const;
  private readonly stripper = new OscPidStripper();
  private killing: Promise<void> | null = null;

  constructor(
    private readonly t: EngineTransport,
    private readonly execId: string,
    private readonly container: string,
    private readonly stream: Duplex,
    private readonly killGraceMs: number,
  ) {
    super();
    stream.on('data', (c: Buffer) => this.emitData(this.stripper.feed(c)));
    let streamDone = false;
    const finish = () => {
      if (streamDone) return;
      streamDone = true;
      this.emitData(this.stripper.flush());
      void this.exitCode().then((code) => this.emitEnd(code));
    };
    stream.once('end', finish);
    stream.once('close', finish);
    stream.on('error', () => {
      /* surfaced through close */
    });
  }

  get pid(): number | null {
    return this.stripper.pid;
  }

  write(data: Buffer): void {
    if (!this.stream.destroyed && this.stream.writable) this.stream.write(data);
  }

  resize(cols: number, rows: number): void {
    void engineRequest(this.t, 'POST', `/exec/${enc(this.execId)}/resize?h=${rows}&w=${cols}`).catch(() => undefined);
  }

  pause(): void {
    this.stream.pause();
  }

  resume(): void {
    this.stream.resume();
  }

  private async inspect(): Promise<{ running: boolean; exitCode: number | null }> {
    try {
      const res = await engineCall(this.t, 'GET', `/exec/${enc(this.execId)}/json`);
      const j = JSON.parse(res.body) as { Running?: boolean; ExitCode?: number | null };
      return { running: j.Running === true, exitCode: typeof j.ExitCode === 'number' ? j.ExitCode : null };
    } catch {
      return { running: false, exitCode: null };
    }
  }

  /** The exit code once the process is gone (one short retry: the stream can end a beat before the daemon records the exit). */
  async exitCode(): Promise<number | null> {
    let state = await this.inspect();
    if (state.running && !this.killed) {
      await delay(200);
      state = await this.inspect();
    }
    return state.running ? null : state.exitCode;
  }

  private async signal(sig: 'HUP' | 'KILL', pid: number): Promise<void> {
    try {
      const created = await engineCall(this.t, 'POST', `/containers/${enc(this.container)}/exec`, {
        AttachStdin: false,
        AttachStdout: false,
        AttachStderr: false,
        Tty: false,
        Cmd: ['kill', `-${sig}`, String(pid)],
      });
      const id = (JSON.parse(created.body) as { Id: string }).Id;
      await engineCall(this.t, 'POST', `/exec/${enc(id)}/start`, { Detach: true, Tty: false });
    } catch {
      /* the container may be gone already */
    }
  }

  kill(): Promise<void> {
    this.killing ??= (async () => {
      this.killed = true;
      this.stream.destroy();
      const pid = this.stripper.pid;
      if (pid === null) return;
      if (!(await this.inspect()).running) return;
      await this.signal('HUP', pid);
      await delay(this.killGraceMs);
      if ((await this.inspect()).running) await this.signal('KILL', pid);
    })();
    return this.killing;
  }
}

/** Create the exec and attach to it. Throws `DockerEngineError` (404 no container, 409 not running). */
export async function openExecTty(t: EngineTransport, opts: ExecTtyOptions): Promise<TtyProcess & { readonly pid: number | null }> {
  const created = await engineCall(t, 'POST', `/containers/${enc(opts.container)}/exec`, {
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Env: ['TERM=xterm-256color', ...(opts.env ?? [])],
    ConsoleSize: [opts.rows, opts.cols],
    Cmd: [...opts.cmd],
  });
  const execId = (JSON.parse(created.body) as { Id: string }).Id;
  const stream = await engineHijack(t, `/exec/${enc(execId)}/start`, { Detach: false, Tty: true, ConsoleSize: [opts.rows, opts.cols] });
  const tty = new EngineExecTty(t, execId, opts.container, stream, opts.killGraceMs ?? 5000);
  // Daemons older than API 1.42 ignore ConsoleSize: resize right after the attach.
  tty.resize(opts.cols, opts.rows);
  return tty;
}

// ── host shells: the short-lived nsenter helper ─────────────────────────────

/** Label on every host-shell helper (value: the session id). */
export const TERMINAL_SESSION_LABEL = 'ninedeploy.terminal.session';
/** Label with the helper's hard expiry (unix seconds). */
export const TERMINAL_EXPIRES_LABEL = 'ninedeploy.terminal.expires';

export const HOST_SHELL_CMD = [
  '-t',
  '1',
  '-m',
  '-u',
  '-i',
  '-n',
  '-p',
  '--',
  '/bin/sh',
  '-c',
  'command -v bash >/dev/null && exec bash -l || exec sh -l',
] as const;

export interface HostShellOptions {
  image: string;
  sessionId: number;
  /** Unix seconds after which the reaper removes the helper whatever happens. */
  expiresAt: number;
  cols: number;
  rows: number;
}

/** The `POST /containers/create` body of a host-shell helper (exported for its test). */
export function hostShellCreateBody(opts: HostShellOptions): Record<string, unknown> {
  return {
    Image: opts.image,
    Entrypoint: ['nsenter'],
    Cmd: [...HOST_SHELL_CMD],
    Env: ['TERM=xterm-256color'],
    Tty: true,
    OpenStdin: true,
    StdinOnce: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Labels: {
      [TERMINAL_SESSION_LABEL]: String(opts.sessionId),
      [TERMINAL_EXPIRES_LABEL]: String(opts.expiresAt),
    },
    HostConfig: {
      Privileged: true,
      PidMode: 'host',
      NetworkMode: 'host',
      IpcMode: 'host',
      UTSMode: 'host',
      AutoRemove: true,
      ConsoleSize: [opts.rows, opts.cols],
    },
  };
}

export const hostShellContainerName = (sessionId: number) => `nd-hostshell-${sessionId}`;

class HostShellTty extends BaseTty {
  readonly mode = 'host' as const;
  private killing: Promise<void> | null = null;

  constructor(
    private readonly t: EngineTransport,
    readonly containerId: string,
    private readonly stream: Duplex,
    exit: Promise<number | null>,
  ) {
    super();
    stream.on('data', (c: Buffer) => this.emitData(c));
    let streamDone = false;
    const finish = () => {
      if (streamDone) return;
      streamDone = true;
      // The wait answer carries the exit code; do not hang on it forever.
      void Promise.race([exit, delay(3000).then(() => null)]).then((code) => this.emitEnd(code));
    };
    stream.once('end', finish);
    stream.once('close', finish);
    stream.on('error', () => {
      /* surfaced through close */
    });
  }

  write(data: Buffer): void {
    if (!this.stream.destroyed && this.stream.writable) this.stream.write(data);
  }

  resize(cols: number, rows: number): void {
    void engineRequest(this.t, 'POST', `/containers/${enc(this.containerId)}/resize?h=${rows}&w=${cols}`).catch(() => undefined);
  }

  pause(): void {
    this.stream.pause();
  }

  resume(): void {
    this.stream.resume();
  }

  kill(): Promise<void> {
    this.killing ??= (async () => {
      this.killed = true;
      this.stream.destroy();
      await forceRemoveContainer(this.t, this.containerId).catch(() => undefined);
    })();
    return this.killing;
  }
}

/**
 * Start a host shell: a privileged helper in the host's PID, network, IPC and
 * UTS namespaces running `nsenter -t 1` into PID 1's mount namespace. The
 * helper is auto-removed when the shell exits and force-removed on session
 * end; the reaper removes any helper whose session is not live.
 */
export async function openHostShellTty(t: EngineTransport, opts: HostShellOptions): Promise<TtyProcess & { readonly containerId: string }> {
  const created = await engineCall(
    t,
    'POST',
    `/containers/create?name=${enc(hostShellContainerName(opts.sessionId))}`,
    hostShellCreateBody(opts),
  );
  const id = (JSON.parse(created.body) as { Id: string }).Id;
  try {
    const stream = await engineHijack(t, `/containers/${enc(id)}/attach?stream=1&stdin=1&stdout=1&stderr=1`);
    // Issued before start so the exit cannot be missed; AutoRemove follows it.
    const exit = engineCall(t, 'POST', `/containers/${enc(id)}/wait?condition=next-exit`, undefined, [], 24 * 3600 * 1000)
      .then((res) => {
        const code = (JSON.parse(res.body) as { StatusCode?: number }).StatusCode;
        return typeof code === 'number' ? code : null;
      })
      .catch(() => null);
    const tty = new HostShellTty(t, id, stream, exit);
    try {
      await engineCall(t, 'POST', `/containers/${enc(id)}/start`, undefined, [304]);
    } catch (err) {
      stream.destroy();
      throw err;
    }
    tty.resize(opts.cols, opts.rows);
    return tty;
  } catch (err) {
    await forceRemoveContainer(t, id).catch(() => undefined);
    throw err;
  }
}

export type HostShellProbe = { ok: true } | { ok: false; reason: string };

const probeCache = new Map<string, HostShellProbe>();

/** Test hook: forget cached probe results. */
export function resetHostShellProbeCache(): void {
  probeCache.clear();
}

/**
 * Does `image` have an `nsenter` (the BusyBox applet in Traefik's Alpine
 * image)? Runs `nsenter --help` once per image per process and caches a
 * definite answer; a transport failure is not cached.
 */
export async function probeHostShellImage(t: EngineTransport, image: string): Promise<HostShellProbe> {
  const cached = probeCache.get(image);
  if (cached) return cached;
  let id: string | null = null;
  let result: HostShellProbe;
  try {
    const created = await engineCall(t, 'POST', '/containers/create', {
      Image: image,
      Entrypoint: ['nsenter'],
      Cmd: ['--help'],
      Labels: { 'ninedeploy.terminal.probe': '1' },
      HostConfig: { NetworkMode: 'none', AutoRemove: false },
    }, [404]);
    if (created.status === 404) {
      // A missing image is not cached: pulling it fixes the probe.
      return { ok: false, reason: `the image ${image} is not present on this host (docker pull ${image})` };
    }
    id = (JSON.parse(created.body) as { Id: string }).Id;
    const started = await engineRequest(t, 'POST', `/containers/${enc(id)}/start`);
    if (started.status >= 300 && started.status !== 304) {
      result = { ok: false, reason: `the image ${image} has no nsenter (${errorText(started.status, started.body)})` };
    } else {
      const waited = await engineCall(t, 'POST', `/containers/${enc(id)}/wait`, undefined, [], 30_000);
      const code = (JSON.parse(waited.body) as { StatusCode?: number }).StatusCode;
      result = code === 126 || code === 127 ? { ok: false, reason: `the image ${image} has no nsenter` } : { ok: true };
    }
  } finally {
    if (id) await forceRemoveContainer(t, id).catch(() => undefined);
  }
  probeCache.set(image, result);
  return result;
}

// ── pipe mode through the docker CLI (TLS / ssh / context transports) ───────

/**
 * `docker exec -i` without a TTY: what 0.14 always did in docker installs.
 * Only for transports the Engine API cannot reach. Credentials in `env` reach
 * the exec through the CLI's own environment (`-e KEY` with no value), never
 * through argv.
 */
class CliPipeTty extends BaseTty {
  readonly mode = 'cli' as const;
  private readonly child: ReturnType<typeof spawn>;

  constructor(container: string, cmd: readonly string[], env: string[]) {
    super();
    const extra: Record<string, string> = {};
    const flags: string[] = [];
    for (const pair of env) {
      const at = pair.indexOf('=');
      const key = pair.slice(0, at);
      extra[key] = pair.slice(at + 1);
      flags.push('-e', key);
    }
    this.child = spawn('docker', ['exec', '-i', '-e', 'TERM=xterm', ...flags, '--', container, ...cmd], {
      env: buildEnv(extra),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdin?.on('error', () => {
      /* EPIPE: the child already exited */
    });
    this.child.stdout?.on('data', (c: Buffer) => this.emitData(Buffer.from(c)));
    this.child.stderr?.on('data', (c: Buffer) => this.emitData(Buffer.from(c)));
    this.child.on('error', () => this.emitEnd(null));
    this.child.on('exit', (code) => this.emitEnd(typeof code === 'number' ? code : null));
  }

  write(data: Buffer): void {
    const stdin = this.child.stdin;
    if (stdin && !stdin.destroyed) stdin.write(data);
  }

  resize(): void {
    /* no PTY in pipe mode */
  }

  pause(): void {
    this.child.stdout?.pause();
    this.child.stderr?.pause();
  }

  resume(): void {
    this.child.stdout?.resume();
    this.child.stderr?.resume();
  }

  async kill(): Promise<void> {
    this.killed = true;
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
  }
}

/** Pipe-mode shell through the docker CLI. The interactive flag makes `sh` print a prompt. */
export function openCliPipeTty(container: string, cmd: readonly string[], env: string[] = []): TtyProcess {
  return new CliPipeTty(container, cmd, env);
}
