import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prompts = vi.hoisted(() => ({ answer: '' }));
vi.mock('../src/prompts.js', () => ({ prompt: vi.fn(async () => prompts.answer) }));

import { pitrBaseBackup, pitrDisable, pitrEnable, pitrRecover, pitrRecoveries, pitrStatus } from '../src/commands/pitr.js';

const status = {
  databaseId: 4, available: true, unavailableReason: null, enabled: true, retentionDays: 7,
  lastBaseBackupAt: '2026-11-05T09:02:30.000Z', lastError: 'The last base backup failed; see the panel log.',
  baseBackupRunning: true, recoveryRunning: false,
  archiving: { failing: false, archivedCount: 12, lastArchivedAt: '2026-11-05T09:04:00.000Z', failedCount: 0, lastFailedAt: null },
  recoverable: [{ from: '2026-11-05T09:02:30.000Z', to: '2026-11-05T09:04:00.000Z' }],
  baseBackups: [{ label: 'nd-20261105T090200000Z', startedAt: '2026-11-05T09:02:00.000Z', finishedAt: '2026-11-05T09:02:30.000Z', sizeBytes: 4_184_641 }],
  archiveBytes: 81_000, segmentCount: 2,
};
const recovery = (over: Record<string, unknown> = {}) => ({
  id: 5, sourceDatabaseId: 4, databaseId: 9, targetTime: null, status: 'completed', error: null, baseBackup: 'nd-20261105T090200000Z',
  recoveredTo: '2026-11-05 09:03:10+00', restoreMs: 1234, startedAt: '2026-11-05T10:00:00.000Z', completedAt: '2026-11-05T10:00:02.000Z', ...over,
});

function client(over: Record<string, unknown> = {}) {
  const pitr = {
    get: vi.fn(async () => status),
    set: vi.fn(async (_id: number, input: { enabled: boolean; retentionDays?: number }) => ({ ...status, enabled: input.enabled, retentionDays: input.retentionDays ?? 7 })),
    baseBackup: vi.fn(async () => ({ started: true })),
    recover: vi.fn(async () => ({ recoveryId: 5, databaseId: 9 })),
    recoveries: vi.fn(async () => [recovery(), recovery({ id: 6, status: 'failed', databaseId: null, error: 'Nothing archived.', targetTime: '2026-11-05T09:00:00.000Z', recoveredTo: null, restoreMs: null })]),
    recovery: vi.fn(async () => recovery()),
    ...over,
  };
  return { pitr, client: { databases: { pitr } } as never };
}

let out: string[];
beforeEach(() => {
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  process.exitCode = 0;
  prompts.answer = '';
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});
const text = () => out.join('\n');

