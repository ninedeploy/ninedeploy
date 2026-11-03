import { expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { smokeNodeAutomaticSleep } from '../../../scripts/lib/smoke-node-automatic-sleep.mjs';
import { nodeSleepDiagnosticSource, projectSleepDiagnostic } from '../../../scripts/lib/smoke-node-sleep-diagnostic.mjs';

it('preserves the original failure and captures the automatic journal before fixture cleanup', async () => {
  const failure = new Error('idle acceptance failed');
  const snapshot = { available: true, journalPhase: 'restoring', reason: 'idle-decision-expired' };
  const docker = vi.fn(() => ({ out: JSON.stringify(snapshot) }));
  const save = vi.fn();
  await expect(smokeNodeAutomaticSleep({
    cleared: async () => { throw failure; }, docker, panel: 'owned-panel', id: 1, save,
  })).rejects.toBe(failure);
  expect(save).toHaveBeenCalledWith('automatic-sleep-failure.json', snapshot);
  expect(docker).toHaveBeenCalledTimes(1);
});

it.each(['docker', 'save'])('never masks the original failure when diagnostic %s fails', async boundary => {
  const failure = new Error('original');
  const save = vi.fn(() => { if (boundary === 'save') throw new Error('diagnostic storage'); });
  await expect(smokeNodeAutomaticSleep({
    cleared: async () => { throw failure; }, panel: 'owned-panel', id: 1, save,
    docker: () => { if (boundary === 'docker') throw new Error('private transport details'); return { out: '{}' }; },
  })).rejects.toBe(failure);
  if (boundary === 'docker') expect(save).toHaveBeenCalledWith('automatic-sleep-failure.json', { available: false });
});

it('retains only automatic journal phases and bounded timing, never error text or credentials', () => {
  const snapshot = projectSleepDiagnostic({ now: 50_000,
    service: { status: 'running', asleepAt: null, secret: 'service-secret' },
    journal: { action: 'sleep', phase: 'restoring', reason: 'Node sleep idle decision expired before Stop; secret=private-token',
      wakeToken: 'wake-secret', workerToken: 'worker-secret', fallbackRouting: true, leaseUntil: new Date(60_000),
      idleEvidence: { idleMs: 315_000, sampledAt: 15_000, sourceId: 'private-source' } },
  });
  expect(snapshot).toEqual({ available: true, observedAtMs: 50_000, serviceStatus: 'running', asleep: false,
    journalAction: 'sleep', journalPhase: 'restoring', reason: 'idle-decision-expired', fallbackRouting: true,
    idleObservedMs: 315_000, idleDecisionAgeMs: 35_000, idleDecisionClockRegressed: false, leaseRemainingMs: 10_000 });
  expect(JSON.stringify(snapshot)).not.toMatch(/secret|private|token|sourceId/i);
});

it('represents absent journals and refuses unknown state strings without exposing them', () => {
  expect(projectSleepDiagnostic({ now: 10, service: {}, journal: null })).toMatchObject({ journalPhase: null, idleDecisionAgeMs: null, reason: null });
  expect(projectSleepDiagnostic({ now: 10, service: { status: 'secret' }, journal: { action: 'secret', phase: 'secret', reason: 'secret', idleEvidence: { sampledAt: 20 } } }))
    .toMatchObject({ serviceStatus: 'unknown', journalAction: 'unknown', journalPhase: 'unknown', reason: 'other', idleDecisionAgeMs: 0, idleDecisionClockRegressed: true });
});

it('generates parseable hosted diagnostic code and rejects non-numeric fixture IDs', () => {
  const code = nodeSleepDiagnosticSource(1);
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: code, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  expect(result.status, result.stderr).toBe(0);
  expect(() => nodeSleepDiagnosticSource('1;private')).toThrow('Invalid diagnostic service');
});
