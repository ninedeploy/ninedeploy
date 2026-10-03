import { describe, expect, it, vi } from 'vitest';
import { orchestratorsRoutes } from '../../src/modules/orchestrators.js';
import { asUser, buildTestApp } from '../helpers.js';

describe('orchestrators routes', () => {
  it('lists every registered orchestrator with its stack names', async () => {
    const app = await buildTestApp();
    await app.register(orchestratorsRoutes);
    // Replace the real registry with a fake that returns two drivers
    // and pre-canned `listStacks()` results. The route treats the
    // shape as opaque, so any promise-resolving array is enough.
    const local = { name: 'local', listStacks: vi.fn().mockResolvedValue(['web', 'api']) };
    const swarm = { name: 'swarm', listStacks: vi.fn().mockResolvedValue([]) };
    (app as unknown as { kernel: { registry: { listOrchestrators: () => unknown[]; getOrchestrator: (n: string) => unknown } } }).kernel.registry.listOrchestrators = () => [local, swarm];
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      orchestrators: [
        { name: 'local', stacks: ['web', 'api'] },
        { name: 'swarm', stacks: [] },
      ],
    });
    expect(local.listStacks).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('returns an empty array when no orchestrators are registered', async () => {
    const app = await buildTestApp();
    await app.register(orchestratorsRoutes);
    (app as unknown as { kernel: { registry: { listOrchestrators: () => unknown[] } } }).kernel.registry.listOrchestrators = () => [];
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.json()).toEqual({ orchestrators: [] });
    await app.close();
  });

  it('lists the stacks of one orchestrator on the plural path', async () => {
    const app = await buildTestApp();
    await app.register(orchestratorsRoutes);
    const driver = {
      listStacks: vi.fn().mockResolvedValue([{ name: 'web', serviceCount: 3 }]),
      getStackStatus: vi.fn(),
    };
    (app as unknown as { kernel: { registry: { getOrchestrator: (n: string) => unknown } } }).kernel.registry.getOrchestrator = (n: string) =>
      n === 'swarm' ? driver : undefined;

    const res = await app.inject({ method: 'GET', url: '/swarm/stacks', headers: asUser() });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stacks: [{ name: 'web', serviceCount: 3 }] });
    // The plural path must not be a disguised single-stack probe.
    expect(driver.getStackStatus).not.toHaveBeenCalled();
    await app.close();
  });

  /**
   * r036. The status route used to be `GET /:name/stacks` and passed the
   * ORCHESTRATOR name straight into `getStackStatus()` as the STACK name, so
   * it could only ever ask for a stack coincidentally named after its own
   * orchestrator and returned null for every real one. The previous test suite
   * PINNED that ("passes the orchestrator name as the stack name") instead of
   * fixing it. The stack now has its own path segment.
   */
  it('asks the orchestrator for the stack named in the path, not for itself', async () => {
    const app = await buildTestApp();
    await app.register(orchestratorsRoutes);
    const driver = {
      listStacks: vi.fn().mockResolvedValue([]),
      getStackStatus: vi.fn().mockResolvedValue({
        name: 'web',
        services: [{ name: 'web', replicas: 3, ready: 3 }],
        appliedAt: '2026-01-01T00:00:00.000Z',
      }),
    };
    (app as unknown as { kernel: { registry: { getOrchestrator: (n: string) => unknown } } }).kernel.registry.getOrchestrator = (n: string) =>
      n === 'swarm' ? driver : undefined;

    const res = await app.inject({ method: 'GET', url: '/swarm/stacks/web', headers: asUser() });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: 'web',
      services: [{ name: 'web', replicas: 3, ready: 3 }],
      appliedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(driver.getStackStatus).toHaveBeenCalledWith('web');
    await app.close();
  });

  it('answers null for a stack the orchestrator has no record of', async () => {
    const app = await buildTestApp();
    await app.register(orchestratorsRoutes);
    const driver = { listStacks: vi.fn().mockResolvedValue([]), getStackStatus: vi.fn().mockResolvedValue(null) };
    (app as unknown as { kernel: { registry: { getOrchestrator: () => unknown } } }).kernel.registry.getOrchestrator = () => driver;

    const res = await app.inject({ method: 'GET', url: '/swarm/stacks/missing', headers: asUser() });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
    expect(driver.getStackStatus).toHaveBeenCalledWith('missing');
    await app.close();
  });

  it('r422: answers a uniform 404 when the named orchestrator is not registered', async () => {
    const app = await buildTestApp();
    await app.register(orchestratorsRoutes);
    (app as unknown as { kernel: { registry: { getOrchestrator: () => undefined } } }).kernel.registry.getOrchestrator = () => undefined;

    for (const url of ['/unknown/stacks', '/unknown/stacks/web']) {
      const res = await app.inject({ method: 'GET', url, headers: asUser() });
      // The old 200-with-{error} shape typed as the success payload crashed
      // typed callers (r361's uniform-404 treatment, belatedly applied here).
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toContain('is not registered');
    }
    await app.close();
  });

  it('rejects unauthenticated callers on the list endpoint', async () => {
    const app = await buildTestApp();
    await app.register(orchestratorsRoutes);
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('is operator-gated: a member cannot trigger host docker reads (403)', async () => {
    // Both endpoints execute host Docker daemon commands through the drivers
    // (`docker stack ls` / `docker service ls` / `docker compose ps`) — the
    // same host-privilege boundary as the exec terminal.
    const app = await buildTestApp();
    await app.register(orchestratorsRoutes);
    const driver = { getStackStatus: vi.fn().mockResolvedValue(null) };
    (app as unknown as { kernel: { registry: { getOrchestrator: () => unknown } } }).kernel.registry.getOrchestrator = () => driver;
    const res = await app.inject({
      method: 'GET',
      url: '/swarm/stacks',
      headers: asUser({ id: 7, isOperator: false }),
    });
    expect(res.statusCode).toBe(403);
    expect(driver.getStackStatus).not.toHaveBeenCalled();
    await app.close();
  });
});
