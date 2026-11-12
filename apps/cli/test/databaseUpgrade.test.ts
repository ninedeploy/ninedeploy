import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prompts = vi.hoisted(() => ({ answer: '' }));
vi.mock('../src/prompts.js', () => ({ prompt: vi.fn(async () => prompts.answer) }));

import { upgradeFinalize, upgradeRollback, upgradeStart, upgradeStatus } from '../src/commands/databaseUpgrade.js';

/** O2: `ninedeploy databases upgrade …`. */
const upgrade = (over: Record<string, unknown> = {}) => ({
  id: 4, databaseId: 9, engine: 'postgres', fromMajor: 16, toMajor: 18, previousVersion: '16', targetVersion: '18',
  previousVolume: 'nd-db-orders-data', targetVolume: 'nd-db-orders-data-u4', status: 'running', phase: 'dump',
  safetyBackupId: 3, verification: null, error: null, createdAt: '2026-11-12T10:00:00.000Z', completedAt: null, rolledBackAt: null, finalizedAt: null,
  ...over,
});
const completed = upgrade({ status: 'completed', phase: null, verification: { tables: 3, rows: 120, sequences: 2, objects: { indexes: 4, constraints: 3, views: 0, triggers: 0, functions: 0, extensions: 'plpgsql' }, mismatches: [] } });

function client(over: Record<string, unknown> = {}) {
  const upgrades = {
    options: vi.fn(async () => ({ databaseId: 9, currentMajor: 16, targets: [17, 18], refusal: null })),
    list: vi.fn(async () => [completed, upgrade({ id: 3, status: 'rolled_back', toMajor: 17, targetVolume: 'nd-db-orders-data-u3' }), upgrade({ id: 2, status: 'failed', error: 'the restored copy does not match' })]),
    start: vi.fn(async () => upgrade()),
    wait: vi.fn(async () => completed),
    rollback: vi.fn(async () => upgrade({ status: 'rolled_back' })),
    finalize: vi.fn(async () => ({ ...upgrade({ status: 'finalized' }), removedVolume: 'nd-db-orders-data' })),
    ...over,
  };
  return { upgrades, client: { databases: { upgrades } } as never };
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

describe('databases upgrade', () => {
  it('status shows the running major, the targets and what each upgrade keeps', async () => {
    const { client: c } = client();
    await upgradeStatus(c, '9');
    expect(text()).toContain('PostgreSQL 16');
    expect(text()).toContain('PostgreSQL 17, PostgreSQL 18');
    expect(text()).toContain('nd-db-orders-data-u3');
    expect(text()).toContain('the restored copy does not match');
  });

  it('status says why no upgrade can start', async () => {
    const { client: c } = client({ options: vi.fn(async () => ({ databaseId: 9, currentMajor: null, targets: [], refusal: { code: 'database_upgrade_pitr', message: 'Point-in-time recovery is on.' } })), list: vi.fn(async () => []) });
    await upgradeStatus(c, '9');
    expect(text()).toContain('Point-in-time recovery is on.');
    expect(text()).toContain('unknown');
  });

  it('start asks first, then waits and tells how to finalize or roll back', async () => {
    const { client: c, upgrades } = client();
    await upgradeStart(c, '9', { to: '18' });
    expect(upgrades.start).not.toHaveBeenCalled();
    expect(text()).toContain('Aborted');
    prompts.answer = 'upgrade';
    await upgradeStart(c, '9', { to: '18', pollMs: 5 });
    expect(upgrades.start).toHaveBeenCalledWith(9, { toMajor: 18 });
    expect(upgrades.wait).toHaveBeenCalledWith(9, 4, { intervalMs: 5 });
    expect(text()).toContain('Upgraded to PostgreSQL 18');
    expect(text()).toContain('3 table(s), 120 row(s)');
    expect(text()).toContain('ninedeploy databases upgrade finalize 9 4');
    expect(text()).toContain('ninedeploy databases upgrade rollback 9 4');
    expect(process.exitCode).toBe(0);
  });

  it('start --no-wait returns once admitted; a failed run sets the exit code', async () => {
    const { client: c, upgrades } = client({ wait: vi.fn(async () => upgrade({ status: 'failed', error: 'restore failed. The database runs on PostgreSQL 16 as before.' })) });
    await upgradeStart(c, '9', { to: '18', yes: true, wait: false });
    expect(upgrades.wait).not.toHaveBeenCalled();
    expect(text()).toContain('Upgrade #4 to PostgreSQL 18 is running');
    await upgradeStart(c, '9', { to: '18', yes: true });
    expect(upgrades.wait).toHaveBeenCalledWith(9, 4, {});
    expect(text()).toContain('as before');
    expect(process.exitCode).toBe(1);
  });

  it('start reports a refused admission and odd outcomes', async () => {
    const refused = client({ start: vi.fn(async () => { throw new Error('The cluster holds other databases (analytics)'); }) });
    await upgradeStart(refused.client, '9', { to: '18', yes: true });
    expect(text()).toContain('other databases');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    const odd = client({ wait: vi.fn(async () => upgrade({ status: 'rolled_back', error: null })) });
    await upgradeStart(odd.client, '9', { to: '18', yes: true });
    expect(text()).toContain('ended rolled_back: no reason recorded');
    process.exitCode = 0;
    const lost = client({ wait: vi.fn(async () => { throw new Error('upgrade 4 is still running'); }) });
    await upgradeStart(lost.client, '9', { to: '18', yes: true });
    expect(text()).toContain('still running');
  });

  it('validates the ids and the target', async () => {
    const { client: c, upgrades } = client();
    await upgradeStart(c, 'x', { to: '18', yes: true });
    await upgradeStart(c, '9', { to: 'latest', yes: true });
    await upgradeRollback(c, '9', 'x', { yes: true });
    await upgradeFinalize(c, 'x', '4', { yes: true });
    await upgradeStatus(c, '0');
    await upgradeRollback(c, 'x', '4', { yes: true });
    await upgradeFinalize(c, '9', 'x', { yes: true });
    expect(upgrades.start).not.toHaveBeenCalled();
    expect(text()).toContain('--to must be a PostgreSQL major');
    expect(process.exitCode).toBe(1);
  });

  it('rollback and finalize confirm, act and report', async () => {
    const { client: c, upgrades } = client();
    await upgradeRollback(c, '9', '4');
    await upgradeFinalize(c, '9', '4');
    expect(upgrades.rollback).not.toHaveBeenCalled();
    expect(upgrades.finalize).not.toHaveBeenCalled();
    prompts.answer = 'rollback';
    await upgradeRollback(c, '9', '4');
    expect(text()).toContain('runs on PostgreSQL 16 again');
    expect(text()).toContain('nd-db-orders-data-u4 is kept');
    prompts.answer = 'finalize';
    await upgradeFinalize(c, '9', '4');
    expect(text()).toContain('Deleted nd-db-orders-data');
  });

  it('rollback, finalize and status report server errors', async () => {
    const boom = vi.fn(async () => { throw new Error('nope'); });
    const { client: c } = client({ rollback: boom, finalize: boom, options: boom });
    await upgradeRollback(c, '9', '4', { yes: true });
    await upgradeFinalize(c, '9', '4', { yes: true });
    await upgradeStatus(c, '9');
    expect(out.filter((l) => l.includes('nope'))).toHaveLength(3);
    expect(process.exitCode).toBe(1);
  });
});
