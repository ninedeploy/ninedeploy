import { createHash } from 'node:crypto';
import { containerLifecycleReply, containerLifecycleRequest, containerRetireSetReply, containerRetireSetRequest, containerStopSetReply, containerStopSetRequest, type ContainerRetireSetReply, type ContainerStopSetReply } from '@ninedeploy/schemas';
import { z } from 'zod';
import { withNodeServiceJournal } from './nodeLifecycle.js';

const request = z.object({
  serviceId: z.number().int().positive().safe(),
  requestId: z.string().regex(/^[a-f0-9]{32}$/),
  revision: z.number().int().positive().safe(),
  deploymentWatermark: z.number().int().positive().safe(),
  timeoutMs: z.number().int().min(1).max(595_000),
}).strict();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Atomically hand a completed modern Stop back to the deployment-ID-fenced protocol. */
export async function handoffStoppedNodeToLegacy(root: string, params: unknown) {
  const input = request.parse(params);
  await withNodeServiceJournal(root, input.serviceId, input.timeoutMs, journal => journal.write(async () => {
    const db = journal.database;
    const mode = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_protocol'").get()
      ? db.prepare('SELECT version FROM runtime_protocol WHERE id=1').get() : undefined;
    const handoffTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_runtime_handoff'").get();
    const saved = handoffTable ? db.prepare('SELECT request_id,revision,watermark FROM legacy_runtime_handoff WHERE id=1').get() : undefined;
    if (mode?.version === 2) {
      if (saved?.request_id !== input.requestId || saved.revision !== input.revision || saved.watermark !== input.deploymentWatermark) {
        throw new Error('Legacy runtime handoff conflicts with the recorded owner');
      }
      const current = db.prepare('SELECT revision,request_hash,intent,receipt FROM lifecycle_head WHERE id=1').get();
      const fence = db.prepare('SELECT deployment_id FROM legacy_create_fence WHERE id=1').get();
      if (!current || current.revision !== input.revision || typeof current.intent !== 'string' || typeof current.receipt !== 'string' ||
        digest(current.intent) !== current.request_hash || !fence || !Number.isSafeInteger(fence.deployment_id) || Number(fence.deployment_id) < input.deploymentWatermark) {
        throw new Error('Legacy runtime handoff is stale or unconfirmed');
      }
      const prior = containerLifecycleRequest.parse({ ...JSON.parse(current.intent), timeoutMs: 1 });
      const priorReceipt = containerLifecycleReply.parse(JSON.parse(current.receipt));
      if (prior.requestId !== input.requestId || prior.serviceId !== input.serviceId || prior.revision !== input.revision ||
        prior.deploymentId !== input.deploymentWatermark || prior.action !== 'stop' || prior.targets.length !== 0 ||
        priorReceipt.requestId !== prior.requestId || priorReceipt.serviceId !== prior.serviceId || priorReceipt.revision !== prior.revision ||
        priorReceipt.deploymentId !== prior.deploymentId || priorReceipt.action !== 'stop' || priorReceipt.items.length !== 0) {
        throw new Error('Legacy runtime handoff is stale or unconfirmed');
      }
      return;
    }
    if (mode?.version !== 1) throw new Error('Modern Stop protocol is unavailable');
    const head = db.prepare('SELECT revision,request_hash,intent,receipt FROM lifecycle_head WHERE id=1').get();
    if (!head || head.revision !== input.revision || typeof head.intent !== 'string' || typeof head.receipt !== 'string' || digest(head.intent) !== head.request_hash) {
      throw new Error('Modern Stop ownership is stale or unconfirmed');
    }
    const parsed = JSON.parse(head.intent) as Record<string, unknown>;
    const { kind, ...recorded } = parsed;
    if (kind !== 'stop' && kind !== 'retire') throw new Error('Modern Stop ownership is stale or unconfirmed');
    const stop = containerStopSetRequest.parse({ ...recorded, timeoutMs: 1 });
    const receipt = kind === 'stop' ? containerStopSetReply.parse(JSON.parse(head.receipt)) : containerRetireSetReply.parse(JSON.parse(head.receipt));
    if (stop.serviceId !== input.serviceId || stop.requestId !== input.requestId || stop.revision !== input.revision ||
      receipt.serviceId !== stop.serviceId || receipt.requestId !== stop.requestId || receipt.revision !== stop.revision ||
      receipt.items.length !== stop.targets.length || stop.targets.some(target => target.deploymentId > input.deploymentWatermark ||
        !receipt.items.some(item => item.id === target.id && item.name === target.name && item.deploymentId === target.deploymentId &&
          ('running' in item ? item.running === false : item.removed === true)))) {
      throw new Error('Modern Stop receipt or watermark is unconfirmed');
    }
    const legacy = containerLifecycleRequest.parse({ requestId: input.requestId, serviceId: input.serviceId,
      deploymentId: input.deploymentWatermark, revision: input.revision, action: 'stop', targets: [], timeoutMs: 1 });
    const { timeoutMs: _timeout, ...intent } = legacy;
    const payload = JSON.stringify(intent);
    const proof = containerLifecycleReply.parse({ requestId: input.requestId, serviceId: input.serviceId,
      deploymentId: input.deploymentWatermark, revision: input.revision, action: 'stop', complete: true, items: [] });
    db.exec('CREATE TABLE IF NOT EXISTS legacy_create_fence (id INTEGER PRIMARY KEY CHECK(id=1), deployment_id INTEGER NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS legacy_runtime_handoff (id INTEGER PRIMARY KEY CHECK(id=1), request_id TEXT NOT NULL, revision INTEGER NOT NULL, watermark INTEGER NOT NULL, stop_intent TEXT NOT NULL, stop_receipt TEXT NOT NULL)');
    db.prepare('INSERT INTO legacy_create_fence(id,deployment_id) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET deployment_id=MAX(deployment_id,excluded.deployment_id)').run(input.deploymentWatermark);
    db.prepare('INSERT INTO legacy_runtime_handoff(id,request_id,revision,watermark,stop_intent,stop_receipt) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET request_id=excluded.request_id,revision=excluded.revision,watermark=excluded.watermark,stop_intent=excluded.stop_intent,stop_receipt=excluded.stop_receipt').run(input.requestId, input.revision, input.deploymentWatermark, head.intent, head.receipt);
    db.prepare('UPDATE lifecycle_head SET request_hash=?,intent=?,receipt=? WHERE id=1 AND revision=?').run(digest(payload), payload, JSON.stringify(proof), input.revision);
    db.prepare('UPDATE runtime_protocol SET version=2 WHERE id=1 AND version=1').run();
  }));
  return { requestId: input.requestId, serviceId: input.serviceId, revision: input.revision,
    deploymentWatermark: input.deploymentWatermark, complete: true as const };
}

