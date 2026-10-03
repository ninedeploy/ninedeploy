import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import kernelPlugin from '../../src/plugins/kernel.js';
import { createFakeDb } from '../helpers.js';

describe('Fastify Kernel Plugin', () => {
  it('decorates fastify with kernel, registers core drivers, boots on ready, and shuts down on close', async () => {
    const app = Fastify({ logger: false });
    const fakeDb = createFakeDb();
    app.decorate('db', fakeDb as any);

    await app.register(kernelPlugin);

    expect(app.kernel).toBeDefined();
    expect(app.kernel.registry.getCompute('docker-local')).toBeDefined();
    expect(app.kernel.registry.getProxy('traefik')).toBeDefined();
    expect(app.kernel.getPlugin('notifications-dispatcher')).toBeDefined();
    expect(app.kernel.getPlugin('cloudflare-tunnels')).toBeDefined();
    expect(app.kernel.getPlugin('telemetry-streamer')).toBeDefined();

    // Fastify route checking req.kernel
    app.get('/test-kernel', async (req) => {
      return { state: req.kernel.state, hasCompute: !!req.kernel.registry.getCompute('docker-local') };
    });

    await app.ready();
    expect(app.kernel.state).toBe('READY');

    const res = await app.inject({ method: 'GET', url: '/test-kernel' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: 'READY', hasCompute: true });

    await app.close();
    expect(app.kernel.state).toBe('TERMINATED');
  });

  // Wiring guard. The registry and S3 build caches shipped fully implemented
  // and fully unit-tested, but nothing ever called `registerBuildCache` for
  // them — so an operator who set `cache_name=s3` silently built against the
  // in-memory LRU. A unit test on the driver cannot catch that; only an
  // assertion on the mount can.
  it('registers all three build-cache backends so cache_name can name any of them', async () => {
    const app = Fastify({ logger: false });
    app.decorate('db', createFakeDb() as any);
    await app.register(kernelPlugin);

    expect(app.kernel.registry.listBuildCaches().map((c) => c.name).sort()).toEqual([
      'inline',
      'registry',
      's3',
    ]);
    expect(app.kernel.registry.getBuildCache('registry')).toBeDefined();
    expect(app.kernel.registry.getBuildCache('s3')).toBeDefined();

    await app.close();
  });

  // An unconfigured remote backend must behave as a cold cache, never as an
  // error: a build must not fail because its optional cache has no settings.
  it('leaves an unconfigured registry/s3 backend cold rather than throwing', async () => {
    const app = Fastify({ logger: false });
    app.decorate('db', createFakeDb() as any);
    await app.register(kernelPlugin);

    for (const name of ['registry', 's3']) {
      const cache = app.kernel.registry.getBuildCache(name)!;
      await expect(cache.lookup('ndbuild:deadbeef')).resolves.toBeNull();
      await expect(cache.store('ndbuild:deadbeef', Buffer.from('{}'))).rejects.toThrow(/no (registry|bucket) configured/);
    }

    await app.close();
  });

  // Exercises the credential SUPPLIERS the registration closes over. They are
  // the part that makes a panel-saved setting take effect without a restart,
  // so a test that only checks registration would leave them unproven.
  // Exercises the credential SUPPLIERS the registration closes over. They are
  // what makes a panel-saved setting take effect without a restart, so a test
  // that only checked registration would leave them unproven.
  it('reads registry connection settings lazily, so saving them needs no restart', async () => {
    // The driver captures `globalThis.fetch` at construction, so the stub has
    // to be in place before the kernel plugin builds it.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 404 }) as never);

    const app = Fastify({ logger: false });
    app.decorate('db', createFakeDb() as any);
    await app.register(kernelPlugin);
    const registry = app.kernel.registry.getBuildCache('registry')!;

    // Unconfigured: the supplier returns null and the driver never dials out.
    await expect(registry.lookup('ndbuild:a')).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    // Saving the URL takes effect on the very next call — no restart.
    await app.kernel.configCenter.set('plugin:build-cache:registry_url', 'https://registry.example.com');
    await expect(registry.lookup('ndbuild:a')).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('https://registry.example.com/v2/');

    fetchSpy.mockRestore();
    await app.close();
  });

  it('handles boot and shutdown error catches in hooks', async () => {
    const app = Fastify({ logger: false });
    const fakeDb = createFakeDb();
    app.decorate('db', fakeDb as any);

    await app.register(kernelPlugin);

    // Mock boot failure
    const bootSpy = vi.spyOn(app.kernel, 'boot').mockRejectedValueOnce(new Error('Boot boom'));
    const shutdownSpy = vi.spyOn(app.kernel, 'shutdown').mockRejectedValueOnce(new Error('Shutdown boom'));

    await expect(app.ready()).resolves.toBeDefined();
    await expect(app.close()).resolves.toBeUndefined();

    bootSpy.mockRestore();
    shutdownSpy.mockRestore();
  });

  it('skips setup if kernel is already decorated', async () => {
    const app = Fastify({ logger: false });
    const existingKernel = { state: 'READY' };
    app.decorate('kernel', existingKernel as any);

    await app.register(kernelPlugin);
    expect(app.kernel).toBe(existingKernel);
  });
});
