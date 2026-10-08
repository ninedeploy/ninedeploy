import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalHandlers } from '@ninedeploy/sdk';
import {
  accessGrantsAdd,
  accessGrantsList,
  accessGrantsRemove,
  accessGrantsUpdate,
  accessMe,
  terminalOpen,
  terminalTarget,
  terminalsKill,
  terminalsList,
  terminalsShow,
  trafficService,
  trafficSettings,
  trafficSummary,
  type TerminalIo,
} from '../src/commands/operations.js';

/** 0.15: `terminals`, `terminal`, `traffic` and `access` commands. */

const h = vi.hoisted(() => ({ prompt: vi.fn(), promptHidden: vi.fn() }));
vi.mock('../src/prompts.js', () => ({ prompt: h.prompt, promptHidden: h.promptHidden }));
vi.mock('ws', () => ({
  WebSocket: class {
    constructor(
      public url: string,
      public protocols: string[],
    ) {}
  },
}));

const ESC = String.fromCharCode(27);

function makeClient() {
  return {
    terminals: { list: vi.fn(), get: vi.fn(), terminate: vi.fn(), create: vi.fn(), connect: vi.fn() },
    traffic: { settings: { get: vi.fn(), set: vi.fn() }, summary: vi.fn(), service: vi.fn() },
    accessGrants: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    access: { me: vi.fn() },
  };
}
type Client = ReturnType<typeof makeClient>;
const asClient = (c: Client) => c as never;

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
const out = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const err = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  vi.resetAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

const session = (over: Record<string, unknown> = {}) => ({
  id: 5,
  status: 'ended',
  targetKind: 'service',
  targetLabel: `web${ESC}[2J`,
  serverId: null,
  userId: 1,
  userEmail: 'op@x.test',
  createdAt: '2026-10-08T10:00:00.000Z',
  startedAt: '2026-10-08T10:00:01.000Z',
  endedAt: '2026-10-08T10:05:00.000Z',
  durationMs: 299_000,
  bytesIn: 10,
  bytesOut: 2048,
  endReason: 'shell_exited',
  exitCode: 0,
  clientIp: '10.0.0.1',
  ...over,
});

describe('terminals list / show / kill', () => {
  it('lists sessions, sanitising labels, and points at the next page', async () => {
    const c = makeClient();
    c.terminals.list.mockResolvedValue({
      items: [session(), session({ id: 4, durationMs: 12_000, startedAt: null, userEmail: null, endReason: null }), session({ id: 3, durationMs: 7_400_000 }), session({ id: 2, durationMs: null })],
      nextBefore: 2,
    });
    await terminalsList(asClient(c), { status: 'ended', target: 'service', limit: '10', before: '9' });
    expect(c.terminals.list).toHaveBeenCalledWith({ status: 'ended', targetKind: 'service', limit: 10, before: 9 });
    expect(out()).toContain('service: web ');
    expect(out()).not.toContain('[2J');
    expect(out()).toContain('4m 59s');
    expect(out()).toContain('12s');
    expect(out()).toContain('2h 3m');
    expect(out()).toContain('--before 2');
    c.terminals.list.mockResolvedValue({ items: [], nextBefore: null });
    await terminalsList(asClient(c));
    expect(c.terminals.list).toHaveBeenLastCalledWith({});
  });

  it('refuses bad filters before calling the server, and reports failures', async () => {
    const c = makeClient();
    await terminalsList(asClient(c), { status: 'running' });
    await terminalsList(asClient(c), { target: 'vm' });
    await terminalsList(asClient(c), { limit: '0' });
    await terminalsList(asClient(c), { before: 'x' });
    expect(c.terminals.list).not.toHaveBeenCalled();
    expect(err()).toContain('--status must be one of');
    expect(err()).toContain('--target must be one of');
    expect(err()).toContain('--limit must be a positive integer');
    c.terminals.list.mockRejectedValue(new Error('Operator access required'));
    await terminalsList(asClient(c));
    expect(err()).toContain('Operator access required');
    expect(process.exitCode).toBe(1);
  });

  it('shows one session', async () => {
    const c = makeClient();
    c.terminals.get.mockResolvedValueOnce(session({ serverId: 3 })).mockResolvedValueOnce(session({ userEmail: null, endReason: null })).mockRejectedValueOnce('gone');
    await terminalsShow(asClient(c), '5');
    expect(out()).toContain('#3');
    expect(out()).toContain('shell_exited');
    await terminalsShow(asClient(c), '5');
    expect(out()).toContain('panel host');
    await terminalsShow(asClient(c), '5');
    expect(err()).toContain('gone');
    await terminalsShow(asClient(c), 'abc');
    expect(c.terminals.get).toHaveBeenCalledTimes(3);
  });

  it('kills after confirmation', async () => {
    const c = makeClient();
    c.terminals.terminate.mockResolvedValueOnce({ ok: true, wasLive: true }).mockResolvedValueOnce({ ok: true, wasLive: false }).mockRejectedValueOnce(new Error('already ended'));
    h.prompt.mockResolvedValueOnce('no');
    await terminalsKill(asClient(c), '5');
    expect(c.terminals.terminate).not.toHaveBeenCalled();
    h.prompt.mockResolvedValueOnce('YES');
    await terminalsKill(asClient(c), '5');
    expect(out()).toContain('Session #5 terminated');
    await terminalsKill(asClient(c), '6', { yes: true });
    expect(out()).toContain('Pending session #6 revoked');
    await terminalsKill(asClient(c), '7', { yes: true });
    expect(err()).toContain('already ended');
    await terminalsKill(asClient(c), '-1', { yes: true });
    expect(c.terminals.terminate).toHaveBeenCalledTimes(3);
  });
});