describe('pitr status', () => {
  it('prints settings, archiving, the window and base backups', async () => {
    await pitrStatus(client().client, '4');
    expect(text()).toMatch(/Retention.*7 day/);
    expect(text()).toMatch(/Archiving.*ok \(12 segment/);
    expect(text()).toContain('2026-11-05T09:02:30.000Z → 2026-11-05T09:04:00.000Z');
    expect(text()).toContain('nd-20261105T090200000Z');
    expect(text()).toContain('The last base backup failed');
  });
  it('says what is missing: off, unavailable, failing, nothing recoverable yet', async () => {
    await pitrStatus(client({ get: vi.fn(async () => ({ ...status, enabled: false })) }).client, '4');
    expect(text()).toContain('ninedeploy databases pitr enable 4');
    out = [];
    await pitrStatus(client({ get: vi.fn(async () => ({ ...status, available: false, unavailableReason: 'PostgreSQL only.' })) }).client, '4');
    expect(text()).toContain('PostgreSQL only.');
    out = [];
    await pitrStatus(client({ get: vi.fn(async () => ({ ...status, lastBaseBackupAt: null, lastError: null, baseBackupRunning: false, recoverable: [], baseBackups: [], archiving: { ...status.archiving, failing: true, lastFailedAt: '2026-11-05T09:05:00.000Z' } })) }).client, '4');
    expect(text()).toMatch(/FAILING since 2026-11-05T09:05:00/);
    expect(text()).toContain('Nothing is recoverable yet');
    out = [];
    await pitrStatus(client({ get: vi.fn(async () => { throw new Error('403 forbidden'); }) }).client, '4');
    expect(text()).toContain('403 forbidden');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    await pitrStatus(client().client, 'x');
    expect(process.exitCode).toBe(1);
  });
});

describe('enable / disable / base-backup', () => {
  it('enables with a retention and validates it', async () => {
    const { pitr, client: c } = client();
    await pitrEnable(c, '4', { retention: '14' });
    expect(pitr.set).toHaveBeenCalledWith(4, { enabled: true, retentionDays: 14 });
    await pitrEnable(c, '4');
    expect(pitr.set).toHaveBeenLastCalledWith(4, { enabled: true });
    await pitrEnable(c, '4', { retention: '40' });
    expect(process.exitCode).toBe(1);
    expect(pitr.set).toHaveBeenCalledTimes(2);
    process.exitCode = 0;
    await pitrEnable(client({ set: vi.fn(async () => { throw new Error('wal_level is minimal'); }) }).client, '4');
    expect(text()).toContain('wal_level is minimal');
    await pitrEnable(c, '0');
    expect(process.exitCode).toBe(1);
  });
  it('disables only after a typed confirmation or --yes', async () => {
    const { pitr, client: c } = client();
    prompts.answer = 'no';
    await pitrDisable(c, '4');
    expect(pitr.set).not.toHaveBeenCalled();
    prompts.answer = 'disable';
    await pitrDisable(c, '4');
    expect(pitr.set).toHaveBeenCalledWith(4, { enabled: false });
    await pitrDisable(c, '4', { yes: true });
    expect(pitr.set).toHaveBeenCalledTimes(2);
    await pitrDisable(client({ set: vi.fn(async () => { throw new Error('pitr_busy'); }) }).client, '4', { yes: true });
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    await pitrDisable(c, 'x');
    expect(process.exitCode).toBe(1);
  });
  it('starts a base backup', async () => {
    const { pitr, client: c } = client();
    await pitrBaseBackup(c, '4');
    expect(pitr.baseBackup).toHaveBeenCalledWith(4);
    expect(text()).toContain('Base backup started');
    await pitrBaseBackup(client({ baseBackup: vi.fn(async () => { throw new Error('already running'); }) }).client, '4');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    await pitrBaseBackup(c, 'x');
    expect(process.exitCode).toBe(1);
  });
});

describe('recover', () => {
  it('admits, polls to the verdict and prints where replay stopped', async () => {
    const running = recovery({ status: 'running', recoveredTo: null });
    const recoveryFn = vi.fn().mockResolvedValueOnce(running).mockResolvedValueOnce(recovery());
    const { pitr, client: c } = client({ recovery: recoveryFn });
    await pitrRecover(c, '4', { name: ' restored ', to: '2026-11-05T10:03:30+01:00', pollMs: 0 });
    expect(pitr.recover).toHaveBeenCalledWith(4, { name: 'restored', targetTime: '2026-11-05T09:03:30.000Z' });
    expect(recoveryFn).toHaveBeenCalledTimes(2);
    expect(text()).toMatch(/Recovered into database #9 in 1234 ms/);
    expect(text()).toContain('2026-11-05 09:03:10+00');
    expect(process.exitCode).toBe(0);
  });
  it('reports a failed recovery, returns at once with --no-wait, and gives up polling at the deadline', async () => {
    await pitrRecover(client({ recovery: vi.fn(async () => recovery({ status: 'failed', error: 'Segment X is missing.' })) }).client, '4', { name: 'r', pollMs: 0 });
    expect(text()).toContain('Recovery #5 failed: Segment X is missing.');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    const { pitr, client: c } = client();
    await pitrRecover(c, '4', { name: 'r', wait: false });
    expect(pitr.recover).toHaveBeenCalledWith(4, { name: 'r', targetTime: null });
    expect(pitr.recovery).not.toHaveBeenCalled();
    expect(text()).toContain('Recovery #5 started into database #9');
    await pitrRecover(client({ recovery: vi.fn(async () => recovery({ status: 'running' })) }).client, '4', { name: 'r', pollMs: 0, timeoutMs: -1 });
    expect(text()).toContain('recovery #5 is still running');
    expect(process.exitCode).toBe(1);
  });
  it('refuses a missing name, a time without a zone, and surfaces an admission refusal', async () => {
    const { pitr, client: c } = client();
    await pitrRecover(c, '4', {});
    expect(text()).toContain('--name is required');
    await pitrRecover(c, '4', { name: 'r', to: '2026-11-05T09:30:00' });
    expect(text()).toContain('--to must be an ISO 8601 time with a zone');
    await pitrRecover(c, '4', { name: 'r', to: 'yesterday' });
    expect(pitr.recover).not.toHaveBeenCalled();
    await pitrRecover(client({ recover: vi.fn(async () => { throw new Error('pitr_recovery_busy'); }) }).client, '4', { name: 'r' });
    expect(text()).toContain('pitr_recovery_busy');
    await pitrRecover(c, 'x', { name: 'r' });
    expect(process.exitCode).toBe(1);
  });
});

describe('recoveries', () => {
  it('lists the history, or says there is none', async () => {
    await pitrRecoveries(client().client, '4');
    expect(text()).toContain('Nothing archived.');
    expect(text()).toContain('latest');
    out = [];
    await pitrRecoveries(client({ recoveries: vi.fn(async () => []) }).client, '4');
    expect(text()).toContain('No recoveries yet.');
    await pitrRecoveries(client({ recoveries: vi.fn(async () => { throw new Error('404'); }) }).client, '4');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    await pitrRecoveries(client().client, 'x');
    expect(process.exitCode).toBe(1);
  });
});
