import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const proxyMock = vi.hoisted(() => ({
  ensureNetwork: vi.fn(async (log: (line: string) => void) => {
    log('network ready');
  }),
  ensureTraefik: vi.fn(async (log: (line: string) => void) => {
    log('traefik ready');
  }),
  writeDynamicConfig: vi.fn(async () => undefined),
  getAcmeEmail: vi.fn(async () => null),
  getDnsConfig: vi.fn(async () => ({ provider: '', token: null, wildcardApex: null })),
}));

vi.mock('../../src/engine/proxy.js', () => proxyMock);

const traefikPlugin = (await import('../../src/plugins/traefik.js')).default;

async function buildApp(db: unknown) {
  const app = Fastify({ logger: false });
  app.decorate('db', db as never);
  await app.register(traefikPlugin);
  return app;
}

describe('traefik plugin', () => {
  it('ensures the network, proxy, and dynamic config on ready', async () => {
    proxyMock.ensureNetwork.mockClear();
    proxyMock.ensureTraefik.mockClear();
    proxyMock.writeDynamicConfig.mockClear();

    const db = { select: vi.fn() };
    const app = await buildApp(db);
    const infoSpy = vi.spyOn(app.log, 'info');

    await app.ready();

    expect(proxyMock.ensureNetwork).toHaveBeenCalledTimes(1);
    expect(proxyMock.ensureTraefik).toHaveBeenCalledTimes(1);
    expect(proxyMock.writeDynamicConfig).toHaveBeenCalledWith(db);
    // the plugin logs each infra step through fastify.log.info({component:'infra'}, line)
    expect(infoSpy).toHaveBeenCalledWith({ component: 'infra' }, expect.any(String));
    await app.close();
  });

  it('passes the resolved DNS config to ensureTraefik', async () => {
    proxyMock.getDnsConfig.mockResolvedValueOnce({ provider: 'cloudflare', token: 'tok', wildcardApex: 'example.com' });
    proxyMock.ensureTraefik.mockClear();

    const app = await buildApp({ select: vi.fn() });
    await app.ready();

    expect(proxyMock.ensureTraefik).toHaveBeenCalledWith(
      expect.any(Function),
      null,
      { provider: 'cloudflare', token: 'tok', wildcardApex: 'example.com' },
    );
    await app.close();
  });

  it('tolerates a failing DNS config read', async () => {
    proxyMock.getDnsConfig.mockRejectedValueOnce(new Error('no table'));
    proxyMock.ensureTraefik.mockClear();

    const app = await buildApp({ select: vi.fn() });
    await app.ready();

    expect(proxyMock.ensureTraefik).toHaveBeenCalledWith(expect.any(Function), null, null);
    await app.close();
  });

  it('passes the resolved ACME email to ensureTraefik', async () => {
    proxyMock.getAcmeEmail.mockResolvedValueOnce('ops@example.com');
    proxyMock.ensureTraefik.mockClear();

    const app = await buildApp({ select: vi.fn() });
    await app.ready();

    expect(proxyMock.ensureTraefik).toHaveBeenCalledWith(expect.any(Function), 'ops@example.com', { provider: '', token: null, wildcardApex: null });
    await app.close();
  });

  it('falls back to no ACME email when the settings read fails', async () => {
    proxyMock.getAcmeEmail.mockRejectedValueOnce(new Error('no table'));
    proxyMock.ensureTraefik.mockClear();

    const app = await buildApp({ select: vi.fn() });
    await app.ready();

    expect(proxyMock.ensureTraefik).toHaveBeenCalledWith(expect.any(Function), null, { provider: '', token: null, wildcardApex: null });
    await app.close();
  });

  it('logs an error when writeDynamicConfig fails', async () => {
    proxyMock.writeDynamicConfig.mockRejectedValueOnce(new Error('config boom'));

    const app = await buildApp({ select: vi.fn() });
    const errorSpy = vi.spyOn(app.log, 'error');

    await app.ready();

    expect(errorSpy).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'config boom' }) },
      'failed to write traefik dynamic config',
    );
    await app.close();
  });

  it('runs periodic self-healing watchdog and absorbs watchdog errors', async () => {
    vi.useFakeTimers();
    try {
      proxyMock.ensureTraefik.mockClear();
      const app = await buildApp({ select: vi.fn() });
      await app.ready();

      expect(proxyMock.ensureTraefik).toHaveBeenCalledTimes(1);

      // Advance 5 minutes for the watchdog timer tick
      proxyMock.ensureTraefik.mockRejectedValueOnce(new Error('docker dead'));
      const warnSpy = vi.spyOn(app.log, 'warn');
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(warnSpy).toHaveBeenCalledWith({ err: expect.any(Error) }, 'traefik watchdog check failed');

      // Next tick succeeds
      proxyMock.ensureTraefik.mockResolvedValueOnce(undefined as never);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(proxyMock.ensureTraefik).toHaveBeenCalledTimes(3);

      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });

  // r363: a boot while Docker was down leaves Traefik to the watchdog, which
  // only ever seeds an EMPTY route file — the routes must be rendered again
  // when the watchdog (re)starts Traefik, and not on every healthy tick.
  it('r363: rewrites the routes when the watchdog (re)starts Traefik, not on a healthy tick', async () => {
    vi.useFakeTimers();
    try {
      proxyMock.ensureTraefik.mockClear();
      proxyMock.writeDynamicConfig.mockClear();
      const db = { select: vi.fn() };
      const app = await buildApp(db);
      await app.ready();
      expect(proxyMock.writeDynamicConfig).toHaveBeenCalledTimes(1); // boot

      proxyMock.ensureTraefik.mockResolvedValueOnce(false as never); // already running
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(proxyMock.writeDynamicConfig).toHaveBeenCalledTimes(1);

      proxyMock.ensureTraefik.mockResolvedValueOnce(true as never); // watchdog started it
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(proxyMock.writeDynamicConfig).toHaveBeenCalledTimes(2);
      expect(proxyMock.writeDynamicConfig).toHaveBeenLastCalledWith(db);

      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