describe('terminal target parsing', () => {
  it('builds each target kind', () => {
    expect(terminalTarget('service', '4')).toEqual({ kind: 'service', serviceId: 4 });
    expect(terminalTarget('service', '4', { replica: '2', node: '3' })).toEqual({ kind: 'service', serviceId: 4, replica: 2, serverId: 3 });
    expect(terminalTarget('db', '2')).toEqual({ kind: 'database', databaseId: 2, mode: 'shell' });
    expect(terminalTarget('db', '2', { client: true })).toEqual({ kind: 'database', databaseId: 2, mode: 'client' });
    expect(terminalTarget('container', 'nd-web')).toEqual({ kind: 'container', name: 'nd-web' });
    expect(terminalTarget('host', undefined)).toEqual({ kind: 'host', serverId: null });
    expect(terminalTarget('host', '3')).toEqual({ kind: 'host', serverId: 3 });
  });

  it('refuses malformed input', () => {
    expect(terminalTarget('service', 'x')).toBeNull();
    expect(terminalTarget('service', '1', { replica: '0' })).toBeNull();
    expect(terminalTarget('service', '1', { node: 'n' })).toBeNull();
    expect(terminalTarget('db', undefined)).toBeNull();
    expect(terminalTarget('container', '../etc')).toBeNull();
    expect(terminalTarget('container', undefined)).toBeNull();
    expect(terminalTarget('host', 'x')).toBeNull();
    expect(terminalTarget('vm', '1')).toBeNull();
    expect(err()).toContain('Usage: ninedeploy terminal service');
  });
});

class FakeStdin extends EventEmitter {
  isTTY = true;
  raw: boolean[] = [];
  paused = false;
  setRawMode(on: boolean) {
    this.raw.push(on);
    return this;
  }
  resume() {
    this.paused = false;
    return this;
  }
  pause() {
    this.paused = true;
    return this;
  }
}
class FakeStdout extends EventEmitter {
  columns = 0;
  rows = 0;
  written: unknown[] = [];
  write(chunk: unknown) {
    this.written.push(chunk);
    return true;
  }
}

function terminalIo(): { io: TerminalIo; stdin: FakeStdin; stdout: FakeStdout; stderr: FakeStdout } {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const stderr = new FakeStdout();
  return { io: { stdin, stdout, stderr, socketFactory: vi.fn() } as unknown as TerminalIo, stdin, stdout, stderr };
}

const CREATED = { session: { id: 7 }, ticket: 'abcdefghijklmnopqrst', ticketExpiresAt: '', attachPath: '/v1/terminals/7/attach' };

