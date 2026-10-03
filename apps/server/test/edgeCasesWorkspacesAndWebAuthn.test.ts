import { describe, expect, it, vi } from 'vitest';
import {
  ensureDefaultWorkspace,
} from '../src/modules/workspaces.js';
import {
  beginRegistration,
} from '../src/lib/webauthn.js';

describe('Edge Cases — Workspaces Multi-tenancy & Auto-provisioning', () => {
  it('provisions a default workspace when none exists and resolves slug collisions', async () => {
    let insertedWorkspace: any = null;
    let insertedMember: any = null;

    const mockDb = {
      query: {
        workspaceMembers: {
          findFirst: vi.fn(async () => null), // No existing membership
        },
        workspaces: {
          findFirst: vi.fn(async () => {
            // Simulate existing slug collision for "personal-workspace"
            return { id: 99, slug: 'personal-workspace' };
          }),
        },
        users: {
          findFirst: vi.fn(async () => ({ id: 5, name: null, email: 'john@example.com' })),
        },
      },
      insert: vi.fn(() => ({
        values: vi.fn((data: any) => ({
          returning: vi.fn(async () => {
            insertedWorkspace = { id: 101, ...data };
            return [insertedWorkspace];
          }),
          // biome-ignore lint/suspicious/noThenProperty: intentional thenable for Drizzle insert mock
          then: (ok: any) => {
            insertedMember = data;
            return Promise.resolve([data]).then(ok);
          },
        })),
      })),
    } as any;

    const ws = await ensureDefaultWorkspace(mockDb, { id: 5, email: 'john@example.com' });
    expect(ws).toBeDefined();
    expect(ws.name).toBe('Personal Workspace');
    expect(ws.slug).toBe('personal-workspace-5'); // Collision resolved with user id
    expect(insertedMember.role).toBe('owner');
  });

  it('reuses existing workspace if user is already a member', async () => {
    const existingWs = { id: 42, name: 'Team Workspace', slug: 'team-ws' };
    const mockDb = {
      query: {
        workspaceMembers: {
          findFirst: vi.fn(async () => ({ id: 1, workspaceId: 42, userId: 10 })),
        },
        workspaces: {
          findFirst: vi.fn(async () => existingWs),
        },
      },
      insert: vi.fn(),
    } as any;

    const ws = await ensureDefaultWorkspace(mockDb, { id: 10 });
    expect(ws).toEqual(existingWs);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});

describe('Edge Cases — WebAuthn / Passkeys Registration & Challenge Store', () => {
  it('generates registration options with Relying Party identity matching publicUrl', async () => {
    const user = { id: 1, email: 'admin@nine.io', name: 'Admin User' };
    const existingCreds: any[] = [];

    const json = await beginRegistration(user, existingCreds);
    const options = JSON.parse(json);

    expect(options.rp.name).toBe('NineDeploy');
    expect(options.rp.id).toBeDefined();
    expect(options.user.name).toBe('admin@nine.io');
    expect(options.challenge).toBeTruthy();
  });
});
