import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../src/components/Toast.js';

const apiMock = vi.hoisted(() => ({ api: { services: { update: vi.fn() } } }));
vi.mock('../src/lib/api.js', () => apiMock);

import { AutoscaleCard } from '../src/routes/service/AutoscaleCard.js';

const STORED = { minReplicas: 2, maxReplicas: 6, metric: 'rps' as const, target: 40, scaleUpSeconds: 90, scaleDownSeconds: 600 };
const svc = { id: 4, name: 'api', slug: 'api', type: 'docker', serverId: null, memLimitMb: 512, autoscale: STORED };

function renderCard() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ToastProvider>
          <AutoscaleCard svc={svc as never} />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AutoscaleCard scheduled minimums (G5.6)', () => {
  afterEach(cleanup);
  beforeEach(() => {
    apiMock.api.services.update.mockReset();
    apiMock.api.services.update.mockResolvedValue({});
  });

  it('adds a window, sets its time zone and saves both with the configuration', async () => {
    renderCard();
    expect(screen.queryByLabelText('Time zone')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add window' }));
    const zone = screen.getByLabelText('Time zone');
    fireEvent.change(zone, { target: { value: 'Europe/Istanbul' } });
    expect(zone).toHaveValue('Europe/Istanbul');
    fireEvent.click(screen.getByRole('button', { name: 'Save autoscaling' }));
    await waitFor(() =>
      expect(apiMock.api.services.update).toHaveBeenCalledWith(4, {
        autoscale: {
          ...STORED,
          schedules: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00', minReplicas: 2 }],
          timezone: 'Europe/Istanbul',
        },
      }),
    );
  });

  it('names an unknown time zone and refuses to save it', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Add window' }));
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'Mars/Olympus' } });
    expect(screen.getByText('An IANA time zone, such as Europe/Istanbul')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save autoscaling' })).toBeDisabled();
  });
});
