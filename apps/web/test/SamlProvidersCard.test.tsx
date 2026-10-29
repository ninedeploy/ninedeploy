import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SamlProvidersCard } from '../src/routes/settings/SamlProvidersCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

describe('SamlProvidersCard (G3.6)', () => {
  beforeEach(() => {
    mockOf(api.sso.listProviders).mockReset().mockResolvedValue({ providers: [] } as never);
    mockOf(api.sso.addProvider).mockReset();
    mockOf(api.sso.removeProvider).mockReset();
  });
  it('lists SAML providers with their metadata URL and adds one', async () => {
    mockOf(api.sso.listProviders).mockResolvedValue({ providers: [{ id: 3, type: 'saml', name: 'corp', createdAt: '' }, { id: 4, type: 'oidc', name: 'gh', createdAt: '' }] } as never);
    mockOf(api.sso.addProvider).mockResolvedValue({ ok: true, id: 5 } as never);
    renderWithProviders(<SamlProvidersCard />);
    expect(await screen.findByText(/\/v1\/auth\/saml\/3\/metadata$/)).toBeTruthy();
    expect(screen.queryByText('gh')).toBeNull();
    await userEvent.type(screen.getByLabelText('Name'), 'okta');
    await userEvent.type(screen.getByLabelText('Email domains'), 'corp.example');
    fireEvent.change(screen.getByLabelText('IdP metadata XML'), { target: { value: '<EntityDescriptor/>' } });
    await userEvent.click(screen.getByRole('button', { name: 'Add SAML provider' }));
    await waitFor(() =>
      expect(api.sso.addProvider).toHaveBeenCalledWith({ type: 'saml', name: 'okta', config: { idpMetadataXml: '<EntityDescriptor/>', emailDomains: ['corp.example'] } }),
    );
  });

  it('requires confirmation before removing an identity provider', async () => {
    mockOf(api.sso.listProviders).mockResolvedValue({ providers: [{ id: 3, type: 'saml', name: 'corp', createdAt: '' }] } as never);
    mockOf(api.sso.removeProvider).mockResolvedValue({ ok: true } as never);
    renderWithProviders(<SamlProvidersCard />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete corp' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Everyone signing in through it falls back to password login/)).toBeInTheDocument();
    expect(api.sso.removeProvider).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.sso.removeProvider).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete corp' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.sso.removeProvider).toHaveBeenCalledWith(3));
  });

  it('keeps the entered SAML settings when the provider rejects them', async () => {
    mockOf(api.sso.addProvider).mockResolvedValue({ ok: false, error: 'Invalid metadata' } as never);
    renderWithProviders(<SamlProvidersCard />);
    const name = await screen.findByLabelText('Name');
    const submit = screen.getByRole('button', { name: 'Add SAML provider' });
    expect(submit).toBeDisabled();
    await userEvent.type(name, 'corp');
    await userEvent.type(screen.getByLabelText('Email domains'), 'EXAMPLE.COM');
    fireEvent.change(screen.getByLabelText('IdP metadata XML'), { target: { value: '<bad/>' } });
    await userEvent.click(submit);
    expect(await screen.findByText('Invalid metadata')).toBeInTheDocument();
    expect(name).toHaveValue('corp');
    expect(api.sso.addProvider).toHaveBeenCalledWith({ type: 'saml', name: 'corp', config: { idpMetadataXml: '<bad/>', emailDomains: ['example.com'] } });
  });
});
