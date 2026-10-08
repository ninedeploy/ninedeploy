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

import { REF_AWS, REF_VAULT, SecretManagersCard } from '../src/routes/settings/SecretManagersCard.js';

const sp = apiMock.api.settings.secretProviders;
const blank = (kind: 'vault' | 'aws') => ({
  kind, configured: false, enabled: false, config: {}, hasCredential: false, lastTestedAt: null, lastTestError: null,
});
const vaultConfigured = {
  kind: 'vault', configured: true, enabled: true, hasCredential: true,
  config: { address: 'https://vault.example', mount: 'kv', authMethod: 'token', namespace: 'team', approleMount: 'approle' },
  lastTestedAt: '2026-10-08T09:00:00.000Z', lastTestError: null,
};
const awsConfigured = {
  kind: 'aws', configured: true, enabled: false, hasCredential: true,
  config: { region: 'eu-west-1', roleArn: 'arn:aws:iam::123456789012:role/nd', roleSessionName: 'ninedeploy' },
  lastTestedAt: '2026-10-08T09:00:00.000Z', lastTestError: 'AccessDenied <b>not html</b>',
};

const panel = (kind: 'vault' | 'aws') => within(screen.getByTestId(`secret-provider-${kind}`));

describe('SecretManagersCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sp.list.mockResolvedValue([blank('vault'), blank('aws')]);
    sp.set.mockImplementation(async (kind: string) => ({ ...blank(kind as 'vault'), configured: true }));
  });

  it('explains the reference syntax and shows both providers unconfigured', async () => {
    renderWithProviders(<SecretManagersCard />);
    expect(await screen.findByTestId('secret-provider-vault')).toHaveTextContent('not configured');
    expect(screen.getByText(REF_VAULT)).toBeInTheDocument();
    expect(screen.getByText(REF_AWS)).toBeInTheDocument();
    expect(REF_VAULT).toBe('$' + '{{vault:path/to/secret#field}}');
    // Nothing saved yet: nothing to save, test or remove.
    expect(panel('vault').getByRole('button', { name: /Save/ })).toBeDisabled();
    expect(panel('vault').getByRole('button', { name: /Test connection/ })).toBeDisabled();
    expect(panel('vault').queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
  });

  it('saves a Vault token setup with only the filled credential', async () => {
    renderWithProviders(<SecretManagersCard />);
    const v = await screen.findByTestId('secret-provider-vault').then(() => panel('vault'));
    fireEvent.change(v.getByLabelText('Vault address'), { target: { value: ' https://vault.example ' } });
    fireEvent.change(v.getByLabelText('KV v2 mount'), { target: { value: ' ' } });
    fireEvent.change(v.getByLabelText('Vault token'), { target: { value: ' hvs.secret ' } });
    fireEvent.click(v.getByRole('button', { name: /Save/ }));
    await waitFor(() =>
      expect(sp.set).toHaveBeenCalledWith('vault', {
        enabled: true,
        config: { address: 'https://vault.example', mount: 'secret', authMethod: 'token' },
        credentials: { token: 'hvs.secret' },
      }),
    );
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('HashiCorp Vault / OpenBao saved', 'success'));
    // The write-only token is forgotten after the save.
    expect(v.getByLabelText('Vault token')).toHaveValue('');
  });

  it('saves a Vault AppRole setup with a namespace and approle mount', async () => {
    renderWithProviders(<SecretManagersCard />);
    await screen.findByTestId('secret-provider-vault');
    const v = panel('vault');
    fireEvent.change(v.getByLabelText('Vault address'), { target: { value: 'https://vault.example' } });
    fireEvent.change(v.getByLabelText('Namespace'), { target: { value: 'team' } });
    fireEvent.change(v.getByLabelText('Auth method'), { target: { value: 'approle' } });
    fireEvent.change(v.getByLabelText('AppRole mount'), { target: { value: '' } });
    fireEvent.change(v.getByLabelText('Role ID'), { target: { value: 'role' } });
    expect(v.getByRole('button', { name: /Save/ })).toBeDisabled();
    fireEvent.change(v.getByLabelText('Secret ID'), { target: { value: 'sid' } });
    fireEvent.click(v.getByRole('switch', { name: /enabled/ }));
    fireEvent.click(v.getByRole('button', { name: /Save/ }));
    await waitFor(() =>
      expect(sp.set).toHaveBeenCalledWith('vault', {
        enabled: false,
        config: { address: 'https://vault.example', mount: 'secret', authMethod: 'approle', namespace: 'team', approleMount: 'approle' },
        credentials: { roleId: 'role', secretId: 'sid' },
      }),
    );
    await waitFor(() => expect(v.getByLabelText('Role ID')).toHaveValue(''));
    expect(v.getByLabelText('Secret ID')).toHaveValue('');
  });

  it('prefills a configured provider and keeps stored credentials when they are left blank', async () => {
    sp.list.mockResolvedValue([vaultConfigured, awsConfigured]);
    renderWithProviders(<SecretManagersCard />);
    await screen.findByTestId('secret-provider-vault');
    const v = panel('vault');
    expect(v.getByLabelText('Vault address')).toHaveValue('https://vault.example');
    expect(v.getByLabelText('KV v2 mount')).toHaveValue('kv');
    expect(v.getByText('stored — blank keeps it')).toBeInTheDocument();
    expect(v.getByText(/Last tested .* — OK/)).toBeInTheDocument();
    fireEvent.click(v.getByRole('button', { name: /Save/ }));
    await waitFor(() =>
      expect(sp.set).toHaveBeenCalledWith('vault', {
        enabled: true,
        config: { address: 'https://vault.example', mount: 'kv', authMethod: 'token', namespace: 'team' },
      }),
    );
    // Switching the auth method drops the stored-credential shortcut (the server would not keep them).
    fireEvent.change(v.getByLabelText('Auth method'), { target: { value: 'approle' } });
    expect(v.getByLabelText('AppRole mount')).toHaveValue('approle');
    expect(v.getByRole('button', { name: /Save/ })).toBeDisabled();
    // A provider's error text renders as plain text.
    const a = panel('aws');
    expect(a.getByText(/AccessDenied <b>not html<\/b>/)).toBeInTheDocument();
    expect(a.getByLabelText('Region')).toHaveValue('eu-west-1');
    expect(a.getByRole('switch', { name: /enabled/ })).toHaveAttribute('aria-checked', 'false');
  });

  it('saves AWS with optional settings and only the filled credentials', async () => {
    renderWithProviders(<SecretManagersCard />);
    await screen.findByTestId('secret-provider-aws');
    const a = panel('aws');
    fireEvent.change(a.getByLabelText('Region'), { target: { value: 'us-east-1' } });
    fireEvent.change(a.getByLabelText('Access key ID'), { target: { value: 'AKIAABCDEFGHIJKLMNOP' } });
    expect(a.getByRole('button', { name: /Save/ })).toBeDisabled();
    fireEvent.change(a.getByLabelText('Secret access key'), { target: { value: 'shh' } });
    fireEvent.change(a.getByLabelText('Endpoint'), { target: { value: 'https://vpce.example' } });
    fireEvent.change(a.getByLabelText('Assume role ARN'), { target: { value: 'arn:aws:iam::123456789012:role/nd' } });
    fireEvent.change(a.getByLabelText('External ID'), { target: { value: 'ext-1' } });
    fireEvent.change(a.getByLabelText('Role session name'), { target: { value: 'nd' } });
    fireEvent.change(a.getByLabelText('Session token'), { target: { value: 'tok' } });
    fireEvent.click(a.getByRole('button', { name: /Save/ }));
    await waitFor(() =>
      expect(sp.set).toHaveBeenCalledWith('aws', {
        enabled: true,
        config: {
          region: 'us-east-1',
          endpoint: 'https://vpce.example',
          roleArn: 'arn:aws:iam::123456789012:role/nd',
          externalId: 'ext-1',
          roleSessionName: 'nd',
        },
        credentials: { accessKeyId: 'AKIAABCDEFGHIJKLMNOP', secretAccessKey: 'shh', sessionToken: 'tok' },
      }),
    );
    await waitFor(() => expect(a.getByLabelText('Secret access key')).toHaveValue(''));
    expect(a.getByLabelText('Access key ID')).toHaveValue('');
    expect(a.getByLabelText('Session token')).toHaveValue('');
  });

  it('saves AWS on stored credentials with the bare region', async () => {
    sp.list.mockResolvedValue([vaultConfigured, { ...awsConfigured, config: { region: 'eu-west-1' } }]);
    renderWithProviders(<SecretManagersCard />);
    await screen.findByTestId('secret-provider-aws');
    fireEvent.click(panel('aws').getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(sp.set).toHaveBeenCalledWith('aws', { enabled: false, config: { region: 'eu-west-1' } }));
  });

  it('reports a refused save', async () => {
    sp.set.mockRejectedValueOnce(new Error('credentials.token required'));
    sp.list.mockResolvedValue([vaultConfigured, awsConfigured]);
    renderWithProviders(<SecretManagersCard />);
    await screen.findByTestId('secret-provider-vault');
    fireEvent.click(panel('vault').getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('credentials.token required', 'error'));
    sp.set.mockRejectedValueOnce('odd');
    fireEvent.click(panel('vault').getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Save failed', 'error'));
  });

  it('tests with and without a probe and shows the result as text', async () => {
    sp.list.mockResolvedValue([vaultConfigured, awsConfigured]);
    sp.test.mockResolvedValueOnce({ ok: true, detail: 'token valid; read app/db' });
    renderWithProviders(<SecretManagersCard />);
    await screen.findByTestId('secret-provider-vault');
    const v = panel('vault');
    fireEvent.change(v.getByLabelText('Probe path'), { target: { value: ' app/db ' } });
    fireEvent.click(v.getByRole('button', { name: /Test connection/ }));
    await waitFor(() => expect(sp.test).toHaveBeenCalledWith('vault', { probePath: 'app/db' }));
    expect(await screen.findByTestId('secret-provider-vault-result')).toHaveTextContent('OK: token valid; read app/db');

    sp.test.mockResolvedValueOnce({ ok: false, detail: 'AWS answered 403' });
    fireEvent.click(panel('aws').getByRole('button', { name: /Test connection/ }));
    await waitFor(() => expect(sp.test).toHaveBeenCalledWith('aws', {}));
    expect(await screen.findByTestId('secret-provider-aws-result')).toHaveTextContent('Failed: AWS answered 403');

    sp.test.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(panel('aws').getByRole('button', { name: /Test connection/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('boom', 'error'));
    sp.test.mockRejectedValueOnce(undefined);
    fireEvent.click(panel('aws').getByRole('button', { name: /Test connection/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Test failed', 'error'));
  });

  it('removes a provider after confirming, and reports a failed remove', async () => {
    sp.list.mockResolvedValue([vaultConfigured, awsConfigured]);
    sp.delete.mockResolvedValueOnce({ ok: true, deleted: true });
    renderWithProviders(<SecretManagersCard />);
    await screen.findByTestId('secret-provider-vault');
    fireEvent.click(panel('vault').getByRole('button', { name: /Remove/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(sp.delete).not.toHaveBeenCalled();
    fireEvent.click(panel('vault').getByRole('button', { name: /Remove/ }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(sp.delete).toHaveBeenCalledWith('vault'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('HashiCorp Vault / OpenBao removed', 'success'));

    sp.delete.mockRejectedValueOnce(new Error('nope'));
    fireEvent.click(panel('aws').getByRole('button', { name: /Remove/ }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('nope', 'error'));
    sp.delete.mockRejectedValueOnce(42);
    fireEvent.click(panel('aws').getByRole('button', { name: /Remove/ }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Remove failed', 'error'));
  });

  it('shows an error card when the list cannot be read', async () => {
    sp.list.mockRejectedValue(new Error('forbidden'));
    renderWithProviders(<SecretManagersCard />);
    expect(await screen.findByText('Could not load the secret managers')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(sp.list).toHaveBeenCalledTimes(2));
  });
});
