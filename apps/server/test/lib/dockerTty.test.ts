/**
 * 0.15 `lib/dockerTty.ts` (DESIGN §1.3, §1.8): the Engine API TTY, exercised
 * against a fake Docker daemon listening on a temporary Unix socket (a named
 * pipe on Windows) — never a real daemon.
 *
 * Also the D1 proof: the runtime image installs no python3, so 0.14's only
 * PTY path (`python3 -c 'import pty'`) could never run in a docker install.
 */
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (...a: unknown[]) => spawnMock.spawn(...a),
}));

const {
  DockerEngineError,
  dockerTransport,
  engineCall,
  engineHijack,
  engineRequest,
  forceRemoveContainer,
  hostShellContainerName,
  hostShellCreateBody,
  HOST_SHELL_CMD,
  inspectContainer,
  isEngineTransport,
  listContainersWithLabel,
  openCliPipeTty,
  openExecTty,
  openHostShellTty,
  OscPidStripper,
  probeHostShellImage,
  resetHostShellProbeCache,
  SHELL_CMD,
  TERMINAL_EXPIRES_LABEL,
  TERMINAL_SESSION_LABEL,
} = await import('../../src/lib/dockerTty.js');

// ── a fake Docker daemon ────────────────────────────────────────────────────

interface Seen {
  method: string;
  url: string;
  body: unknown;
  headers: http.IncomingHttpHeaders;
}

type Handler = (req: Seen, res: http.ServerResponse) => void;
type Upgrade = (req: Seen, socket: Socket) => void;

interface FakeDaemon {
  socketPath: string;
  seen: Seen[];
  on(method: string, pattern: RegExp, handler: Handler): void;
  onUpgrade(pattern: RegExp, handler: Upgrade): void;
  close(): Promise<void>;
}

const daemons: FakeDaemon[] = [];