/** Replay a retirement receipt after its ownership has been handed back to legacy creation. */
export async function replayHandedOffRetirement(root: string, input: z.infer<typeof containerRetireSetRequest>): Promise<ContainerRetireSetReply | null> {
  return withNodeServiceJournal(root, input.serviceId, input.timeoutMs, journal => journal.write(async () => {
    const db = journal.database;
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_protocol'").get();
    const mode = table ? db.prepare('SELECT version FROM runtime_protocol WHERE id=1').get() : undefined;
    if (mode?.version !== 2) return null;
    const saved = db.prepare('SELECT request_id,revision,stop_intent,stop_receipt FROM legacy_runtime_handoff WHERE id=1').get();
    const current = db.prepare('SELECT revision FROM lifecycle_head WHERE id=1').get();
    const { timeoutMs: _timeout, ...intent } = input;
    if (!saved || saved.request_id !== input.requestId || saved.revision !== input.revision || current?.revision !== input.revision ||
      saved.stop_intent !== JSON.stringify({ kind: 'retire', ...intent }) || typeof saved.stop_receipt !== 'string') {
      throw new Error('Handed-off retirement is stale or its request changed');
    }
    const receipt = containerRetireSetReply.parse(JSON.parse(saved.stop_receipt));
    if (receipt.requestId !== input.requestId || receipt.serviceId !== input.serviceId || receipt.revision !== input.revision ||
      receipt.items.length !== input.targets.length || input.targets.some(target => !receipt.items.some(item =>
        item.id === target.id && item.name === target.name && item.deploymentId === target.deploymentId && item.removed))) {
      throw new Error('Handed-off retirement receipt changed');
    }
    return receipt;
  }));
}

/** A lost handoff reply must not make the recorded Stop unrecoverable. */
export async function replayHandedOffStop(root: string, input: z.infer<typeof containerStopSetRequest>): Promise<ContainerStopSetReply | null> {
  return withNodeServiceJournal(root, input.serviceId, input.timeoutMs, journal => journal.write(async () => {
    const db = journal.database;
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_protocol'").get();
    const mode = table ? db.prepare('SELECT version FROM runtime_protocol WHERE id=1').get() : undefined;
    if (mode?.version !== 2) return null;
    const saved = db.prepare('SELECT request_id,revision,stop_intent,stop_receipt FROM legacy_runtime_handoff WHERE id=1').get();
    const current = db.prepare('SELECT revision FROM lifecycle_head WHERE id=1').get();
    const { timeoutMs: _timeout, ...intent } = input;
    if (!saved || saved.request_id !== input.requestId || saved.revision !== input.revision || current?.revision !== input.revision ||
      saved.stop_intent !== JSON.stringify({ kind: 'stop', ...intent }) || typeof saved.stop_receipt !== 'string') {
      throw new Error('Handed-off Stop is stale or its request changed');
    }
    const receipt = containerStopSetReply.parse(JSON.parse(saved.stop_receipt));
    if (receipt.requestId !== input.requestId || receipt.serviceId !== input.serviceId || receipt.revision !== input.revision ||
      receipt.items.length !== input.targets.length || input.targets.some(target => !receipt.items.some(item =>
        item.id === target.id && item.name === target.name && item.deploymentId === target.deploymentId && !item.running))) {
      throw new Error('Handed-off Stop receipt changed');
    }
    return receipt;
  }));
}
