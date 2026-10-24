import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/** 0.16.10: the live autoscale status on the service Overview. */

vi.mock('../src/lib/autoscaleApi.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/autoscaleApi.js')>()),
  autoscaleApi: (await import('./apiMock.js')).createAutoscaleApiMock(),
}));

import { autoscaleApi } from '../src/lib/autoscaleApi.js';
import { AutoscalePanel, autoscaleEventLine, autoscaleValue } from '../src/routes/service/AutoscalePanel.js';

const status = vi.mocked(autoscaleApi.status);

const ON = {
  enabled: true,
  replicas: 3,
  minReplicas: 1,
  maxReplicas: 4,
  metric: 'cpu' as const,
  target: 50,
  value: 80,
  desired: 4,
  holding: null,
  lastEvent: { at: new Date(Date.now() - 4 * 60_000).toISOString(), from: 2, to: 3, reason: 'cpu 80% per container over 60s (target 50%)' },
};

function renderPanel(enabled = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AutoscalePanel serviceId={1} enabled={enabled} />
    </QueryClientProvider>,
  );
}

describe('autoscaleValue', () => {
  it('reads a percentage or requests per second, and a dash without a value', () => {
    expect(autoscaleValue(62.5, 'cpu')).toBe('62.5%');
    expect(autoscaleValue(40, 'memory')).toBe('40%');
    expect(autoscaleValue(12, 'rps')).toBe('12 req/s');
    expect(autoscaleValue(null, 'cpu')).toBe('—');
    expect(autoscaleValue(undefined, 'rps')).toBe('—');
  });
});

describe('autoscaleEventLine', () => {
  it('names the change, when, and why', () => {
    expect(autoscaleEventLine(ON.lastEvent)).toBe('2 → 3, 4m ago: cpu 80% per container over 60s (target 50%)');
  });
});

describe('AutoscalePanel', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    status.mockResolvedValue(ON);
  });

  const panelShown = () => screen.queryByText('Autoscaling') !== null;

  it('does not poll while disabled', () => {
    renderPanel(false);
    expect(panelShown()).toBe(false);
    expect(status).not.toHaveBeenCalled();
  });

  it('shows the containers serving, the value against the target, the desired count and the last change', async () => {
    renderPanel();
    expect(await screen.findByText('3 of 1–4')).toBeInTheDocument();
    expect(status).toHaveBeenCalledWith(1);
    expect(screen.getByText('3 of 1–4')).toBeInTheDocument();
    expect(screen.getByText('cpu per container')).toBeInTheDocument();
    expect(screen.getByText('80% · target 50%')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('2 → 3, 4m ago: cpu 80% per container over 60s (target 50%)')).toBeInTheDocument();
    expect(screen.queryByText(/^Holding/)).not.toBeInTheDocument();
  });

  it('says why it holds, and has dashes before the first look', async () => {
    status.mockResolvedValue({
      ...ON,
      metric: 'rps',
      target: 20,
      value: null,
      desired: null,
      holding: 'requests per second need traffic analytics (Traefik → Traffic)',
      lastEvent: null,
    });
    renderPanel();
    expect(await screen.findByText('Holding: requests per second need traffic analytics (Traefik → Traffic).')).toBeInTheDocument();
    expect(screen.getByText('— · target 20 req/s')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('none yet')).toBeInTheDocument();
  });

  it('polls every 15 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderPanel();
      await waitFor(() => expect(status).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(15_000);
      await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders nothing when autoscaling is off', async () => {
    status.mockResolvedValue({ enabled: false, replicas: 1 });
    const { unmount } = renderPanel();
    await waitFor(() => expect(status).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(panelShown()).toBe(false);
    unmount();
  });

  it('keeps a visible error and retries the status instead of hiding the panel', async () => {
    status.mockRejectedValueOnce(new Error('down')).mockResolvedValue(ON);
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent('Autoscaling status is unavailable');
    expect(screen.queryByText('Live 15s')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry status' }));
    expect(await screen.findByText('3 of 1–4')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(status).toHaveBeenCalledTimes(2);
  });
});
