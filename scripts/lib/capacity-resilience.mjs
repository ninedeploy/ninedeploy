import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';

export const faultProfiles = Object.freeze({
  'slow-node': Object.freeze({ delayMs: 750, deploymentWaitP95Ms: 45_000, recoveryMs: 8_000 }),
  'full-disk': Object.freeze({ startSecond: 19, holdMs: 8_000, recoveryMs: 12_000 }),
  'log-outage': Object.freeze({ minimumPendingLines: 400, recoveryMs: 120_000 }),
});

export function faultChecks(scenario, outcome) {
  const atMost = (key, limit) => ({ name: key, value: outcome[key], limit,
    passed: Number.isFinite(outcome[key]) && outcome[key] <= limit });
  const atLeast = (key, limit) => ({ name: key, value: outcome[key], limit, passed: outcome[key] >= limit });
  const match = (name, expected) => ({ name, value: outcome[name], limit: expected, passed: outcome[name] === expected });
  const options = faultProfiles[scenario];
  switch (scenario) {
    case 'slow-node':
      return [atLeast('delayedChunks', 1), atLeast('slowProbeMs', options.delayMs), atMost('recoveryMs', options.recoveryMs)];
    case 'full-disk':
      return [match('errno', 'ENOSPC'), match('fullFreeBytes', 0), match('writeRejected', true),
        match('noPartialWrite', true), match('writeRetried', true), atLeast('sqliteFullLines', 1),
        atLeast('observedHoldMs', options.holdMs - 50),
        atMost('recoveryMs', options.recoveryMs)];
    case 'log-outage':
      return [match('offlineConnectionRefused', true), match('deliveredBeforeRestore', 0),
        atLeast('pendingBeforeRestore', options.minimumPendingLines), atMost('recoveryMs', options.recoveryMs)];
    default:
      return [];
  }
}

export async function fullDiskProbe({ disk, call, inventory }, outcome) {
  const opted = faultProfiles['full-disk'];
  const name = 'Capacity disk pressure probe';
  const noProbe = async () => {
    const inventoryResult = await inventory();
    const rows = Array.isArray(inventoryResult) ? inventoryResult : inventoryResult.services;
    return rows.every(row => row.name !== name);
  };
  const fill = await disk('fill');
  const heldAt = performance.now();
  let response;
  outcome.disk = fill;
  outcome.errno = fill.errno;
  outcome.fullFreeBytes = fill.after.freeBytes;
  try {
    response = await call('create', name);
    outcome.writeStatus = response.status;
    outcome.writeRejected = response.status >= 500;
    outcome.noPartialWrite = await noProbe();
    await pause(Math.max(0, heldAt + opted.holdMs - performance.now()));
    outcome.observedHoldMs = performance.now() - heldAt;
  } finally {
    outcome.released = await disk('release');
  }
  if (!outcome.noPartialWrite) {
    if (response?.body?.id) await call('delete', response.body.id);
    return;
  }
  const resumedAt = performance.now();
  const retry = await call('create', name);
  const id = retry.body?.id;
  outcome.writeRetried = retry.status >= 200 && retry.status < 300 && Number.isSafeInteger(id) && !(await noProbe());
  if (outcome.writeRetried) {
    const removed = await call('delete', id);
    assert.ok(removed.status >= 200 && removed.status < 300 && await noProbe(), 'Could not remove the disposable write probe');
  }
  outcome.recoveryMs = performance.now() - resumedAt;
}
