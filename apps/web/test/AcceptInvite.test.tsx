import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { AcceptInvite } from '../src/routes/AcceptInvite.js';
import { api } from '../src/lib/api.js';
import { useAuth } from '../src/lib/auth.js';
import { Route, Routes } from 'react-router';
import { WorkspaceProvider, useWorkspace } from '../src/lib/workspace.js';
import { renderRoute, renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

vi.mock('../src/lib/auth.js', async () => {
  const { createAuthMock } = await import('./apiMock.js');
  return createAuthMock();
});

const renderAt = (path: string) =>
  renderRoute(<AcceptInvite />, { path: '/invite/:token', route: path });

describe('AcceptInvite page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a sign-in CTA for anonymous visitors', async () => {
    mockOf(api.workspaces.previewInvitation).mockResolvedValueOnce({
      workspaceId: 1,
      workspaceName: 'Acme',
      workspaceSlug: 'acme',
      email: 'invitee@example.com',
      isOperator: false,
      // invitedByName intentionally omitted to exercise the "A workspace owner" fallback.
      invitedByName: undefined as unknown as string,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    } as never);
    mockOf(useAuth).mockReturnValue({
      user: null,
      loading: false,
      login: vi.fn(),
      setup: vi.fn(),
      loginWithPasskey: vi.fn(),
      logout: vi.fn(),
      refresh: vi.fn(),
    });

    renderAt('/invite/abc123');

    expect(await screen.findByText('Join Acme')).toBeInTheDocument();
    const signIn = screen.getByRole('button', { name: /Sign in to accept/i });
    fireEvent.click(signIn);
    // The router navigates within MemoryRouter — the login route would catch it
    // if the navigate() call was not gated on user.
  });

  it('falls back to a generic error message when a non-Error is thrown', async () => {
    mockOf(api.workspaces.previewInvitation).mockResolvedValueOnce({
      workspaceId: 1,
      workspaceName: 'Acme',
      workspaceSlug: 'acme',
      email: 'invitee@example.com',
      isOperator: false,
      invitedByName: 'Owner',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    } as never);
    // Throwing a plain string (not an Error) exercises the `err instanceof
    // Error` false branch in onError.
    mockOf(api.workspaces.acceptInvitation).mockRejectedValueOnce('not-an-error' as never);
    mockOf(useAuth).mockReturnValue({
      user: { id: 1, email: 'invitee@example.com', name: 'Invitee', isOperator: false },
      loading: false,
      login: vi.fn(),
      setup: vi.fn(),
      loginWithPasskey: vi.fn(),
      logout: vi.fn(),
      refresh: vi.fn(),
    });

    renderAt('/invite/abc123');
    fireEvent.click(await screen.findByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByText('Failed to accept invitation')).toBeInTheDocument();
  });

  it('retries accepting after an error', async () => {
    mockOf(api.workspaces.previewInvitation).mockResolvedValue({
      workspaceId: 1,
      workspaceName: 'Acme',
      workspaceSlug: 'acme',
      email: 'invitee@example.com',
      isOperator: false,
      invitedByName: 'Owner',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    } as never);
    mockOf(api.workspaces.acceptInvitation)
      .mockRejectedValueOnce(new Error('Boom') as never)
      .mockResolvedValueOnce({ ok: true, workspaceId: 1, isOperator: false } as never);
    mockOf(useAuth).mockReturnValue({
      user: { id: 1, email: 'invitee@example.com', name: 'Invitee', isOperator: false },
      loading: false,
      login: vi.fn(),
      setup: vi.fn(),
      loginWithPasskey: vi.fn(),
      logout: vi.fn(),
      refresh: vi.fn(),
    });

    renderAt('/invite/abc123');
    expect(await screen.findByText('Join Acme')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByText('Could not accept')).toBeInTheDocument();
    // Click "Try again" — the retry should succeed and transition the page.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Welcome aboard')).toBeInTheDocument();
  });

  it('flags an email mismatch when the signed-in user is different', async () => {
    mockOf(api.workspaces.previewInvitation).mockResolvedValueOnce({
      workspaceId: 1,
      workspaceName: 'Acme',
      workspaceSlug: 'acme',
      email: 'invitee@example.com',
      isOperator: true,
      invitedByName: 'Owner',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    } as never);
    mockOf(useAuth).mockReturnValue({
      user: { id: 1, email: 'someone-else@example.com', name: 'Other', isOperator: false },
      loading: false,
      login: vi.fn(),
      setup: vi.fn(),
      loginWithPasskey: vi.fn(),
      logout: vi.fn(),
      refresh: vi.fn(),
    });

    renderAt('/invite/abc123');
    expect(await screen.findByText('Different email address')).toBeInTheDocument();
  });

  it('accepts the invitation and reports success', async () => {
    mockOf(api.workspaces.previewInvitation).mockResolvedValueOnce({
      workspaceId: 1,
      workspaceName: 'Acme',
      workspaceSlug: 'acme',
      email: 'invitee@example.com',
      isOperator: false,
      invitedByName: 'Owner',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    } as never);
    mockOf(api.workspaces.acceptInvitation).mockResolvedValueOnce({
      ok: true,
      workspaceId: 1,
      isOperator: false,
    } as never);
    mockOf(useAuth).mockReturnValue({
      user: { id: 1, email: 'invitee@example.com', name: 'Invitee', isOperator: false },
      loading: false,
      login: vi.fn(),
      setup: vi.fn(),
      loginWithPasskey: vi.fn(),
      logout: vi.fn(),
      refresh: vi.fn(),
    });

    renderAt('/invite/abc123');
    expect(await screen.findByText('Join Acme')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByText('Welcome aboard')).toBeInTheDocument();
    expect(api.workspaces.acceptInvitation).toHaveBeenCalledWith('abc123');
  });

  it('lands the user in the workspace they just joined, not their previous one (r295)', async () => {
    const personal = { id: 1, name: 'Personal', slug: 'personal' };
    const acme = { id: 7, name: 'Acme', slug: 'acme' };
    window.localStorage.setItem('nd_current_workspace_id', '1');
    mockOf(api.workspaces.list).mockResolvedValue([personal] as never);
    mockOf(api.workspaces.previewInvitation).mockResolvedValueOnce({
      workspaceId: 7,
      workspaceName: 'Acme',
      workspaceSlug: 'acme',
      email: 'invitee@example.com',
      isOperator: false,
      invitedByName: 'Owner',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    } as never);
    mockOf(api.workspaces.acceptInvitation).mockImplementationOnce(async () => {
      mockOf(api.workspaces.list).mockResolvedValue([personal, acme] as never);
      return { ok: true, workspaceId: 7, isOperator: false } as never;
    });
    mockOf(useAuth).mockReturnValue({
      user: { id: 1, email: 'invitee@example.com', name: 'Invitee', isOperator: false },
      loading: false,
      login: vi.fn(),
      setup: vi.fn(),
      loginWithPasskey: vi.fn(),
      logout: vi.fn(),
      refresh: vi.fn(),
    });
    function Current() {
      const { currentWorkspace } = useWorkspace();
      return <p>in:{currentWorkspace?.name ?? 'none'}</p>;
    }
    // As in App.tsx: the invite page sits outside the authed shell, whose
    // WorkspaceProvider mounts only once the user is sent to "/".
    renderWithProviders(
      <Routes>
        <Route path="/invite/:token" element={<AcceptInvite />} />
        <Route
          path="/"
          element={
            <WorkspaceProvider>
              <Current />
            </WorkspaceProvider>
          }
        />
      </Routes>,
      { route: '/invite/abc123' },
    );
    expect(await screen.findByText('Join Acme')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByText('in:Acme', {}, { timeout: 4000 })).toBeInTheDocument();
    window.localStorage.removeItem('nd_current_workspace_id');
  });

  it('shows a fallback message when the token is unknown', async () => {
    mockOf(api.workspaces.previewInvitation).mockRejectedValueOnce(new Error('not found') as never);
    mockOf(useAuth).mockReturnValue({
      user: null,
      loading: false,
      login: vi.fn(),
      setup: vi.fn(),
      loginWithPasskey: vi.fn(),
      logout: vi.fn(),
      refresh: vi.fn(),
    });

    renderAt('/invite/zzz');
    expect(await screen.findByText('Invitation no longer valid')).toBeInTheDocument();
  });

  it('surfaces an accept error and offers a retry', async () => {
    mockOf(api.workspaces.previewInvitation).mockResolvedValueOnce({
      workspaceId: 1,
      workspaceName: 'Acme',
      workspaceSlug: 'acme',
      email: 'invitee@example.com',
      isOperator: false,
      invitedByName: 'Owner',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    } as never);
    mockOf(api.workspaces.acceptInvitation).mockRejectedValueOnce(new Error('Boom') as never);
    mockOf(useAuth).mockReturnValue({
      user: { id: 1, email: 'invitee@example.com', name: 'Invitee', isOperator: false },
      loading: false,
      login: vi.fn(),
      setup: vi.fn(),
      loginWithPasskey: vi.fn(),
      logout: vi.fn(),
      refresh: vi.fn(),
    });

    renderAt('/invite/abc123');
    expect(await screen.findByText('Join Acme')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByText('Could not accept')).toBeInTheDocument();
    expect(screen.getByText('Boom')).toBeInTheDocument();
  });
});
