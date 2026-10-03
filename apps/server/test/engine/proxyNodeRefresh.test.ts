import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { servers } from '@ninedeploy/db';

/**
 * r521: `writeDynamicConfig` refreshes every node's proxy and used to swallow
 * every failure — including the node a deploy had just started a container
 * on, so the pipeline believed routing had flipped and stopped the previous
 * container there. The deploying node's failure now propagates; the rest of
 * the fleet stays best-effort, and its failures are audited instead of lost.
 */

const h = vi.hoisted(() => ({
  config: { paths: { dataDir: '' }, acmeEmail: null as string | null },
  syncAllNodeProxies: vi.fn(async (_db: unknown, ids: number[]) => ids.map((serverId) => ({ serverId, ok: true }))),
  audit: vi.fn(async () => undefined),
}));

vi.mock('../../src/config.js', () => ({ config: h.config }));
vi.mock('../../src/lib/exec.js', () => ({ capture: vi.fn(async () => ''), run: vi.fn(async () => undefined), sleep: vi.fn(async () => undefined) }));
vi.mock('../../src/lib/dockerPull.js', () => ({ ensureDockerImage: vi.fn(async () => undefined) }));
vi.mock('../../src/lib/nodeProxy.js', () => ({ syncAllNodeProxies: h.syncAllNodeProxies }));
vi.mock('../../src/lib/audit.js', () => ({ audit: h.audit }));

const base = mkdtempSync(path.join(os.tmpdir(), 'nd-proxy-nodes-'));
h.config.paths = { dataDir: base };
const { writeDynamicConfig } = await import('../../src/engine/proxy.js');

afterAll(() => rmSync(base, { recursive: true, force: true }));

/** Empty routing tables; `nodeIds` registered nodes. */
const makeDb = (nodeIds: number[]) => ({
  select: vi.fn(() => ({
    from: vi.fn((t: unknown) => {
      const rows = t === servers ? nodeIds.map((id) => ({ id })) : [];
      return Object.assign(Promise.resolve(rows), { where: async () => rows });
    }),
  })),
  query: { settings: { findFirst: async () => undefined } },
});

/** Node `failing` answers its sync with an error; every other node is fine. */
const syncFails = (failing: number[]) =>
  h.syncAllNodeProxies.mockImplementation(async (_db: unknown, ids: number[]) =>
    ids.map((serverId) =>
      failing.includes(serverId) ? { serverId, ok: false, reason: `agent #${serverId} unreachable` } : { serverId, ok: true },
    ),
  );

describe('writeDynamicConfig node refresh (r521)', () => {
  beforeEach(() => {
    h.syncAllNodeProxies.mockReset();
    h.audit.mockClear();
  });

  it("throws when the REQUIRED node's proxy could not be updated", async () => {
    syncFails([4]);
    await expect(writeDynamicConfig(makeDb([3, 4]) as never, { requireNode: 4 })).rejects.toThrow(
      /proxy on node #4 could not be updated: agent #4 unreachable/,
    );
    // The required node's failure fails the deploy; it is not double-reported
    // as a background refresh failure.
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('keeps every OTHER node best-effort — audited, never thrown', async () => {
    syncFails([3]);
    await expect(writeDynamicConfig(makeDb([3, 4]) as never, { requireNode: 4 })).resolves.toBeUndefined();
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), null, 'server.proxy_sync_failed', 'node #3', {
      serverId: 3,
      reason: 'agent #3 unreachable',
    });
    // Without a required node (a domain edit) nothing throws either, and the
    // same dead node is not re-audited inside the cooldown.
    await expect(writeDynamicConfig(makeDb([3, 4]) as never)).resolves.toBeUndefined();
    expect(h.audit).toHaveBeenCalledTimes(1);
  });

  it('throws when the required node is not registered, or the refresh cannot run at all', async () => {
    syncFails([]);
    await expect(writeDynamicConfig(makeDb([3]) as never, { requireNode: 9 })).rejects.toThrow(/node #9 is not registered/);
    h.syncAllNodeProxies.mockRejectedValueOnce(new Error('db locked'));
    await expect(writeDynamicConfig(makeDb([9]) as never, { requireNode: 9 })).rejects.toThrow(/node #9 could not be updated: db locked/);
    h.syncAllNodeProxies.mockRejectedValueOnce(new Error('db locked'));
    await expect(writeDynamicConfig(makeDb([9]) as never)).resolves.toBeUndefined();
  });
});
