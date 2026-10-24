import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { ObservabilityCard } from '../src/components/ObservabilityCard.js';
import { LogDrainQueue } from '../src/components/LogDrainQueue.js';
import { api } from '../src/lib/api.js';
import { mockOf, renderWithProviders } from './helpers.js';

vi.mock('../src/lib/api.js', async () => (await import('./apiMock.js')).createFakeApiModule());
const view = {
  settings: { retentionDays: 7, prometheusEnabled: false, otlpEndpoint: 'https://collector.example/v1/metrics', logQueueMaxMb: 16, hasOtlpAuthorization: true },
  exportStatus: { lastAttemptAt: null, lastSuccessAt: null, result: null },
};
beforeEach(() => {
  vi.clearAllMocks();
  mockOf(api.stats.observability.get).mockResolvedValue(view);
  mockOf(api.stats.observability.update).mockResolvedValue(view);
  mockOf(api.stats.observability.test).mockResolvedValue({ ok: true, status: 200, samples: 2, error: null });
  mockOf(api.logDrains.queue).mockResolvedValue({ pendingBatches: 2, pendingEntries: 10, payloadBytes: 4000, blockedBatches: 0, pausedSources: 0, oldestAt: null });
  mockOf(api.logDrains.retryQueue).mockResolvedValue({});
  mockOf(api.logDrains.discardQueue).mockResolvedValue({ discardedBatches: 2 });
});
afterEach(() => vi.restoreAllMocks());
describe('monitoring controls', () => {
  it('saves the selected history interval without clearing a saved collector credential', async () => {
    renderWithProviders(<ObservabilityCard />);
    fireEvent.click(await screen.findByText('History & metrics export'));
    fireEvent.change(screen.getByLabelText('Service history retention (days)'), { target: { value: '30' } });
    fireEvent.click(screen.getByLabelText('Enable Prometheus scraping'));
    fireEvent.click(screen.getByRole('button', { name: 'Save monitoring settings' }));
    await waitFor(() => expect(api.stats.observability.update).toHaveBeenCalledWith({
      retentionDays: 30, prometheusEnabled: true, otlpEndpoint: view.settings.otlpEndpoint, logQueueMaxMb: 16,
    }));
    expect(screen.getByLabelText('Collector Authorization header')).toHaveValue('');
  });
  it('clears authorization only when explicitly selected and tests the saved collector', async () => {
    renderWithProviders(<ObservabilityCard />);
    fireEvent.click(await screen.findByText('History & metrics export'));
    fireEvent.click(screen.getByLabelText('Remove saved authorization'));
    fireEvent.click(screen.getByRole('button', { name: 'Save monitoring settings' }));
    await waitFor(() => expect(api.stats.observability.update).toHaveBeenCalledWith(expect.objectContaining({ otlpAuthorization: '' })));
    fireEvent.click(screen.getByRole('button', { name: 'Test saved collector' }));
    await screen.findByText('Collector accepted 2 metric samples');
  });
  it('reports a settings failure and allows retry', async () => {
    mockOf(api.stats.observability.get).mockRejectedValueOnce(new Error('unavailable'));
    renderWithProviders(<ObservabilityCard />);
    expect(await screen.findByText('Monitoring settings unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('History & metrics export')).toBeInTheDocument();
  });
  it('displays backpressure and schedules a queue retry', async () => {
    mockOf(api.logDrains.queue).mockResolvedValue({ pendingBatches: 2, pendingEntries: 10, payloadBytes: 4000, blockedBatches: 1, pausedSources: 1, oldestAt: '2026-10-22T15:00:00Z' });
    renderWithProviders(<LogDrainQueue id={3} enabled />);
    expect(await screen.findByText(/10 queued lines/)).toBeInTheDocument();
    expect(screen.getByText(/Capture paused/)).toBeInTheDocument();
    expect(screen.getByText(/bound to previous destination/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry delivery' }));
    await waitFor(() => expect(api.logDrains.retryQueue).toHaveBeenCalledWith(3));
  });
  it('requires confirmation before discarding captured logs', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderWithProviders(<LogDrainQueue id={3} enabled />);
    const button = await screen.findByRole('button', { name: 'Discard queue' });
    fireEvent.click(button); expect(api.logDrains.discardQueue).not.toHaveBeenCalled();
    confirm.mockReturnValue(true); fireEvent.click(button);
    await waitFor(() => expect(api.logDrains.discardQueue).toHaveBeenCalledWith(3));
  });
  it('keeps retry disabled while the destination is disabled', async () => {
    renderWithProviders(<LogDrainQueue id={3} enabled={false} />);
    expect(await screen.findByRole('button', { name: 'Retry delivery' })).toBeDisabled();
    expect(screen.getByText(/queue is retained/)).toBeInTheDocument();
  });
});
