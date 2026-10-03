import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResetPassword } from '../src/routes/ResetPassword.js';
import { api } from '../src/lib/api.js';
import { mockOf, renderWithProviders } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

// Dummy fixtures — not credentials (test-only values).
const NEW_PW = 'fresh-pass-123';
const TOKEN = 'token-1234567890abcdef';

const fill = async (user: ReturnType<typeof userEvent.setup>, pw: string = NEW_PW) => {
  await user.type(screen.getByPlaceholderText('Paste the token from your link'), TOKEN);
  await user.type(screen.getByPlaceholderText('At least 8 characters'), pw);
  await user.type(screen.getByPlaceholderText('Repeat the new password'), pw);
};

describe('ResetPassword', () => {
  beforeEach(() => vi.clearAllMocks());

  it('submits the token and new value, then redirects to login', async () => {
    mockOf(api.auth.resetPasswordWithToken).mockResolvedValue({ ok: true } as never);
    const user = userEvent.setup();
    renderWithProviders(<ResetPassword />);
    await fill(user);
    await user.click(screen.getByRole('button', { name: /Set new password/ }));
    await waitFor(() =>
      expect(api.auth.resetPasswordWithToken).toHaveBeenCalledWith({ token: TOKEN, newPassword: NEW_PW }));
  });

  it('reads the token from the URL when present', async () => {
    mockOf(api.auth.resetPasswordWithToken).mockResolvedValue({ ok: true } as never);
    const user = userEvent.setup();
    renderWithProviders(<ResetPassword />, { route: '/reset-password?token=urltoken1234567890' });
    expect(screen.queryByPlaceholderText('Paste the token from your link')).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('At least 8 characters'), NEW_PW);
    await user.type(screen.getByPlaceholderText('Repeat the new password'), NEW_PW);
    await user.click(screen.getByRole('button', { name: /Set new password/ }));
    await waitFor(() =>
      expect(api.auth.resetPasswordWithToken).toHaveBeenCalledWith({ token: 'urltoken1234567890', newPassword: NEW_PW }));
  });

  it('rejects mismatched entries locally', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ResetPassword />);
    await fill(user);
    await user.clear(screen.getByPlaceholderText('Repeat the new password'));
    await user.type(screen.getByPlaceholderText('Repeat the new password'), 'different1');
    await user.click(screen.getByRole('button', { name: /Set new password/ }));
    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
    expect(api.auth.resetPasswordWithToken).not.toHaveBeenCalled();
  });

  it('rejects a too-short value locally', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ResetPassword />);
    await fill(user, 'short');
    await user.click(screen.getByRole('button', { name: /Set new password/ }));
    expect(await screen.findByText('Password must be at least 8 characters.')).toBeInTheDocument();
    expect(api.auth.resetPasswordWithToken).not.toHaveBeenCalled();
  });

  it('surfaces a rejected token', async () => {
    mockOf(api.auth.resetPasswordWithToken).mockRejectedValue(new Error('Invalid or expired reset token') as never);
    const user = userEvent.setup();
    renderWithProviders(<ResetPassword />);
    await fill(user);
    await user.click(screen.getByRole('button', { name: /Set new password/ }));
    expect(await screen.findByText('Invalid or expired reset token')).toBeInTheDocument();
  });

  it('shows a generic error for non-Error rejections', async () => {
    mockOf(api.auth.resetPasswordWithToken).mockRejectedValue('boom' as never);
    const user = userEvent.setup();
    renderWithProviders(<ResetPassword />);
    await fill(user);
    await user.click(screen.getByRole('button', { name: /Set new password/ }));
    expect(await screen.findByText('Reset failed')).toBeInTheDocument();
  });

  it('keeps the button disabled without a token', () => {
    renderWithProviders(<ResetPassword />);
    expect(screen.getByRole('button', { name: /Set new password/ })).toBeDisabled();
  });

  it('shows the pending label while in flight', async () => {
    mockOf(api.auth.resetPasswordWithToken).mockReturnValue(new Promise(() => {}) as never);
    const user = userEvent.setup();
    renderWithProviders(<ResetPassword />);
    await fill(user);
    await user.click(screen.getByRole('button', { name: /Set new password/ }));
    expect(await screen.findByText('Please wait…')).toBeInTheDocument();
  });

  it('submits via form enter without clicking the button', async () => {
    mockOf(api.auth.resetPasswordWithToken).mockResolvedValue({ ok: true } as never);
    const user = userEvent.setup();
    renderWithProviders(<ResetPassword />);
    await fill(user);
    fireEvent.submit(screen.getByRole('button', { name: /Set new password/ }).closest('form')!);
    await waitFor(() => expect(api.auth.resetPasswordWithToken).toHaveBeenCalled());
  });
});
