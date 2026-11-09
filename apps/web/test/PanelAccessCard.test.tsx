import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, createQueryClient } from './web-utils.js';
import { mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => (await import('./apiMock.js')).createFakeApiModule());

import { api } from '../src/lib/api.js';
import { ToastProvider } from '../src/components/Toast.js';
import { PanelAccessCard } from '../src/routes/settings/PanelAccessCard.js';

const render = () =>
  renderWithProviders(<PanelAccessCard />, { queryClient: createQueryClient(), wrapper: (c) => <ToastProvider>{c}</ToastProvider> });

const view = { enabled: false, cidrs: [] as string[], includeTokens: false, yourIp: '203.0.113.9', overridden: false };

beforeEach(() => {
  mockOf(api.settings.panelAccess.get).mockReset();
  mockOf(api.settings.panelAccess.set).mockReset();
});

// O4: the panel IP allow-list card under Settings → Security.
describe('PanelAccessCard', () => {
  it('adds the caller’s address and saves the list as entered, one per line or comma', async () => {
    mockOf(api.settings.panelAccess.get).mockResolvedValue(view);
    mockOf(api.settings.panelAccess.set).mockResolvedValue({ ...view, enabled: true, cidrs: ['198.51.100.0/24', '203.0.113.9'] });
    render();
    expect(await screen.findByText('203.0.113.9')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '198.51.100.0/24,' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add my address' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Restrict the panel to these addresses' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.settings.panelAccess.set).toHaveBeenCalledWith({ enabled: true, cidrs: ['198.51.100.0/24', '203.0.113.9'], includeTokens: false }),
    );
    expect(await screen.findByText('Panel allow-list on')).toBeInTheDocument();
  });

  it('shows the server’s refusal and the env override', async () => {
    mockOf(api.settings.panelAccess.get).mockResolvedValue({ ...view, overridden: true });
    mockOf(api.settings.panelAccess.set).mockRejectedValue(new Error('This list does not include your address (203.0.113.9)'));
    render();
    expect(await screen.findByText(/NINEDEPLOY_PANEL_ACCESS=off is set on the server/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/does not include your address/)).toBeInTheDocument();
  });
});
