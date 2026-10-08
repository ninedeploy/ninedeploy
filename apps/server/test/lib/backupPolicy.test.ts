import { describe, expect, it } from 'vitest';
import {
  assertBackupCron,
  cronPeriodMs,
  FAILED_ATTEMPTS_KEPT,
  loadBackupPolicies,
  nextCronRun,
  planRetention,
  type RetentionRow,
  serializeBackupPolicy,
} from '../../src/lib/backupPolicy.js';

const HOUR = 3_600_000;

/** Newest-first scheduled rows: `spec` letters c = completed, f = failed,
 *  r = running; a trailing `+` marks a row with a remote copy. */
function rows(spec: string[]): RetentionRow[] {
  return spec.map((s, i) => ({
    id: i + 1,
    scope: 'scheduled',
    status: s[0] === 'c' ? 'completed' : s[0] === 'f' ? 'failed' : 'running',
    remoteKey: s.endsWith('+') ? `k/${i + 1}` : null,
  }));
}

describe('assertBackupCron (same rule as scheduled jobs)', () => {
  it('accepts 5-field expressions', () => {
    for (const expr of ['0 3 * * *', '0 */6 * * *', '0 3 * * 0', '15,45 2 1-5 * *']) {
      expect(() => assertBackupCron(expr)).not.toThrow();
    }
  });
  it('refuses 6-field (seconds) patterns and garbage with a 400', () => {
    for (const expr of ['* * * * * *', '0 3 * *', 'every day', '61 * * * *']) {
      expect(() => assertBackupCron(expr)).toThrow(expect.objectContaining({ statusCode: 400 }));
    }
  });
});

describe('nextCronRun / cronPeriodMs', () => {
  const from = new Date(2026, 9, 8, 10, 0, 0); // local time, like croner
  it('computes the next run and the cadence', () => {
    expect(nextCronRun('0 */6 * * *', from)?.getTime()).toBe(new Date(2026, 9, 8, 12, 0, 0).getTime());
    expect(cronPeriodMs('0 */6 * * *', from)).toBe(6 * HOUR);
    expect(cronPeriodMs('0 3 * * *', from)).toBe(24 * HOUR);
    expect(cronPeriodMs('0 3 * * 0', from)).toBe(7 * 24 * HOUR);
  });
  it('is null for an invalid expression', () => {
    expect(nextCronRun('nope', from)).toBeNull();
    expect(cronPeriodMs('nope', from)).toBeNull();
  });
});

describe('planRetention', () => {
  it('built-in rule: completed rows past N are dropped with their remote copy (pre-0.12 behaviour)', () => {
    const plan = planRetention(rows(['c+', 'c+', 'c', 'c+', 'c']), { retainCount: 3, retainRemoteCount: null });
    expect([...plan]).toEqual([
      [4, 'drop'],
      [5, 'drop'],
    ]);
  });

  it('F97/F288: failed attempts never evict a completed dump, and have their own bound', () => {
    const spec = [...Array(FAILED_ATTEMPTS_KEPT + 3).fill('f'), 'c'];
    const plan = planRetention(rows(spec), { retainCount: 1, retainRemoteCount: null });
    // The lone completed dump (oldest, behind every failure) is kept.
    expect(plan.has(spec.length)).toBe(false);
    expect([...plan.values()].filter((a) => a === 'drop')).toHaveLength(3);
  });

  it('never touches the newest completed dump, even with a nonsensical count', () => {
    for (const retainCount of [0, -5, Number.NaN]) {
      const plan = planRetention(rows(['c+', 'c']), { retainCount, retainRemoteCount: retainCount });
      expect(plan.has(1)).toBe(false);
    }
  });

  it('ignores manual and running rows', () => {
    const r = rows(['c', 'r', 'c', 'c']);
    r.push({ id: 99, scope: 'db', status: 'completed', remoteKey: null });
    const plan = planRetention(r, { retainCount: 1, retainRemoteCount: null });
    expect([...plan.keys()].sort()).toEqual([3, 4]);
  });

  it('separate remote count: more remote copies than local dumps', () => {
    // keep 2 local, 3 remote: rows 3 and 4 keep only their remote copy.
    const plan = planRetention(rows(['c+', 'c+', 'c+', 'c+', 'c+', 'c']), { retainCount: 2, retainRemoteCount: 3 });
    expect([...plan]).toEqual([
      [3, 'trim-local'],
      [4, 'drop'],
      [5, 'drop'],
      [6, 'drop'],
    ]);
  });

  it('separate remote count: fewer remote copies than local dumps', () => {
    const plan = planRetention(rows(['c+', 'c+', 'c+', 'c']), { retainCount: 4, retainRemoteCount: 1 });
    expect([...plan]).toEqual([
      [2, 'trim-remote'],
      [3, 'trim-remote'],
    ]);
  });

  it('remote copies are counted over rows that have one — an upload outage does not cost the last remote copy', () => {
    // Newest three dumps never reached the bucket; the 4th is the only remote copy.
    const plan = planRetention(rows(['c', 'c', 'c', 'c+', 'c+']), { retainCount: 3, retainRemoteCount: 1 });
    expect(plan.get(4)).toBe('trim-local');
    expect(plan.get(5)).toBe('drop');
  });
});

describe('loadBackupPolicies', () => {
  it('is empty when the table is not there (mocked DB, pre-0067 schema)', async () => {
    expect((await loadBackupPolicies({ query: {} } as never)).size).toBe(0);
    const missing = new Error('Failed query', { cause: new Error('SQLITE_ERROR: no such table: database_backup_policies') });
    const db = { query: { databaseBackupPolicies: { findMany: async () => Promise.reject(missing) } } };
    expect((await loadBackupPolicies(db as never)).size).toBe(0);
  });

  it('rethrows any other read error — a policy database must never fall back to the built-in 7', async () => {
    const db = { query: { databaseBackupPolicies: { findMany: async () => Promise.reject(new Error('SQLITE_BUSY')) } } };
    await expect(loadBackupPolicies(db as never)).rejects.toThrow('SQLITE_BUSY');
  });

  it('keys rows by database id', async () => {
    const db = { query: { databaseBackupPolicies: { findMany: async () => [{ databaseId: 3 }, { databaseId: 9 }] } } };
    expect([...(await loadBackupPolicies(db as never)).keys()]).toEqual([3, 9]);
  });
});

describe('serializeBackupPolicy', () => {
  it('reports the built-in default for a database without a row', () => {
    expect(serializeBackupPolicy(5, null)).toEqual({
      databaseId: 5,
      configured: false,
      enabled: true,
      cron: null,
      retainCount: 7,
      retainRemoteCount: null,
      destinationId: null,
      localOnly: false,
      nextRunAt: null,
      updatedAt: null,
    });
  });

  it('includes the next run only for an enabled policy', () => {
    const now = new Date(2026, 9, 8, 10, 0, 0);
    const row = {
      databaseId: 5, enabled: true, cron: '0 12 * * *', retainCount: 14, retainRemoteCount: 30,
      destinationId: 2, localOnly: false, createdAt: now, updatedAt: now,
    };
    expect(serializeBackupPolicy(5, row, now)).toMatchObject({
      configured: true, cron: '0 12 * * *', retainCount: 14, retainRemoteCount: 30, destinationId: 2,
      nextRunAt: new Date(2026, 9, 8, 12, 0, 0).toISOString(),
    });
    expect(serializeBackupPolicy(5, { ...row, enabled: false }, now).nextRunAt).toBeNull();
  });
});
