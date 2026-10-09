import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 0.15 (T2b): node terminals, agent side (DESIGN §1.5) — the sealed
 * `terminal.open` op, the `/agent/terminal` channel with its per-channel
 * frame cipher, the node owner's host-shell switch, the capability, cleanup
 * when the panel connection drops, and that a 0.14 panel sees no change.
 * Docker is never reached: `lib/dockerTty.ts` is faked.
 */

const fakes = vi.hoisted(() => {
  const make = (mode: 'exec' | 'host') => {
    const dataCbs: Array<(c: Buffer) => void> = [];
    const endCbs: Array<(c: number | null) => void> = [];
    const early: Buffer[] = [];
    const t = {
      mode,
      containerId: mode === 'host' ? 'helper-1' : undefined,
      written: [] as string[],
      resizes: [] as Array<[number, number]>,
      pauses: 0,
      resumes: 0,
      killed: 0,
      write: (b: Buffer) => void t.written.push(b.toString()),
      resize: (c: number, r: number) => void t.resizes.push([c, r]),
      pause: () => void t.pauses++,
      resume: () => void t.resumes++,
      kill: async () => {
        t.killed++;
      },
      onData: (cb: (c: Buffer) => void) => {
        dataCbs.push(cb);
        if (early.length) cb(Buffer.concat(early.splice(0)));
      },
      onEnd: (cb: (c: number | null) => void) => void endCbs.push(cb),
      emit: (s: string) => {
        if (dataCbs.length === 0) early.push(Buffer.from(s));
        for (const cb of dataCbs) cb(Buffer.from(s));
      },
      exit: (code: number | null) => {
        for (const cb of endCbs.splice(0)) cb(code);
      },
    };
    return t;
  };
  return {
    make,
    ttys: [] as Array<ReturnType<typeof make>>,
    inspect: vi.fn(),
    openExec: vi.fn(),
    openHost: vi.fn(),
    probe: vi.fn(),
  };
});
vi.mock('../src/lib/dockerTty.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/dockerTty.js')>()),
  dockerTransport: () => ({ kind: 'socket', socketPath: '/var/run/docker.sock' }),
  inspectContainer: (...a: unknown[]) => fakes.inspect(...a),
  probeHostShellImage: (...a: unknown[]) => fakes.probe(...a),
  openExecTty: (...a: unknown[]) => fakes.openExec(...a),
  openHostShellTty: (...a: unknown[]) => fakes.openHost(...a),
  listContainersWithLabel: async () => [],
  forceRemoveContainer: async () => undefined,
}));
const spawnMock = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => 0));
vi.mock('../src/lib/spawnValidated.js', () => ({ spawnValidated: spawnMock }));

const agent = await import('../src/agent.js');
const { buildAgentApp } = await import('../src/agentApp.js');
const { open: openSealed, seal } = await import('../src/lib/agentSeal.js');
const { parseAgentCapabilities } = await import('../src/lib/agentCapabilities.js');
const { AgentChannelTty, parseTerminalChannel } = await import('../src/lib/agentTerminal.js');
const { deriveFrameKey, encodeResize, FRAME_TYPE, FrameOpener, FrameSealer } = await import('../src/lib/agentFrameCipher.js');
const { buildTestApp, listen } = await import('./helpers.js');

const TOKEN = 'agent-shared-token';
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');

type App = Awaited<ReturnType<typeof buildTestApp>>;
let app: App;
let port: number;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  fakes.ttys.length = 0;
  fakes.inspect.mockReset().mockImplementation(async (_t: unknown, name: string) =>
    name === 'gone' ? null : { id: `id-${name}`, running: name !== 'stopped', hostname: 'h', labels: {} },
  );
  fakes.openExec.mockReset().mockImplementation(async () => {
    const t = fakes.make('exec');
    fakes.ttys.push(t);
    return t;
  });
  fakes.openHost.mockReset().mockImplementation(async () => {
    const t = fakes.make('host');
    fakes.ttys.push(t);
    return t;
  });
  fakes.probe.mockReset().mockResolvedValue({ ok: true });
  spawnMock.mockReset().mockResolvedValue(0);
  agent._resetAgentTerminals();
  delete process.env['NINEDEPLOY_AGENT_HOST_TERMINAL'];
  delete process.env['NINEDEPLOY_HOST_TERMINAL'];
  app = await buildTestApp();
  await app.register(agent.agentRoutes, { tokenHash: TOKEN_HASH });
  port = await listen(app);
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await app.close();
  agent._resetAgentTerminals();
  delete process.env['NINEDEPLOY_AGENT_HOST_TERMINAL'];
  delete process.env['NINEDEPLOY_HOST_TERMINAL'];
});

