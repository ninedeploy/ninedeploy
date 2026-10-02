import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { SecuritySection } from '../src/routes/settings/SecuritySection.js';
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

const saveButtons = () => screen.getAllByRole('button', { name: 'Save' });

describe('SecuritySection (r562)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a failed load shows an error and no field can be saved over the unknown values', async () => {
    mockOf(api.settings.get).mockRejectedValue(new Error('HTTP 500'));
    renderWithProviders(<SecuritySection />);
    expect(await screen.findByText('Could not load the security settings')).toBeInTheDocument();
    // The DNS case that bit: a token typed alone used to send provider '' and
    // apex '' — switching the wildcard DNS-01 challenge off.
    fireEvent.change(screen.getByLabelText('DNS API token'), { target: { value: 'tok' } });
    for (const b of saveButtons()) expect(b).toBeDisabled();
    expect(screen.getByRole('switch')).toBeDisabled();
    for (const b of saveButtons()) fireEvent.click(b);
    expect(api.settings.setDns).not.toHaveBeenCalled();
    expect(api.settings.setAcmeEmail).not.toHaveBeenCalled();
    expect(api.settings.setPanelDomain).not.toHaveBeenCalled();
    expect(api.settings.setTemplatesSource).not.toHaveBeenCalled();
  });

  it('enables saving once the real settings have loaded, keeping the stored DNS values', async () => {
    mockOf(api.settings.get).mockResolvedValue({ allowRegistration: true, dnsProvider: 'cloudflare', hasDnsToken: true, wildcardApex: 'example.com' } as never);
    mockOf(api.settings.setDns).mockResolvedValue({ ok: true } as never);
    renderWithProviders(<SecuritySection />);
    await waitFor(() => expect(saveButtons()[0]).toBeEnabled());
    expect(screen.queryByText('Could not load the security settings')).toBeNull();
    fireEvent.change(screen.getByLabelText('DNS API token'), { target: { value: 'tok' } });
    fireEvent.click(saveButtons()[saveButtons().length - 1]!);
    await waitFor(() =>
      expect(api.settings.setDns).toHaveBeenCalledWith({ provider: 'cloudflare', token: 'tok', wildcardApex: 'example.com' }),
    );
  });
});
