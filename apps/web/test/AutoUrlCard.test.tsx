import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { AutoUrlCard } from '../src/routes/settings/AutoUrlCard.js';
import { api } from '../src/lib/api.js';
import { mockOf, renderWithProviders } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const settings = (over: Record<string, unknown> = {}) => ({
  effective: { mode: 'off', domain: null, ip: null, source: 'setting' },
  stored: { mode: 'off', domain: null, ip: null },
  envWildcard: null,
  suggestedIp: '203.0.113.10',
  ...over,
});

beforeEach(() => {
  for (const fn of Object.values(api.settings.autoUrl)) mockOf(fn as never).mockReset();
  mockOf(api.settings.autoUrl.get).mockResolvedValue(settings());
  mockOf(api.settings.autoUrl.set).mockResolvedValue({ ok: true, effective: { mode: 'sslip' } });
});

describe('AutoUrlCard', () => {
  it('turns on sslip.io with the installer address, previewing the URL', async () => {
    renderWithProviders(<AutoUrlCard />);
    const off = await screen.findByRole('radio', { name: /Off/ });
    await waitFor(() => expect(off).toBeEnabled());
    expect(off).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: /Free test URLs/ }));
    expect(screen.getByLabelText('Server IP address')).toHaveValue('203.0.113.10');
    expect(screen.getByText('http://my-app.203.0.113.10.sslip.io')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.settings.autoUrl.set).toHaveBeenCalledWith({ mode: 'sslip', ip: '203.0.113.10' }));
  });

  it('fills the address from Detect', async () => {
    mockOf(api.settings.autoUrl.detectIp).mockResolvedValue({ ip: '198.51.100.7', public: true });
    renderWithProviders(<AutoUrlCard />);
    const sslip = await screen.findByRole('radio', { name: /Free test URLs/ });
    await waitFor(() => expect(sslip).toBeEnabled());
    fireEvent.click(sslip);
    fireEvent.click(screen.getByRole('button', { name: /Detect/ }));
    await waitFor(() => expect(screen.getByLabelText('Server IP address')).toHaveValue('198.51.100.7'));
  });

  it('domain mode strips a pasted "*." and refuses an invalid name', async () => {
    renderWithProviders(<AutoUrlCard />);
    const domain = await screen.findByRole('radio', { name: /Your wildcard domain/ });
    await waitFor(() => expect(domain).toBeEnabled());
    fireEvent.click(domain);
    const input = screen.getByLabelText('Base domain');
    fireEvent.change(input, { target: { value: 'not a domain' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '*.apps.example.com' } });
    expect(screen.getByText('https://my-app.apps.example.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.settings.autoUrl.set).toHaveBeenCalledWith({ mode: 'domain', domain: 'apps.example.com' }));
  });

  it('shows the stored choice as active', async () => {
    mockOf(api.settings.autoUrl.get).mockResolvedValue(
      settings({ effective: { mode: 'sslip', domain: null, ip: '203.0.113.10', source: 'setting' }, stored: { mode: 'sslip', domain: null, ip: '203.0.113.10' } }),
    );
    renderWithProviders(<AutoUrlCard />);
    expect(await screen.findByText('active')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Free test URLs/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('defers to NINEDEPLOY_WILDCARD_DOMAIN when it is set', async () => {
    mockOf(api.settings.autoUrl.get).mockResolvedValue(settings({ envWildcard: 'apps.corp.test' }));
    renderWithProviders(<AutoUrlCard />);
    expect(await screen.findByText('my-app.apps.corp.test')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('warns when IP detection yields a private address and lets the user correct it', async () => {
    mockOf(api.settings.autoUrl.detectIp).mockResolvedValue({ ip: '192.168.1.2', public: false });
    renderWithProviders(<AutoUrlCard />);
    const sslip = await screen.findByRole('radio', { name: /Free test URLs/ });
    await waitFor(() => expect(sslip).toBeEnabled());
    fireEvent.click(sslip);
    fireEvent.click(screen.getByRole('button', { name: 'Detect' }));
    expect(await screen.findByText('Detected 192.168.1.2, which is not a public address')).toBeInTheDocument();
    const input = screen.getByLabelText('Server IP address');
    fireEvent.change(input, { target: { value: '999.1.1.1' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '198.51.100.7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.settings.autoUrl.set).toHaveBeenCalledWith({ mode: 'sslip', ip: '198.51.100.7' }));
  });

  it('preserves the entered domain after a failed save and allows retry', async () => {
    mockOf(api.settings.autoUrl.set).mockRejectedValueOnce(new Error('permission denied')).mockResolvedValueOnce({ ok: true } as never);
    renderWithProviders(<AutoUrlCard />);
    const mode = await screen.findByRole('radio', { name: /Your wildcard domain/ });
    await waitFor(() => expect(mode).toBeEnabled());
    fireEvent.click(mode);
    const domain = screen.getByLabelText('Base domain');
    fireEvent.change(domain, { target: { value: 'apps.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Could not save: permission denied')).toBeInTheDocument();
    expect(domain).toHaveValue('apps.example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.settings.autoUrl.set).toHaveBeenCalledTimes(2));
  });

  it('shows an IP detection failure without replacing the configured value', async () => {
    mockOf(api.settings.autoUrl.detectIp).mockRejectedValue(new Error('detection failed'));
    renderWithProviders(<AutoUrlCard />);
    const sslip = await screen.findByRole('radio', { name: /Free test URLs/ });
    await waitFor(() => expect(sslip).toBeEnabled());
    fireEvent.click(sslip);
    fireEvent.click(screen.getByRole('button', { name: 'Detect' }));
    expect(await screen.findByText('detection failed')).toBeInTheDocument();
    expect(screen.getByLabelText('Server IP address')).toHaveValue('203.0.113.10');
  });
});
