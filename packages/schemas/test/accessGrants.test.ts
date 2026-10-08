import { describe, expect, it } from 'vitest';
import {
  accessGrant,
  accessGrantCreate,
  accessGrantListQuery,
  accessGrantRole,
  accessGrantTargetKey,
  accessGrantUpdate,
  accessMe,
  projectAccessEntry,
  projectAccessVia,
} from '../src/accessGrants.js';

describe('accessGrantCreate (0.15)', () => {
  it('names the user by email or id and targets a project, an environment or both', () => {
    expect(accessGrantCreate.parse({ email: ' Dev@Example.com ', projectId: 3, role: 'member' })).toEqual({
      email: 'dev@example.com',
      projectId: 3,
      role: 'member',
    });
    expect(accessGrantCreate.parse({ userId: 4, environmentId: 5, role: 'viewer' })).toEqual({ userId: 4, environmentId: 5, role: 'viewer' });
    expect(accessGrantCreate.parse({ userId: 4, projectId: 3, environmentId: 5, role: 'admin' })).toMatchObject({ projectId: 3, environmentId: 5 });
  });

  it('needs exactly one subject', () => {
    expect(accessGrantCreate.safeParse({ projectId: 3, role: 'member' }).success).toBe(false);
    expect(accessGrantCreate.safeParse({ email: 'a@example.com', userId: 4, projectId: 3, role: 'member' }).success).toBe(false);
    expect(accessGrantCreate.safeParse({ email: 'not-an-email', projectId: 3, role: 'member' }).success).toBe(false);
  });

  it('needs at least one target', () => {
    const res = accessGrantCreate.safeParse({ userId: 4, role: 'member' });
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]?.path).toEqual(['projectId']);
  });

  it('never grants owner (raise-only, O5) and refuses stray keys', () => {
    expect(accessGrantRole.options).toEqual(['viewer', 'member', 'admin']);
    expect(accessGrantCreate.safeParse({ userId: 4, projectId: 3, role: 'owner' }).success).toBe(false);
    expect(accessGrantCreate.safeParse({ userId: 4, projectId: 3, role: 'member', workspaceId: 9 }).success).toBe(false);
    expect(accessGrantUpdate.parse({ role: 'admin' })).toEqual({ role: 'admin' });
    expect(accessGrantUpdate.safeParse({ role: 'owner' }).success).toBe(false);
    expect(accessGrantUpdate.safeParse({ role: 'member', projectId: 1 }).success).toBe(false);
  });
});

describe('accessGrantTargetKey', () => {
  it('builds the uniqueness key the table stores', () => {
    expect(accessGrantTargetKey({ projectId: 3 })).toBe('p:3');
    expect(accessGrantTargetKey({ environmentId: 5, projectId: null })).toBe('e:5');
    expect(accessGrantTargetKey({ projectId: 3, environmentId: 5 })).toBe('pe:3:5');
  });

  it('refuses a grant with no target', () => {
    expect(() => accessGrantTargetKey({})).toThrow(/project or an environment/);
    expect(() => accessGrantTargetKey({ projectId: null, environmentId: null })).toThrow();
  });
});

describe('access grant views', () => {
  const grant = {
    id: 1,
    workspaceId: 2,
    user: { id: 4, email: 'dev@example.com', name: 'Dev' },
    project: { id: 3, name: 'shop' },
    environment: null,
    role: 'member',
    suspended: false,
    createdAt: '2026-10-08T00:00:00.000Z',
    createdBy: { id: 1, email: 'admin@example.com' },
    isGuest: true,
  };

  it('describes a grant, the list query and /access/me', () => {
    expect(accessGrant.parse(grant)).toEqual(grant);
    expect(accessGrantListQuery.parse({ userId: '4', projectId: '3', environmentId: '5' })).toEqual({ userId: 4, projectId: 3, environmentId: 5 });
    expect(accessGrantListQuery.parse({})).toEqual({});
    expect(accessGrantListQuery.safeParse({ role: 'admin' }).success).toBe(false);
    const me = { grants: [grant], guestWorkspaces: [{ id: 2, name: 'Team', slug: 'team' }] };
    expect(accessMe.parse(me)).toEqual(me);
  });

  it('explains how a user reaches a project', () => {
    expect(projectAccessVia.options).toEqual(['operator', 'seat', 'grant', 'creator']);
    const entry = { user: { id: 4, email: 'dev@example.com', name: 'Dev' }, role: 'admin', via: ['seat', 'grant'] };
    expect(projectAccessEntry.parse(entry)).toEqual(entry);
    expect(projectAccessEntry.safeParse({ ...entry, via: [] }).success).toBe(false);
  });
});