async function fakeDaemon(): Promise<FakeDaemon> {
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\nd-tty-test-${randomBytes(6).toString('hex')}`
      : join(tmpdir(), `nd-tty-test-${randomBytes(6).toString('hex')}.sock`);
  const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];
  const upgrades: Array<{ pattern: RegExp; handler: Upgrade }> = [];
  const seen: Seen[] = [];
  const sockets = new Set<Socket>();
  const readBody = (req: http.IncomingMessage) =>
    new Promise<unknown>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try {
          resolve(text ? JSON.parse(text) : undefined);
        } catch {
          resolve(text);
        }
      });
    });
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const entry = { method: req.method ?? '', url: req.url ?? '', body, headers: req.headers };
    seen.push(entry);
    const route = routes.find((r) => r.method === entry.method && r.pattern.test(entry.url));
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: `no route ${entry.method} ${entry.url}` }));
      return;
    }
    route.handler(entry, res);
  });
  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('upgrade', async (req: http.IncomingMessage, socket: Socket, head: Buffer) => {
    // `head` holds only the bytes that arrived with the headers; on a slow
    // runner the body comes in a later packet, so read up to Content-Length.
    const want = Number(req.headers['content-length'] ?? 0);
    let raw = head;
    while (raw.length < want) {
      const more = await new Promise<Buffer | null>((resolve) => {
        socket.once('data', (c: Buffer) => resolve(c));
        socket.once('end', () => resolve(null));
      });
      if (!more) break;
      raw = Buffer.concat([raw, more]);
    }
    const bodyBytes = want > 0 ? raw.subarray(0, want) : raw;
    const rest = want > 0 ? raw.subarray(want) : Buffer.alloc(0);
    if (rest.length) socket.unshift(rest);
    const body = bodyBytes.length ? JSON.parse(bodyBytes.toString()) : undefined;
    const entry = { method: req.method ?? '', url: req.url ?? '', body, headers: req.headers };
    seen.push(entry);
    const up = upgrades.find((u) => u.pattern.test(entry.url));
    if (!up) {
      const msg = '{"message":"no such exec"}';
      socket.end(`HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: ${msg.length}\r\n\r\n${msg}`);
      return;
    }
    socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    up.handler(entry, socket);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const daemon: FakeDaemon = {
    socketPath,
    seen,
    on: (method, pattern, handler) => void routes.push({ method, pattern, handler }),
    onUpgrade: (pattern, handler) => void upgrades.push({ pattern, handler }),
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== 'win32') rmSync(socketPath, { force: true });
    },
  };
  daemons.push(daemon);
  return daemon;
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const waitFor = async (pred: () => boolean, timeoutMs = 2000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

beforeEach(() => {
  resetHostShellProbeCache();
  spawnMock.spawn.mockReset();
});

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.close();
});

// ── D1 ──────────────────────────────────────────────────────────────────────

describe('D1: the runtime image has no python3, so 0.14 never had a PTY in docker installs', () => {
  const dockerfile = readFileSync(new URL('../../../../Dockerfile', import.meta.url), 'utf8');
  const stages = dockerfile.split(/^FROM\s+/m).slice(1);
  const runtime = stages.find((s) => /^\S+\s+AS\s+runtime\b/im.test(s));

  it('finds the runtime stage (guards the scan)', () => {
    expect(runtime).toBeDefined();
    expect(runtime!).toMatch(/apt-get install/);
  });

  it('the runtime stage is a Debian slim image and installs no python', () => {
    // `node:*-slim` ships without python3 (the build stage installs it for
    // native modules and documents exactly that); the runtime stage installs
    // only ca-certificates, curl, docker-cli, git and tini.
    expect(runtime!.split('\n')[0]).toMatch(/^node:\S*-slim\s+AS\s+runtime/i);
    expect(runtime!).not.toMatch(/python/i);
    const installs = [...runtime!.matchAll(/apt-get install[^\n]*(?:\\\n[^\n]*)*/g)].map((m) => m[0]);
    expect(installs.length).toBeGreaterThan(0);
    for (const line of installs) expect(line).not.toMatch(/python/);
    // …while python3 exists only in the build stage, which the runtime does not inherit.
    const build = stages.find((s) => /^\S+\s+AS\s+build\b/im.test(s));
    expect(build).toMatch(/python3/);
  });

  it('the 0.15 PTY path needs neither python nor a docker CLI child', () => {
    // Whatever the shell, the Engine API exec asks Docker for the TTY.
    expect(SHELL_CMD[0]).toBe('/bin/sh');
    expect(SHELL_CMD.join(' ')).not.toMatch(/python/);
  });
});

// ── transport selection ─────────────────────────────────────────────────────

describe('dockerTransport', () => {
  const yes = () => true;
  const no = () => false;

  it('uses the default socket when DOCKER_HOST is unset (and it exists)', () => {
    expect(dockerTransport({}, 'linux', yes)).toEqual({ kind: 'socket', socketPath: '/var/run/docker.sock' });
    expect(dockerTransport({}, 'linux', no)).toMatchObject({ kind: 'cli' });
    expect(dockerTransport({}, 'win32', no)).toEqual({ kind: 'socket', socketPath: '\\\\.\\pipe\\docker_engine' });
  });

  it('follows unix:// and npipe:// hosts', () => {
    expect(dockerTransport({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' }, 'linux', no)).toEqual({
      kind: 'socket',
      socketPath: '/run/user/1000/docker.sock',
    });
    expect(dockerTransport({ DOCKER_HOST: 'unix://' }, 'linux', no)).toMatchObject({ kind: 'cli' });
    expect(dockerTransport({ DOCKER_HOST: 'npipe:////./pipe/docker_engine' }, 'win32', no)).toEqual({
      kind: 'socket',
      socketPath: '\\\\.\\pipe\\docker_engine',
    });
    expect(dockerTransport({ DOCKER_HOST: 'npipe://' }, 'win32', no)).toMatchObject({ kind: 'cli' });
  });

  it('speaks plain HTTP to tcp:// without TLS, and falls back to the CLI with TLS', () => {
    expect(dockerTransport({ DOCKER_HOST: 'tcp://10.0.0.5:2375' })).toEqual({ kind: 'tcp', host: '10.0.0.5', port: 2375 });
    expect(dockerTransport({ DOCKER_HOST: 'tcp://docker' })).toEqual({ kind: 'tcp', host: 'docker', port: 2375 });
    expect(dockerTransport({ DOCKER_HOST: 'tcp://[::1]:9' })).toEqual({ kind: 'tcp', host: '::1', port: 9 });
    expect(dockerTransport({ DOCKER_HOST: 'tcp://10.0.0.5:2376', DOCKER_TLS_VERIFY: '1' })).toMatchObject({ kind: 'cli' });
    expect(dockerTransport({ DOCKER_HOST: 'tcp://10.0.0.5:2376', DOCKER_TLS: 'yes' })).toMatchObject({ kind: 'cli' });
    expect(dockerTransport({ DOCKER_HOST: 'tcp://10.0.0.5:2375', DOCKER_TLS_VERIFY: '0' })).toMatchObject({ kind: 'tcp' });
    expect(dockerTransport({ DOCKER_HOST: 'tcp://' })).toMatchObject({ kind: 'cli' });
    expect(dockerTransport({ DOCKER_HOST: 'tcp://host:notaport' })).toMatchObject({ kind: 'cli' });
  });

  it('falls back to the CLI for ssh:// and for a non-default context', () => {
    expect(dockerTransport({ DOCKER_HOST: 'ssh://deploy@host' })).toEqual({ kind: 'cli', reason: 'DOCKER_HOST uses ssh://' });
    expect(dockerTransport({ DOCKER_HOST: 'weird' })).toEqual({ kind: 'cli', reason: 'DOCKER_HOST uses unknown://' });
    expect(dockerTransport({ DOCKER_CONTEXT: 'remote' }, 'linux', yes)).toMatchObject({ kind: 'cli' });
    expect(dockerTransport({ DOCKER_CONTEXT: 'default' }, 'linux', yes)).toMatchObject({ kind: 'socket' });
    expect(isEngineTransport({ kind: 'cli', reason: 'x' })).toBe(false);
    expect(isEngineTransport({ kind: 'tcp', host: 'h', port: 1 })).toBe(true);
  });

  it('defaults to the process environment', () => {
    expect(['socket', 'tcp', 'cli']).toContain(dockerTransport().kind);
  });
});

// ── raw requests ────────────────────────────────────────────────────────────

describe('engine requests', () => {
  it('sends JSON and maps a daemon error to DockerEngineError', async () => {
    const d = await fakeDaemon();
    const t = { kind: 'socket' as const, socketPath: d.socketPath };
    d.on('POST', /^\/echo$/, (req, res) => json(res, 201, { got: req.body }));
    d.on('GET', /^\/fail$/, (_req, res) => json(res, 409, { message: 'container is not running' }));
    d.on('GET', /^\/plain$/, (_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    d.on('GET', /^\/empty$/, (_req, res) => {
      res.writeHead(502);
      res.end();
    });
    const res = await engineRequest(t, 'POST', '/echo', { a: 1 });
    expect(res.status).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ got: { a: 1 } });
    expect(d.seen[0]!.headers['content-type']).toBe('application/json');
    await expect(engineCall(t, 'GET', '/fail')).rejects.toMatchObject({ status: 409, message: 'container is not running' });
    await expect(engineCall(t, 'GET', '/plain')).rejects.toMatchObject({ status: 500, message: 'boom' });
    await expect(engineCall(t, 'GET', '/empty')).rejects.toThrow('Docker Engine API answered 502');
    expect((await engineCall(t, 'GET', '/fail', undefined, [409])).status).toBe(409);
    expect(new DockerEngineError(1, 'x').name).toBe('DockerEngineError');
  });

  it('rejects on a transport error and on a timeout', async () => {
    await expect(engineRequest({ kind: 'tcp', host: '127.0.0.1', port: 9 }, 'GET', '/x')).rejects.toThrow();
    const d = await fakeDaemon();
    d.on('GET', /^\/slow$/, () => {
      /* never answers */
    });
    await expect(engineRequest({ kind: 'socket', socketPath: d.socketPath }, 'GET', '/slow', undefined, 50)).rejects.toThrow(/timed out/);
  });

  it('a refused hijack rejects with the daemon message', async () => {
    const d = await fakeDaemon();
    await expect(engineHijack({ kind: 'socket', socketPath: d.socketPath }, '/exec/nope/start', {})).rejects.toMatchObject({
      status: 404,
    });
  });

  it('inspects, lists and removes containers (names URL-encoded)', async () => {
    const d = await fakeDaemon();
    const t = { kind: 'socket' as const, socketPath: d.socketPath };
    d.on('GET', /^\/containers\/web\/json$/, (_r, res) =>
      json(res, 200, { Id: 'abc123', State: { Running: true }, Config: { Hostname: 'abc', Labels: { a: 'b' } } }),
    );
    d.on('GET', /^\/containers\/bare\/json$/, (_r, res) => json(res, 200, {}));
    d.on('GET', /^\/containers\/json\?/, (_r, res) => json(res, 200, [{ Id: 'h1', Labels: { [TERMINAL_SESSION_LABEL]: '4' } }, { Id: 'h2' }]));
    d.on('DELETE', /^\/containers\//, (req, res) => json(res, req.url.includes('gone') ? 404 : 204, {}));
    expect(await inspectContainer(t, 'web')).toEqual({ id: 'abc123', running: true, hostname: 'abc', labels: { a: 'b' } });
    expect(await inspectContainer(t, 'bare')).toEqual({ id: '', running: false, hostname: null, labels: {} });
    expect(await inspectContainer(t, 'a b')).toBeNull();
    expect(d.seen.some((s) => s.url === '/containers/a%20b/json')).toBe(true);
    expect(await listContainersWithLabel(t, TERMINAL_SESSION_LABEL)).toEqual([
      { id: 'h1', labels: { [TERMINAL_SESSION_LABEL]: '4' } },
      { id: 'h2', labels: {} },
    ]);
    const listUrl = d.seen.find((s) => s.url.startsWith('/containers/json'))!.url;
    expect(decodeURIComponent(listUrl)).toContain(`"label":["${TERMINAL_SESSION_LABEL}"]`);
    await forceRemoveContainer(t, 'h1');
    await forceRemoveContainer(t, 'gone');
    expect(d.seen.filter((s) => s.method === 'DELETE').map((s) => s.url)).toEqual(['/containers/h1?force=1', '/containers/gone?force=1']);
  });
});

// ── the PID marker ──────────────────────────────────────────────────────────

describe('OscPidStripper', () => {
  const MARK = '\x1b]777;nd-pid;4242\x07';

  it('strips the marker and records the PID', () => {
    const s = new OscPidStripper();
    expect(s.feed(Buffer.from(`${MARK}$ `)).toString()).toBe('$ ');
    expect(s.pid).toBe(4242);
    expect(s.feed(Buffer.from(MARK)).toString()).toBe(MARK); // only the first one
  });

  it('handles a marker split across every chunk boundary', () => {
    const full = `pre${MARK}post`;
    for (let cut = 1; cut < full.length; cut++) {
      const s = new OscPidStripper();
      const out = Buffer.concat([s.feed(Buffer.from(full.slice(0, cut))), s.feed(Buffer.from(full.slice(cut))), s.flush()]).toString();
      expect(out, `cut at ${cut}`).toBe('prepost');
      expect(s.pid).toBe(4242);
    }
    // One byte at a time.
    const s = new OscPidStripper();
    const out = Buffer.concat([...full].map((ch) => s.feed(Buffer.from(ch)))).toString() + s.flush().toString();
    expect(out).toBe('prepost');
  });

  it('passes everything through when no marker comes, or a malformed one', () => {
    const s = new OscPidStripper();
    const big = 'x'.repeat(9000);
    expect(s.feed(Buffer.from(big)).toString()).toBe(big);
    expect(s.feed(Buffer.from(MARK)).toString()).toBe(MARK);
    expect(s.pid).toBeNull();

    const bad = new OscPidStripper();
    expect(bad.feed(Buffer.from('\x1b]777;nd-pid;abc\x07!')).toString()).toBe('\x1b]777;nd-pid;abc\x07!');
    expect(bad.pid).toBeNull();

    const unterminated = new OscPidStripper();
    const text = `\x1b]777;nd-pid;${'9'.repeat(40)}`;
    expect(unterminated.feed(Buffer.from(text)).toString()).toBe(text);

    const tail = new OscPidStripper();
    expect(tail.feed(Buffer.from('ab\x1b]7')).toString()).toBe('ab');
    expect(tail.flush().toString()).toBe('\x1b]7');
  });
});

// ── exec TTY ────────────────────────────────────────────────────────────────

describe('openExecTty', () => {
  const execDaemon = async (state: { running: boolean; exitCode: number | null }) => {
    const d = await fakeDaemon();
    let shell: Socket | null = null;
    let execs = 0;
    d.on('POST', /^\/containers\/[^/]+\/exec$/, (_req, res) => json(res, 201, { Id: `exec${++execs}` }));
    d.on('POST', /^\/exec\/[^/]+\/resize\?/, (_req, res) => json(res, 201, {}));
    d.on('POST', /^\/exec\/exec[2-9]\/start$/, (_req, res) => json(res, 200, {}));
    d.on('GET', /^\/exec\/[^/]+\/json$/, (_req, res) => json(res, 200, { Running: state.running, ExitCode: state.exitCode }));
    d.onUpgrade(/^\/exec\/exec1\/start$/, (_req, socket) => {
      shell = socket;
      socket.write('\x1b]777;nd-pid;31\x07$ ');
      socket.on('data', (c: Buffer) => socket.write(c)); // echo
    });
    return { d, shell: () => shell, state };
  };

  it('creates a TTY exec, hijacks start, strips the PID marker and resizes', async () => {
    const { d, shell, state } = await execDaemon({ running: true, exitCode: null });
    const t = { kind: 'socket' as const, socketPath: d.socketPath };
    const tty = await openExecTty(t, { container: 'nd-app-web', cmd: SHELL_CMD, env: ['PGPASSWORD=s3cret'], cols: 120, rows: 32 });
    expect(tty.mode).toBe('exec');
    const out: string[] = [];
    tty.onData((c) => out.push(c.toString()));
    await waitFor(() => out.join('').includes('$ '));
    expect(out.join('')).toBe('$ ');
    expect(tty.pid).toBe(31);

    const create = d.seen.find((s) => s.url === '/containers/nd-app-web/exec')!;
    expect(create.body).toEqual({
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Env: ['TERM=xterm-256color', 'PGPASSWORD=s3cret'],
      ConsoleSize: [32, 120],
      Cmd: [...SHELL_CMD],
    });
    const start = d.seen.find((s) => s.url === '/exec/exec1/start')!;
    expect(start.headers.upgrade).toBe('tcp');
    expect(String(start.headers.connection).toLowerCase()).toBe('upgrade');
    expect(start.body).toEqual({ Detach: false, Tty: true, ConsoleSize: [32, 120] });

    tty.write(Buffer.from('ls\r'));
    await waitFor(() => out.join('').includes('ls\r'));
    tty.resize(200, 50);
    await waitFor(() => d.seen.some((s) => s.url === '/exec/exec1/resize?h=50&w=200'));
    expect(d.seen.some((s) => s.url === '/exec/exec1/resize?h=32&w=120')).toBe(true);
    tty.pause();
    tty.resume();

    // The shell exits: the stream ends, the exit code is read back.
    const ended = new Promise<number | null>((resolve) => tty.onEnd(resolve));
    state.running = false;
    state.exitCode = 3;
    shell()!.end();
    expect(await ended).toBe(3);
    // A late listener still learns the code.
    expect(await new Promise((resolve) => tty.onEnd(resolve))).toBe(3);
    await tty.kill();
    // Not running any more: no HUP exec.
    expect(d.seen.filter((s) => s.url.endsWith('/exec') && s.method === 'POST')).toHaveLength(1);
  });

  it('kill() HUPs a shell that survives the dropped attach, then KILLs it after the grace period', async () => {
    const { d, state } = await execDaemon({ running: true, exitCode: null });
    const t = { kind: 'socket' as const, socketPath: d.socketPath };
    const tty = await openExecTty(t, { container: 'c1', cmd: SHELL_CMD, cols: 80, rows: 24, killGraceMs: 10 });
    await waitFor(() => tty.pid === 31);
    await tty.kill();
    await tty.kill(); // idempotent
    const signals = d.seen.filter((s) => s.method === 'POST' && s.url === '/containers/c1/exec').slice(1).map((s) => (s.body as { Cmd: string[] }).Cmd);
    expect(signals).toEqual([
      ['kill', '-HUP', '31'],
      ['kill', '-KILL', '31'],
    ]);
    expect(d.seen.filter((s) => /^\/exec\/exec[23]\/start$/.test(s.url)).map((s) => s.body)).toEqual([
      { Detach: true, Tty: false },
      { Detach: true, Tty: false },
    ]);
    state.running = false;
  });

  it('kill() of a shell that never reported a PID only drops the stream', async () => {
    const d = await fakeDaemon();
    d.on('POST', /^\/containers\/c1\/exec$/, (_r, res) => json(res, 201, { Id: 'e1' }));
    d.on('POST', /resize/, (_r, res) => json(res, 201, {}));
    d.on('GET', /^\/exec\/e1\/json$/, (_r, res) => json(res, 500, { message: 'daemon hiccup' }));
    d.onUpgrade(/^\/exec\/e1\/start$/, () => {
      /* silent */
    });
    const tty = await openExecTty({ kind: 'socket', socketPath: d.socketPath }, { container: 'c1', cmd: ['sh'], cols: 80, rows: 24 });
    const ended = new Promise<number | null>((resolve) => tty.onEnd(resolve));
    await tty.kill();
    expect(await ended).toBeNull(); // the inspect failed: unknown exit code
    tty.write(Buffer.from('ignored after kill'));
    expect(d.seen.filter((s) => s.url === '/containers/c1/exec')).toHaveLength(1);
  });

  it('surfaces a missing or stopped container', async () => {
    const d = await fakeDaemon();
    d.on('POST', /^\/containers\/stopped\/exec$/, (_r, res) => json(res, 409, { message: 'Container stopped is not running' }));
    const t = { kind: 'socket' as const, socketPath: d.socketPath };
    await expect(openExecTty(t, { container: 'missing', cmd: ['sh'], cols: 80, rows: 24 })).rejects.toMatchObject({ status: 404 });
    await expect(openExecTty(t, { container: 'stopped', cmd: ['sh'], cols: 80, rows: 24 })).rejects.toMatchObject({
      status: 409,
      message: 'Container stopped is not running',
    });
  });
});

// ── host shells ─────────────────────────────────────────────────────────────

describe('host shells', () => {
  it('the helper is privileged in the host namespaces, auto-removed and labelled', () => {
    const body = hostShellCreateBody({ image: 'traefik:3', sessionId: 9, expiresAt: 1_900_000_000, cols: 100, rows: 30 });
    expect(body).toMatchObject({
      Image: 'traefik:3',
      Entrypoint: ['nsenter'],
      Cmd: [...HOST_SHELL_CMD],
      Tty: true,
      OpenStdin: true,
      StdinOnce: true,
      Labels: { [TERMINAL_SESSION_LABEL]: '9', [TERMINAL_EXPIRES_LABEL]: '1900000000' },
      HostConfig: { Privileged: true, PidMode: 'host', NetworkMode: 'host', IpcMode: 'host', UTSMode: 'host', AutoRemove: true },
    });
    expect(HOST_SHELL_CMD.slice(0, 2)).toEqual(['-t', '1']);
    expect(hostShellContainerName(9)).toBe('nd-hostshell-9');
  });

  it('creates, attaches, waits, starts and resizes; kill removes the helper', async () => {
    const d = await fakeDaemon();
    let release: ((code: number) => void) | null = null;
    let shell: Socket | null = null;
    d.on('POST', /^\/containers\/create\?name=nd-hostshell-5$/, (_r, res) => json(res, 201, { Id: 'helper1' }));
    d.on('POST', /^\/containers\/helper1\/wait\?condition=next-exit$/, (_r, res) => {
      release = (code) => json(res, 200, { StatusCode: code });
    });
    d.on('POST', /^\/containers\/helper1\/start$/, (_r, res) => json(res, 204, {}));
    d.on('POST', /^\/containers\/helper1\/resize\?/, (_r, res) => json(res, 200, {}));
    d.on('DELETE', /^\/containers\/helper1\?force=1$/, (_r, res) => json(res, 204, {}));
    d.onUpgrade(/^\/containers\/helper1\/attach\?stream=1&stdin=1&stdout=1&stderr=1$/, (_r, socket) => {
      shell = socket;
      socket.write('# ');
    });
    const t = { kind: 'socket' as const, socketPath: d.socketPath };
    const tty = await openHostShellTty(t, { image: 'traefik:3', sessionId: 5, expiresAt: 2_000_000_000, cols: 90, rows: 20 });
    expect(tty.mode).toBe('host');
    expect(tty.containerId).toBe('helper1');
    const out: string[] = [];
    tty.onData((c) => out.push(c.toString()));
    await waitFor(() => out.join('') === '# ');
    await waitFor(() => d.seen.some((s) => s.url === '/containers/helper1/resize?h=20&w=90'));
    const order = d.seen.map((s) => `${s.method} ${s.url.split('?')[0]}`);
    expect(order.indexOf('POST /containers/helper1/attach')).toBeLessThan(order.indexOf('POST /containers/helper1/start'));
    expect(order.indexOf('POST /containers/helper1/wait')).toBeLessThan(order.indexOf('POST /containers/helper1/start'));
    tty.write(Buffer.from('id\r'));
    tty.resize(100, 40);
    tty.pause();
    tty.resume();
    const ended = new Promise<number | null>((resolve) => tty.onEnd(resolve));
    release!(0);
    shell!.end();
    expect(await ended).toBe(0);
    await tty.kill();
    await tty.kill();
    expect(d.seen.filter((s) => s.method === 'DELETE')).toHaveLength(1);
  });

  it('removes the helper when the start fails', async () => {
    const d = await fakeDaemon();
    d.on('POST', /^\/containers\/create/, (_r, res) => json(res, 201, { Id: 'h2' }));
    d.on('POST', /^\/containers\/h2\/wait/, () => {
      /* pending */
    });
    d.on('POST', /^\/containers\/h2\/start$/, (_r, res) => json(res, 500, { message: 'privileged containers are not allowed' }));
    d.on('DELETE', /^\/containers\/h2/, (_r, res) => json(res, 204, {}));
    d.onUpgrade(/^\/containers\/h2\/attach/, () => {
      /* silent */
    });
    const t = { kind: 'socket' as const, socketPath: d.socketPath };
    await expect(openHostShellTty(t, { image: 'traefik:3', sessionId: 6, expiresAt: 1, cols: 80, rows: 24 })).rejects.toThrow(
      'privileged containers are not allowed',
    );
    expect(d.seen.some((s) => s.method === 'DELETE' && s.url === '/containers/h2?force=1')).toBe(true);
  });

  it('probes the image for nsenter once and caches a definite answer', async () => {
    const d = await fakeDaemon();
    const t = { kind: 'socket' as const, socketPath: d.socketPath };
    let created = 0;
    d.on('POST', /^\/containers\/create$/, (req, res) => {
      const image = (req.body as { Image: string }).Image;
      if (image === 'absent:1') return json(res, 404, { message: 'No such image: absent:1' });
      created++;
      json(res, 201, { Id: `probe-${image.replace(/\W/g, '')}` });
    });
    d.on('POST', /^\/containers\/probe-nonsenter1\/start$/, (_r, res) =>
      json(res, 400, { message: 'exec: "nsenter": executable file not found in $PATH' }),
    );
    d.on('POST', /^\/containers\/probe-[a-z0-9]+\/start$/, (_r, res) => json(res, 204, {}));
    d.on('POST', /^\/containers\/probe-traefik3\/wait$/, (_r, res) => json(res, 200, { StatusCode: 1 }));
    d.on('POST', /^\/containers\/probe-shell127\/wait$/, (_r, res) => json(res, 200, { StatusCode: 127 }));
    d.on('DELETE', /^\/containers\/probe-/, (_r, res) => json(res, 204, {}));

    expect(await probeHostShellImage(t, 'traefik:3')).toEqual({ ok: true });
    expect(await probeHostShellImage(t, 'traefik:3')).toEqual({ ok: true });
    expect(created).toBe(1); // cached
    const probeBody = d.seen.find((s) => s.url === '/containers/create')!.body as Record<string, unknown>;
    expect(probeBody).toMatchObject({ Image: 'traefik:3', Entrypoint: ['nsenter'], Cmd: ['--help'], HostConfig: { NetworkMode: 'none' } });

    expect(await probeHostShellImage(t, 'nonsenter:1')).toMatchObject({ ok: false, reason: expect.stringContaining('has no nsenter') });
    expect(await probeHostShellImage(t, 'shell:127')).toMatchObject({ ok: false });
    // A missing image is not cached (pulling it fixes the probe).
    expect(await probeHostShellImage(t, 'absent:1')).toMatchObject({ ok: false, reason: expect.stringContaining('docker pull absent:1') });
    expect(await probeHostShellImage(t, 'absent:1')).toMatchObject({ ok: false });
    expect(d.seen.filter((s) => s.method === 'POST' && s.url === '/containers/create' && (s.body as { Image: string }).Image === 'absent:1')).toHaveLength(2);
    // Every probe container is removed.
    expect(d.seen.filter((s) => s.method === 'DELETE')).toHaveLength(3);
  });
});

// ── CLI pipe mode ───────────────────────────────────────────────────────────

describe('openCliPipeTty (TLS / ssh transports)', () => {
  const fakeChild = () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), { destroyed: false, write: vi.fn() }),
      stdout: Object.assign(new EventEmitter(), { pause: vi.fn(), resume: vi.fn() }),
      stderr: Object.assign(new EventEmitter(), { pause: vi.fn(), resume: vi.fn() }),
      kill: vi.fn(),
    });
    return child;
  };

  it('runs docker exec -i with credentials in the environment, never in argv', async () => {
    const child = fakeChild();
    spawnMock.spawn.mockReturnValue(child);
    const tty = openCliPipeTty('nd-db-x', ['psql', '-U', 'nine'], ['PGPASSWORD=s3cret']);
    const [cmd, args, opts] = spawnMock.spawn.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(cmd).toBe('docker');
    expect(args).toEqual(['exec', '-i', '-e', 'TERM=xterm', '-e', 'PGPASSWORD', '--', 'nd-db-x', 'psql', '-U', 'nine']);
    expect(args.join(' ')).not.toContain('s3cret');
    expect(opts.env.PGPASSWORD).toBe('s3cret');
    expect(tty.mode).toBe('cli');

    const out: string[] = [];
    tty.onData((c) => out.push(c.toString()));
    child.stdout.emit('data', Buffer.from('a'));
    child.stderr.emit('data', Buffer.from('b'));
    child.stdout.emit('data', Buffer.alloc(0));
    expect(out).toEqual(['a', 'b']);
    tty.write(Buffer.from('q'));
    expect(child.stdin.write).toHaveBeenCalled();
    child.stdin.emit('error', new Error('EPIPE')); // absorbed
    tty.resize(100, 30); // no PTY: ignored
    tty.pause();
    tty.resume();
    expect(child.stdout.pause).toHaveBeenCalled();
    expect(child.stderr.resume).toHaveBeenCalled();
    const ended = new Promise<number | null>((resolve) => tty.onEnd(resolve));
    child.emit('exit', 2);
    expect(await ended).toBe(2);
    await tty.kill();
    expect(child.kill).toHaveBeenCalled();
  });

  it('ends with a null code when the CLI cannot start, and kill never throws', async () => {
    const child = fakeChild();
    child.kill.mockImplementation(() => {
      throw new Error('gone');
    });
    child.stdin.destroyed = true;
    spawnMock.spawn.mockReturnValue(child);
    const tty = openCliPipeTty('c', ['sh', '-i']);
    tty.write(Buffer.from('dropped'));
    expect(child.stdin.write).not.toHaveBeenCalled();
    const ended = new Promise<number | null>((resolve) => tty.onEnd(resolve));
    child.emit('error', new Error('spawn docker ENOENT'));
    expect(await ended).toBeNull();
    child.emit('exit', null);
    await expect(tty.kill()).resolves.toBeUndefined();
  });
});
