/** Only bounded state/timing fields and fixed reason classes may leave the owned fixture. */
export function projectSleepDiagnostic({ service, journal, now }) {
  const integer = value => Number.isSafeInteger(value) ? value : null;
  const text = typeof journal?.reason === 'string' ? journal.reason : '';
  const reasons = [
    ['idle decision expired', 'idle-decision-expired'],
    ['catcher readiness', 'catcher-readiness'],
    ['restoration unavailable', 'restoration-unavailable'],
    ['application readiness', 'application-readiness'],
    ['routing', 'routing-unconfirmed'],
    ['authority', 'authority-or-lease-changed'],
    ['worker lease', 'authority-or-lease-changed'],
  ];
  const sampledAt = integer(journal?.idleEvidence?.sampledAt);
  const leaseUntil = journal?.leaseUntil instanceof Date ? integer(journal.leaseUntil.getTime()) : null;
  const phase = journal?.phase;
  return {
    available: true,
    observedAtMs: integer(now),
    serviceStatus: ['running', 'stopped', 'error', 'idle', 'deploying'].includes(service?.status) ? service.status : 'unknown',
    asleep: service?.asleepAt != null,
    journalAction: journal ? ['sleep', 'wake'].includes(journal.action) ? journal.action : 'unknown' : null,
    journalPhase: journal ? ['accepted', 'fencing', 'prepared', 'routing', 'routed', 'stopping', 'asleep', 'restoring', 'starting', 'readiness', 'publishing', 'completed', 'superseded'].includes(phase) ? phase : 'unknown' : null,
    reason: text ? reasons.find(([match]) => text.toLowerCase().includes(match))?.[1] ?? 'other' : null,
    fallbackRouting: journal?.fallbackRouting === true,
    idleObservedMs: integer(journal?.idleEvidence?.idleMs),
    idleDecisionAgeMs: sampledAt !== null && integer(now) !== null ? integer(Math.max(0, now - sampledAt)) : null,
    idleDecisionClockRegressed: sampledAt !== null && integer(now) !== null && now < sampledAt,
    leaseRemainingMs: leaseUntil !== null && integer(now) !== null ? integer(leaseUntil - now) : null,
  };
}

/** Read the automatic journal, not the separate manual lifecycle intent. No runtime effects. */
export function nodeSleepDiagnosticSource(id) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid diagnostic service');
  return `import assert from 'node:assert/strict';
import { createDb, services, nodeSleepTransitions, eq } from '/app/packages/db/dist/index.js';
import { config } from '/app/apps/server/dist/config.js';
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.match(process.env.DOCKER_HOST ?? '', new RegExp('^tcp://' + 'nd-node-canary-paneldocker-[a-f0-9]+:2375$'));
const c = createDb({ url: config.dbUrl });
try {
  await c.ready;
  const service = await c.db.query.services.findFirst({ where: eq(services.id, ${id}), columns: { status: true, asleepAt: true } });
  const journal = await c.db.query.nodeSleepTransitions.findFirst({ where: eq(nodeSleepTransitions.serviceId, ${id}), columns: { action: true, phase: true, reason: true, idleEvidence: true, leaseUntil: true, fallbackRouting: true } });
  const project = ${projectSleepDiagnostic.toString()};
  console.log(JSON.stringify(project({ service, journal, now: Date.now() })));
} finally { c.client?.close(); }`;
}

export function captureNodeSleepDiagnostic({ docker, panel, id }) {
  const result = docker(['exec', '-e', 'GITHUB_ACTIONS=true', panel, 'node', '--input-type=module', '-e', nodeSleepDiagnosticSource(id)], { timeout: 10_000, maxBuffer: 16 * 1024 });
  return JSON.parse(result.out);
}
