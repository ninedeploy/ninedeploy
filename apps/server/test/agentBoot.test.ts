import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  buildApp: vi.fn(),
  exitCalls: [] as number[],
  signalListeners: {} as Record<string, () => void>,
}));

vi.mock('../src/agentApp.js', () => ({ buildAgentApp: state.buildApp }));

interface FakeApp {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  log: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  register: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

function fakeApp(): FakeApp {
  return {
    listen: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    log: { info: vi.fn(), error: vi.fn() },
    register: vi.fn(async () => undefined),
    post: vi.fn(),
    get: vi.fn(),
  };
}

let _exitSpy: ReturnType<typeof vi.spyOn>;
let _onSpy: ReturnType<typeof vi.spyOn>;
let _logSpy: ReturnType<typeof vi.spyOn>;
let envAgent: string | undefined;
let envToken: string | undefined;
let envPort: string | undefined;
let envEgress: string | undefined;

// main() persists an auto-join token in its working directory (r176); keep
// that out of the source tree.
const agentCwd = mkdtempSync(path.join(os.tmpdir(), 'nd-agentboot-'));
const originalCwd = process.cwd();

beforeEach(() => {
  process.chdir(agentCwd);
  state.exitCalls = [];
  state.signalListeners = {};
  state.buildApp.mockReset();
  // The announce call targets 127.0.0.1 with a stubbed fetch; the egress
  // guard cannot see the stub and blocks the loopback address first.
  envEgress = process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
  process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'] = '1';
  _exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    state.exitCalls.push(code ?? 0);
    return undefined as never;
  }) as never);
  _onSpy = vi.spyOn(process, 'on').mockImplementation((((event: string, listener: () => void) => {
    state.signalListeners[event] = listener;
    return process;
  }) as never) as never);
  _logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  envAgent = process.env['NINEDEPLOY_AGENT'];
  envToken = process.env['NINEDEPLOY_AGENT_TOKEN'];
  envPort = process.env['NINEDEPLOY_AGENT_PORT'];
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  vi.resetModules();
  if (envAgent === undefined) delete process.env['NINEDEPLOY_AGENT'];
  else process.env['NINEDEPLOY_AGENT'] = envAgent;
  if (envToken === undefined) delete process.env['NINEDEPLOY_AGENT_TOKEN'];
  else process.env['NINEDEPLOY_AGENT_TOKEN'] = envToken;
  if (envPort === undefined) delete process.env['NINEDEPLOY_AGENT_PORT'];
  else process.env['NINEDEPLOY_AGENT_PORT'] = envPort;
  if (envEgress === undefined) delete process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
  else process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'] = envEgress;
});

async function importAgent() {
  vi.resetModules();
  process.env['NINEDEPLOY_AGENT'] = '1';
  const mod = await import('../src/agent.js');
  return mod;
}

