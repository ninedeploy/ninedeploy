import { describe, expect, it } from 'vitest';
import { OS_UPDATES_MAX, osAutoUpdatesInput, osPackageManager, osUpdateStatus, osUpdateStatusQuery } from '../src/osUpdates.js';

const update = { name: 'openssl', version: '2', from: '1', security: true };
const status = {
  os: { id: 'debian', version: '12', name: 'Debian' }, packageManager: 'apt',
  updates: [update], updatesTruncated: false, securityCount: 1,
  autoUpdates: { installed: true, enabled: true }, rebootRequired: null,
  rebootPackages: [], warnings: [], checkedAt: '2026-10-28T00:00:00Z',
};

describe('OS update contracts', () => {
  it('accepts update status and a nullable reboot state', () => {
    expect(osUpdateStatus.parse(status)).toEqual(status);
    expect(osUpdateStatus.parse({ ...status, packageManager: 'unsupported', updates: [{ ...update, from: null }] }).updates[0]?.from).toBeNull();
    expect(osPackageManager.safeParse('dnf').success).toBe(true);
    expect(osPackageManager.safeParse('other').success).toBe(false);
  });

  it('enforces bounded lists and nonnegative integral security counts', () => {
    for (const patch of [
      { updates: Array.from({ length: OS_UPDATES_MAX + 1 }, () => update) },
      { securityCount: -1 }, { securityCount: 0.5 },
      { rebootPackages: Array.from({ length: 201 }, () => 'pkg') },
      { warnings: Array.from({ length: 21 }, () => 'warning') },
    ]) expect(osUpdateStatus.safeParse({ ...status, ...patch }).success).toBe(false);
  });

  it('validates auto-update actions and strict refresh queries', () => {
    expect(osAutoUpdatesInput.parse({ enabled: false })).toEqual({ enabled: false });
    expect(osAutoUpdatesInput.safeParse({ enabled: 'true' }).success).toBe(false);
    expect(osUpdateStatusQuery.parse({ refresh: '1' })).toEqual({ refresh: '1' });
    expect(osUpdateStatusQuery.parse({})).toEqual({});
    expect(osUpdateStatusQuery.safeParse({ refresh: 'true' }).success).toBe(false);
    expect(osUpdateStatusQuery.safeParse({ unknown: '1' }).success).toBe(false);
  });
});
