import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { ObservabilityCard } from '../src/components/ObservabilityCard.js';
import { api } from '../src/lib/api.js';
import { mockOf, renderWithProviders } from './helpers.js';

vi.mock('../src/lib/api.js', async () => (await import('./apiMock.js')).createFakeApiModule());

const view = {
  settings: { retentionDays: 7, prometheusEnabled: false, otlpEndpoint: 'https://collector.example/v1/metrics', logQueueMaxMb: 16, hasOtlpAuthorization: false },
  exportStatus: { lastAttemptAt: null, lastSuccessAt: null, result: null },
};

beforeEach(() => {
  mockOf(api.stats.observability.get).mockReset().mockResolvedValue(view);
  mockOf(api.stats.observability.update).mockReset();
  mockOf(api.stats.observability.test).mockReset();
});

describe('ObservabilityCard edits and failures', () => {
  it('sends the edited endpoint, queue limit and new authorization, and reports a failed save', async () => {
    mockOf(api.stats.observability.update).mockRejectedValue(new Error('nope'));
    renderWithProviders(<ObservabilityCard />);
    fireEvent.click(await screen.findByText('History & metrics export'));
    fireEvent.change(screen.getByLabelText('Log queue limit per destination (MiB)'), { target: { value: '64' } });
    fireEvent.change(screen.getByLabelText('OTLP/HTTP JSON metrics endpoint'), { target: { value: 'https://otel.internal/v1/metrics' } });
    fireEvent.change(screen.getByLabelText('Collector Authorization header'), { target: { value: 'Bearer abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save monitoring settings' }));
    await waitFor(() =>
      expect(api.stats.observability.update).toHaveBeenCalledWith({
        retentionDays: 7,
        prometheusEnabled: false,
        otlpEndpoint: 'https://otel.internal/v1/metrics',
        logQueueMaxMb: 64,
        otlpAuthorization: 'Bearer abc',
      }),
    );
    expect(await screen.findByText('Monitoring settings could not be saved')).toBeInTheDocument();
    expect(screen.getByLabelText('Collector Authorization header')).toHaveValue('Bearer abc');
  });

  it('blocks saving an out-of-range queue limit', async () => {
    renderWithProviders(<ObservabilityCard />);
    fireEvent.click(await screen.findByText('History & metrics export'));
    fireEvent.change(screen.getByLabelText('Log queue limit per destination (MiB)'), { target: { value: '300' } });
    expect(screen.getByRole('button', { name: 'Save monitoring settings' })).toBeDisabled();
  });

  it('reports when the collector test cannot run', async () => {
    mockOf(api.stats.observability.test).mockRejectedValue(new Error('down'));
    renderWithProviders(<ObservabilityCard />);
    fireEvent.click(await screen.findByText('History & metrics export'));
    fireEvent.click(screen.getByRole('button', { name: 'Test saved collector' }));
    expect(await screen.findByText('Metrics export could not be tested')).toBeInTheDocument();
    expect(api.stats.observability.test).toHaveBeenCalledTimes(1);
  });
});
