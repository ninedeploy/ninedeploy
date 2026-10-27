import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from './web-utils.js';

const apiMock = vi.hoisted(() => ({
  api: {
    settings: { secretProviders: { list: vi.fn(), set: vi.fn(), delete: vi.fn(), test: vi.fn() } },
  },
}));
vi.mock('../src/lib/api.js', () => apiMock);

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', async () => {
  const actual = await vi.importActual<typeof import('../src/components/Toast.js')>('../src/components/Toast.js');
  return { ...actual, useToast: () => toastSpy };
});

import { REF_OP, REF_SSM, SecretManagersCard } from '../src/routes/settings/SecretManagersCard.js';

const sp = apiMock.api.settings.secretProviders;
const KINDS = ['vault', 'aws', 'gcp', 'azure', 'onepassword', 'exec'] as const;
const blank = (kind: string) => ({ kind, configured: false, enabled: false, config: {}, hasCredential: false, lastTestedAt: null, lastTestError: null });
const panel = (kind: string) => within(screen.getByTestId(`secret-provider-${kind}`));

describe('SecretManagersCard — G3.2 providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sp.list.mockResolvedValue(KINDS.map(blank));
    sp.set.mockImplementation(async (kind: string) => ({ ...blank(kind), configured: true }));
    sp.test.mockResolvedValue({ ok: true, detail: 'Token accepted (2 vault(s) visible)' });
  });

  it('shows every provider and the new reference forms', async () => {
    renderWithProviders(<SecretManagersCard />);
    for (const kind of KINDS) expect(await screen.findByTestId(`secret-provider-${kind}`)).toHaveTextContent('not configured');
    expect(screen.getByText(REF_SSM)).toBeInTheDocument();
    expect(screen.getByText(REF_OP)).toBeInTheDocument();
  });

  it('saves a GCP service account with an optional project', async () => {
    renderWithProviders(<SecretManagersCard />);
    await screen.findByTestId('secret-provider-gcp');
    const g = panel('gcp');
    expect(g.getByRole('button', { name: /Save/ })).toBeDisabled();
    fireEvent.change(g.getByLabelText('Service account key (JSON)'), { target: { value: '{"type":"service_account"}' } });
    fireEvent.click(g.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(sp.set).toHaveBeenCalledWith('gcp', { enabled: true, config: {}, credentials: { serviceAccountJson: '{"type":"service_account"}' } }));
    // The write-only key is cleared once saved.
    await waitFor(() => expect(g.getByLabelText('Service account key (JSON)')).toHaveValue(''));
  });

  it('asks for the Azure secret again when the app registration changes', async () => {
    sp.list.mockResolvedValue(
      KINDS.map((k) =>
        k === 'azure'
          ? {
              ...blank('azure'),
              configured: true,
              enabled: true,
              hasCredential: true,
              config: { vaultUrl: 'https://kv.vault.azure.net', tenantId: 't-1', clientId: 'c-1' },
            }
          : blank(k),
      ),
    );
    renderWithProviders(<SecretManagersCard />);
    await screen.findByTestId('secret-provider-azure');
    const a = panel('azure');
    expect(a.getByRole('button', { name: /Save/ })).toBeEnabled();
    // Another vault needs the secret again too (a vault.azure.net token works at any vault).
    fireEvent.change(a.getByLabelText('Vault URL'), { target: { value: 'https://other.vault.azure.net' } });
    expect(a.getByRole('button', { name: /Save/ })).toBeDisabled();
    fireEvent.change(a.getByLabelText('Vault URL'), { target: { value: 'https://kv.vault.azure.net/' } });
    expect(a.getByRole('button', { name: /Save/ })).toBeEnabled();
    fireEvent.change(a.getByLabelText('Client ID'), { target: { value: 'c-2' } });
    expect(a.getByRole('button', { name: /Save/ })).toBeDisabled();
    fireEvent.change(a.getByLabelText('Client secret'), { target: { value: 'cs' } });
    fireEvent.click(a.getByRole('button', { name: /Save/ }));
    await waitFor(() =>
      expect(sp.set).toHaveBeenCalledWith('azure', {
        enabled: true,
        // Sent as typed; the server drops the trailing slash.
        config: { vaultUrl: 'https://kv.vault.azure.net/', tenantId: 't-1', clientId: 'c-2' },
        credentials: { clientSecret: 'cs' },
      }),
    );
  });

  it('tests 1Password Connect with a probe reference', async () => {
    sp.list.mockResolvedValue(
      KINDS.map((k) =>
        k === 'onepassword'
          ? { ...blank(k), configured: true, enabled: true, hasCredential: true, config: { address: 'https://connect.example.com' } }
          : blank(k),
      ),
    );
    renderWithProviders(<SecretManagersCard />);
    await screen.findByTestId('secret-provider-onepassword');
    const o = panel('onepassword');
    fireEvent.change(o.getByLabelText(/Probe reference/), { target: { value: 'Prod/DB/password' } });
    fireEvent.click(o.getByRole('button', { name: /Test connection/ }));
    await waitFor(() => expect(sp.test).toHaveBeenCalledWith('onepassword', { probeName: 'Prod/DB/password' }));
    expect(await screen.findByTestId('secret-provider-onepassword-result')).toHaveTextContent('OK: Token accepted');
  });

  it('saves an exec argv one argument per line and needs an absolute path', async () => {
    renderWithProviders(<SecretManagersCard />);
    await screen.findByTestId('secret-provider-exec');
    const e = panel('exec');
    fireEvent.change(e.getByLabelText('Command'), { target: { value: 'bw\nget' } });
    expect(e.getByRole('button', { name: /Save/ })).toBeDisabled();
    fireEvent.change(e.getByLabelText('Command'), { target: { value: '/usr/bin/bw\n get \n\npassword\n{name}' } });
    fireEvent.change(e.getByLabelText('Timeout (seconds)'), { target: { value: '20' } });
    fireEvent.click(e.getByRole('button', { name: /Save/ }));
    await waitFor(() =>
      expect(sp.set).toHaveBeenCalledWith('exec', { enabled: true, config: { command: ['/usr/bin/bw', 'get', 'password', '{name}'], timeoutSeconds: 20 } }),
    );
    sp.set.mockRejectedValueOnce(new Error('The exec secret provider is off: start the panel with NINEDEPLOY_SECRET_EXEC=1 to allow it'));
    fireEvent.click(e.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith(expect.stringContaining('NINEDEPLOY_SECRET_EXEC=1'), 'error'));
  });
});