/** One sealed `/agent/exec` call, as the panel's agentOp makes it. */
async function sealedOp(op: string, params: Record<string, unknown>) {
  const nonce = Math.random().toString(36).slice(2);
  const res = await app.inject({ method: 'POST', url: '/agent/exec', payload: { sealed: seal(TOKEN_HASH, { op, params, nonce }) } });
  if (res.statusCode !== 200) return { status: res.statusCode, error: res.json().error as { code: string; message: string }, lines: [] as string[] };
  const body = openSealed<{ lines: string[]; exitCode: number; nonce: string }>(TOKEN_HASH, res.json().sealed);
  return { status: 200, error: null, lines: body.lines, exitCode: body.exitCode, nonce: body.nonce };
}

const OPEN_PARAMS = { kind: 'container', container: 'web-12', cols: 100, rows: 30, sessionId: 7 };

async function openChannel(params: Record<string, unknown> = OPEN_PARAMS) {
  const res = await sealedOp('terminal.open', params);
  expect(res.status).toBe(200);
  const ch = parseTerminalChannel(res.lines);
  expect(ch).not.toBeNull();
  return ch!;
}

function connect(channel: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agent/terminal`, [`ninedeploy.agent-terminal.${channel}`]);
  ws.binaryType = 'arraybuffer';
  sockets.push(ws);
  const frames: Buffer[] = [];
  ws.addEventListener('message', (ev) => frames.push(Buffer.from(ev.data as ArrayBuffer)));
  const opened = new Promise<boolean>((resolve) => {
    ws.addEventListener('open', () => resolve(true));
    ws.addEventListener('error', () => resolve(false));
  });
  const closed = new Promise<number>((resolve) => ws.addEventListener('close', (ev) => resolve(ev.code)));
  return { ws, frames, opened, closed };
}

const waitFor = async (pred: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('wiring (each fails if its registration is removed)', () => {
  it("advertises 'terminal' and handles terminal.open", () => {
    expect(agent.AGENT_CAPABILITIES).toContain('terminal');
    expect(agent.agentMode.HANDLED_OPS.has('terminal.open')).toBe(true);
  });

  it('agentRoutes registers GET /agent/terminal as a WebSocket route', () => {
    expect(app.hasRoute({ method: 'GET', url: '/agent/terminal' })).toBe(true);
  });

  it("the agent app registers @fastify/websocket (the agent's own server, 256 KiB frames)", async () => {
    const a = await buildAgentApp();
    await a.ready();
    expect(a.hasDecorator('websocketServer')).toBe(true);
    expect((a as unknown as { websocketServer: { options: { maxPayload: number } } }).websocketServer.options.maxPayload).toBe(256 * 1024);
    await a.close();
  });
});

describe('terminal.open', () => {
  it('is refused over the unencrypted transport — nothing touches Docker', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/agent/exec',
      headers: { 'x-agent-token': TOKEN },
      payload: { op: 'terminal.open', params: OPEN_PARAMS },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/unencrypted transport/);
    await expect(agent.runOp('terminal.open', OPEN_PARAMS, () => undefined)).rejects.toThrow(/sealed request/);
    expect(fakes.inspect).not.toHaveBeenCalled();
    expect(fakes.openExec).not.toHaveBeenCalled();
    expect(agent.terminalChannelCount()).toBe(0);
  });

  it('answers one ND-TERMINAL line (channel + 32-byte salt) inside the sealed reply', async () => {
    const res = await sealedOp('terminal.open', OPEN_PARAMS);
    expect(res.status).toBe(200);
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0]).toMatch(/^ND-TERMINAL \{"channel":"[0-9a-f]{32}","salt":"[A-Za-z0-9+/=]{44}"\}$/);
    expect(fakes.openExec).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ container: 'web-12', cols: 100, rows: 30 }));
    expect(agent.terminalChannelCount()).toBe(1);
  });

  it('validates its operands', async () => {
    for (const bad of [
      { ...OPEN_PARAMS, kind: 'shell' },
      { ...OPEN_PARAMS, container: '-it' },
      { ...OPEN_PARAMS, container: 'a b' },
      { ...OPEN_PARAMS, cols: 9 },
      { ...OPEN_PARAMS, rows: 201 },
      { ...OPEN_PARAMS, sessionId: 0 },
      { ...OPEN_PARAMS, cols: '100' },
    ]) {
      const res = await sealedOp('terminal.open', bad);
      expect(res.status).toBe(400);
    }
    expect(fakes.openExec).not.toHaveBeenCalled();
  });

  it("refuses a missing or stopped container, and the node's own containers", async () => {
    expect((await sealedOp('terminal.open', { ...OPEN_PARAMS, container: 'gone' })).error?.message).toMatch(/does not exist/);
    expect((await sealedOp('terminal.open', { ...OPEN_PARAMS, container: 'stopped' })).error?.message).toMatch(/not running/);
    expect((await sealedOp('terminal.open', { ...OPEN_PARAMS, container: 'ninedeploy-agent' })).error?.message).toMatch(/refused/);
    expect((await sealedOp('terminal.open', { ...OPEN_PARAMS, container: 'ninedeploy-proxy' })).error?.message).toMatch(/refused/);
    fakes.inspect.mockResolvedValueOnce({ id: 'x', running: true, hostname: null, labels: { 'ninedeploy.terminal.session': '3' } });
    expect((await sealedOp('terminal.open', { ...OPEN_PARAMS, container: 'nd-hostshell-3' })).error?.message).toMatch(/refused/);
    expect(fakes.openExec).not.toHaveBeenCalled();
  });

  it('opens a host shell through the nsenter helper (proxy image by default)', async () => {
    const res = await sealedOp('terminal.open', { kind: 'host', cols: 80, rows: 24, sessionId: 9 });
    expect(res.status).toBe(200);
    expect(fakes.probe).toHaveBeenCalledWith(expect.anything(), 'traefik:v3.1');
    expect(fakes.openHost).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ image: 'traefik:v3.1', sessionId: 9, cols: 80, rows: 24 }));
    fakes.probe.mockResolvedValueOnce({ ok: false, reason: 'the image x has no nsenter' });
    expect((await sealedOp('terminal.open', { kind: 'host', cols: 80, rows: 24, sessionId: 10 })).error?.message).toMatch(/NINEDEPLOY_HOST_SHELL_IMAGE/);
  });

  it("obeys the node owner's kill switch (either variable), and stops advertising terminal.host", async () => {
    for (const [name, value] of [
      ['NINEDEPLOY_AGENT_HOST_TERMINAL', 'off'],
      ['NINEDEPLOY_HOST_TERMINAL', 'off'],
      ['NINEDEPLOY_AGENT_HOST_TERMINAL', 'false'],
    ] as const) {
      process.env[name] = value;
      const res = await sealedOp('terminal.open', { kind: 'host', cols: 80, rows: 24, sessionId: 9 });
      expect(res.status).toBe(400);
      expect(res.error?.message).toMatch(/Host shells are disabled on this node/);
      const ping = await sealedOp('agent.ping', {});
      expect([...parseAgentCapabilities(ping.lines).caps]).not.toContain('terminal.host');
      expect([...parseAgentCapabilities(ping.lines).caps]).toContain('terminal');
      delete process.env[name];
    }
    expect(fakes.openHost).not.toHaveBeenCalled();
    // Container shells are unaffected by the host switch.
    process.env['NINEDEPLOY_AGENT_HOST_TERMINAL'] = 'off';
    expect((await sealedOp('terminal.open', OPEN_PARAMS)).status).toBe(200);
    const ping = await sealedOp('agent.ping', {});
    delete process.env['NINEDEPLOY_AGENT_HOST_TERMINAL'];
    // Multi-node: the 0.15 answer stays the prefix; new capabilities follow it.
    // An opt-in capability (0.16 T7 `swarm`) is advertised only once its owner set its variable.
    const { AGENT_OPT_IN } = await import('../src/agentOps/index.js');
    const added = agent.AGENT_CAPABILITIES.slice(agent.AGENT_CAPABILITIES_015.length).filter((c) => !Object.hasOwn(AGENT_OPT_IN, c));
    expect(added.length).toBe(agent.AGENT_CAPABILITIES.length - agent.AGENT_CAPABILITIES_015.length - Object.keys(AGENT_OPT_IN).length);
    expect([...parseAgentCapabilities(ping.lines).caps]).toEqual([...agent.AGENT_CAPABILITIES_015, ...added]);
    expect([...parseAgentCapabilities((await sealedOp('agent.ping', {})).lines).caps]).toEqual([
      ...agent.AGENT_CAPABILITIES_015,
      'terminal.host',
      ...added,
    ]);
  });

  it('holds at most 8 channels', async () => {
    for (let i = 0; i < agent.TERMINAL_MAX_CHANNELS; i++) await openChannel();
    const ninth = await sealedOp('terminal.open', OPEN_PARAMS);
    expect(ninth.status).toBe(400);
    expect(ninth.error?.message).toMatch(/at most 8/);
  });

  it('a channel nobody attached expires after 30 s and its process is killed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await agent.runOp('terminal.open', OPEN_PARAMS, () => undefined, { sealed: true });
      expect(agent.terminalChannelCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(agent.TERMINAL_CHANNEL_TTL_MS + 1);
      expect(agent.terminalChannelCount()).toBe(0);
      expect(fakes.ttys[0]!.killed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('/agent/terminal channel', () => {
  it('bridges an authenticated, encrypted stream both ways; resize works; output waits for the panel to authenticate', async () => {
    const ch = await openChannel();
    fakes.ttys[0]!.emit('early prompt $ ');
    const c = connect(ch.channel);
    expect(await c.opened).toBe(true);
    expect(c.ws.protocol).toBe(`ninedeploy.agent-terminal.${ch.channel}`);
    await new Promise((r) => setTimeout(r, 50));
    expect(c.frames).toHaveLength(0); // nothing before the panel's first frame

    const key = deriveFrameKey(TOKEN_HASH, ch.salt);
    const tx = new FrameSealer(key, 'panel');
    const rx = new FrameOpener(key, 'agent');
    c.ws.send(tx.seal(FRAME_TYPE.resize, encodeResize(120, 40)));
    await waitFor(() => c.frames.length > 0);
    const first = rx.open(c.frames[0]!);
    expect([first.type, first.payload.toString()]).toEqual([FRAME_TYPE.data, 'early prompt $ ']);
    expect(fakes.ttys[0]!.resizes).toEqual([[120, 40]]);

    c.ws.send(tx.seal(FRAME_TYPE.data, Buffer.from('echo hi\r')));
    await waitFor(() => fakes.ttys[0]!.written.length === 1);
    expect(fakes.ttys[0]!.written).toEqual(['echo hi\r']);
    fakes.ttys[0]!.emit('hi\r\n');
    await waitFor(() => c.frames.length === 2);
    expect(rx.open(c.frames[1]!).payload.toString()).toBe('hi\r\n');

    c.ws.send(tx.seal(FRAME_TYPE.pause));
    c.ws.send(tx.seal(FRAME_TYPE.resume));
    await waitFor(() => fakes.ttys[0]!.resumes === 1);
    expect(fakes.ttys[0]!.pauses).toBe(1);

    fakes.ttys[0]!.exit(0);
    expect(await c.closed).toBe(1000);
    const exit = rx.open(c.frames[2]!);
    expect([exit.type, exit.payload.toString()]).toEqual([FRAME_TYPE.exit, '{"code":0}']);
    await waitFor(() => agent.terminalChannelCount() === 0);
  });

  it('the panel connection dropping kills the process (exec or host helper)', async () => {
    for (const params of [OPEN_PARAMS, { kind: 'host', cols: 80, rows: 24, sessionId: 4 }]) {
      const ch = await openChannel(params);
      const c = connect(ch.channel);
      expect(await c.opened).toBe(true);
      c.ws.send(new FrameSealer(deriveFrameKey(TOKEN_HASH, ch.salt), 'panel').seal(FRAME_TYPE.resize, encodeResize(80, 24)));
      await new Promise((r) => setTimeout(r, 30));
      c.ws.close();
      const tty = fakes.ttys.at(-1)!;
      await waitFor(() => tty.killed === 1);
      await waitFor(() => agent.terminalChannelCount() === 0);
    }
  });

  it('a channel is single use: a second connection is closed 1008', async () => {
    const ch = await openChannel();
    const a = connect(ch.channel);
    expect(await a.opened).toBe(true);
    const b = connect(ch.channel);
    expect(await b.closed).toBe(1008);
    const unknown = connect('0'.repeat(32));
    expect(await unknown.closed).toBe(1008);
    const noProtocol = new WebSocket(`ws://127.0.0.1:${port}/agent/terminal`);
    sockets.push(noProtocol);
    expect(await new Promise<number>((r) => noProtocol.addEventListener('close', (ev) => r(ev.code)))).toBe(1008);
  });

  it('a peer without the key (or replaying, or out of order) is cut off and the process killed', async () => {
    // Wrong key: a racing peer that learned the channel id.
    const ch1 = await openChannel();
    const c1 = connect(ch1.channel);
    expect(await c1.opened).toBe(true);
    c1.ws.send(new FrameSealer(deriveFrameKey('f'.repeat(64), ch1.salt), 'panel').seal(FRAME_TYPE.data, Buffer.from('id\r')));
    expect(await c1.closed).toBe(1008);
    expect(c1.frames).toHaveLength(0);
    await waitFor(() => fakes.ttys[0]!.killed === 1);
    expect(fakes.ttys[0]!.written).toEqual([]);

    // A replayed frame.
    const ch2 = await openChannel();
    const c2 = connect(ch2.channel);
    expect(await c2.opened).toBe(true);
    const tx = new FrameSealer(deriveFrameKey(TOKEN_HASH, ch2.salt), 'panel');
    const f0 = tx.seal(FRAME_TYPE.data, Buffer.from('ls\r'));
    c2.ws.send(f0);
    c2.ws.send(f0);
    expect(await c2.closed).toBe(1008);
    expect(fakes.ttys[1]!.written).toEqual(['ls\r']);

    // Text frames are not part of the protocol.
    const ch3 = await openChannel();
    const c3 = connect(ch3.channel);
    expect(await c3.opened).toBe(true);
    c3.ws.send('{"t":"resize"}');
    expect(await c3.closed).toBe(1008);
  });

  it('a peer that never authenticates is closed after 10 s', async () => {
    const ch = await openChannel();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const c = connect(ch.channel);
      await vi.waitFor(() => expect(c.ws.readyState).toBe(1));
      await vi.advanceTimersByTimeAsync(agent.TERMINAL_AUTH_TIMEOUT_MS + 1);
      vi.useRealTimers();
      expect(await c.closed).toBe(1008);
      await waitFor(() => fakes.ttys[0]!.killed === 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the panel's AgentChannelTty speaks the same protocol (end to end against the real route)", async () => {
    const ch = await openChannel();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agent/terminal`, [`ninedeploy.agent-terminal.${ch.channel}`]);
    ws.binaryType = 'arraybuffer';
    sockets.push(ws);
    await new Promise((r) => ws.addEventListener('open', r));
    const tty = new AgentChannelTty(ws as never, deriveFrameKey(TOKEN_HASH, ch.salt), 'container');
    tty.start(90, 20);
    const out: string[] = [];
    tty.onData((b) => out.push(b.toString()));
    const ended = new Promise<number | null>((r) => tty.onEnd(r));
    await waitFor(() => fakes.ttys[0]!.resizes.length === 1);
    expect(fakes.ttys[0]!.resizes).toEqual([[90, 20]]);
    tty.write(Buffer.alloc(40_000, 0x61)); // split into two frames
    await waitFor(() => fakes.ttys[0]!.written.join('').length === 40_000);
    expect(fakes.ttys[0]!.written).toHaveLength(2);
    tty.resize(132, 50);
    await waitFor(() => fakes.ttys[0]!.resizes.length === 2);
    fakes.ttys[0]!.emit('$ ');
    await waitFor(() => out.join('') === '$ ');
    fakes.ttys[0]!.exit(130);
    expect(await ended).toBe(130);
    expect(tty.failure).toBeNull();

    // kill() from the panel closes the channel; the agent kills the process.
    const ch2 = await openChannel();
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/agent/terminal`, [`ninedeploy.agent-terminal.${ch2.channel}`]);
    ws2.binaryType = 'arraybuffer';
    sockets.push(ws2);
    await new Promise((r) => ws2.addEventListener('open', r));
    const tty2 = new AgentChannelTty(ws2 as never, deriveFrameKey(TOKEN_HASH, ch2.salt), 'container');
    tty2.start(80, 24);
    await waitFor(() => fakes.ttys[1]!.resizes.length === 1);
    await tty2.kill();
    await waitFor(() => fakes.ttys[1]!.killed === 1);
  });

  it('closing the agent app closes every channel', async () => {
    await openChannel();
    await openChannel();
    await app.close();
    expect(agent.terminalChannelCount()).toBe(0);
    expect(fakes.ttys.map((t) => t.killed)).toEqual([1, 1]);
    app = await buildTestApp(); // afterEach closes it
  });
});

