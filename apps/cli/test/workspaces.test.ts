import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NineDeployClient } from '@ninedeploy/sdk';
import {
  workspacesList, workspacesGet, workspacesCreate, workspacesDelete,
} from '../src/commands/workspaces.js';

describe('CLI workspaces commands', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  const fakeClient = {
    workspaces: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
  } as unknown as NineDeployClient;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('lists workspaces when empty', async () => {
    vi.mocked(fakeClient.workspaces.list).mockResolvedValueOnce([]);
    await workspacesList(fakeClient);
    expect(logSpy).toHaveBeenCalledWith('  No workspaces found.');
  });

  it('lists workspaces when items exist', async () => {
    vi.mocked(fakeClient.workspaces.list).mockResolvedValueOnce([
      {
        id: 1,
        name: 'Acme Corp',
        slug: 'acme-corp',
        myRole: 'owner',
        memberCount: 3,
        projectCount: 5,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    await workspacesList(fakeClient);
    expect(fakeClient.workspaces.list).toHaveBeenCalled();
  });

  it('handles workspacesList error', async () => {
    vi.mocked(fakeClient.workspaces.list).mockRejectedValueOnce(new Error('Network error'));
    await expect(workspacesList(fakeClient)).rejects.toThrow('Network error');
  });

  it('gets workspace detail with members and description', async () => {
    vi.mocked(fakeClient.workspaces.get).mockResolvedValueOnce({
      id: 1,
      name: 'Acme Corp',
      slug: 'acme-corp',
      description: 'Production workspace',
      myRole: 'owner',
      memberCount: 2,
      projectCount: 4,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      members: [
        { id: 10, userId: 1, name: 'Admin User', email: 'admin@acme.com', role: 'owner', createdAt: '2026-01-01' },
        { id: 11, userId: 2, name: null, email: 'dev@acme.com', role: 'member', createdAt: '2026-01-01' },
      ],
    });
    await workspacesGet(fakeClient, '1');
    expect(logSpy).toHaveBeenCalledWith('\n  Workspace #1: Acme Corp (acme-corp)');
    expect(logSpy).toHaveBeenCalledWith('  Description: Production workspace');
  });

  it('gets workspace detail without description', async () => {
    vi.mocked(fakeClient.workspaces.get).mockResolvedValueOnce({
      id: 2,
      name: 'No Desc Corp',
      slug: 'no-desc-corp',
      description: null,
      myRole: 'admin',
      memberCount: 1,
      projectCount: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      members: [
        { id: 10, userId: 1, name: 'Admin', email: 'admin@acme.com', role: 'admin', createdAt: '2026-01-01' },
      ],
    });
    await workspacesGet(fakeClient, '2');
    expect(logSpy).toHaveBeenCalledWith('\n  Workspace #2: No Desc Corp (no-desc-corp)');
  });

  it('rejects invalid workspace id in get', async () => {
    await expect(workspacesGet(fakeClient, 'abc')).rejects.toThrow('Workspace ID must be an integer');
  });

  it('handles workspacesGet error', async () => {
    vi.mocked(fakeClient.workspaces.get).mockRejectedValueOnce(new Error('Not found'));
    await expect(workspacesGet(fakeClient, '99')).rejects.toThrow('Not found');
  });

  it('creates a workspace', async () => {
    vi.mocked(fakeClient.workspaces.create).mockResolvedValueOnce({
      id: 2,
      name: 'Team Beta',
      slug: 'team-beta',
      description: 'Beta testing',
      myRole: 'owner',
      memberCount: 1,
      projectCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await workspacesCreate(fakeClient, 'Team Beta', { description: 'Beta testing' });
    expect(logSpy).toHaveBeenCalledWith('  ✓ Workspace #2 created: Team Beta (team-beta)');
  });

  it('handles workspacesCreate error', async () => {
    vi.mocked(fakeClient.workspaces.create).mockRejectedValueOnce(new Error('Duplicate'));
    await expect(workspacesCreate(fakeClient, 'Duplicate', {})).rejects.toThrow('Duplicate');
  });

  it('deletes a workspace', async () => {
    vi.mocked(fakeClient.workspaces.delete).mockResolvedValueOnce({ ok: true });
    await workspacesDelete(fakeClient, '2');
    expect(logSpy).toHaveBeenCalledWith('  ✓ Workspace #2 deleted.');
  });

  it('rejects invalid workspace id in delete', async () => {
    await expect(workspacesDelete(fakeClient, 'invalid')).rejects.toThrow('Workspace ID must be an integer');
  });

  it('handles workspacesDelete error', async () => {
    vi.mocked(fakeClient.workspaces.delete).mockRejectedValueOnce(new Error('Forbidden'));
    await expect(workspacesDelete(fakeClient, '1')).rejects.toThrow('Forbidden');
  });
});