describe('terminal (interactive)', () => {
  function connectingClient() {
    const c = makeClient();
    const conn = { write: vi.fn(), resize: vi.fn(), close: vi.fn(), ready: true };
    let handlers!: TerminalHandlers;
    c.terminals.create.mockResolvedValue(CREATED);
    c.terminals.connect.mockImplementation((_created: unknown, hs: TerminalHandlers) => {
      handlers = hs;
      return conn;
    });
    return { c, conn, handlers: () => handlers };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('runs a raw-mode session: input, resize, output and the exit code', async () => {
    const { c, conn, handlers } = connectingClient();
    const { io, stdin, stdout, stderr } = terminalIo();
    stdout.columns = 900;
    stdout.rows = 2;
    const done = terminalOpen(asClient(c), 'service', '4', {}, io);
    await tick();
    expect(c.terminals.create).toHaveBeenCalledWith({ target: { kind: 'service', serviceId: 4 }, cols: 500, rows: 5 });
    expect(c.terminals.connect.mock.calls[0]?.[0]).toBe(CREATED);
    expect(stdin.raw).toEqual([true]);
    handlers().onReady!({ sessionId: 7, target: { kind: 'service', label: `web${ESC}]0;x`, serverId: null } });
    expect(String(stderr.written[0])).toContain('Connected to web (session #7)');
    expect(String(stderr.written[0])).not.toContain(']0;');
    stdin.emit('data', Buffer.from('ls\r'));
    stdin.emit('data', 'q');
    expect(conn.write).toHaveBeenCalledWith(new Uint8Array(Buffer.from('ls\r')));
    expect(conn.write).toHaveBeenCalledWith('q');
    stdout.columns = 100;
    stdout.rows = 40;
    stdout.emit('resize');
    expect(conn.resize).toHaveBeenCalledWith(100, 40);
    const bytes = new Uint8Array([104]);
    handlers().onData!(bytes);
    expect(stdout.written).toContain(bytes);
    handlers().onNotice!('hello');
    handlers().onExit!({ code: 3, reason: 'shell_exited' });
    handlers().onClose!({ code: 1000, reason: '', message: 'The shell exited.' });
    await done;
    expect(stdin.raw).toEqual([true, false]);
    expect(stdin.paused).toBe(true);
    expect(stdin.listenerCount('data')).toBe(0);
    expect(stdout.listenerCount('resize')).toBe(0);
    expect(process.exitCode).toBe(3);
  });

  it('a clean close without an exit code exits 0; an abnormal close explains it and exits 1', async () => {
    const first = connectingClient();
    const a = terminalIo();
    const p1 = terminalOpen(asClient(first.c), 'db', '2', { client: true }, a.io);
    await tick();
    expect(first.c.terminals.create.mock.calls[0]?.[0]).toMatchObject({ cols: 120, rows: 32 });
    first.handlers().onClose!({ code: 1000, reason: '', message: '' });
    await p1;
    expect(process.exitCode).toBe(0);

    const second = connectingClient();
    const b = terminalIo();
    const p2 = terminalOpen(asClient(second.c), 'container', 'nd-web', {}, b.io);
    await tick();
    second.handlers().onClose!({ code: 4410, reason: 'terminated', message: 'An operator terminated this session.' });
    await p2;
    expect(String(b.stderr.written.at(-1))).toContain('An operator terminated this session.');
    expect(process.exitCode).toBe(1);
  });

  it('host shells ask for the password with a hidden prompt (never argv)', async () => {
    const { c, handlers } = connectingClient();
    const { io } = terminalIo();
    h.promptHidden.mockResolvedValueOnce('pw').mockResolvedValueOnce('');
    const p = terminalOpen(asClient(c), 'host', '3', {}, io);
    await tick();
    expect(c.terminals.create.mock.calls[0]?.[0]).toMatchObject({ target: { kind: 'host', serverId: 3 }, password: 'pw' });
    handlers().onClose!({ code: 1000, reason: '', message: '' });
    await p;
    const p2 = terminalOpen(asClient(c), 'host', undefined, {}, terminalIo().io);
    await tick();
    expect(c.terminals.create.mock.calls[1]?.[0]).not.toHaveProperty('password');
    handlers().onClose!({ code: 1000, reason: '', message: '' });
    await p2;
  });

  it('needs a TTY, reports a refused create and a bad target', async () => {
    const c = makeClient();
    const noTty = terminalIo();
    noTty.stdin.isTTY = false;
    await terminalOpen(asClient(c), 'service', '1', {}, noTty.io);
    expect(err()).toContain('needs a TTY');
    await terminalOpen(asClient(c), 'service', 'x', {}, terminalIo().io);
    expect(c.terminals.create).not.toHaveBeenCalled();
    c.terminals.create.mockRejectedValueOnce(new Error('Update the node agent to v0.15.0'));
    await terminalOpen(asClient(c), 'service', '1', { node: '2' }, terminalIo().io);
    expect(err()).toContain('Update the node agent to v0.15.0');
    expect(c.terminals.connect).not.toHaveBeenCalled();
  });

  it('defaults to the ws package socket and process streams', async () => {
    const { c, handlers } = connectingClient();
    const { stdin } = terminalIo();
    const realStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    try {
      const p = terminalOpen(asClient(c), 'service', '1');
      await vi.waitFor(() => expect(c.terminals.connect).toHaveBeenCalled());
      const factory = (c.terminals.connect.mock.calls[0]![2] as { socketFactory: (u: string, p: string[]) => { url: string; protocols: string[] } }).socketFactory;
      expect(factory('ws://x/v1/terminals/7/attach', ['ninedeploy.terminal.v1'])).toMatchObject({ url: 'ws://x/v1/terminals/7/attach' });
      handlers().onClose!({ code: 1000, reason: '', message: '' });
      await p;
    } finally {
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
    }
  });
});

const TRAFFIC_VIEW = {
  enabled: true,
  retentionDays: 30,
  status: 'running',
  lastError: null as string | null,
  lastIngestAt: '2026-10-08T10:00:00.000Z' as string | null,
  logBytes: 1024,
  malformedLines: 0,
  dockerLogDriver: 'json-file',
};
const counters = { requests: 20, status1xx: 0, status2xx: 18, status3xx: 0, status4xx: 0, status5xx: 2, statusOther: 0, bytesOut: 4096, durationSumMs: 400, durationMaxMs: 90 };
const scope = (key: string, host: string | null) => ({ ...counters, p50Ms: 10, p95Ms: null, p99Ms: 80, scopeKey: key, domainId: null, serviceId: null, host });

describe('traffic', () => {
  it('shows the settings', async () => {
    const c = makeClient();
    c.traffic.settings.get.mockResolvedValueOnce(TRAFFIC_VIEW).mockResolvedValueOnce({ ...TRAFFIC_VIEW, enabled: false, lastIngestAt: null, lastError: `boom${ESC}[1m` });
    await trafficSettings(asClient(c));
    expect(out()).toContain('json-file');
    await trafficSettings(asClient(c));
    const line = out().split('\n').find((l) => l.includes('boom')) ?? '';
    expect(line).toContain('boom');
    expect(line).not.toContain('[1m');
    expect(c.traffic.settings.set).not.toHaveBeenCalled();
  });

  it('enables after the recreate warning, saves retention without one', async () => {
    const c = makeClient();
    c.traffic.settings.set.mockResolvedValue(TRAFFIC_VIEW);
    h.prompt.mockResolvedValueOnce('no').mockResolvedValueOnce('yes');
    await trafficSettings(asClient(c), { enable: true });
    expect(c.traffic.settings.set).not.toHaveBeenCalled();
    expect(out()).toContain('recreates Traefik once');
    await trafficSettings(asClient(c), { enable: true });
    expect(c.traffic.settings.set).toHaveBeenCalledWith({ enabled: true });
    await trafficSettings(asClient(c), { disable: true, yes: true, retention: '90' });
    expect(c.traffic.settings.set).toHaveBeenLastCalledWith({ enabled: false, retentionDays: 90 });
    await trafficSettings(asClient(c), { retention: '7' });
    expect(c.traffic.settings.set).toHaveBeenLastCalledWith({ retentionDays: 7 });
    expect(h.prompt).toHaveBeenCalledTimes(2);
  });

  it('refuses conflicting flags and explains a failed toggle', async () => {
    const c = makeClient();
    await trafficSettings(asClient(c), { enable: true, disable: true });
    await trafficSettings(asClient(c), { retention: '0' });
    expect(c.traffic.settings.set).not.toHaveBeenCalled();
    c.traffic.settings.set.mockRejectedValueOnce(new Error('Traefik could not be recreated')).mockRejectedValueOnce(new Error('bad retention'));
    await trafficSettings(asClient(c), { enable: true, yes: true });
    expect(err()).toContain('Traefik could not be recreated');
    expect(out()).toContain('ninedeploy traffic settings');
    logSpy.mockClear();
    await trafficSettings(asClient(c), { retention: '500' });
    expect(err()).toContain('bad retention');
    expect(out()).not.toContain('Check the current state');
  });

  it('prints the instance summary', async () => {
    const c = makeClient();
    const summary = { enabled: true, range: '7d', granularity: 3600, totals: { ...counters, p50Ms: 12.4, p95Ms: 300, p99Ms: null }, series: [], topDomains: [scope('d:1', 'app.example.com')], panel: scope('panel', null), custom: null };
    c.traffic.summary.mockResolvedValueOnce(summary).mockResolvedValueOnce({ ...summary, enabled: false }).mockRejectedValueOnce(new Error('nope'));
    await trafficSummary(asClient(c), { range: '7d', top: '5' });
    expect(c.traffic.summary).toHaveBeenCalledWith({ range: '7d', top: 5 });
    expect(out()).toContain('app.example.com');
    expect(out()).toContain('panel');
    expect(out()).toContain('12ms / 300ms / —');
    await trafficSummary(asClient(c));
    expect(c.traffic.summary).toHaveBeenLastCalledWith({});
    expect(out()).toContain('Traffic analytics is off');
    await trafficSummary(asClient(c));
    expect(err()).toContain('nope');
    await trafficSummary(asClient(c), { range: '2d' });
    await trafficSummary(asClient(c), { top: 'x' });
    expect(c.traffic.summary).toHaveBeenCalledTimes(3);
  });

  it('prints one service', async () => {
    const c = makeClient();
    const s = { enabled: true, range: '1h', granularity: 60, totals: { ...counters, p50Ms: 1, p95Ms: 2, p99Ms: 3 }, series: [], domains: [scope('d:2', 'svc.example.com')] };
    c.traffic.service.mockResolvedValueOnce(s).mockResolvedValueOnce({ ...s, enabled: false }).mockRejectedValueOnce(new Error('Service not found'));
    await trafficService(asClient(c), '4', { range: '1h' });
    expect(c.traffic.service).toHaveBeenCalledWith(4, { range: '1h' });
    expect(out()).toContain('svc.example.com');
    await trafficService(asClient(c), '4');
    expect(c.traffic.service).toHaveBeenLastCalledWith(4, {});
    expect(out()).toContain('off on this panel');
    await trafficService(asClient(c), '4');
    expect(err()).toContain('Service not found');
    await trafficService(asClient(c), 'x');
    await trafficService(asClient(c), '4', { range: 'year' });
    expect(c.traffic.service).toHaveBeenCalledTimes(3);
  });
});

const grant = (over: Record<string, unknown> = {}) => ({
  id: 8,
  workspaceId: 1,
  user: { id: 4, email: 'guest@x.test', name: null },
  project: { id: 5, name: 'shop' },
  environment: { id: 9, name: 'prod' },
  role: 'member',
  suspended: true,
  createdAt: '',
  createdBy: null,
  isGuest: true,
  ...over,
});

describe('access grants', () => {
  it('lists with filters', async () => {
    const c = makeClient();
    c.accessGrants.list.mockResolvedValueOnce([grant(), grant({ id: 9, project: null, suspended: false, isGuest: false })]).mockRejectedValueOnce(new Error('Workspace not found'));
    await accessGrantsList(asClient(c), { workspace: '1', user: '4', project: '5', environment: '9' });
    expect(c.accessGrants.list).toHaveBeenCalledWith(1, { userId: 4, projectId: 5, environmentId: 9 });
    expect(out()).toContain('project shop · env prod');
    expect(out()).toContain('guest,suspended');
    await accessGrantsList(asClient(c), { workspace: '1' });
    expect(err()).toContain('Workspace not found');
    await accessGrantsList(asClient(c), {});
    await accessGrantsList(asClient(c), { workspace: '1', user: 'x' });
    expect(c.accessGrants.list).toHaveBeenCalledTimes(2);
  });

  it('adds by email or user id, validating the subject, target and role', async () => {
    const c = makeClient();
    c.accessGrants.create.mockResolvedValueOnce(grant()).mockResolvedValueOnce(grant({ isGuest: false, environment: null })).mockRejectedValueOnce(new Error('That account cannot be granted access in this workspace'));
    await accessGrantsAdd(asClient(c), { workspace: '1', email: ' Guest@X.test ', project: '5', environment: '9', role: 'member' });
    expect(c.accessGrants.create).toHaveBeenCalledWith(1, { role: 'member', email: 'guest@x.test', projectId: 5, environmentId: 9 });
    expect(out()).toContain('(guest)');
    await accessGrantsAdd(asClient(c), { workspace: '1', user: '4', project: '5', role: 'viewer' });
    expect(c.accessGrants.create).toHaveBeenLastCalledWith(1, { role: 'viewer', userId: 4, projectId: 5 });
    await accessGrantsAdd(asClient(c), { workspace: '1', email: 'x@y.test', environment: '9', role: 'admin' });
    expect(err()).toContain('cannot be granted');
    await accessGrantsAdd(asClient(c), { email: 'a@b.test', project: '1', role: 'member' });
    await accessGrantsAdd(asClient(c), { workspace: '1', email: 'a@b.test', user: '4', project: '1', role: 'member' });
    await accessGrantsAdd(asClient(c), { workspace: '1', project: '1', role: 'member' });
    await accessGrantsAdd(asClient(c), { workspace: '1', email: 'a@b.test', role: 'member' });
    await accessGrantsAdd(asClient(c), { workspace: '1', email: 'a@b.test', project: '1', role: 'owner' });
    await accessGrantsAdd(asClient(c), { workspace: '1', email: 'a@b.test', project: '1' });
    await accessGrantsAdd(asClient(c), { workspace: '1', email: 'a@b.test', project: 'x', role: 'member' });
    expect(c.accessGrants.create).toHaveBeenCalledTimes(3);
    expect(err()).toContain('exactly one of --email or --user');
    expect(err()).toContain('--project, --environment, or both');
    expect(err()).toContain('--role must be one of viewer, member, admin');
  });

  it('updates a role', async () => {
    const c = makeClient();
    c.accessGrants.update.mockResolvedValueOnce(grant({ role: 'admin' })).mockRejectedValueOnce(new Error('grant_exceeds_role'));
    await accessGrantsUpdate(asClient(c), '8', { workspace: '1', role: 'admin' });
    expect(c.accessGrants.update).toHaveBeenCalledWith(1, 8, { role: 'admin' });
    expect(out()).toContain('Grant #8 is now admin');
    await accessGrantsUpdate(asClient(c), '8', { workspace: '1', role: 'admin' });
    expect(err()).toContain('grant_exceeds_role');
    await accessGrantsUpdate(asClient(c), '8', { role: 'admin' });
    await accessGrantsUpdate(asClient(c), 'x', { workspace: '1', role: 'admin' });
    await accessGrantsUpdate(asClient(c), '8', { workspace: '1', role: 'root' });
    expect(c.accessGrants.update).toHaveBeenCalledTimes(2);
  });

  it('removes after confirmation', async () => {
    const c = makeClient();
    c.accessGrants.delete.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('Access grant not found'));
    h.prompt.mockResolvedValueOnce('n').mockResolvedValueOnce('yes');
    await accessGrantsRemove(asClient(c), '8', { workspace: '1' });
    expect(c.accessGrants.delete).not.toHaveBeenCalled();
    await accessGrantsRemove(asClient(c), '8', { workspace: '1' });
    expect(c.accessGrants.delete).toHaveBeenCalledWith(1, 8);
    expect(out()).toContain('Grant #8 revoked');
    await accessGrantsRemove(asClient(c), '8', { workspace: '1', yes: true });
    expect(err()).toContain('Access grant not found');
    await accessGrantsRemove(asClient(c), '8', {});
    await accessGrantsRemove(asClient(c), 'x', { workspace: '1', yes: true });
    expect(c.accessGrants.delete).toHaveBeenCalledTimes(2);
  });

  it('shows the caller own access and guest workspaces', async () => {
    const c = makeClient();
    c.access.me
      .mockResolvedValueOnce({ grants: [grant()], guestWorkspaces: [{ id: 1, name: `Acme${ESC}[0m`, slug: 'acme' }] })
      .mockResolvedValueOnce({ grants: [], guestWorkspaces: [] })
      .mockRejectedValueOnce(new Error('Unauthorized'));
    await accessMe(asClient(c));
    expect(out()).toContain('Guest workspaces');
    expect(out()).toContain('Acme');
    expect(out()).not.toContain(`Acme${ESC}`);
    logSpy.mockClear();
    await accessMe(asClient(c));
    expect(out()).not.toContain('Guest workspaces');
    await accessMe(asClient(c));
    expect(err()).toContain('Unauthorized');
  });
});
