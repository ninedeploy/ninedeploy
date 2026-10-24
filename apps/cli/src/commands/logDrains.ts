import type { NineDeployClient } from '../client.js';
import { error, info, success } from '../lib/format.js';

function drainId(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Drain ID must be a positive safe integer');
  return Number(value);
}

export async function logDrainQueueAction(client: NineDeployClient, id: string): Promise<void> {
  try {
    const status = await client.logDrains.queue(drainId(id));
    info('Pending: ' + status.pendingBatches + ' batch(es), ' + status.pendingEntries + ' entries, ' + status.payloadBytes + ' bytes');
    info('Blocked: ' + status.blockedBatches + ' batch(es); paused sources: ' + status.pausedSources);
    info('Oldest: ' + (status.oldestAt ?? 'none'));
  } catch (err) { error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; }
}

export async function logDrainRetryAction(client: NineDeployClient, id: string): Promise<void> {
  try {
    const status = await client.logDrains.retryQueue(drainId(id));
    success('Retry scheduled for the next delivery cycle; ' + status.pendingBatches + ' batch(es) remain queued');
  } catch (err) { error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; }
}

export async function logDrainDiscardAction(client: NineDeployClient, id: string, opts: { yes?: boolean }): Promise<void> {
  try {
    const parsedId = drainId(id);
    if (!opts.yes) throw new Error('Discard permanently deletes queued logs. Repeat with --yes to confirm.');
    const result = await client.logDrains.discardQueue(parsedId);
    success('Discarded ' + result.discardedBatches + ' queued batch(es)');
  } catch (err) { error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; }
}
