import { describe, expect, it } from 'vitest';
import { statsSnapshot, statsSnapshotQuery } from '../src/service.js';
describe('database snapshot contract', () => {
  it('preserves unfiltered clients and validates database selectors', () => {
    expect(statsSnapshot.parse({ host: null, containers: [] })).toEqual({ host: null, containers: [] });
    expect(statsSnapshotQuery.parse({ databaseId: '13' })).toEqual({ databaseId: 13 });
    expect(statsSnapshotQuery.safeParse({ databaseId: '9007199254740992' }).success).toBe(false);
  });
  it('retains target and freshness without inventing a CPU sample', () => {
    const value = { host: null, containers: [], resource: { kind: 'database', id: 13, serverId: 8, state: 'unavailable', sampledAt: null } };
    expect(statsSnapshot.parse(value)).toEqual(value);
    expect(statsSnapshot.safeParse({ ...value, resource: { ...value.resource, sampledAt: Number.NaN } }).success).toBe(false);
  });
});
