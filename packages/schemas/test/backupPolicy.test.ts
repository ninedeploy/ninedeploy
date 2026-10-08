import { describe, expect, it } from 'vitest';
import {
  BACKUP_RETAIN_MAX,
  BACKUP_RETAIN_MIN,
  DEFAULT_BACKUP_RETAIN_COUNT,
  backupPolicy,
  backupPolicyInput,
} from '../src/backupPolicy.js';

describe('backupPolicyInput (0.12)', () => {
  it('fills the optional fields with the built-in meaning', () => {
    expect(backupPolicyInput.parse({ cron: ' 0 3 * * * ', retainCount: 7 })).toEqual({
      enabled: true,
      cron: '0 3 * * *',
      retainCount: 7,
      retainRemoteCount: null,
      destinationId: null,
      localOnly: false,
    });
  });

  it('keeps explicit values', () => {
    expect(
      backupPolicyInput.parse({ enabled: false, cron: '*/30 * * * *', retainCount: 3, retainRemoteCount: 10, destinationId: 4 }),
    ).toMatchObject({ enabled: false, retainRemoteCount: 10, destinationId: 4, localOnly: false });
    expect(backupPolicyInput.parse({ cron: '0 3 * * *', retainCount: 1, localOnly: true })).toMatchObject({
      localOnly: true,
      destinationId: null,
      retainRemoteCount: null,
    });
  });

  it('bounds both retention counts', () => {
    const base = { cron: '0 3 * * *' };
    expect(backupPolicyInput.safeParse({ ...base, retainCount: BACKUP_RETAIN_MIN }).success).toBe(true);
    expect(backupPolicyInput.safeParse({ ...base, retainCount: BACKUP_RETAIN_MAX }).success).toBe(true);
    expect(backupPolicyInput.safeParse({ ...base, retainCount: BACKUP_RETAIN_MIN - 1 }).success).toBe(false);
    expect(backupPolicyInput.safeParse({ ...base, retainCount: BACKUP_RETAIN_MAX + 1 }).success).toBe(false);
    expect(backupPolicyInput.safeParse({ ...base, retainCount: 2.5 }).success).toBe(false);
    expect(backupPolicyInput.safeParse({ ...base, retainCount: 7, retainRemoteCount: 0 }).success).toBe(false);
    expect(DEFAULT_BACKUP_RETAIN_COUNT).toBe(7);
  });

  it('refuses an empty cron and a non-positive destination', () => {
    expect(backupPolicyInput.safeParse({ cron: '   ', retainCount: 7 }).success).toBe(false);
    expect(backupPolicyInput.safeParse({ cron: '0 3 * * *', retainCount: 7, destinationId: 0 }).success).toBe(false);
  });

  it('refuses a destination or remote retention on a local-only policy', () => {
    const dest = backupPolicyInput.safeParse({ cron: '0 3 * * *', retainCount: 7, localOnly: true, destinationId: 2 });
    expect(dest.success).toBe(false);
    expect(dest.error?.issues[0]?.path).toEqual(['destinationId']);
    const remote = backupPolicyInput.safeParse({ cron: '0 3 * * *', retainCount: 7, localOnly: true, retainRemoteCount: 5 });
    expect(remote.success).toBe(false);
    expect(remote.error?.issues[0]?.path).toEqual(['retainRemoteCount']);
  });
});

describe('backupPolicy response', () => {
  it('describes an unconfigured database (built-in schedule)', () => {
    const row = {
      databaseId: 3,
      configured: false,
      enabled: true,
      cron: null,
      retainCount: 7,
      retainRemoteCount: null,
      destinationId: null,
      localOnly: false,
      nextRunAt: null,
      updatedAt: null,
    };
    expect(backupPolicy.parse(row)).toEqual(row);
    expect(backupPolicy.safeParse({ ...row, configured: 'no' }).success).toBe(false);
  });
});
