import { afterEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_CLOSE, TERMINAL_FRAME_MAX_BYTES, TERMINAL_PROTOCOL, TERMINAL_TICKET_PROTOCOL_PREFIX } from '@ninedeploy/schemas';
import {
  NineDeployError,
  TERMINAL_INPUT_CHUNK_BYTES,
  TERMINAL_PENDING_INPUT_MAX,
  TERMINAL_SUBPROTOCOL,
  TERMINAL_TICKET_PREFIX,
  connectTerminal,
  createClient,
  terminalAttachInfo,
  terminalCloseMessage,
  type TerminalSocketLike,
} from '../src/index.js';

/**
 * 0.15 surfaces (T6): terminals (HTTP routes, the attach URL and the v1
 * protocol client), traffic analytics and access grants.
 */

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function client(baseUrl = 'http://api.test') {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: { method?: string; body?: unknown }) => {
    calls.push({
      url: url.replace(/^https?:\/\/[^/]+/, ''),
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return { ok: true, status: 200, text: async () => '{}' } as unknown as Response;
  });
  return { api: createClient({ baseUrl, fetch: fetchMock }), calls };
}

const TICKET = 'abcdefghijklmnop_-0123456789';
const CREATED = { ticket: TICKET, attachPath: '/v1/terminals/7/attach' };

describe('0.15 route mapping', () => {
  it('maps terminals, traffic and access grants onto the server routes', async () => {
    const { api, calls } = client();
    const cases: Array<[() => Promise<unknown>, string, string, unknown]> = [
      [() => api.terminals.create({ target: { kind: 'database', databaseId: 3 } }), 'POST', '/v1/terminals', { target: { kind: 'database', databaseId: 3 } }],
      [() => api.terminals.list(), 'GET', '/v1/terminals', undefined],
      [() => api.terminals.list({ status: 'active', targetKind: 'host', limit: 20, before: 40 }), 'GET', '/v1/terminals?status=active&targetKind=host&limit=20&before=40', undefined],
      [() => api.terminals.get(7), 'GET', '/v1/terminals/7', undefined],
      [() => api.terminals.terminate(7), 'DELETE', '/v1/terminals/7', undefined],
      [() => api.terminals.settings.get(), 'GET', '/v1/terminals/settings', undefined],
      [() => api.terminals.settings.set({ hostTerminalEnabled: true, password: 'pw' }), 'PUT', '/v1/terminals/settings', { hostTerminalEnabled: true, password: 'pw' }],
      [() => api.traffic.settings.get(), 'GET', '/v1/traffic/settings', undefined],
      [() => api.traffic.settings.set({ enabled: true }), 'PUT', '/v1/traffic/settings', { enabled: true }],
      [() => api.traffic.summary(), 'GET', '/v1/traffic/summary', undefined],
      [() => api.traffic.summary({ range: '7d', top: 5 }), 'GET', '/v1/traffic/summary?range=7d&top=5', undefined],
      [() => api.traffic.service(4), 'GET', '/v1/services/4/traffic', undefined],
      [() => api.traffic.service(4, { range: '1h' }), 'GET', '/v1/services/4/traffic?range=1h', undefined],
      [() => api.accessGrants.list(2), 'GET', '/v1/workspaces/2/access-grants', undefined],
      [() => api.accessGrants.list(2, { userId: 9 }), 'GET', '/v1/workspaces/2/access-grants?userId=9', undefined],
      [
        () => api.accessGrants.create(2, { email: 'a@b.test', projectId: 5, role: 'member' }),
        'POST',
        '/v1/workspaces/2/access-grants',
        { email: 'a@b.test', projectId: 5, role: 'member' },
      ],
      [() => api.accessGrants.update(2, 8, { role: 'admin' }), 'PATCH', '/v1/workspaces/2/access-grants/8', { role: 'admin' }],
      [() => api.accessGrants.delete(2, 8), 'DELETE', '/v1/workspaces/2/access-grants/8', undefined],
      [() => api.access.me(), 'GET', '/v1/access/me', undefined],
      [() => api.access.project(5), 'GET', '/v1/projects/5/access', undefined],
    ];
    for (const [call, method, url, body] of cases) {
      calls.length = 0;
      await call();
      expect(calls, `${method} ${url}`).toEqual([{ method, url, body }]);
    }
  });
});

