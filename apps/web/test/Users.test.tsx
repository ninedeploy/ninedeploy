import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { Users } from '../src/routes/Users.js';
import { api } from '../src/lib/api.js';
import { useAuth } from '../src/lib/auth.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', async () => {
  const actual = await vi.importActual<typeof import('../src/components/Toast.js')>('../src/components/Toast.js');
  return { ...actual, useToast: () => toastSpy };
});

vi.mock('../src/lib/auth.js', async () => {
  const { createAuthMock } = await import('./apiMock.js');
  return createAuthMock();
});

const users = [
  { id: 1, email: 'admin@example.com', name: 'Admin', isOperator: true, workspaceCount: 2, createdAt: '2026-01-01T00:00:00Z' },
  { id: 2, email: 'member@example.com', name: null as string | null, isOperator: false, workspaceCount: 1, createdAt: '2026-01-01T00:00:00Z' },
  { id: 3, email: 'coadmin@example.com', name: 'Co', isOperator: true, workspaceCount: 3, createdAt: '2026-01-01T00:00:00Z' },
];

describe('Users', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // People management is operator-only (r472) — the mock user is one.
    mockOf(useAuth).mockReturnValue({ user: { id: 1, email: 'admin@example.com', isOperator: true } } as never);
    vi.stubGlobal('confirm', vi.fn(() => true));
  });

  it('shows skeleton while loading', () => {
    mockOf(api.users.list).mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Users />);
    expect(document.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('creates a user via the add-user form', async () => {
    mockOf(api.users.list).mockResolvedValue([] as never);
    mockOf(api.users.create).mockResolvedValue({
      id: 9, email: 'new@x.dev', name: null, isOperator: false, workspaceCount: 0, createdAt: '2026-01-01T00:00:00Z',
    } as never);
    renderWithProviders(<Users />);
    fireEvent.click(await screen.findByRole('button', { name: /New user/i }));
    fireEvent.change(screen.getByLabelText('New user email'), { target: { value: 'new@x.dev' } });
    fireEvent.change(screen.getByLabelText('New user password'), { target: { value: 'fresh-pass-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create user' }));
    await waitFor(() => expect(api.users.create).toHaveBeenCalledWith({
      email: 'new@x.dev', password: 'fresh-pass-123', name: undefined,
    }));
  });

  it('validates the add-user form before submitting', async () => {
    mockOf(api.users.list).mockResolvedValue([] as never);
    renderWithProviders(<Users />);
    fireEvent.click(await screen.findByRole('button', { name: /New user/i }));
    // invalid email -> refused before any request
    fireEvent.change(screen.getByLabelText('New user email'), { target: { value: 'not-an-email' } });
    fireEvent.change(screen.getByLabelText('New user password'), { target: { value: 'fresh-pass-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create user' }));
    expect(api.users.create).not.toHaveBeenCalled();
    // short password -> also refused
    fireEvent.change(screen.getByLabelText('New user email'), { target: { value: 'new@x.dev' } });
    fireEvent.change(screen.getByLabelText('New user password'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create user' }));
    expect(api.users.create).not.toHaveBeenCalled();
    // optional name rides along
    fireEvent.change(screen.getByLabelText('New user name'), { target: { value: 'New Person' } });
    fireEvent.change(screen.getByLabelText('New user password'), { target: { value: 'fresh-pass-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create user' }));
    await waitFor(() => expect(api.users.create).toHaveBeenCalledWith({
      email: 'new@x.dev', password: 'fresh-pass-123', name: 'New Person',
    }));
  });

  it('shows the pending state while creation is in flight', async () => {
    mockOf(api.users.list).mockResolvedValue([] as never);
    mockOf(api.users.create).mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<Users />);
    fireEvent.click(await screen.findByRole('button', { name: /New user/i }));
    fireEvent.change(screen.getByLabelText('New user email'), { target: { value: 'new@x.dev' } });
    fireEvent.change(screen.getByLabelText('New user password'), { target: { value: 'fresh-pass-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create user' }));
    await waitFor(() => expect(screen.getByText('Creating…')).toBeInTheDocument());
  });

  it('toasts when user creation fails', async () => {
    mockOf(api.users.list).mockResolvedValue([] as never);
    mockOf(api.users.create).mockRejectedValue(new Error('email_taken') as never);
    renderWithProviders(<Users />);
    fireEvent.click(await screen.findByRole('button', { name: /New user/i }));
    fireEvent.change(screen.getByLabelText('New user email'), { target: { value: 'dup@x.dev' } });
    fireEvent.change(screen.getByLabelText('New user password'), { target: { value: 'fresh-pass-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create user' }));
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith(
        expect.stringMatching(/Could not create the user/),
        'error',
      ),
    );
  });

  it('shows empty state when there are no users', async () => {
    mockOf(api.users.list).mockResolvedValue([] as never);
    renderWithProviders(<Users />);
    await screen.findByText('No users');
  });

  it('renders users with workspace count, operator badge, self-label and delete for others', async () => {
    mockOf(api.users.list).mockResolvedValue(users as never);
    renderWithProviders(<Users />);
    await screen.findByText('admin@example.com');
    expect(screen.getByText('(you)')).toBeInTheDocument();
    // Operator badge for the two operators in the fixture.
    expect(screen.getAllByText('Operator').length).toBe(2);
    // Member badge for the one member.
    expect(screen.getAllByText('Member').length).toBe(1);
    // Workspace counts.
    expect(screen.getByText('2 workspaces')).toBeInTheDocument();
    expect(screen.getByText('3 workspaces')).toBeInTheDocument();
    expect(screen.getByText('1 workspace')).toBeInTheDocument();
    // Delete buttons only for non-self users (member + coadmin).
    const deleteButtons = screen.getAllByTitle('Delete user');
    expect(deleteButtons).toHaveLength(2);
  });

  it('deletes a user after confirmation', async () => {
    mockOf(api.users.list).mockResolvedValue(users as never);
    mockOf(api.users.remove).mockResolvedValue(undefined as never);
    renderWithProviders(<Users />);
    fireEvent.click((await screen.findAllByTitle('Delete user'))[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.users.remove).toHaveBeenCalledWith(2));
  });

  // The instance-operator flag is what actually gates the operator-only routes
  // and the host-privilege boundary. It used to be implied by owning any
  // workspace (self-grantable); it is now granted explicitly from this table.
  it('grants the instance-operator flag to a member (after confirming, r402)', async () => {
    mockOf(api.users.list).mockResolvedValue(users as never);
    mockOf(api.users.setOperator).mockResolvedValue({ ok: true, id: 2, isOperator: true } as never);
    renderWithProviders(<Users />);
    fireEvent.click(await screen.findByTitle('Grant instance-operator access (full control of this server)'));
    fireEvent.click(await screen.findByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(api.users.setOperator).toHaveBeenCalledWith(2, true));
  });

  it('revokes the flag from another operator (after confirming)', async () => {
    mockOf(api.users.list).mockResolvedValue(users as never);
    mockOf(api.users.setOperator).mockResolvedValue({ ok: true, id: 3, isOperator: false } as never);
    renderWithProviders(<Users />);
    // Only user 3 is a revocable operator — the signed-in admin (id 1) gets no
    // control at all, so nobody can demote themselves out of the panel.
    const revokes = await screen.findAllByTitle('Revoke instance-operator access');
    expect(revokes).toHaveLength(1);
    fireEvent.click(revokes[0]!);
    // Two "Revoke" buttons now exist (the row link + the dialog confirm); the
    // dialog's is the last one rendered.
    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' }).at(-1)!);
    await waitFor(() => expect(api.users.setOperator).toHaveBeenCalledWith(3, false));
  });

  it('toasts when an operator grant is refused', async () => {
    mockOf(api.users.list).mockResolvedValue(users as never);
    mockOf(api.users.setOperator).mockRejectedValue(new Error('Cannot remove the last instance operator') as never);
    renderWithProviders(<Users />);
    fireEvent.click(await screen.findByTitle('Grant instance-operator access (full control of this server)'));
    fireEvent.click(await screen.findByRole('button', { name: 'Grant' }));
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith('Cannot remove the last instance operator', 'error'),
    );
  });

  it('does not delete when the dialog is cancelled', async () => {
    mockOf(api.users.list).mockResolvedValue(users as never);
    renderWithProviders(<Users />);
    fireEvent.click((await screen.findAllByTitle('Delete user'))[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.users.remove).not.toHaveBeenCalled();
  });

  it('shows an error card with retry when the users query fails', async () => {
    mockOf(api.users.list).mockRejectedValue(new Error('403') as never);
    renderWithProviders(<Users />);
    expect(await screen.findByText("Couldn't load users")).toBeInTheDocument();
    expect(screen.getByText('403')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.users.list).toHaveBeenCalledTimes(2));
  });

  it('toasts on delete failures', async () => {
    mockOf(api.users.list).mockResolvedValue(users as never);
    mockOf(api.users.remove).mockRejectedValue(new Error('last admin') as never);
    renderWithProviders(<Users />);
    // The rows only exist once the users query resolves - querying
    // synchronously still finds the loading skeleton.
    fireEvent.click((await screen.findAllByTitle('Delete user'))[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.users.remove).toHaveBeenCalledWith(2));
  });

  it('resets another user password via the inline form', async () => {
    mockOf(api.users.list).mockResolvedValue(users as never);
    mockOf(api.users.resetPassword).mockResolvedValue({ ok: true } as never);
    renderWithProviders(<Users />);

    fireEvent.click((await screen.findAllByTitle(/Reset password/))[0]!);
    const input = await screen.findByPlaceholderText('new password (min 8)');
    const freshPassword = ['fresh', 'pass', '123'].join('-');
    fireEvent.change(input, { target: { value: freshPassword } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(api.users.resetPassword).toHaveBeenCalledWith(2, { newPassword: freshPassword }));
    // The inline form closes after success.
    await waitFor(() => expect(screen.queryByPlaceholderText('new password (min 8)')).not.toBeInTheDocument());
  });

  it('rejects a too-short reset password without calling the API', async () => {
    mockOf(api.users.list).mockResolvedValue(users as never);
    renderWithProviders(<Users />);

    fireEvent.click((await screen.findAllByTitle(/Reset password/))[0]!);
    const input = await screen.findByPlaceholderText('new password (min 8)');
    fireEvent.change(input, { target: { value: 'short' } });
    fireEvent.click(screen.getByText('Save'));
    expect(api.users.resetPassword).not.toHaveBeenCalled();
  });
});

