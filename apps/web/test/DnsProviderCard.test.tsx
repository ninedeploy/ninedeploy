import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DnsProviderCard } from '../src/routes/settings/DnsProviderCard.js';
import { IntegrationsSection } from '../src/routes/settings/IntegrationsSection.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', async () => {
  const actual = await vi.importActual<typeof import('../src/components/Toast.js')>('../src/components/Toast.js');
  return { ...actual, useToast: () => toastSpy };
});

const none = { providers: ['route53', 'ovh', 'porkbun', 'hetzner'], provider: null, configured: null, fields: {} };

describe('DnsProviderCard (G3.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOf(api.settings.dnsProvider.get).mockResolvedValue(none as never);
    mockOf(api.settings.dnsProvider.set).mockResolvedValue({ ok: true, provider: 'hetzner' } as never);
    mockOf(api.settings.dnsProvider.test).mockResolvedValue({ ok: true, provider: 'hetzner', zones: ['example.com'], zoneCount: 1 } as never);
    mockOf(api.settings.dnsProvider.clear).mockResolvedValue({ ok: true } as never);
  });

  it('is mounted on the integrations page', async () => {
    mockOf(api.settings.vault.get).mockResolvedValue({ provider: '', hasToken: false } as never);
    mockOf(api.settings.dnsRecords.get).mockResolvedValue({ enabled: false, hasToken: false } as never);
    renderWithProviders(<IntegrationsSection />);
    expect(await screen.findByText('DNS records: Route 53, OVH, Porkbun, Hetzner')).toBeInTheDocument();
  });

  it('saves the fields of the chosen provider', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DnsProviderCard />);
    expect(await screen.findByText('No DNS record provider is active.')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('DNS provider'), 'ovh');
    const save = screen.getByRole('button', { name: 'Save and activate' });
    expect(save).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Region'), 'ovh-ca');
    await user.type(screen.getByLabelText('Application key'), 'appkey12');
    await user.type(screen.getByLabelText('Application secret'), 'secret-1');
    await user.type(screen.getByLabelText('Consumer key'), 'consumer-1');
    await user.click(save);
    await waitFor(() =>
      expect(api.settings.dnsProvider.set).toHaveBeenCalledWith({
        provider: 'ovh',
        credentials: { endpoint: 'ovh-ca', applicationKey: 'appkey12', applicationSecret: 'secret-1', consumerKey: 'consumer-1' },
      }),
    );
    // Secrets are cleared from the form once saved; the key stays.
    await waitFor(() => expect(screen.getByLabelText('Application secret')).toHaveValue(''));
    expect(screen.getByLabelText('Application key')).toHaveValue('appkey12');
  });

  it('prefills the active provider, lists its zones and switches it off', async () => {
    const user = userEvent.setup();
    mockOf(api.settings.dnsProvider.get).mockResolvedValue({ ...none, provider: 'route53', configured: 'route53', fields: { accessKeyId: 'AKIAEXAMPLE' } } as never);
    renderWithProviders(<DnsProviderCard />);
    expect(await screen.findByText('Active: Amazon Route 53')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Access key ID')).toHaveValue('AKIAEXAMPLE'));
    expect(screen.getByLabelText('Secret access key')).toHaveAttribute('placeholder', 'saved; re-enter to change');
    mockOf(api.settings.dnsProvider.test).mockResolvedValueOnce({ ok: true, zones: ['example.com', 'example.org'], zoneCount: 2 } as never);
    await user.click(screen.getByRole('button', { name: 'List zones' }));
    expect(await screen.findByText('2 zone(s): example.com, example.org')).toBeInTheDocument();
    mockOf(api.settings.dnsProvider.test).mockResolvedValueOnce({ ok: false, error: 'Route 53 API error: 403' } as never);
    await user.click(screen.getByRole('button', { name: 'List zones' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Route 53 API error: 403', 'error'));
    await user.click(screen.getByRole('button', { name: 'Switch off' }));
    await waitFor(() => expect(api.settings.dnsProvider.clear).toHaveBeenCalled());
  });

  it('says when another provider is active and keeps the zone test shut', async () => {
    mockOf(api.settings.dnsProvider.get).mockResolvedValue({ ...none, provider: 'cloudflare', configured: 'hetzner' } as never);
    renderWithProviders(<DnsProviderCard />);
    expect(await screen.findByText('Active provider: cloudflare (configured on its own card)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'List zones' })).toBeDisabled();
  });

  it('reports a failed save', async () => {
    const user = userEvent.setup();
    mockOf(api.settings.dnsProvider.set).mockRejectedValueOnce(new Error('apiKey: apiKey starts with pk1_'));
    renderWithProviders(<DnsProviderCard />);
    await screen.findByText('No DNS record provider is active.');
    await user.selectOptions(screen.getByLabelText('DNS provider'), 'porkbun');
    await user.type(screen.getByLabelText('API key'), 'nope');
    await user.type(screen.getByLabelText('Secret API key'), 'sk1_x');
    await user.click(screen.getByRole('button', { name: 'Save and activate' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('apiKey: apiKey starts with pk1_', 'error'));
  });
});