describe('agent bootstrap', () => {
  it('exits without a token hash', async () => {
    delete process.env['NINEDEPLOY_AGENT_TOKEN'];
    // process.exit is mocked (doesn't halt), so main would continue — give it
    // a fake app to register against so the run stays clean.
    state.buildApp.mockResolvedValue(fakeApp());
    const mod = await importAgent();
    await vi.waitFor(() => expect(state.exitCalls).toContain(1));
    await mod.agentMode.main();
  });

  it('boots, listens on the agent port and shuts down on SIGTERM', async () => {
    process.env['NINEDEPLOY_AGENT_TOKEN'] = 'a'.repeat(64);
    process.env['NINEDEPLOY_AGENT_PORT'] = '4699';
    const app = fakeApp();
    state.buildApp.mockResolvedValue(app);
    const mod = await importAgent();
    await vi.waitFor(() => expect(app.listen).toHaveBeenCalledWith({ host: '0.0.0.0', port: 4699 }));
    expect(app.register).toHaveBeenCalledWith(expect.anything(), { tokenHash: 'a'.repeat(64) });
    expect(mod.agentMode.OPS).toBeDefined();

    // SIGTERM & SIGINT → graceful close.
    await state.signalListeners['SIGTERM']!();
    await vi.waitFor(() => expect(app.close).toHaveBeenCalled());
    await vi.waitFor(() => expect(state.exitCalls).toContain(0));

    await state.signalListeners['SIGINT']!();
    await vi.waitFor(() => expect(state.exitCalls.length).toBeGreaterThanOrEqual(2));
  });

  it('does not boot when the agent flag is absent', async () => {
    const app = fakeApp();
    state.buildApp.mockResolvedValue(app);
    vi.resetModules();
    delete process.env['NINEDEPLOY_AGENT'];
    const mod = await import('../src/agent.js');
    expect(app.listen).not.toHaveBeenCalled();
    expect(mod.agentMode.OPS).toBeDefined();
  });

  it('generates token and announces to master when NINEDEPLOY_MASTER_URL is present', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'pending', message: 'Announced' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    process.env['NINEDEPLOY_MASTER_URL'] = 'http://127.0.0.1:4000';
    process.env['NINEDEPLOY_NODE_NAME'] = 'edge-custom-name';
    process.env['NINEDEPLOY_ADVERTISE_HOST'] = '192.168.1.100';
    delete process.env['NINEDEPLOY_AGENT_TOKEN'];
    delete process.env['NINEDEPLOY_AGENT_RAW_TOKEN'];

    const app = fakeApp();
    state.buildApp.mockResolvedValue(app);
    await importAgent();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4000/v1/servers/announce',
      expect.objectContaining({
        method: 'POST',
        // The enrolment header and the abort-timeout signal ride along too.
        headers: expect.objectContaining({ 'content-type': 'application/json' }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.name).toBe('edge-custom-name');
    expect(body.host).toBe('192.168.1.100');
    expect(body.token).toHaveLength(64);

    delete process.env['NINEDEPLOY_MASTER_URL'];
    delete process.env['NINEDEPLOY_NODE_NAME'];
    delete process.env['NINEDEPLOY_ADVERTISE_HOST'];
    vi.unstubAllGlobals();
  });

  it('handles master announce HTTP error and network failure gracefully', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Error',
      })
      .mockRejectedValueOnce(new Error('connection refused'));
    vi.stubGlobal('fetch', fetchMock);

    process.env['NINEDEPLOY_MASTER_URL'] = 'http://127.0.0.1:4000';
    process.env['NINEDEPLOY_AGENT_TOKEN'] = 'b'.repeat(64);
    process.env['NINEDEPLOY_AGENT_RAW_TOKEN'] = 'b'.repeat(64);

    const app = fakeApp();
    state.buildApp.mockResolvedValue(app);
    await importAgent();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Second import with non-Error network failure and hostname fallback
    delete process.env['NINEDEPLOY_NODE_NAME'];
    fetchMock.mockRejectedValueOnce('raw string connection failure');
    const app2 = fakeApp();
    state.buildApp.mockResolvedValue(app2);
    await importAgent();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    delete process.env['NINEDEPLOY_MASTER_URL'];
    delete process.env['NINEDEPLOY_AGENT_TOKEN'];
    delete process.env['NINEDEPLOY_AGENT_RAW_TOKEN'];
    vi.unstubAllGlobals();
  });

  it('announceToMaster handles success, warnings, and errors directly', async () => {
    const { announceToMaster } = await import('../src/agent.js');

    // Success
    const fetchOk = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'pending', message: 'Announced' }),
    });
    vi.stubGlobal('fetch', fetchOk);
    await announceToMaster('http://master.local:4000', { name: 'n1', port: 4600, token: 'tok' });
    expect(fetchOk).toHaveBeenCalledTimes(1);

    // Warning / HTTP error
    const fetchWarn = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Invalid payload',
    });
    vi.stubGlobal('fetch', fetchWarn);
    await announceToMaster('http://master.local:4000', { name: 'n2', port: 4600, token: 'tok' });
    expect(fetchWarn).toHaveBeenCalledTimes(1);

    // Network Error
    const fetchErr = vi.fn().mockRejectedValue(new Error('dns lookup failed'));
    vi.stubGlobal('fetch', fetchErr);
    await announceToMaster('http://master.local:4000', { name: 'n3', port: 4600, token: 'tok' });
    expect(fetchErr).toHaveBeenCalledTimes(1);

    // Non-Error rejection
    const fetchStringErr = vi.fn().mockRejectedValue('raw socket error');
    vi.stubGlobal('fetch', fetchStringErr);
    await announceToMaster('http://master.local:4000', { name: 'n4', port: 4600, token: 'tok' });
    expect(fetchStringErr).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });
});
