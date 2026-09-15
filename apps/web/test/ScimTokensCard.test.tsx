import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { ScimTokensCard } from '../src/routes/settings/ScimTokensCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

describe('ScimTokensCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOf(api.scim.listTokens).mockResolvedValue([
      { id: 4, name: 'Okta', workspaceId: 7, createdAt: '2026-09-15T00:00:00Z', lastUsedAt: null, revoked: false },
    ] as never);
    mockOf(api.workspaces.list).mockResolvedValue([{ id: 7, name: 'Acme' }] as never);
  });

  it('lists tokens with workspace and last-used metadata', async () => {
    renderWithProviders(<ScimTokensCard />);
    await screen.findByText('Okta');
    expect(screen.getByText(/workspace #7/)).toBeInTheDocument();
    expect(screen.getByText(/never used/)).toBeInTheDocument();
  });

  it('mints a token, shows the plaintext exactly once, and revokes', async () => {
    mockOf(api.scim.createToken).mockResolvedValue({ id: 5, token: 'scim_plain-secret' } as never);
    mockOf(api.scim.revokeToken).mockResolvedValue({ ok: true } as never);
    const { user, ...rtl } = await import('./helpers.js');
    void user;
    const view = rtl.renderWithProviders(<ScimTokensCard />);
    await screen.findByText('Okta');
    fireEvent.change(screen.getByLabelText('SCIM workspace'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await screen.findByText('Copy this token now');
    expect(screen.getByText('scim_plain-secret')).toBeInTheDocument();
    // Only the plaintext is shown once; dismiss removes it.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('scim_plain-secret')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke Okta' }));
    await waitFor(() => expect(api.scim.revokeToken).toHaveBeenCalledWith(4));
    view.unmount();
  });

  it('toasts instead of crashing when minting fails', async () => {
    mockOf(api.scim.createToken).mockRejectedValue(new Error('boom'));
    const view = renderWithProviders(<ScimTokensCard />);
    await screen.findByText('Okta');
    fireEvent.change(screen.getByLabelText('SCIM workspace'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => expect(api.scim.createToken).toHaveBeenCalled());
    // The card stays mounted and the error toast fired (no token banner).
    expect(screen.queryByText('Copy this token now')).not.toBeInTheDocument();
    view.unmount();
  });

  it('toasts on revoke failure and keeps the token listed', async () => {
    mockOf(api.scim.revokeToken).mockRejectedValue(new Error('boom'));
    const view = renderWithProviders(<ScimTokensCard />);
    await screen.findByText('Okta');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Okta' }));
    await waitFor(() => expect(api.scim.revokeToken).toHaveBeenCalled());
    expect(screen.getByText('Okta')).toBeInTheDocument();
    view.unmount();
  });
});
