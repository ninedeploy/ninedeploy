import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { LogDrainQueue } from '../src/components/LogDrainQueue.js';
import { api } from '../src/lib/api.js';
import { mockOf, renderWithProviders } from './helpers.js';

vi.mock('../src/lib/api.js', async () => (await import('./apiMock.js')).createFakeApiModule());

beforeEach(() => {
  mockOf(api.logDrains.queue).mockReset().mockResolvedValue({ pendingBatches: 2, pendingEntries: 10, payloadBytes: 4000, blockedBatches: 0, pausedSources: 0, oldestAt: null });
  mockOf(api.logDrains.retryQueue).mockReset();
  mockOf(api.logDrains.discardQueue).mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('LogDrainQueue failures', () => {
  it('reports a retry that could not be scheduled', async () => {
    mockOf(api.logDrains.retryQueue).mockRejectedValue(new Error('busy'));
    renderWithProviders(<LogDrainQueue id={4} enabled />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry delivery' }));
    await waitFor(() => expect(api.logDrains.retryQueue).toHaveBeenCalledWith(4));
    expect(await screen.findByText('Could not schedule delivery retry')).toBeInTheDocument();
  });

  it('reports a discard that failed after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockOf(api.logDrains.discardQueue).mockRejectedValue(new Error('locked'));
    renderWithProviders(<LogDrainQueue id={4} enabled />);
    fireEvent.click(await screen.findByRole('button', { name: 'Discard queue' }));
    await waitFor(() => expect(api.logDrains.discardQueue).toHaveBeenCalledWith(4));
    expect(await screen.findByText('Could not discard queued logs')).toBeInTheDocument();
    expect(screen.getByText(/10 queued lines/)).toBeInTheDocument();
  });

  it('says when the queue cannot be read', async () => {
    mockOf(api.logDrains.queue).mockRejectedValue(new Error('gone'));
    renderWithProviders(<LogDrainQueue id={4} enabled />);
    expect(await screen.findByText('Delivery queue unavailable')).toBeInTheDocument();
  });
});
