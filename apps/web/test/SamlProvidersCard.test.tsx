import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
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
});
