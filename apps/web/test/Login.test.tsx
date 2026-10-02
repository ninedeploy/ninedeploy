import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router';
import { Login } from '../src/routes/Login.js';
import { api } from '../src/lib/api.js';
import { useAuth } from '../src/lib/auth.js';
import { ssoNavigation } from '../src/lib/sso.js';
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

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function authValue(overrides: Record<string, unknown> = {}) {
  return {
    user: null,
    loading: false,
    login: vi.fn().mockResolvedValue(undefined),
    setup: vi.fn().mockResolvedValue(undefined),
    loginWithPasskey: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn(),
    ...overrides,
  };
}

describe('Login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a retry card instead of the setup form when the status probe fails', async () => {
    // A failed probe must NOT funnel the user into "Create admin account" —
    // that submit is a guaranteed 409 on an initialized instance.
    mockOf(api.auth.status).mockRejectedValue(new Error('ECONNREFUSED') as never);
    mockOf(useAuth).mockReturnValue(authValue() as never);
    renderWithProviders(<Login />);

    expect(await screen.findByRole('heading', { name: 'Cannot reach the server' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sign in/ })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Admin')).not.toBeInTheDocument();

    mockOf(api.auth.status).mockResolvedValue({ initialized: true } as never);
    await act(async () => {
      screen.getByRole('button', { name: 'Retry' }).click();
    });
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  });

  it('redirects to / when already logged in', async () => {
    mockOf(api.auth.status).mockResolvedValue({ initialized: true } as never);
    mockOf(useAuth).mockReturnValue(authValue({ user: { id: 1, email: 'a@b.c' } }) as never);
    renderWithProviders(
      <>
        <Login />
        <LocationProbe />
      </>,
    );
    await screen.findByTestId('location');
    expect(screen.getByTestId('location')).toHaveTextContent('/');
  });

  it('shows the sign-in form for an initialized instance', async () => {
    mockOf(api.auth.status).mockResolvedValue({ initialized: true } as never);
    mockOf(useAuth).mockReturnValue(authValue() as never);
    renderWithProviders(<Login />);
    await screen.findByRole('heading', { name: 'Welcome back' });
    expect(screen.queryByPlaceholderText('Admin')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign in/ })).toBeInTheDocument();
  });

  it('logs in and navigates to the from location', async () => {
    const user = userEvent.setup();
    const login = vi.fn().mockResolvedValue(undefined);
    mockOf(api.auth.status).mockResolvedValue({ initialized: true } as never);
    mockOf(useAuth).mockReturnValue(authValue({ login }) as never);
    renderWithProviders(
      <>
        <Login />
        <LocationProbe />
      </>,
      { initialEntries: [{ pathname: '/login', state: { from: '/hub' } }] },
    );
    await user.type(await screen.findByPlaceholderText('you@example.com'), 'a@b.c');
    await user.type(screen.getByPlaceholderText('••••••••'), 'secret');
    await user.click(screen.getByRole('button', { name: /Sign in/ }));
    await waitFor(() => expect(login).toHaveBeenCalledWith('a@b.c', 'secret', undefined));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/hub'));
  });

  it('defaults navigation to / when no from state', async () => {
    const user = userEvent.setup();
    const login = vi.fn().mockResolvedValue(undefined);
    mockOf(api.auth.status).mockResolvedValue({ initialized: true } as never);
    mockOf(useAuth).mockReturnValue(authValue({ login }) as never);
    renderWithProviders(
      <>
        <Login />
        <LocationProbe />
      </>,
    );
    await user.type(await screen.findByPlaceholderText('you@example.com'), 'a@b.c');
    await user.type(screen.getByPlaceholderText('••••••••'), 'secret');
    await user.click(screen.getByRole('button', { name: /Sign in/ }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/'));
  });

  it('shows the setup form for a fresh instance and creates the admin', async () => {
    const user = userEvent.setup();
    const setup = vi.fn().mockResolvedValue(undefined);
    mockOf(api.auth.status).mockResolvedValue({ initialized: false } as never);
    mockOf(useAuth).mockReturnValue(authValue({ setup }) as never);
    renderWithProviders(<Login />);
    await screen.findByRole('heading', { name: 'Create admin account' });
    expect(screen.getByPlaceholderText('Admin')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Admin'), 'Boss');
    await user.type(screen.getByPlaceholderText('you@example.com'), 'a@b.c');
    await user.type(screen.getByPlaceholderText('••••••••'), 'secret');
    await user.click(screen.getByRole('button', { name: /Create account/ }));
    await waitFor(() => expect(setup).toHaveBeenCalledWith('a@b.c', 'secret', 'Boss'));
  });

  it('creates the admin without a display name', async () => {
    const user = userEvent.setup();
    const setup = vi.fn().mockResolvedValue(undefined);
    mockOf(api.auth.status).mockResolvedValue({ initialized: false } as never);
    mockOf(useAuth).mockReturnValue(authValue({ setup }) as never);
    renderWithProviders(<Login />);
    await screen.findByRole('heading', { name: 'Create admin account' });
    await user.type(screen.getByPlaceholderText('you@example.com'), 'a@b.c');
    await user.type(screen.getByPlaceholderText('••••••••'), 'secret');
    await user.click(screen.getByRole('button', { name: /Create account/ }));
    await waitFor(() => expect(setup).toHaveBeenCalledWith('a@b.c', 'secret', undefined));
  });

  it('shows an error message when login fails', async () => {
    const user = userEvent.setup();
    const login = vi.fn().mockRejectedValue(new Error('Bad credentials'));
    mockOf(api.auth.status).mockResolvedValue({ initialized: true } as never);
    mockOf(useAuth).mockReturnValue(authValue({ login }) as never);
    renderWithProviders(<Login />);
    await user.type(await screen.findByPlaceholderText('you@example.com'), 'a@b.c');
    await user.type(screen.getByPlaceholderText('••••••••'), 'wrong');
    await user.click(screen.getByRole('button', { name: /Sign in/ }));
    await screen.findByText('Bad credentials');
  });

  it('shows a generic error when a non-Error is thrown', async () => {
    const user = userEvent.setup();
    const login = vi.fn().mockRejectedValue('boom');
    mockOf(api.auth.status).mockResolvedValue({ initialized: true } as never);
    mockOf(useAuth).mockReturnValue(authValue({ login }) as never);
    renderWithProviders(<Login />);
    await user.type(await screen.findByPlaceholderText('you@example.com'), 'a@b.c');
    await user.type(screen.getByPlaceholderText('••••••••'), 'wrong');
    await user.click(screen.getByRole('button', { name: /Sign in/ }));
    await screen.findByText('Something went wrong');
  });

  it('switches to the two-factor step and signs in with the code', async () => {
    const user = userEvent.setup();
    // First attempt: the account has 2FA enabled and no code was given. The
    // server marks this with the typed `totp_required` error code (the UI
    // keys off the code, not the English message).
    const totpRequired = Object.assign(new Error('Two-factor code required'), { code: 'totp_required' });
    const login = vi
      .fn()
      .mockRejectedValueOnce(totpRequired)
      .mockResolvedValueOnce(undefined);
    mockOf(api.auth.status).mockResolvedValue({ initialized: true } as never);
    mockOf(useAuth).mockReturnValue(authValue({ login }) as never);
    renderWithProviders(<Login />);
    await user.type(await screen.findByPlaceholderText('you@example.com'), 'a@b.c');
    await user.type(screen.getByPlaceholderText('••••••••'), 'secret');
    await user.click(screen.getByRole('button', { name: /Sign in/ }));
    // The second step appears without an error banner.
    expect(await screen.findByPlaceholderText('123456')).toBeInTheDocument();
    expect(screen.queryByText('Two-factor code required')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Verify & sign in/ })).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('123456'), '123456');
    await user.click(screen.getByRole('button', { name: /Verify & sign in/ }));
    await waitFor(() => expect(login).toHaveBeenLastCalledWith('a@b.c', 'secret', '123456'));
  });

  it('shows the error when the two-factor code is wrong', async () => {
    const user = userEvent.setup();
    const totpRequired = Object.assign(new Error('Two-factor code required'), { code: 'totp_required' });
    const login = vi
      .fn()
      .mockRejectedValueOnce(totpRequired)
      .mockRejectedValueOnce(new Error('Invalid two-factor code'));
    mockOf(api.auth.status).mockResolvedValue({ initialized: true } as never);
    mockOf(useAuth).mockReturnValue(authValue({ login }) as never);
    renderWithProviders(<Login />);
    await user.type(await screen.findByPlaceholderText('you@example.com'), 'a@b.c');
    await user.type(screen.getByPlaceholderText('••••••••'), 'secret');
    await user.click(screen.getByRole('button', { name: /Sign in/ }));
    await user.type(await screen.findByPlaceholderText('123456'), '000000');
    await user.click(screen.getByRole('button', { name: /Verify & sign in/ }));
    expect(await screen.findByText('Invalid two-factor code')).toBeInTheDocument();
  });

  it('links to forgot-password on initialized instances and hides it on fresh ones', async () => {
    mockOf(api.auth.status).mockResolvedValue({ initialized: true } as never);
    mockOf(useAuth).mockReturnValue(authValue() as never);
    const { unmount } = renderWithProviders(<Login />);
    expect(await screen.findByRole('link', { name: /Forgot your password\?/ })).toHaveAttribute('href', '/forgot-password');
    unmount();

    mockOf(api.auth.status).mockResolvedValue({ initialized: false } as never);
    renderWithProviders(<Login />);
    await screen.findByRole('heading', { name: 'Create admin account' });
    expect(screen.queryByRole('link', { name: /Forgot your password\?/ })).not.toBeInTheDocument();
  });

  it('signs in with a passkey and navigates to the from location', async () => {
    const user = userEvent.setup();
    const loginWithPasskey = vi.fn().mockResolvedValue(undefined);
    mockOf(api.auth.status).mockResolvedValue({ initialized: true } as never);
    mockOf(useAuth).mockReturnValue(authValue({ loginWithPasskey }) as never);
    renderWithProviders(
      <>
        <Login />
        <LocationProbe />
      </>,
      { initialEntries: [{ pathname: '/login', state: { from: '/networks' } }] },
    );
    await user.click(await screen.findByRole('button', { name: /Use a passkey/ }));
    await waitFor(() => expect(loginWithPasskey).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/networks'));
  });

  it('shows the passkey error message when passkey sign-in fails', async () => {
    const user = userEvent.setup();
    const loginWithPasskey = vi.fn().mockRejectedValue(new Error('Passkey challenge expired'));
    mockOf(api.auth.status).mockResolvedValue({ initialized: true } as never);
    mockOf(useAuth).mockReturnValue(authValue({ loginWithPasskey }) as never);
    renderWithProviders(<Login />);
    await user.click(await screen.findByRole('button', { name: /Use a passkey/ }));
    expect(await screen.findByText('Passkey challenge expired')).toBeInTheDocument();
  });

  it('shows a generic passkey error for non-Error rejections', async () => {
    const user = userEvent.setup();
    const loginWithPasskey = vi.fn().mockRejectedValue(undefined);
    mockOf(api.auth.status).mockResolvedValue({ initialized: true } as never);
    mockOf(useAuth).mockReturnValue(authValue({ loginWithPasskey }) as never);
    renderWithProviders(<Login />);
    await user.click(await screen.findByRole('button', { name: /Use a passkey/ }));
    expect(await screen.findByText('Passkey sign-in cancelled')).toBeInTheDocument();
  });

  it('shows the password-reset success banner after a completed reset', async () => {
    mockOf(api.auth.status).mockResolvedValue({ initialized: true } as never);
    mockOf(useAuth).mockReturnValue(authValue() as never);
    renderWithProviders(<Login />, { initialEntries: ['/login?reset=ok'] });
    expect(await screen.findByText(/Password updated — sign in with your new password/)).toBeInTheDocument();
  });

  it('renders public SSO provider buttons and redirects on click', async () => {
    const user = userEvent.setup();
    mockOf(api.auth.status).mockResolvedValue({ initialized: true } as never);
    mockOf(api.auth.oidc.publicProviders).mockResolvedValue([
      { id: 1, name: 'GitHub Enterprise', slug: 'github', authUrl: '/v1/auth/oidc/github/login' },
    ] as never);
    mockOf(useAuth).mockReturnValue(authValue() as never);

    const go = vi.spyOn(ssoNavigation, 'go').mockImplementation(() => undefined);
    try {
      renderWithProviders(<Login />, { initialEntries: ['/login?returnTo=%2Fservices%2F4'] });
      expect(await screen.findByText('GitHub Enterprise')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /GitHub Enterprise/ }));
      // r505: through apiUrl(), carrying the return path and this tab's nonce.
      expect(go).toHaveBeenCalledTimes(1);
      const url = new URL(go.mock.calls[0]![0], window.location.origin);
      expect(url.pathname).toBe('/v1/auth/oidc/github/login');
      expect(url.searchParams.get('returnTo')).toBe('/services/4');
      expect(url.searchParams.get('nonce')).toBe(sessionStorage.getItem('ninedeploy.ssoNonce'));
    } finally {
      go.mockRestore();
      sessionStorage.clear();
    }
  });

  it('r505: an SSO start never carries a cross-origin returnTo', async () => {
    const user = userEvent.setup();
    mockOf(api.auth.status).mockResolvedValue({ initialized: true } as never);
    mockOf(api.auth.oidc.publicProviders).mockResolvedValue([
      { id: 1, name: 'GitHub Enterprise', slug: 'github', authUrl: '/v1/auth/oidc/github/login' },
    ] as never);
    mockOf(useAuth).mockReturnValue(authValue() as never);
    const go = vi.spyOn(ssoNavigation, 'go').mockImplementation(() => undefined);
    try {
      renderWithProviders(<Login />, { initialEntries: ['/login?returnTo=%2F%2Fevil.example'] });
      await user.click(await screen.findByRole('button', { name: /GitHub Enterprise/ }));
      expect(new URL(go.mock.calls[0]![0], window.location.origin).searchParams.get('returnTo')).toBe('/');
    } finally {
      go.mockRestore();
      sessionStorage.clear();
    }
  });

  it('r505: a password sign-in ignores a protocol-relative returnTo', async () => {
    const user = userEvent.setup();
    const login = vi.fn().mockResolvedValue(undefined);
    mockOf(api.auth.status).mockResolvedValue({ initialized: true } as never);
    mockOf(useAuth).mockReturnValue(authValue({ login }) as never);
    renderWithProviders(
      <>
        <Login />
        <LocationProbe />
      </>,
      { initialEntries: ['/login?returnTo=%2F%2Fevil.example'] },
    );
    await user.type(await screen.findByPlaceholderText('you@example.com'), 'a@b.c');
    await user.type(screen.getByPlaceholderText('••••••••'), 'secret');
    await user.click(screen.getByRole('button', { name: /Sign in/ }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/));
  });

  it('r505: explains a refused SSO hand-off', async () => {
    mockOf(api.auth.status).mockResolvedValue({ initialized: true } as never);
    mockOf(useAuth).mockReturnValue(authValue({ ssoError: 'Single sign-on could not be completed — please sign in again.' }) as never);
    renderWithProviders(<Login />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/please sign in again/);
  });
});
