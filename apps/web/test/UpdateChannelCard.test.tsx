import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { UpdateChannelCard } from '../src/routes/settings/UpdateChannelCard.js';
import { ToastProvider } from '../src/components/Toast.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

// A6: every release (default) or the stable channel.
describe('UpdateChannelCard', () => {
  it('shows the stored channel and switches to stable', async () => {
    mockOf(api.system.updateChannel.set).mockResolvedValue({ channel: 'stable', check: { current: '0.18.25', latest: 'v0.18.21', updateAvailable: false, notesUrl: null, checkedAt: new Date().toISOString(), channel: 'stable' } } as never);
    renderWithProviders(<ToastProvider><UpdateChannelCard /></ToastProvider>);
    const select = await screen.findByLabelText('Offer updates from');
    expect((select as HTMLSelectElement).value).toBe('release');
    fireEvent.change(select, { target: { value: 'stable' } });
    await waitFor(() => expect(api.system.updateChannel.set).toHaveBeenCalledWith('stable'));
    expect(await screen.findByText('The panel now follows the stable channel')).toBeInTheDocument();
  });
});