describe('Users one-time reset link', () => {
  const link = { url: 'https://panel.test/reset/abc', expiresAt: '2026-03-01T00:00:00Z' };

  beforeEach(() => {
    mockOf(api.users.list).mockResolvedValue(users as never);
  });

  it('reveals the link, copies it and dismisses the banner', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    mockOf(api.users.resetLink).mockResolvedValue(link as never);
    renderWithProviders(<Users />);

    fireEvent.click((await screen.findAllByTitle(/Generate a one-time reset link/))[0]!);
    expect(await screen.findByText(link.url)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(link.url));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Reset link copied', 'success'));

    fireEvent.click(screen.getByText('Done'));
    await waitFor(() => expect(screen.queryByText(link.url)).not.toBeInTheDocument());
  });

  it('tells the operator to select the link manually when the clipboard is blocked', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
    });
    mockOf(api.users.resetLink).mockResolvedValue(link as never);
    renderWithProviders(<Users />);

    fireEvent.click((await screen.findAllByTitle(/Generate a one-time reset link/))[0]!);
    fireEvent.click(await screen.findByText('Copy'));
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith('Copy failed — select the link manually', 'error'),
    );
  });

  it('reports a failure to mint the link', async () => {
    mockOf(api.users.resetLink).mockRejectedValue(new Error('nope') as never);
    renderWithProviders(<Users />);

    fireEvent.click((await screen.findAllByTitle(/Generate a one-time reset link/))[0]!);
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith('Could not generate the reset link', 'error'),
    );
  });

  it('cancels an open inline password reset', async () => {
    renderWithProviders(<Users />);

    fireEvent.click((await screen.findAllByTitle(/Reset password/))[0]!);
    expect(await screen.findByPlaceholderText('new password (min 8)')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText('new password (min 8)')).not.toBeInTheDocument(),
    );
  });

  it('reports a failed password reset', async () => {
    mockOf(api.users.resetPassword).mockRejectedValue(new Error('weak') as never);
    renderWithProviders(<Users />);

    fireEvent.click((await screen.findAllByTitle(/Reset password/))[0]!);
    fireEvent.change(await screen.findByPlaceholderText('new password (min 8)'), {
      target: { value: 'fresh-pass-123' },
    });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Password reset failed', 'error'));
  });
});