describe('a 0.14 panel talking to a 0.15 agent sees no behaviour change', () => {
  // The v0.14.0 op table (OPS keys + HANDLED_OPS), taken from git tag v0.14.0.
  const OPS_014 = [
    'agent.ping', 'agent.stats', 'docker.build', 'docker.composeConfig', 'docker.composeDown', 'docker.composePs',
    'docker.composePull', 'docker.composeRestartPolicy', 'docker.composeUp', 'docker.inspect', 'docker.login',
    'docker.logout', 'docker.logs', 'docker.networkConnect', 'docker.networkCreate', 'docker.networkDisconnect',
    'docker.networkRm', 'docker.pull', 'docker.rm', 'docker.run', 'docker.runEnv', 'docker.start', 'docker.stop',
    'docker.volumeInspect', 'docker.volumeRm', 'file.deleteEnv', 'file.deleteWorkspace', 'file.writeEnv',
    'file.writeWorkspace', 'git.checkout', 'git.clone', 'git.ensure', 'git.fetch', 'git.reset', 'git.rev-parse',
    'proxy.ensure', 'proxy.writeConfig', 'workspace.remove',
  ];

  it('the op table is the 0.14 table plus terminal.open, nothing removed or renamed', () => {
    const now = [...new Set([...Object.keys(agent.agentMode.OPS), ...agent.agentMode.HANDLED_OPS])].sort();
    // Ops added after 0.14: terminal.open (0.15) and the multi-node registry
    // (agentOps/index.ts; snapshot OPS_015 in agentMultiNode.test.ts).
    const added = new Set(['terminal.open', ...agent.agentMode.AGENT_OPS.keys()]);
    expect(now.filter((op) => !added.has(op))).toEqual(OPS_014);
    expect(now).toContain('terminal.open');
  });

  it('an existing op answers the same shape on both transports', async () => {
    spawnMock.mockImplementation(async (_e: unknown, _a: unknown, onLine: unknown) => {
      (onLine as (l: string) => void)('stopping web-3');
      return 0;
    });
    const plain = await app.inject({ method: 'POST', url: '/agent/exec', headers: { 'x-agent-token': TOKEN }, payload: { op: 'docker.stop', params: { name: 'web-3' } } });
    expect(plain.json()).toEqual({ lines: ['stopping web-3'], exitCode: 0, envFile: null });
    const sealed = await sealedOp('docker.stop', { name: 'web-3' });
    expect(sealed).toMatchObject({ status: 200, lines: ['stopping web-3'], exitCode: 0 });
    expect(spawnMock).toHaveBeenCalledWith('docker', ['stop', '-t', '5', 'web-3'], expect.any(Function), {});
  });

  it("the ping still advertises every 0.14 capability first, so a 0.14 panel's checks pass unchanged", async () => {
    const info = parseAgentCapabilities((await sealedOp('agent.ping', {})).lines);
    expect([...info.caps].slice(0, 3)).toEqual(['build-path-guard', 'workspace.remove', 'git.credential']);
    const res = await app.inject({ method: 'GET', url: '/agent/ping' });
    expect(Object.keys(res.json())).toEqual(['ok', 'agent', 'sealed', 'version']);
  });

  it('an unknown op is still 400 unknown_op', async () => {
    expect((await sealedOp('terminal.attach', {})).error?.code).toBe('unknown_op');
  });
});

