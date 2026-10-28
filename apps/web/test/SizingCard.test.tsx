import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { SizingCard } from '../src/routes/service/SizingCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const report = (over: Record<string, unknown>) => ({
  serviceId: 5,
  spanHours: 30,
  samples: 900,
  memory: { p95: 410, peak: 480 },
  cpu: { p95: 0.92, peak: 1 },
  limits: { memoryMiB: 512, cpuCores: 1 },
  enoughHistory: true,
  hints: [],
  ...over,
});

describe('SizingCard (G5.6)', () => {
  it('shows nothing without history', async () => {
    mockOf(api.services.sizing).mockResolvedValue(report({ memory: null, cpu: null, samples: 0 }) as never);
    const { container } = renderWithProviders(<SizingCard serviceId={5} />);
    await waitFor(() => expect(api.services.sizing).toHaveBeenCalledWith(5));
    expect(container.textContent).toBe('');
  });

  it('shows the figures and the suggestions', async () => {
    mockOf(api.services.sizing).mockResolvedValue(
      report({
        hints: [
          { resource: 'memory', action: 'raise', current: 512, suggested: 640, reason: 'it peaked at 480 MiB, 94 % of its limit' },
          { resource: 'cpu', action: 'raise', current: 1, suggested: 1.5, reason: 'it used 0.92 cores at the 95th percentile, 92 % of its limit' },
        ],
      }) as never,
    );
    renderWithProviders(<SizingCard serviceId={5} />);
    expect(await screen.findByText('Memory: 410 MiB at the 95th percentile, peak 480 MiB')).toBeInTheDocument();
    expect(screen.getByText('640 MiB')).toBeInTheDocument();
    expect(screen.getByText('1.5 cores')).toBeInTheDocument();
    expect(screen.getAllByText('Raise the limit')).toHaveLength(2);
  });

  it('says when there is too little history for suggestions', async () => {
    mockOf(api.services.sizing).mockResolvedValue(report({ enoughHistory: false, spanHours: 2 }) as never);
    renderWithProviders(<SizingCard serviceId={5} />);
    expect(await screen.findByText('Suggestions start after 12 hours of history.')).toBeInTheDocument();
  });
});