describe('terminal attach URL', () => {
  it('mirrors the server protocol constants', () => {
    expect(TERMINAL_SUBPROTOCOL).toBe(TERMINAL_PROTOCOL);
    expect(TERMINAL_TICKET_PREFIX).toBe(TERMINAL_TICKET_PROTOCOL_PREFIX);
    expect(TERMINAL_INPUT_CHUNK_BYTES).toBeLessThan(TERMINAL_FRAME_MAX_BYTES);
  });

  it('turns an absolute base URL into ws/wss and keeps a sub-path prefix', () => {
    expect(terminalAttachInfo('http://panel.test/', CREATED)).toEqual({
      url: 'ws://panel.test/v1/terminals/7/attach',
      protocols: ['ninedeploy.terminal.v1', `ninedeploy.ticket.${TICKET}`],
    });
    expect(terminalAttachInfo('https://panel.test/nd', CREATED).url).toBe('wss://panel.test/nd/v1/terminals/7/attach');
  });

  it('resolves a relative base URL against the page location', () => {
    expect(terminalAttachInfo('', CREATED, { protocol: 'https:', host: 'p.test:8443' }).url).toBe('wss://p.test:8443/v1/terminals/7/attach');
    expect(terminalAttachInfo('/api', CREATED, { protocol: 'http:', host: 'p.test' }).url).toBe('ws://p.test/api/v1/terminals/7/attach');
    vi.stubGlobal('location', { protocol: 'http:', host: 'page.test' });
    try {
      expect(terminalAttachInfo('', CREATED).url).toBe('ws://page.test/v1/terminals/7/attach');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses a relative base without a location, a foreign path and a malformed ticket', () => {
    expect(() => terminalAttachInfo('', CREATED)).toThrow(NineDeployError);
    expect(() => terminalAttachInfo('http://p.test', { ...CREATED, attachPath: '/v1/services/1/exec' })).toThrow(/attach path/);
    expect(() => terminalAttachInfo('http://p.test', { ...CREATED, ticket: 'short' })).toThrow(/malformed/);
  });

  it('client.terminals.attachInfo uses the client base URL', () => {
    const { api } = client('https://panel.test');
    expect(api.terminals.attachInfo(CREATED).url).toBe('wss://panel.test/v1/terminals/7/attach');
    const relative = client('').api;
    expect(relative.terminals.attachInfo(CREATED, { protocol: 'http:', host: 'x.test' }).url).toBe('ws://x.test/v1/terminals/7/attach');
  });

  it('explains every close code', () => {
    for (const code of [...Object.values(TERMINAL_CLOSE), 1006]) {
      expect(terminalCloseMessage(code)).toMatch(/\w/);
    }
    expect(terminalCloseMessage(4408)).toMatch(/idle/);
    expect(terminalCloseMessage(4409)).toMatch(/maximum/);
    expect(terminalCloseMessage(4410)).toMatch(/terminated/);
    expect(terminalCloseMessage(4429)).toMatch(/Too many/);
    expect(terminalCloseMessage(1009)).toMatch(/too large/);
    expect(terminalCloseMessage(1006)).toMatch(/1006/);
  });
});

class FakeSocket implements TerminalSocketLike {
  binaryType = 'blob';
  readyState = 0;
  sent: Array<string | Uint8Array> = [];
  closedWith: [number | undefined, string | undefined] | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(
    public url: string,
    public protocols: string[],
  ) {}
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closedWith = [code, reason];
  }
  text(msg: unknown) {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }
  get json() {
    return this.sent.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d));
  }
  get bytes() {
    return this.sent.filter((d): d is Uint8Array => typeof d !== 'string');
  }
}

