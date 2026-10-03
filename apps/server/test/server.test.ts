import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const serverState = vi.hoisted(() => ({
  buildApp: vi.fn(),
  config: { host: '127.0.0.1', port: 4321 },
  exitCalls: [] as number[],
  signalListeners: {} as Record<string, () => void>,
}));

vi.mock('../src/app.js', () => ({ buildApp: serverState.buildApp }));
vi.mock('../src/config.js', () => ({ config: serverState.config }));

interface FakeApp {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  log: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  addHook: ReturnType<typeof vi.fn>;
}

function fakeApp(overrides: Partial<FakeApp> = {}): FakeApp {
  const hooks: Array<() => Promise<void>> = [];
  const app: FakeApp = {
    listen: vi.fn(async () => '0.0.0.0:3000'),
    close: vi.fn(async () => {
      for (const hook of hooks) await hook();
    }),
    log: { info: vi.fn(), error: vi.fn() },
    addHook: vi.fn((_name: string, fn: () => Promise<void>) => {
      hooks.push(fn);
    }),
    ...overrides,
  };
  return app;
}

let _exitSpy: ReturnType<typeof vi.spyOn>;
let onSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  serverState.exitCalls = [];
  serverState.signalListeners = {};
  serverState.buildApp.mockReset();
  _exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    serverState.exitCalls.push(code ?? 0);
    return undefined as never;
  }) as never);
  onSpy = vi.spyOn(process, 'on').mockImplementation((((event: string, listener: () => void) => {
    serverState.signalListeners[event] = listener;
    return process;
  }) as never) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function importServer() {
  vi.resetModules();
  await import('../src/server.js');
}

describe('server bootstrap', () => {
  it('builds the app, listens, and shuts down cleanly on SIGINT', async () => {
    const app = fakeApp();
    serverState.buildApp.mockResolvedValue(app);

    await importServer();
    await vi.waitFor(() => expect(app.listen).toHaveBeenCalled());

    expect(serverState.buildApp).toHaveBeenCalledTimes(1);
    expect(app.listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 4321 });
    expect(app.log.info).toHaveBeenCalledWith('NineDeploy API listening on http://127.0.0.1:4321');
    expect(app.addHook).toHaveBeenCalledWith('onClose', expect.any(Function));

    // Trigger the SIGINT handler; close() runs the registered onClose hook.
    serverState.signalListeners['SIGINT']!();
    await vi.waitFor(() => expect(app.close).toHaveBeenCalled());
    expect(app.log.info).toHaveBeenCalledWith({ signal: 'SIGINT' }, 'received signal, closing');
    expect(app.log.info).toHaveBeenCalledWith('NineDeploy shutting down');
    await vi.waitFor(() => expect(serverState.exitCalls).toContain(0));
  });

  it('shuts down cleanly on SIGTERM too', async () => {
    const app = fakeApp();
    serverState.buildApp.mockResolvedValue(app);

    await importServer();
    await vi.waitFor(() => expect(app.listen).toHaveBeenCalled());

    serverState.signalListeners['SIGTERM']!();
    await vi.waitFor(() => expect(serverState.exitCalls).toContain(0));
    expect(app.log.info).toHaveBeenCalledWith({ signal: 'SIGTERM' }, 'received signal, closing');
  });

  it('exits with code 1 when listen fails', async () => {
    const app = fakeApp({
      listen: vi.fn(async () => {
        throw new Error('EADDRINUSE');
      }),
    });
    serverState.buildApp.mockResolvedValue(app);

    await importServer();
    await vi.waitFor(() => expect(serverState.exitCalls).toContain(1));
    expect(app.log.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'EADDRINUSE' }));
  });

  it('registers SIGINT and SIGTERM handlers after a successful boot', async () => {
    const app = fakeApp();
    serverState.buildApp.mockResolvedValue(app);

    await importServer();
    await vi.waitFor(() => expect(app.listen).toHaveBeenCalled());

    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(serverState.signalListeners['SIGINT']).toBeTypeOf('function');
    expect(serverState.signalListeners['SIGTERM']).toBeTypeOf('function');
  });
});