describe('D5 (node side): Traefik log rotation on the node proxy', () => {
  const runArgv = () => spawnMock.mock.calls.map((c) => c[1] as string[]).find((a) => a[0] === 'run')!;
  beforeEach(() => agent.resetNodeDockerLoggingDriverCache());

  it('json-file and local get max-size/max-file; other drivers or no answer keep the 0.14 argv', async () => {
    const work = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'nd-d5-'));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(work);
    try {
      for (const [driver, expected] of [
        ['json-file', ['--log-opt', 'max-size=20m', '--log-opt', 'max-file=3']],
        ['local', ['--log-opt', 'max-size=20m', '--log-opt', 'max-file=3']],
        ['journald', []],
        [null, []],
      ] as const) {
        agent.resetNodeDockerLoggingDriverCache();
        spawnMock.mockReset().mockImplementation(async (_e: unknown, argv: unknown, onLine: unknown) => {
          if ((argv as string[])[0] === 'info') {
            if (driver === null) return 1;
            (onLine as (l: string) => void)(driver);
          }
          return 0;
        });
        await agent.runOp('proxy.ensure', {}, () => undefined);
        const argv = runArgv();
        const tail = argv.slice(argv.findIndex((a) => a.endsWith(':/etc/traefik/acme.json')) + 1, -1);
        expect(tail).toEqual(expected);
        expect(argv.at(-1)).toBe('traefik:v3.1');
        // The probe runs before the live proxy is removed.
        const order = spawnMock.mock.calls.map((c) => (c[1] as string[])[0]);
        expect(order.indexOf('info')).toBeLessThan(order.indexOf('rm'));
      }
      // Cached once known.
      agent.resetNodeDockerLoggingDriverCache();
      spawnMock.mockReset().mockImplementation(async (_e: unknown, argv: unknown, onLine: unknown) => {
        if ((argv as string[])[0] === 'info') (onLine as (l: string) => void)('json-file');
        return 0;
      });
      await agent.runOp('proxy.ensure', {}, () => undefined);
      await agent.runOp('proxy.ensure', {}, () => undefined);
      expect(spawnMock.mock.calls.filter((c) => (c[1] as string[])[0] === 'info')).toHaveLength(1);
    } finally {
      cwd.mockRestore();
      (await import('node:fs')).rmSync(work, { recursive: true, force: true });
    }
  });

  it('nodeProxyLogOptArgs is the panel rule', () => {
    expect(agent.nodeProxyLogOptArgs('json-file')).toEqual(['--log-opt', 'max-size=20m', '--log-opt', 'max-file=3']);
    expect(agent.nodeProxyLogOptArgs('syslog')).toEqual([]);
    expect(agent.nodeProxyLogOptArgs(null)).toEqual([]);
  });
});