function attach(handlers = {}, opts: { pingIntervalMs?: number } = { pingIntervalMs: 0 }) {
  let socket!: FakeSocket;
  const conn = connectTerminal(terminalAttachInfo('http://p.test', CREATED), handlers, {
    ...opts,
    socketFactory: (url, protocols) => {
      socket = new FakeSocket(url, protocols);
      return socket;
    },
  });
  return { conn, socket };
}

const READY = { t: 'ready', sessionId: 7, target: { kind: 'service', label: 'web', serverId: null } };

describe('connectTerminal (protocol v1)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens with the v1 subprotocols and binary frames as ArrayBuffers', () => {
    const { socket, conn } = attach();
    expect(socket.url).toBe('ws://p.test/v1/terminals/7/attach');
    expect(socket.protocols).toEqual(['ninedeploy.terminal.v1', `ninedeploy.ticket.${TICKET}`]);
    expect(socket.binaryType).toBe('arraybuffer');
    expect(conn.ready).toBe(false);
    socket.onerror?.({});
  });

  it('holds input and the last resize until ready, then flushes them in order', () => {
    const onReady = vi.fn();
    const { socket, conn } = attach({ onReady });
    conn.write('ls\r');
    conn.write(new Uint8Array([1, 2]));
    conn.write('');
    conn.resize(2, 1000.4);
    expect(socket.sent).toEqual([]);
    socket.text(READY);
    expect(conn.ready).toBe(true);
    expect(onReady).toHaveBeenCalledWith({ sessionId: 7, target: READY.target });
    expect(socket.json).toEqual([{ t: 'resize', cols: 10, rows: 200 }]);
    expect(socket.bytes.map((b) => Array.from(b))).toEqual([[108, 115, 13], [1, 2]]);
    conn.resize(80, 24);
    conn.write('x');
    expect(socket.json.at(-1)).toEqual({ t: 'resize', cols: 80, rows: 24 });
    expect(Array.from(socket.bytes.at(-1)!)).toEqual([120]);
  });

  it('drops input beyond the pending cap and chunks large writes below the frame cap', () => {
    const { socket, conn } = attach();
    conn.write(new Uint8Array(TERMINAL_PENDING_INPUT_MAX));
    conn.write('dropped');
    socket.text(READY);
    expect(socket.bytes.map((b) => b.length)).toEqual([TERMINAL_INPUT_CHUNK_BYTES, TERMINAL_INPUT_CHUNK_BYTES]);
    socket.sent = [];
    conn.write(new Uint8Array(TERMINAL_INPUT_CHUNK_BYTES + 5));
    expect(socket.bytes.map((b) => b.length)).toEqual([TERMINAL_INPUT_CHUNK_BYTES, 5]);
  });

  it('routes output, notices and the exit message; ignores junk text', () => {
    const onData = vi.fn();
    const onNotice = vi.fn();
    const onExit = vi.fn();
    const { socket } = attach({ onData, onNotice, onExit });
    socket.onmessage?.({ data: new Uint8Array([65]).buffer });
    socket.onmessage?.({ data: new Uint8Array([66]) });
    socket.onmessage?.({ data: new DataView(new Uint8Array([0, 67]).buffer, 1, 1) });
    expect(onData.mock.calls.map(([b]) => Array.from(b as Uint8Array))).toEqual([[65], [66], [67]]);
    socket.text('not json');
    socket.text({ t: 'mystery' });
    socket.text({ t: 'notice', message: 'Could not open the terminal' });
    socket.text({ t: 'exit', code: 0, reason: 'shell_exited' });
    socket.text({ t: 'exit', code: null, reason: 'idle' });
    expect(onNotice).toHaveBeenCalledWith('Could not open the terminal');
    expect(onExit.mock.calls).toEqual([[{ code: 0, reason: 'shell_exited' }], [{ code: null, reason: 'idle' }]]);
  });

  it('works without handlers', () => {
    let socket!: FakeSocket;
    connectTerminal(terminalAttachInfo('http://p.test', CREATED), undefined, {
      pingIntervalMs: 0,
      socketFactory: (url, protocols) => (socket = new FakeSocket(url, protocols)),
    });
    socket.onmessage?.({ data: new Uint8Array([1]) });
    socket.text(READY);
    socket.text({ t: 'notice', message: 'n' });
    socket.text({ t: 'exit', code: 1, reason: 'r' });
    socket.onclose?.({ code: 1000, reason: '' });
  });

  it('reports the close with a message and stops sending afterwards', () => {
    const onClose = vi.fn();
    const { socket, conn } = attach({ onClose });
    socket.text(READY);
    socket.onclose?.({ code: 4410, reason: 'terminated' });
    expect(onClose).toHaveBeenCalledWith({ code: 4410, reason: 'terminated', message: terminalCloseMessage(4410) });
    expect(conn.ready).toBe(false);
    socket.sent = [];
    conn.write('late');
    conn.resize(80, 24);
    conn.close();
    expect(socket.sent).toEqual([]);
    expect(socket.closedWith).toBeNull();
  });

  it('close() closes once with 1000', () => {
    const { socket, conn } = attach();
    conn.close();
    conn.close();
    expect(socket.closedWith).toEqual([1000, 'client closed']);
  });

  it('pings on an interval after ready, and stops when closed', () => {
    vi.useFakeTimers();
    const { socket, conn } = attach({}, { pingIntervalMs: 1000 });
    socket.text(READY);
    vi.advanceTimersByTime(2500);
    expect(socket.json.filter((m) => m.t === 'ping')).toHaveLength(2);
    conn.close();
    vi.advanceTimersByTime(5000);
    expect(socket.json.filter((m) => m.t === 'ping')).toHaveLength(2);
  });

  it('pings every 30s by default; a ping after a server close is not sent', () => {
    vi.useFakeTimers();
    let socket!: FakeSocket;
    connectTerminal(terminalAttachInfo('http://p.test', CREATED), {}, {
      socketFactory: (url, protocols) => (socket = new FakeSocket(url, protocols)),
    });
    socket.text(READY);
    vi.advanceTimersByTime(30_000);
    expect(socket.json.filter((m) => m.t === 'ping')).toHaveLength(1);
    socket.onclose?.({ code: 1006, reason: '' });
    vi.advanceTimersByTime(60_000);
    expect(socket.json.filter((m) => m.t === 'ping')).toHaveLength(1);
  });

  it('a ping racing a close is suppressed', () => {
    const intervals: Array<() => void> = [];
    vi.stubGlobal('setInterval', (fn: () => void) => {
      intervals.push(fn);
      return 1;
    });
    vi.stubGlobal('clearInterval', () => undefined);
    const { socket, conn } = attach({}, { pingIntervalMs: 10 });
    socket.text(READY);
    conn.close();
    intervals[0]!();
    expect(socket.json.filter((m) => m.t === 'ping')).toHaveLength(0);
  });

  it('uses globalThis.WebSocket by default, and refuses without one', () => {
    const made: FakeSocket[] = [];
    vi.stubGlobal(
      'WebSocket',
      class extends FakeSocket {
        constructor(url: string, protocols: string[]) {
          super(url, protocols);
          made.push(this);
        }
      },
    );
    const { api } = client('http://p.test');
    api.terminals.connect(CREATED, {}, { pingIntervalMs: 0 });
    expect(made[0]?.protocols[0]).toBe('ninedeploy.terminal.v1');
    vi.stubGlobal('WebSocket', undefined);
    expect(() => api.terminals.connect(CREATED)).toThrow(/WebSocket/);
  });
});
