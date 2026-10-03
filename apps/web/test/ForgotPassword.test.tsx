import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ForgotPassword } from '../src/routes/ForgotPassword.js';
import { api } from '../src/lib/api.js';
import { mockOf, renderWithProviders } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

describe('ForgotPassword', () => {
  beforeEach(() => vi.clearAllMocks());

  it('submits the email and shows the sent state', async () => {
    mockOf(api.auth.forgotPassword).mockResolvedValue({ ok: true } as never);
    const user = userEvent.setup();
    renderWithProviders(<ForgotPassword />);
    await user.type(screen.getByPlaceholderText('you@example.com'), 'user@example.com');
    await user.click(screen.getByRole('button', { name: /Send reset link/ }));
    await waitFor(() => expect(api.auth.forgotPassword).toHaveBeenCalledWith('user@example.com'));
    expect(await screen.findByText(/reset link is on its way/)).toBeInTheDocument();
    expect(screen.getByText(/ask an admin/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to sign in/ })).toHaveAttribute('href', '/login');
  });

  it('keeps the button disabled for an empty email', () => {
    renderWithProviders(<ForgotPassword />);
    expect(screen.getByRole('button', { name: /Send reset link/ })).toBeDisabled();
    fireEvent.submit(screen.getByPlaceholderText('you@example.com').closest('form')!);
    expect(api.auth.forgotPassword).not.toHaveBeenCalled();
  });

  it('shows the request error', async () => {
    mockOf(api.auth.forgotPassword).mockRejectedValue(new Error('rate limited') as never);
    const user = userEvent.setup();
    renderWithProviders(<ForgotPassword />);
    await user.type(screen.getByPlaceholderText('you@example.com'), 'user@example.com');
    fireEvent.click(screen.getByRole('button', { name: /Send reset link/ }));
    expect(await screen.findByText('rate limited')).toBeInTheDocument();
  });

  it('shows a generic error for non-Error rejections', async () => {
    mockOf(api.auth.forgotPassword).mockRejectedValue('boom' as never);
    const user = userEvent.setup();
    renderWithProviders(<ForgotPassword />);
    await user.type(screen.getByPlaceholderText('you@example.com'), 'user@example.com');
    fireEvent.click(screen.getByRole('button', { name: /Send reset link/ }));
    expect(await screen.findByText('Request failed')).toBeInTheDocument();
  });

  it('shows the pending label while the request is in flight', async () => {
    mockOf(api.auth.forgotPassword).mockReturnValue(new Promise(() => {}) as never);
    const user = userEvent.setup();
    renderWithProviders(<ForgotPassword />);
    await user.type(screen.getByPlaceholderText('you@example.com'), 'user@example.com');
    await user.click(screen.getByRole('button', { name: /Send reset link/ }));
    expect(await screen.findByText('Please wait…')).toBeInTheDocument();
  });
});
