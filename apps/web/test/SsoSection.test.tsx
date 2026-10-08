import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { OIDC_DEFAULT_ROLE_NOTE, parseAllowedDomains, SsoSection } from '../src/routes/settings/SsoSection.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

describe('SsoSection', () => {
  const mockProviders = [
    {
      id: 1,
      name: 'Google Workspace',
      slug: 'google',
      issuerUrl: 'https://accounts.google.com',
      clientId: 'google-client-id',
      scopes: 'openid profile email',
      enabled: true,
      autoEnroll: true,
      defaultRole: 'member' as const,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockOf(api.auth.oidc.list).mockResolvedValue(mockProviders as never);
  });

  it('renders SSO providers list', async () => {
    renderWithProviders(<SsoSection />);

    await waitFor(() => {
      expect(screen.getByText('Single Sign-On (SSO & OIDC)')).toBeInTheDocument();
      expect(screen.getByText('Google Workspace')).toBeInTheDocument();
      expect(screen.getByText(/slug: google/)).toBeInTheDocument();
    });
  });

  it('renders a disabled provider without the auto-enroll chip', async () => {
    mockOf(api.auth.oidc.list).mockResolvedValue([
      { ...mockProviders[0], enabled: false, autoEnroll: false },
    ] as never);
    renderWithProviders(<SsoSection />);
    expect(await screen.findByText('Disabled')).toBeInTheDocument();
    expect(screen.queryByText(/auto-enroll/i)).not.toBeInTheDocument();
  });

  it('preloads the Google preset, ignores empty submits and maps string failures', async () => {
    renderWithProviders(<SsoSection />);
    await screen.findByText('Google Workspace');

    // The Google quick preset prefills the create form.
    fireEvent.click(screen.getByRole('button', { name: /google oidc/i }));
    expect(screen.getByText('Configure SSO / OIDC Provider')).toBeInTheDocument();
    expect((screen.getByPlaceholderText('e.g. Google Workspace') as HTMLInputElement).value).toBe('Google Workspace');

    // A raw submit with the client id missing is a no-op.
    const form = screen.getByPlaceholderText('OAuth Client ID').closest('form')!;
    fireEvent.submit(form);
    expect(api.auth.oidc.create).not.toHaveBeenCalled();

    // Typing the issuer/secret wires the form fields.
    fireEvent.change(screen.getByPlaceholderText('https://accounts.google.com or https://your-tenant.okta.com'), {
      target: { value: 'https://accounts.google.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('OAuth Client ID'), { target: { value: 'g-cid' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••••••'), { target: { value: 'g-sec' } });

    // A non-Error rejection surfaces the generic message.
    mockOf(api.auth.oidc.create).mockRejectedValueOnce('boom' as never);
    fireEvent.click(screen.getByRole('button', { name: 'Create Provider' }));
    expect(await screen.findByText('Failed to save SSO provider')).toBeInTheDocument();
  });

  it('edits a provider without an issuer URL', async () => {
    mockOf(api.auth.oidc.list).mockResolvedValue([
      { ...mockProviders[0], issuerUrl: null },
    ] as never);
    mockOf(api.auth.oidc.update).mockResolvedValueOnce({ ...mockProviders[0], name: 'Renamed' } as never);
    renderWithProviders(<SsoSection />);
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    const form = screen.getByPlaceholderText('e.g. Google Workspace').closest('form')!;
    // Leave the (empty) issuer blank → the update sends null.
    const nameInput = screen.getByPlaceholderText('e.g. Google Workspace') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Renamed' } });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(api.auth.oidc.update).toHaveBeenCalledWith(1, expect.objectContaining({
        issuerUrl: null,
        name: 'Renamed',
      })));
  });

  it('adds an SSO provider via quick preset', async () => {
    mockOf(api.auth.oidc.create).mockResolvedValueOnce({
      id: 2,
      name: 'GitHub',
      slug: 'github',
      issuerUrl: null,
      clientId: 'gh-cid',
      scopes: 'read:user user:email',
      enabled: true,
      autoEnroll: true,
      defaultRole: 'member',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    } as never);

    renderWithProviders(<SsoSection />);

    await waitFor(() => {
      expect(screen.getByText('Google Workspace')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('GitHub OAuth'));
    expect(screen.getByText('Configure SSO / OIDC Provider')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('OAuth Client ID'), {
      target: { value: 'gh-cid' },
    });
    fireEvent.change(screen.getByPlaceholderText('••••••••••••'), {
      target: { value: 'gh-csec' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create Provider' }));

    await waitFor(() => {
      expect(api.auth.oidc.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'GitHub',
          slug: 'github',
          clientId: 'gh-cid',
          clientSecret: 'gh-csec',
        }),
      );
    });
  });

  it('edits an SSO provider', async () => {
    mockOf(api.auth.oidc.update).mockResolvedValueOnce({
      ...mockProviders[0],
      name: 'Google Enterprise',
    } as never);

    renderWithProviders(<SsoSection />);

    await waitFor(() => {
      expect(screen.getByText('Google Workspace')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByText('Edit Google Workspace')).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('Google Workspace'), {
      target: { value: 'Google Enterprise' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(api.auth.oidc.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          name: 'Google Enterprise',
        }),
      );
    });
  });

  it('deletes an SSO provider via the confirm dialog (r402)', async () => {
    mockOf(api.auth.oidc.delete).mockResolvedValueOnce({ ok: true } as never);

    renderWithProviders(<SsoSection />);

    await waitFor(() => {
      expect(screen.getByText('Google Workspace')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('Delete Provider'));
    // The native confirm() is gone; the app-wide dialog replaces it.
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(api.auth.oidc.delete).toHaveBeenCalledWith(1);
    });
  });

  it('r402: a failed provider deletion renders its error instead of dying silently', async () => {
    mockOf(api.auth.oidc.delete).mockRejectedValueOnce(new Error('boom') as never);

    renderWithProviders(<SsoSection />);
    fireEvent.click(await screen.findByTitle('Delete Provider'));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(await screen.findByText(/Could not delete the provider/)).toBeInTheDocument();
  });

  it('shows the empty state when no providers are configured', async () => {
    mockOf(api.auth.oidc.list).mockResolvedValue([] as never);
    renderWithProviders(<SsoSection />);
    expect(await screen.findByText(/No SSO providers configured/)).toBeInTheDocument();
  });

  it('requires slug and client secret when creating', async () => {
    renderWithProviders(<SsoSection />);
    await waitFor(() => expect(screen.getByText('Google Workspace')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Add Provider'));
    fireEvent.change(screen.getByPlaceholderText('e.g. Google Workspace'), { target: { value: 'Custom' } });
    fireEvent.change(screen.getByPlaceholderText('OAuth Client ID'), { target: { value: 'cid-2' } });
    // Bypass DOM required-validation to exercise the handler's own guard.
    fireEvent.submit(screen.getByPlaceholderText('e.g. Google Workspace').closest('form')!);

    expect(await screen.findByText('Slug and Client Secret are required')).toBeInTheDocument();
    expect(api.auth.oidc.create).not.toHaveBeenCalled();
  });

  it('normalizes the slug and honors the toggles when creating', async () => {
    mockOf(api.auth.oidc.create).mockResolvedValueOnce(mockProviders[0] as never);
    renderWithProviders(<SsoSection />);
    await waitFor(() => expect(screen.getByText('Google Workspace')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Add Provider'));
    fireEvent.change(screen.getByPlaceholderText('e.g. Google Workspace'), { target: { value: 'Authentik' } });
    // The slug input lowercases and strips invalid characters.
    fireEvent.change(screen.getByPlaceholderText('e.g. google or okta'), { target: { value: 'My IdP!' } });
    fireEvent.change(screen.getByPlaceholderText('OAuth Client ID'), { target: { value: 'cid-3' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••••••'), { target: { value: 's3cret' } });
    fireEvent.click(screen.getByLabelText('Enable SSO on login page'));
    fireEvent.click(screen.getByLabelText('Auto-enroll new users on first login'));
    fireEvent.click(screen.getByRole('button', { name: 'Create Provider' }));

    await waitFor(() => {
      expect(api.auth.oidc.create).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Authentik',
        slug: 'myidp',
        enabled: false,
        autoEnroll: false,
      }));
    });
    // F1014: the deprecated OIDC defaultRole is no longer sent.
    expect('defaultRole' in (mockOf(api.auth.oidc.create).mock.calls[0]![0] as object)).toBe(false);
    // The modal closes after a successful save.
    await waitFor(() =>
      expect(screen.queryByText('Configure SSO / OIDC Provider')).not.toBeInTheDocument());
  });

  it('keeps the stored secret when an edit leaves it blank', async () => {
    mockOf(api.auth.oidc.update).mockResolvedValueOnce(mockProviders[0] as never);
    renderWithProviders(<SsoSection />);
    await waitFor(() => expect(screen.getByText('Google Workspace')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));
    await screen.findByText('Edit Google Workspace');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(api.auth.oidc.update).toHaveBeenCalled());
    const sent = mockOf(api.auth.oidc.update).mock.calls[0]![1] as Record<string, unknown>;
    expect(sent).toEqual(expect.objectContaining({ name: 'Google Workspace' }));
    // Blank secret means "keep the stored one": the key is not sent at all.
    expect('clientSecret' in sent).toBe(false);
  });

  it('sends the typed secret on rotation and surfaces save failures', async () => {
    mockOf(api.auth.oidc.update).mockResolvedValueOnce(mockProviders[0] as never);
    renderWithProviders(<SsoSection />);
    await waitFor(() => expect(screen.getByText('Google Workspace')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));
    await screen.findByText('Edit Google Workspace');
    const secretField = screen.getByPlaceholderText('••••••••••••');
    fireEvent.change(secretField, { target: { value: 'rotated-fixture-secret' } });
    // Assert with the value read back from the form field.
    const typedSecret = (secretField as HTMLInputElement).value;
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(api.auth.oidc.update).toHaveBeenCalledWith(1, expect.objectContaining({
        clientSecret: typedSecret,
      }));
    });

    // Failure path surfaces the server message in the form.
    mockOf(api.auth.oidc.update).mockRejectedValueOnce(new Error('slug already exists') as never);
    fireEvent.click(screen.getByText('Edit'));
    await screen.findByText('Edit Google Workspace');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText('slug already exists')).toBeInTheDocument();
  });

  it('keeps the provider when the delete confirm is dismissed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    renderWithProviders(<SsoSection />);
    await waitFor(() => expect(screen.getByText('Google Workspace')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Delete Provider'));
    expect(api.auth.oidc.delete).not.toHaveBeenCalled();
  });

  it('cancels out of the create modal without saving', async () => {
    renderWithProviders(<SsoSection />);
    await waitFor(() => expect(screen.getByText('Google Workspace')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Okta / Auth0'));
    expect(screen.getByDisplayValue('Okta Enterprise')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByText('Configure SSO / OIDC Provider')).not.toBeInTheDocument());
    expect(api.auth.oidc.create).not.toHaveBeenCalled();
  });

  it('closes the create modal via the dialog backdrop', async () => {
    renderWithProviders(<SsoSection />);
    await waitFor(() => expect(screen.getByText('Google Workspace')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Add Provider'));
    await screen.findByText('Configure SSO / OIDC Provider');
    fireEvent.click(screen.getAllByLabelText('Close dialog')[0]!);
    await waitFor(() =>
      expect(screen.queryByText('Configure SSO / OIDC Provider')).not.toBeInTheDocument());
  });

  // ── r507: allowed email domains ──────────────────────────────────────────
  describe('r507: allowed email domains', () => {
    it('warns about open enrollment when auto-enroll has no domain list', async () => {
      renderWithProviders(<SsoSection />);
      expect(await screen.findByText('Any domain')).toBeInTheDocument();
      expect(screen.getByText(/Auto-enroll is on with no domain restriction/)).toBeInTheDocument();
    });

    it('lists the domains and drops the warning once a provider is restricted', async () => {
      mockOf(api.auth.oidc.list).mockResolvedValue([{ ...mockProviders[0], allowedDomains: ['corp.com', 'corp.io'] }] as never);
      renderWithProviders(<SsoSection />);
      expect(await screen.findByText(/domains: corp.com, corp.io/)).toBeInTheDocument();
      expect(screen.queryByText('Any domain')).not.toBeInTheDocument();
      expect(screen.queryByText(/Auto-enroll is on with no domain restriction/)).not.toBeInTheDocument();
    });

    it('sends the normalised list on create, and the form warning follows the field', async () => {
      mockOf(api.auth.oidc.list).mockResolvedValue([] as never);
      mockOf(api.auth.oidc.create).mockResolvedValueOnce({ ...mockProviders[0], id: 3 } as never);
      renderWithProviders(<SsoSection />);
      fireEvent.click(await screen.findByText('GitHub OAuth'));
      // Auto-enroll defaults on with an empty list → the form warns.
      expect(screen.getByText(/Auto-enroll is on with no domain restriction/)).toBeInTheDocument();
      fireEvent.change(screen.getByPlaceholderText('corp.com, corp.io'), { target: { value: '@Corp.com, corp.io corp.com' } });
      expect(screen.queryByText(/Auto-enroll is on with no domain restriction/)).not.toBeInTheDocument();
      fireEvent.change(screen.getByPlaceholderText('OAuth Client ID'), { target: { value: 'gh-cid' } });
      fireEvent.change(screen.getByPlaceholderText('••••••••••••'), { target: { value: 'gh-csec' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create Provider' }));
      await waitFor(() =>
        expect(api.auth.oidc.create).toHaveBeenCalledWith(expect.objectContaining({ allowedDomains: ['corp.com', 'corp.io'] })));
    });

    it('prefills the list when editing and sends it back on save', async () => {
      mockOf(api.auth.oidc.list).mockResolvedValue([{ ...mockProviders[0], allowedDomains: ['corp.com'] }] as never);
      mockOf(api.auth.oidc.update).mockResolvedValueOnce(mockProviders[0] as never);
      renderWithProviders(<SsoSection />);
      fireEvent.click(await screen.findByText('Edit'));
      const field = screen.getByPlaceholderText('corp.com, corp.io') as HTMLInputElement;
      expect(field.value).toBe('corp.com');
      fireEvent.change(field, { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
      await waitFor(() => expect(api.auth.oidc.update).toHaveBeenCalledWith(1, expect.objectContaining({ allowedDomains: [] })));
    });

    it('parseAllowedDomains splits, lower-cases, strips @ and de-duplicates', () => {
      expect(parseAllowedDomains(' @A.com,b.io;  a.com   c.dev ')).toEqual(['a.com', 'b.io', 'c.dev']);
      expect(parseAllowedDomains('')).toEqual([]);
    });
  });
});

// F1014: an OIDC provider's defaultRole has no effect since D1/F146 (a user it
// enrolls always owns their personal workspace; OIDC maps into no team
// workspace). The form replaces the role picker with one explanatory line and
// stops sending the field; the API still accepts it and stored values stay.
describe('SsoSection — deprecated OIDC default role (F1014)', () => {
  const stored = {
    id: 9,
    name: 'Okta',
    slug: 'okta',
    issuerUrl: 'https://corp.okta.com',
    clientId: 'okta-cid',
    scopes: 'openid profile email',
    enabled: true,
    autoEnroll: true,
    defaultRole: 'admin' as const,
    allowedDomains: ['corp.com'],
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockOf(api.auth.oidc.list).mockResolvedValue([stored] as never);
  });

  it('the create form shows the note instead of a role picker', async () => {
    renderWithProviders(<SsoSection />);
    await screen.findByText('Okta');
    fireEvent.click(screen.getByText('Add Provider'));
    const form = screen.getByPlaceholderText('OAuth Client ID').closest('form')!;
    expect(form.textContent).toContain(OIDC_DEFAULT_ROLE_NOTE);
    expect(OIDC_DEFAULT_ROLE_NOTE).toMatch(/Not used for OIDC sign-ins/);
    expect(within(form).queryByRole('combobox')).toBeNull();
    expect(within(form).queryByText(/Default User Role/i)).toBeNull();
    expect(within(form).queryByText(/instance management/i)).toBeNull();
  });

  it('the provider list no longer shows the stored role', async () => {
    renderWithProviders(<SsoSection />);
    await screen.findByText('Okta');
    expect(screen.getByText(/slug: okta/)).toBeInTheDocument();
    expect(screen.queryByText(/role: admin/)).toBeNull();
  });

  it('editing a provider with a stored role leaves that field out of the PATCH', async () => {
    mockOf(api.auth.oidc.update).mockResolvedValueOnce(stored as never);
    renderWithProviders(<SsoSection />);
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    const form = screen.getByPlaceholderText('OAuth Client ID').closest('form')!;
    expect(form.textContent).toContain(OIDC_DEFAULT_ROLE_NOTE);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.auth.oidc.update).toHaveBeenCalled());
    const [id, sent] = mockOf(api.auth.oidc.update).mock.calls[0]! as [number, Record<string, unknown>];
    expect(id).toBe(9);
    expect(sent).toEqual(expect.objectContaining({ name: 'Okta', autoEnroll: true, allowedDomains: ['corp.com'] }));
    expect('defaultRole' in sent).toBe(false);
  });
});
