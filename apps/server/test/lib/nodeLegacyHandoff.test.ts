import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeLifecycle, runNodeCreation } from '../../src/lib/nodeLifecycle.js';
import { handoffStoppedNodeToLegacy } from '../../src/lib/nodeLegacyHandoff.js';
import { createNodeRuntimeMutation } from '../../src/lib/nodeRuntimeMutation.js';

let root: string;
const id = (number: number) => number.toString(16).padStart(32, '0');
const stop = { requestId: id(9), serviceId: 7, revision: 9, timeoutMs: 5000, graceSeconds: 5, targets: [] };
const handoff = { requestId: stop.requestId, serviceId: 7, revision: stop.revision, timeoutMs: 5000, deploymentWatermark: 10 };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'nd-legacy-handoff-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('modern Stop to legacy deployment handoff', () => {
  it('permits only a newer deployment and rejects delayed modern operations after an idempotent handoff', async () => {
    const runtime = createNodeRuntimeMutation(root);
    await runtime.fence({ requestId: id(8), serviceId: 7, revision: 8, timeoutMs: 5000 });
    const receipt = await runtime.stop(stop);
    await handoffStoppedNodeToLegacy(root, handoff);
    await handoffStoppedNodeToLegacy(root, handoff);
    expect(await runtime.stop(stop)).toEqual(receipt);
    await expect(runtime.stop({ ...stop, graceSeconds: 4 })).rejects.toThrow(/request changed/);
    const effect = vi.fn(async () => 'created');
    await expect(runNodeCreation(root, 7, effect, 10)).rejects.toThrow(/stale|fenced/);
    expect(effect).not.toHaveBeenCalled();
    await expect(runNodeCreation(root, 7, effect, 11)).resolves.toBe('created');
    await expect(runtime.fence({ requestId: id(10), serviceId: 7, revision: 10, timeoutMs: 5000 })).rejects.toThrow(/watermark|stale/);
    await expect(handoffStoppedNodeToLegacy(root, { ...handoff, deploymentWatermark: 11 })).rejects.toThrow(/conflicts/);
  });

  it.each(['wrong-owner', 'missing-receipt', 'tampered-intent'] as const)('refuses %s without enabling legacy creation', async failure => {
    const runtime = createNodeRuntimeMutation(root);
    await runtime.stop(stop);
    const db = new DatabaseSync(join(root, 'service-7.sqlite'));
    try {
      if (failure === 'missing-receipt') db.exec('UPDATE lifecycle_head SET receipt=NULL');
      if (failure === 'tampered-intent') db.exec("UPDATE lifecycle_head SET intent='{}'");
    } finally { db.close(); }
    await expect(handoffStoppedNodeToLegacy(root, failure === 'wrong-owner' ? { ...handoff, requestId: id(99) } : handoff)).rejects.toThrow();
    await expect(runNodeCreation(root, 7, async () => 'created', 11)).rejects.toThrow(/fenced/);
  });

  it('does not replay a handoff over a newer lifecycle owner', async () => {
    await createNodeRuntimeMutation(root).stop(stop);
    await handoffStoppedNodeToLegacy(root, handoff);
    await createNodeLifecycle(root).apply({ requestId: id(10), serviceId: 7, revision: 10, deploymentId: 11, action: 'stop', targets: [], timeoutMs: 5000 });
    await expect(handoffStoppedNodeToLegacy(root, handoff)).rejects.toThrow(/stale/);
    await expect(runNodeCreation(root, 7, async () => 'created', 11)).rejects.toThrow(/stale|fenced/);
  });

  it('admits a newer Stop but rejects an old watermark even if the earlier create failed', async () => {
    const runtime = createNodeRuntimeMutation(root);
    await runtime.stop(stop);
    await handoffStoppedNodeToLegacy(root, handoff);
    await expect(runNodeCreation(root, 7, async () => { throw new Error('docker reply lost'); }, 11)).rejects.toThrow('docker reply lost');
    const newerFence = { requestId: id(10), serviceId: 7, revision: 10, timeoutMs: 5000 };
    await expect(runtime.fence({ ...newerFence, deploymentWatermark: 10 })).rejects.toThrow(/watermark|stale/);
    await expect(runtime.fence({ ...newerFence, deploymentWatermark: 11 })).resolves.toMatchObject({ complete: true });
    const nextStop = { ...stop, requestId: id(11), revision: 11 };
    await runtime.stop(nextStop);
    await handoffStoppedNodeToLegacy(root, { ...handoff, requestId: nextStop.requestId, revision: nextStop.revision, deploymentWatermark: 11 });
    await expect(runNodeCreation(root, 7, async () => 'created', 11)).rejects.toThrow(/stale|fenced/);
    await expect(runNodeCreation(root, 7, async () => 'created', 12)).resolves.toBe('created');
    await expect(runNodeCreation(root, 7, async () => 'obsolete', 11)).rejects.toThrow(/stale|fenced/);
  });

  it('fails closed if handoff evidence or watermark is damaged', async () => {
    await createNodeRuntimeMutation(root).stop(stop);
    await handoffStoppedNodeToLegacy(root, handoff);
    const db = new DatabaseSync(join(root, 'service-7.sqlite'));
    try { db.exec('UPDATE legacy_create_fence SET deployment_id=1'); } finally { db.close(); }
    await expect(handoffStoppedNodeToLegacy(root, handoff)).rejects.toThrow(/unconfirmed/);
    await expect(runNodeCreation(root, 7, async () => 'created', 11)).rejects.toThrow(/unconfirmed/);
  });
});
