import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TwoFactorGate } from '../src/components/TwoFactorGate.js';
import { TwoFactorPolicyCard } from '../src/routes/workspaces/TwoFactorPolicyCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});
vi.mock('../src/lib/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth.js')>()),
  useAuth: () => ({ user: { id: 1 }, logout: vi.fn() }),
}));

describe('TwoFactorGate (G1.4)', () => {
  it('lets the app through when nothing is required', async () => {
    renderWithProviders(<TwoFactorGate><p>app</p></TwoFactorGate>);
    expect(await screen.findByText('app')).toBeTruthy();
  });

  it('shows the enrolment screen instead of the app while held', async () => {
    mockOf(api.auth.twoFactor.requirement).mockResolvedValue({ required: true, enrolled: false, verified: false, workspaces: [{ id: 2, name: 'Acme' }] } as never);
    renderWithProviders(<TwoFactorGate><p>app</p></TwoFactorGate>);
    expect(await screen.findByText('Two-factor authentication required')).toBeTruthy();
    expect(screen.getByText(/Acme requires two-factor authentication/)).toBeTruthy();
    expect(screen.getByText('Set up 2FA')).toBeTruthy();
    expect(screen.queryByText('app')).toBeNull();
  });

  it('asks an enrolled account to sign in again with its second factor', async () => {
    mockOf(api.auth.twoFactor.requirement).mockResolvedValue({ required: true, enrolled: true, verified: false, workspaces: [{ id: 2, name: 'Acme' }] } as never);
    renderWithProviders(<TwoFactorGate><p>app</p></TwoFactorGate>);
    expect(await screen.findByText(/Sign out, then sign in again with it/)).toBeTruthy();
    expect(screen.queryByText('Set up 2FA')).toBeNull();
  });
});

describe('TwoFactorPolicyCard (G1.4)', () => {
  it('turns the requirement on', async () => {
    mockOf(api.workspaces.twoFactor.set).mockResolvedValue({ required: true, ssoExemptProviders: [], membersWithout: 2 } as never);
    renderWithProviders(<TwoFactorPolicyCard workspaceId={3} />);
    await userEvent.click(await screen.findByRole('switch', { name: 'Require two-factor authentication' }));
    await waitFor(() => expect(api.workspaces.twoFactor.set).toHaveBeenCalledWith(3, { required: true, ssoExemptProviders: [] }));
    expect(await screen.findByText('2 members have no second factor yet')).toBeTruthy();
  });

  it('adds and removes only the selected SSO exemption and excludes GitHub', async () => {
    mockOf(api.workspaces.twoFactor.get).mockResolvedValue({ required: true, ssoExemptProviders: ['oidc:2'], membersWithout: 1 } as never);
    mockOf(api.auth.oidc.publicProviders).mockResolvedValue([
      { id: 2, slug: 'corp', name: 'Corporate SSO' },
      { id: 3, slug: 'partner', name: 'Partner SSO' },
      { id: 4, slug: 'github', name: 'GitHub' },
    ] as never);
    mockOf(api.workspaces.twoFactor.set).mockResolvedValueOnce({ required: true, ssoExemptProviders: ['oidc:2', 'oidc:3'], membersWithout: 1 } as never)
      .mockResolvedValueOnce({ required: true, ssoExemptProviders: ['oidc:3'], membersWithout: 1 } as never);
    renderWithProviders(<TwoFactorPolicyCard workspaceId={3} />);
    const partner = await screen.findByRole('checkbox', { name: 'Partner SSO' });
    expect(screen.queryByRole('checkbox', { name: 'GitHub' })).not.toBeInTheDocument();
    await userEvent.click(partner);
    await waitFor(() => expect(api.workspaces.twoFactor.set).toHaveBeenCalledWith(3, { required: true, ssoExemptProviders: ['oidc:2', 'oidc:3'] }));
    await waitFor(() => expect(partner).toBeChecked());
    await userEvent.click(screen.getByRole('checkbox', { name: 'Corporate SSO' }));
    await waitFor(() => expect(api.workspaces.twoFactor.set).toHaveBeenCalledWith(3, { required: true, ssoExemptProviders: ['oidc:3'] }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Corporate SSO' })).not.toBeChecked());
  });

  it('reports a refused policy change without claiming the requirement is enabled', async () => {
    mockOf(api.workspaces.twoFactor.get).mockResolvedValue({ required: false, ssoExemptProviders: [], membersWithout: 2 } as never);
    mockOf(api.auth.oidc.publicProviders).mockResolvedValue([] as never);
    mockOf(api.workspaces.twoFactor.set).mockRejectedValue(new Error('Verify your second factor first'));
    renderWithProviders(<TwoFactorPolicyCard workspaceId={3} />);
    const toggle = await screen.findByRole('switch', { name: 'Require two-factor authentication' });
    await userEvent.click(toggle);
    expect(await screen.findByText('Verify your second factor first')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
});
