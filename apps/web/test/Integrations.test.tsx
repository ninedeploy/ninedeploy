import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntegrationsSection } from '../src/routes/settings/IntegrationsSection.js';
import { api } from '../src/lib/api.js';
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

describe('IntegrationsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOf(api.settings.vault.get).mockResolvedValue({ provider: '', hasToken: false } as never);
    mockOf(api.settings.dnsRecords.get).mockResolvedValue({ enabled: false, hasToken: false } as never);
  });

  it('renders both cards and keeps actions disabled without credentials', async () => {
    renderWithProviders(<IntegrationsSection />);
    expect(await screen.findByText('Vault provider')).toBeInTheDocument();
    expect(screen.getByText('Cloudflare DNS records')).toBeInTheDocument();
    // Vault save is disabled without a token; both test actions are disabled
    // without stored credentials. (DNS save is allowed while disabled-off.)
    expect(screen.getAllByRole('button', { name: 'Save' })[0]).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Test token' })).toBeDisabled();
  });

  it('saves vault settings with infisical defaults and tests the connection', async () => {
    const user = userEvent.setup();
    mockOf(api.settings.vault.get).mockResolvedValue({ provider: 'infisical', hasToken: true } as never);
    mockOf(api.settings.vault.set).mockResolvedValue(undefined as never);
    mockOf(api.settings.vault.test).mockResolvedValue({ secrets: 12 } as never);
    renderWithProviders(<IntegrationsSection />);

    await user.type(screen.getByPlaceholderText('Universal Auth / service token'), 'tok');
    await user.type(document.querySelector<HTMLInputElement>('input[placeholder="default"]')!, 'staging');
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]!);
    await waitFor(() =>
      expect(api.settings.vault.set).toHaveBeenCalledWith({
        provider: 'infisical',
        token: 'tok',
        projectId: '',
        environment: 'staging',
      }),
    );
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Vault settings saved', 'success'));

    const testBtn = screen.getByRole('button', { name: 'Test connection' });
    await waitFor(() => expect(testBtn).toBeEnabled());
    fireEvent.click(testBtn);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Connected — 12 secrets reachable', 'success'));
  });

  it('sends doppler-shaped vault settings and surfaces a test failure', async () => {
    const user = userEvent.setup();
    mockOf(api.settings.vault.set).mockResolvedValue(undefined as never);
    // A vault test failure is an exception (any 2xx response means success).
    mockOf(api.settings.vault.test).mockRejectedValue(new Error('bad token') as never);
    mockOf(api.settings.vault.get).mockResolvedValue({ provider: 'doppler', hasToken: true } as never);
    renderWithProviders(<IntegrationsSection />);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'doppler' } });
    await user.type(screen.getByPlaceholderText('Universal Auth / service token'), 'tok');
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]!);
    await waitFor(() =>
      expect(api.settings.vault.set).toHaveBeenCalledWith(expect.objectContaining({ provider: 'doppler', environment: 'dev' })),
    );

    const vaultTest = screen.getByRole('button', { name: 'Test connection' });
    await waitFor(() => expect(vaultTest).toBeEnabled());
    fireEvent.click(vaultTest);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('bad token', 'error'));
  });

  it('saves DNS record settings and reports token validity', async () => {
    const user = userEvent.setup();
    // After saving, the stored-token flag makes the test action available.
    mockOf(api.settings.dnsRecords.get).mockResolvedValue({ enabled: false, hasToken: true } as never);
    mockOf(api.settings.dnsRecords.set).mockResolvedValue(undefined as never);
    mockOf(api.settings.dnsRecords.test).mockResolvedValue({ ok: true, status: 'active' } as never);
    renderWithProviders(<IntegrationsSection />);

    fireEvent.click(screen.getByRole('checkbox'));
    await user.type(screen.getByPlaceholderText('Zone:DNS:Edit-capable token'), 'cf-tok');
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[1]!);
    await waitFor(() =>
      expect(api.settings.dnsRecords.set).toHaveBeenCalledWith({ enabled: true, token: 'cf-tok' }),
    );
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('DNS records settings saved', 'success'));

    const dnsTest = screen.getByRole('button', { name: 'Test token' });
    await waitFor(() => expect(dnsTest).toBeEnabled());
    fireEvent.click(dnsTest);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Token valid (active)', 'success'));
  });

  it('sends the workspace id with vault settings', async () => {
    const user = userEvent.setup();
    mockOf(api.settings.vault.get).mockResolvedValue({ provider: 'infisical', hasToken: true } as never);
    mockOf(api.settings.vault.set).mockResolvedValue(undefined as never);
    renderWithProviders(<IntegrationsSection />);

    const projectId = screen.getByText('Workspace ID').parentElement!.querySelector('input')!;
    await user.type(projectId, 'ws-42');
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]!);
    await waitFor(() =>
      expect(api.settings.vault.set).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'ws-42', environment: 'default' })),
    );
  });

  it('reports vault save failures with and without a message', async () => {
    mockOf(api.settings.vault.get).mockResolvedValue({ provider: 'infisical', hasToken: true } as never);
    mockOf(api.settings.vault.set).mockRejectedValueOnce(new Error('vault locked') as never);
    const first = renderWithProviders(<IntegrationsSection />);
    const save1 = (await screen.findAllByRole('button', { name: 'Save' }))[0]!;
    await waitFor(() => expect(save1).toBeEnabled());
    fireEvent.click(save1);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('vault locked', 'error'));
    first.unmount();

    mockOf(api.settings.vault.set).mockRejectedValueOnce('boom' as never);
    renderWithProviders(<IntegrationsSection />);
    const save2 = (await screen.findAllByRole('button', { name: 'Save' }))[0]!;
    await waitFor(() => expect(save2).toBeEnabled());
    fireEvent.click(save2);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Save failed', 'error'));
  });

  it('reports a generic vault connection failure for non-Error rejections', async () => {
    mockOf(api.settings.vault.get).mockResolvedValue({ provider: 'doppler', hasToken: true } as never);
    mockOf(api.settings.vault.test).mockRejectedValueOnce('offline' as never);
    renderWithProviders(<IntegrationsSection />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'doppler' } });
    const testBtn = screen.getByRole('button', { name: 'Test connection' });
    await waitFor(() => expect(testBtn).toBeEnabled());
    fireEvent.click(testBtn);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Connection failed', 'error'));
  });

  it('sends the record content with DNS settings', async () => {
    const user = userEvent.setup();
    mockOf(api.settings.dnsRecords.get).mockResolvedValue({ enabled: false, hasToken: true } as never);
    mockOf(api.settings.dnsRecords.set).mockResolvedValue(undefined as never);
    renderWithProviders(<IntegrationsSection />);
    await user.type(screen.getByPlaceholderText('203.0.113.10 or cname.example.com'), 'cname.example.com');
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[1]!);
    await waitFor(() =>
      expect(api.settings.dnsRecords.set).toHaveBeenCalledWith({ enabled: false, content: 'cname.example.com' }),
    );
  });

  it('reports DNS save and test failures', async () => {
    mockOf(api.settings.dnsRecords.get).mockResolvedValue({ enabled: false, hasToken: true } as never);
    mockOf(api.settings.dnsRecords.set).mockRejectedValueOnce(new Error('zone denied') as never);
    mockOf(api.settings.dnsRecords.test).mockRejectedValueOnce(new Error('bad token') as never);
    const first = renderWithProviders(<IntegrationsSection />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Save' }))[1]!);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('zone denied', 'error'));
    fireEvent.click(screen.getByRole('button', { name: 'Test token' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('bad token', 'error'));
    first.unmount();

    mockOf(api.settings.dnsRecords.set).mockRejectedValueOnce('boom' as never);
    mockOf(api.settings.dnsRecords.test).mockRejectedValueOnce('boom' as never);
    renderWithProviders(<IntegrationsSection />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Save' }))[1]!);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Save failed', 'error'));
    fireEvent.click(screen.getByRole('button', { name: 'Test token' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Connection failed', 'error'));
  });

  it('enables the vault test via a typed token and shows pending labels', async () => {
    const user = userEvent.setup();
    // No stored token, but a freshly typed one counts as initialized.
    mockOf(api.settings.vault.get).mockResolvedValue({ provider: 'infisical', hasToken: false } as never);
    renderWithProviders(<IntegrationsSection />);
    await screen.findByText('Vault provider');
    await user.type(screen.getByPlaceholderText('Universal Auth / service token'), 'fresh-tok');
    const testBtn = screen.getByRole('button', { name: 'Test connection' });
    await waitFor(() => expect(testBtn).toBeEnabled());
    // Test in flight → pending label; then it resolves.
    mockOf(api.settings.vault.test).mockReturnValueOnce(new Promise(() => {}) as never);
    fireEvent.click(testBtn);
    expect(await screen.findByText('Testing…')).toBeInTheDocument();
  });

  it('shows the vault saving label while a save is in flight', async () => {
    mockOf(api.settings.vault.get).mockResolvedValue({ provider: 'infisical', hasToken: true } as never);
    mockOf(api.settings.vault.set).mockReturnValueOnce(new Promise(() => {}) as never);
    renderWithProviders(<IntegrationsSection />);
    const save = (await screen.findAllByRole('button', { name: 'Save' }))[0]!;
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(await screen.findByText('Saving…')).toBeInTheDocument();
  });

  it('covers DNS token test result fallbacks', async () => {
    mockOf(api.settings.dnsRecords.get).mockResolvedValue({ enabled: false, hasToken: true } as never);
    mockOf(api.settings.dnsRecords.test)
      .mockResolvedValueOnce({ ok: true } as never) // no status → "active"
      .mockResolvedValueOnce({ ok: false } as never); // no error → "Token invalid"
    renderWithProviders(<IntegrationsSection />);
    const test = await screen.findByRole('button', { name: 'Test token' });
    await waitFor(() => expect(test).toBeEnabled());
    fireEvent.click(test);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Token valid (active)', 'success'));
    fireEvent.click(test);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Token invalid', 'error'));
  });

  it('shows DNS saving and testing pending labels', async () => {
    mockOf(api.settings.dnsRecords.get).mockResolvedValue({ enabled: false, hasToken: true } as never);
    mockOf(api.settings.dnsRecords.set).mockReturnValueOnce(new Promise(() => {}) as never);
    mockOf(api.settings.dnsRecords.test).mockReturnValueOnce(new Promise(() => {}) as never);
    renderWithProviders(<IntegrationsSection />);
    const save = (await screen.findAllByRole('button', { name: 'Save' }))[1]!;
    const test = await screen.findByRole('button', { name: 'Test token' });
    await waitFor(() => expect(test).toBeEnabled());
    fireEvent.click(save);
    expect(await screen.findByText('Saving…')).toBeInTheDocument();
    fireEvent.click(test);
    expect(await screen.findByText('Testing…')).toBeInTheDocument();
  });

  it('reports an invalid DNS token', async () => {
    mockOf(api.settings.dnsRecords.get).mockResolvedValue({ enabled: true, hasToken: true } as never);
    mockOf(api.settings.dnsRecords.test).mockResolvedValue({ ok: false, error: 'denied' } as never);
    renderWithProviders(<IntegrationsSection />);
    const dnsTest = await screen.findByRole('button', { name: 'Test token' });
    await waitFor(() => expect(dnsTest).toBeEnabled());
    fireEvent.click(dnsTest);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('denied', 'error'));
  });

  it('saves Namecheap credentials trimmed and clears the key on success', async () => {
    const user = userEvent.setup();
    mockOf(api.settings.namecheap.get).mockResolvedValue({ apiUser: '', hasKey: false } as never);
    mockOf(api.settings.namecheap.set).mockResolvedValue(undefined as never);
    renderWithProviders(<IntegrationsSection />);

    await user.type(screen.getByPlaceholderText('account-owner-username'), '  ncuser ');
    await user.type(screen.getByPlaceholderText('Namecheap API key'), ' nck3y ');
    await user.type(screen.getByPlaceholderText('203.0.113.10'), '203.0.113.10');
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[2]!);
    await waitFor(() =>
      expect(api.settings.namecheap.set).toHaveBeenCalledWith({
        apiUser: 'ncuser',
        apiKey: 'nck3y',
        clientIp: '203.0.113.10',
      }),
    );
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Namecheap credentials saved', 'success'));
    // The key is never pre-populated from the server — cleared after a save.
    expect(screen.getByPlaceholderText('Namecheap API key')).toHaveValue('');
  });

  it('reports Namecheap save failures', async () => {
    const user = userEvent.setup();
    mockOf(api.settings.namecheap.get).mockResolvedValue({ apiUser: '', hasKey: false } as never);
    mockOf(api.settings.namecheap.set).mockRejectedValue(new Error('IP not whitelisted') as never);
    renderWithProviders(<IntegrationsSection />);

    await user.type(screen.getByPlaceholderText('account-owner-username'), 'ncuser');
    await user.type(screen.getByPlaceholderText('Namecheap API key'), 'nck3y');
    await user.type(screen.getByPlaceholderText('203.0.113.10'), '203.0.113.10');
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[2]!);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('IP not whitelisted', 'error'));
  });
});
