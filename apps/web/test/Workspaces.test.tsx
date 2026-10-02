import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { Workspaces } from '../src/routes/Workspaces.js';
import { api } from '../src/lib/api.js';
import { useAuth } from '../src/lib/auth.js';
import { useWorkspace } from '../src/lib/workspace.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

vi.mock('../src/lib/auth.js', async () => {
  const { createAuthMock } = await import('./apiMock.js');
  return createAuthMock();
});

vi.mock('../src/lib/workspace.js', async () => {
  const { createWorkspaceMock } = await import('./apiMock.js');
  return createWorkspaceMock();
});

// The route toasts mutation failures (r402); renderWithProviders ships no
// ToastProvider, so the hook falls back to a no-op — observe it through here.
const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', async () => {
  const actual = await vi.importActual<typeof import('../src/components/Toast.js')>('../src/components/Toast.js');
  return { ...actual, useToast: () => toastSpy };
});

describe('Workspaces route', () => {
  const mockWs = {
    id: 1,
    name: 'Acme Corp',
    slug: 'acme-corp',
    description: 'Main production workspace',
    myRole: 'owner' as const,
    memberCount: 2,
    projectCount: 4,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    members: [
      { id: 10, userId: 1, role: 'owner' as const, createdAt: '2026-01-01', email: 'admin@acme.com', name: 'Admin' },
      { id: 11, userId: 2, role: 'member' as const, createdAt: '2026-01-01', email: 'dev@acme.com', name: 'Developer' },
    ],
  };

  const switchWorkspace = vi.fn();
  const refreshWorkspaces = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockOf(useWorkspace).mockReturnValue({
      workspaces: [mockWs],
      currentWorkspace: mockWs,
      isLoading: false,
      switchWorkspace,
      createWorkspace: vi.fn(),
      refreshWorkspaces,
    });
    mockOf(api.workspaces.get).mockResolvedValue(mockWs as never);
  });

  it('renders workspace details and member list', async () => {
    renderWithProviders(<Workspaces />);

    await waitFor(() => {
      expect(screen.getByText('Workspaces & Teams')).toBeInTheDocument();
      expect(screen.getByText('Acme Corp')).toBeInTheDocument();
      expect(screen.getByText('Main production workspace')).toBeInTheDocument();
      expect(screen.getByText('dev@acme.com')).toBeInTheDocument();
    });
  });

  it('falls back to a stable shell when no workspace is selected', async () => {
    // When currentWorkspace is null, the page should not crash and should not
    // call the invitation listing endpoint.
    mockOf(useWorkspace).mockReturnValue({
      workspaces: [],
      currentWorkspace: null,
      isLoading: false,
      switchWorkspace,
      createWorkspace: vi.fn(),
      refreshWorkspaces,
    });
    renderWithProviders(<Workspaces />);
    expect(await screen.findByText('Workspaces & Teams')).toBeInTheDocument();
    expect(api.workspaces.listInvitations).not.toHaveBeenCalled();
  });

  it('invites a new member to the workspace', async () => {
    mockOf(api.workspaces.addMember).mockResolvedValueOnce({
      id: 12,
      userId: 3,
      role: 'member',
      createdAt: '2026-01-01',
      email: 'newuser@acme.com',
      name: null,
    } as never);

    renderWithProviders(<Workspaces />);

    await waitFor(() => {
      expect(screen.getByText('Invite Member')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Invite Member'));
    expect(screen.getByText('Invite Team Member')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('developer@acme.com'), {
      target: { value: 'newuser@acme.com' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));

    await waitFor(() => {
      expect(api.workspaces.addMember).toHaveBeenCalledWith(1, {
        email: 'newuser@acme.com',
        role: 'member',
      });
      expect(refreshWorkspaces).toHaveBeenCalled();
    });
  });

  it('shows the accept URL after a successful invite for an unknown address', async () => {
    // The unified POST /workspaces/:id/members endpoint returns a WorkspaceMemberInviteEntry
    // when the address is not yet a user. The UI should swap the dialog into a
    // "link to share" state instead of closing.
    mockOf(api.workspaces.addMember).mockResolvedValueOnce({
      kind: 'invitation',
      id: 50,
      workspaceId: 1,
      email: 'newbie@acme.com',
      role: 'member',
      acceptUrl: 'http://localhost:3000/invite/abc123',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    } as never);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    renderWithProviders(<Workspaces />);
    await waitFor(() => expect(screen.getByText('Invite Member')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Invite Member'));
    fireEvent.change(screen.getByPlaceholderText('developer@acme.com'), {
      target: { value: 'newbie@acme.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));

    // Dialog re-renders to the link-sharing state.
    expect(await screen.findByText('Invitation Sent')).toBeInTheDocument();
    const input = screen.getByDisplayValue('http://localhost:3000/invite/abc123') as HTMLInputElement;
    expect(input.readOnly).toBe(true);

    // Click the Copy button — the label should toggle to "Copied".
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith('http://localhost:3000/invite/abc123');

    // Focusing the read-only input should select its contents (so the user can
    // just press Ctrl-C without manually selecting the link). The Input
    // component forwards onFocus; spy on select() before dispatching.
    const linkInput = screen.getByDisplayValue('http://localhost:3000/invite/abc123') as HTMLInputElement & {
      select?: () => void;
    };
    const select = vi.fn();
    linkInput.select = select;
    fireEvent.focus(linkInput);
    expect(select).toHaveBeenCalled();
  });

  it('lists pending invitations with a revoke control', async () => {
    mockOf(api.workspaces.listInvitations).mockResolvedValueOnce([
      {
        id: 90,
        workspaceId: 1,
        email: 'pending@acme.com',
        role: 'admin',
        invitedByUserId: 1,
        // invitedByName intentionally null to hit the "Invited by someone" fallback.
        invitedByName: null,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        acceptedAt: null,
        acceptedByUserId: null,
        revokedAt: null,
        createdAt: new Date().toISOString(),
      },
    ] as never);
    mockOf(api.workspaces.revokeInvitation).mockResolvedValueOnce({ ok: true } as never);

    renderWithProviders(<Workspaces />);
    expect(await screen.findByText('Pending Invitations')).toBeInTheDocument();
    expect(screen.getByText('pending@acme.com')).toBeInTheDocument();
    // Fallback text when invitedByName is null.
    expect(screen.getByText(/Invited by someone/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => {
      expect(api.workspaces.revokeInvitation).toHaveBeenCalledWith(1, 90);
    });
  });

  it('r402: surfaces a revoke failure as a toast instead of a dead button', async () => {
    mockOf(api.workspaces.listInvitations).mockResolvedValueOnce([
      {
        id: 90, workspaceId: 1, email: 'pending@acme.com', role: 'admin', invitedByUserId: 1,
        invitedByName: null, expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        acceptedAt: null, acceptedByUserId: null, revokedAt: null, createdAt: new Date().toISOString(),
      },
    ] as never);
    mockOf(api.workspaces.revokeInvitation).mockRejectedValueOnce(new Error('nope') as never);

    renderWithProviders(<Workspaces />);
    expect(await screen.findByText('pending@acme.com')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('nope', 'error'));
  });

  it('reports invite failures inline', async () => {
    mockOf(api.workspaces.addMember).mockRejectedValueOnce(new Error('already a member') as never);

    renderWithProviders(<Workspaces />);

    await waitFor(() => {
      expect(screen.getByText('Invite Member')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Invite Member'));
    fireEvent.change(screen.getByPlaceholderText('developer@acme.com'), {
      target: { value: 'dev@acme.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));

    expect(await screen.findByText('already a member')).toBeInTheDocument();
  });

  it('cancels out of the invite, edit and delete dialogs without acting', async () => {
    renderWithProviders(<Workspaces />);
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());

    // Invite dialog: cancel discards the draft.
    fireEvent.click(screen.getByText('Invite Member'));
    fireEvent.change(screen.getByPlaceholderText('developer@acme.com'), {
      target: { value: 'draft@acme.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Invite Team Member')).not.toBeInTheDocument());
    expect(api.workspaces.addMember).not.toHaveBeenCalled();

    // Edit dialog: cancel keeps the current name.
    fireEvent.click(screen.getByRole('button', { name: 'Edit Details' }));
    expect(await screen.findByText('Edit Workspace')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Edit Workspace')).not.toBeInTheDocument());
    expect(api.workspaces.update).not.toHaveBeenCalled();

    // Delete dialog: cancel keeps the workspace.
    fireEvent.click(screen.getByRole('button', { name: 'Delete Workspace' }));
    expect(await screen.findByText(/Are you sure you want to permanently delete/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByText(/Are you sure you want to permanently delete/)).not.toBeInTheDocument());
    expect(api.workspaces.delete).not.toHaveBeenCalled();

    // Each dialog also closes via its backdrop (✕).
    fireEvent.click(screen.getByText('Invite Member'));
    expect(await screen.findByText('Invite Team Member')).toBeInTheDocument();
    fireEvent.click(screen.getAllByLabelText('Close dialog')[0]!);
    await waitFor(() => expect(screen.queryByText('Invite Team Member')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Edit Details' }));
    expect(await screen.findByText('Edit Workspace')).toBeInTheDocument();
    fireEvent.click(screen.getAllByLabelText('Close dialog')[0]!);
    await waitFor(() => expect(screen.queryByText('Edit Workspace')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Delete Workspace' }));
    expect(await screen.findByText(/Are you sure you want to permanently delete/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByLabelText('Close dialog')[0]!);
    await waitFor(() =>
      expect(screen.queryByText(/Are you sure you want to permanently delete/)).not.toBeInTheDocument());
    expect(api.workspaces.delete).not.toHaveBeenCalled();
  });

  it('updates member role', async () => {
    mockOf(api.workspaces.updateMemberRole).mockResolvedValueOnce({
      id: 11,
      userId: 2,
      role: 'admin',
      createdAt: '2026-01-01',
    } as never);

    renderWithProviders(<Workspaces />);

    await waitFor(() => {
      expect(screen.getByText('dev@acme.com')).toBeInTheDocument();
    });

    const selects = screen.getAllByRole('combobox');
    const memberRoleSelect = selects.find((s) => (s as HTMLSelectElement).value === 'member');
    expect(memberRoleSelect).toBeDefined();

    fireEvent.change(memberRoleSelect!, { target: { value: 'admin' } });

    await waitFor(() => {
      expect(api.workspaces.updateMemberRole).toHaveBeenCalledWith(1, 11, {
        role: 'admin',
      });
    });
  });

  it('removes member from workspace', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockOf(api.workspaces.removeMember).mockResolvedValueOnce({ ok: true } as never);

    renderWithProviders(<Workspaces />);

    await waitFor(() => {
      expect(screen.getByText('dev@acme.com')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Remove'));

    await waitFor(() => {
      expect(api.workspaces.removeMember).toHaveBeenCalledWith(1, 11);
    });
  });

  it('edits workspace details', async () => {
    mockOf(api.workspaces.update).mockResolvedValueOnce({
      ...mockWs,
      name: 'Acme Corp Updated',
      description: 'Updated description',
    } as never);

    renderWithProviders(<Workspaces />);

    await waitFor(() => {
      expect(screen.getByText('Edit Details')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Edit Details'));
    expect(screen.getByText('Edit Workspace')).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('Acme Corp'), {
      target: { value: 'Acme Corp Updated' },
    });
    fireEvent.change(screen.getByDisplayValue('Main production workspace'), {
      target: { value: 'Updated description' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(api.workspaces.update).toHaveBeenCalledWith(1, {
        name: 'Acme Corp Updated',
        description: 'Updated description',
      });
    });
  });

  it('deletes workspace', async () => {
    mockOf(api.workspaces.delete).mockResolvedValueOnce({ ok: true } as never);

    renderWithProviders(<Workspaces />);

    // The danger zone has both a heading and a button labelled "Delete
    // Workspace" — target the button by role.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete Workspace' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Workspace' }));
    expect(screen.getByText(/Are you sure you want to permanently delete/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Yes, Delete Workspace' }));

    await waitFor(() => {
      expect(api.workspaces.delete).toHaveBeenCalledWith(1);
      expect(refreshWorkspaces).toHaveBeenCalled();
    });
  });

  it('switches workspaces from the header selector', async () => {
    const second = { ...mockWs, id: 2, name: 'Second', slug: 'second' };
    mockOf(useWorkspace).mockReturnValue({
      workspaces: [mockWs, second],
      currentWorkspace: mockWs,
      isLoading: false,
      switchWorkspace,
      createWorkspace: vi.fn(),
      refreshWorkspaces,
    });
    renderWithProviders(<Workspaces />);
    const selector = await screen.findByDisplayValue(/Acme Corp/);
    fireEvent.change(selector, { target: { value: '2' } });
    expect(switchWorkspace).toHaveBeenCalledWith(2);
  });

  it('toggles the roles guide open and closed', async () => {
    renderWithProviders(<Workspaces />);
    fireEvent.click(await screen.findByRole('button', { name: /Roles Guide/ }));
    expect(await screen.findByText(/Role & Permissions Matrix/)).toBeInTheDocument();
    // The banner's ✕ button collapses it again.
    fireEvent.click(screen.getByRole('button', { name: '✕' }));
    await waitFor(() =>
      expect(screen.queryByText(/Role & Permissions Matrix/)).not.toBeInTheDocument());
  });

  it('searches members by name and email, including name-less members', async () => {
    mockOf(api.workspaces.get).mockResolvedValue({
      ...mockWs,
      members: [
        ...mockWs.members,
        { id: 12, userId: 3, role: 'viewer' as const, createdAt: '2026-01-01', email: 'ghost@acme.com', name: null },
      ],
    } as never);
    renderWithProviders(<Workspaces />);
    await screen.findByText('dev@acme.com');

    const search = screen.getByPlaceholderText('Search member...');
    fireEvent.change(search, { target: { value: 'Developer' } });
    expect(screen.getByText('dev@acme.com')).toBeInTheDocument();
    expect(screen.queryByText('admin@acme.com')).not.toBeInTheDocument();

    // A name-less member is found by email (name?.includes falls back false).
    fireEvent.change(search, { target: { value: 'ghost@' } });
    // Its row renders the email everywhere the name would be.
    expect(screen.getAllByText('ghost@acme.com').length).toBeGreaterThan(1);

    fireEvent.change(search, { target: { value: 'zzz-no-match' } });
    expect(screen.queryByText('dev@acme.com')).not.toBeInTheDocument();
  });

  it('invites with a chosen role and ignores empty raw submits', async () => {
    mockOf(api.workspaces.addMember).mockResolvedValue({ ok: true } as never);
    renderWithProviders(<Workspaces />);
    fireEvent.click(await screen.findByText('Invite Member'));

    // A raw form submit with no email is a no-op.
    fireEvent.submit(document.querySelector('form')!);
    expect(api.workspaces.addMember).not.toHaveBeenCalled();

    // The role dropdown travels with the invite.
    fireEvent.change(screen.getByPlaceholderText('developer@acme.com'), {
      target: { value: 'viewer@acme.com' },
    });
    fireEvent.change(screen.getByDisplayValue(/Member — Can manage/), { target: { value: 'viewer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));
    await waitFor(() =>
      expect(api.workspaces.addMember).toHaveBeenCalledWith(1, {
        email: 'viewer@acme.com',
        role: 'viewer',
      }));
  });

  it('maps non-Error invite failures to the generic message', async () => {
    mockOf(api.workspaces.addMember).mockRejectedValueOnce('boom' as never);
    renderWithProviders(<Workspaces />);
    fireEvent.click(await screen.findByText('Invite Member'));
    fireEvent.change(screen.getByPlaceholderText('developer@acme.com'), {
      target: { value: 'x@acme.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));
    expect(await screen.findByText('Failed to invite member')).toBeInTheDocument();
  });

  it('edits without a description and maps non-Error update failures', async () => {
    mockOf(api.workspaces.get).mockResolvedValue({
      ...mockWs,
      description: null,
      memberCount: undefined,
      projectCount: undefined,
    } as never);
    renderWithProviders(<Workspaces />);

    // Without member/project counts the header falls back to the member list
    // length and zero projects.
    await screen.findByText('Acme Corp');
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Details' }));
    expect(await screen.findByText('Edit Workspace')).toBeInTheDocument();

    // Emptying the name and submitting raw does nothing.
    const nameInput = screen.getByDisplayValue('Acme Corp');
    fireEvent.change(nameInput, { target: { value: '' } });
    fireEvent.submit(nameInput.closest('form')!);
    expect(api.workspaces.update).not.toHaveBeenCalled();

    // A name-only update sends description: null.
    mockOf(api.workspaces.update).mockResolvedValueOnce(mockWs as never);
    fireEvent.change(nameInput, { target: { value: 'Acme Bare' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() =>
      expect(api.workspaces.update).toHaveBeenCalledWith(1, {
        name: 'Acme Bare',
        description: null,
      }));

    // A non-Error rejection surfaces the generic message.
    mockOf(api.workspaces.update).mockRejectedValueOnce('nope' as never);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Details' }));
    await screen.findByText('Edit Workspace');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText('Failed to update workspace')).toBeInTheDocument();

    // An Error rejection surfaces its message.
    mockOf(api.workspaces.update).mockRejectedValueOnce(new Error('name taken') as never);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText('name taken')).toBeInTheDocument();
  });

  it('leaves the workspace as a non-owner member and maps non-Error delete failures', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockOf(useAuth).mockReturnValue({
      user: { id: 1, email: 'me@acme.com', name: 'Me', isOperator: true as const },
      loading: false,
    });
    mockOf(api.workspaces.get).mockResolvedValue({
      ...mockWs,
      myRole: 'admin' as const,
      members: [
        { id: 20, userId: 99, role: 'owner' as const, createdAt: '2026-01-01', email: 'boss@acme.com', name: 'Boss' },
        { id: 21, userId: 1, role: 'admin' as const, createdAt: '2026-01-01', email: 'me@acme.com', name: 'Me' },
      ],
    } as never);
    renderWithProviders(<Workspaces />);

    // My own non-owner row offers Leave instead of Remove.
    fireEvent.click(await screen.findByRole('button', { name: /^Leave$/ }));
    await waitFor(() => expect(api.workspaces.removeMember).toHaveBeenCalledWith(1, 21));

    // A non-Error workspace deletion failure surfaces the generic message.
    mockOf(api.workspaces.delete).mockRejectedValueOnce('boom' as never);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, Delete Workspace' }));
    expect(await screen.findByText('Failed to delete workspace')).toBeInTheDocument();

    // An Error rejection surfaces its message instead.
    mockOf(api.workspaces.delete).mockRejectedValueOnce(new Error('has projects') as never);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Workspace' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, Delete Workspace' }));
    expect(await screen.findByText('has projects')).toBeInTheDocument();
  });

  it('renders static badges and no removal buttons for a viewer', async () => {
    mockOf(useAuth).mockReturnValue({
      user: { id: 3, email: 'view@acme.com', name: 'Viewer', isOperator: false as const },
      loading: false,
    });
    mockOf(api.workspaces.get).mockResolvedValue({
      ...mockWs,
      myRole: 'viewer' as const,
      memberCount: undefined,
      members: [
        { id: 30, userId: 9, role: 'owner' as const, createdAt: '2026-01-01', email: 'boss@acme.com', name: 'Boss' },
        { id: 31, userId: 8, role: 'admin' as const, createdAt: '2026-01-01', email: 'ops@acme.com', name: 'Ops' },
        { id: 32, userId: 3, role: 'viewer' as const, createdAt: '2026-01-01', email: 'view@acme.com', name: null },
        // A pending/ghost member without name or email still renders a row.
        { id: 33, userId: 4, role: 'viewer' as const, createdAt: '2026-01-01', email: null, name: null },
      ],
    } as never);

    renderWithProviders(<Workspaces />);
    // Every role renders as a static badge (owner indigo, admin emerald,
    // viewer neutral) — no role dropdowns for a viewer.
    await screen.findByText('Boss');
    expect(screen.getAllByRole('combobox').length).toBe(1); // only the workspace switcher
    // A viewer still sees Leave on their OWN row (isMe), but no Remove
    // buttons for anyone else.
    expect(screen.getByRole('button', { name: /^Leave$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove$/ })).not.toBeInTheDocument();
    // The name+email-less member falls back to the '?' avatar.
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('requires confirmation before removing and skips it when declined', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderWithProviders(<Workspaces />);
    fireEvent.click(await screen.findByRole('button', { name: /^Remove$/ }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(api.workspaces.removeMember).not.toHaveBeenCalled();
  });

  it('renders an empty selector when no workspace is current', async () => {
    mockOf(useWorkspace).mockReturnValue({
      workspaces: [],
      currentWorkspace: null,
      isLoading: false,
      switchWorkspace,
      createWorkspace: vi.fn(),
      refreshWorkspaces,
    });
    renderWithProviders(<Workspaces />);
    // The header selector holds the empty option; no detail renders.
    const selector = await screen.findByRole('combobox');
    expect((selector as HTMLSelectElement).value).toBe('');
  });

  it('falls back to one member when the detail carries no member list', async () => {
    mockOf(api.workspaces.get).mockResolvedValue({
      ...mockWs,
      memberCount: undefined,
      members: undefined,
    } as never);
    renderWithProviders(<Workspaces />);
    // The stats grid falls all the way back to 1 without counts or a list.
    await screen.findByText('1');
  });
});
