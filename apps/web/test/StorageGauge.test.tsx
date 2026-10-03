import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, renderWithProviders } from './web-utils.js';

const apiMock = vi.hoisted(() => ({
  api: {
    backups: { storage: vi.fn() },
  },
}));

vi.mock('../src/lib/api.js', () => apiMock);

import { StorageGauge } from '../src/components/StorageGauge.js';

function renderGauge(sizeBytes?: number) {
  apiMock.api.backups.storage.mockResolvedValue({ sizeBytes: sizeBytes ?? 0 });
  return renderWithProviders(<StorageGauge databaseId={3} />, {
    queryClient: createQueryClient(),
  });
}

describe('StorageGauge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a loading placeholder while the query is pending', () => {
    apiMock.api.backups.storage.mockReturnValue(new Promise(() => {}));
    const { container } = renderWithProviders(<StorageGauge databaseId={3} />, {
      queryClient: createQueryClient(),
    });
    expect(screen.getByText('…')).toBeInTheDocument();
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('formats 0 bytes as 0 MB with the emerald fill', async () => {
    renderGauge(0);
    await waitFor(() => expect(screen.getByText('0 MB')).toBeInTheDocument());
    const fill = document.querySelector('div.h-full');
    expect(fill?.className).toContain('bg-emerald-500');
    expect((fill as HTMLElement).style.width).toBe('4%');
  });

  it('formats sub-MB sizes in KB', async () => {
    renderGauge(512 * 1024); // 0.5 MB
    await waitFor(() => expect(screen.getByText('512 KB')).toBeInTheDocument());
  });

  it('formats MB sizes', async () => {
    renderGauge(100 * 1024 * 1024);
    await waitFor(() => expect(screen.getByText('100.0 MB')).toBeInTheDocument());
  });

  it('formats GB sizes', async () => {
    renderGauge(2048 * 1024 * 1024);
    await waitFor(() => expect(screen.getByText('2.00 GB')).toBeInTheDocument());
  });

  it('caps the fill at 100% for very large volumes', async () => {
    renderGauge(1024 * 1024 * 1024); // 1 GB
    await waitFor(() => expect(screen.getByText('1.00 GB')).toBeInTheDocument());
    const fill = document.querySelector('div.h-full') as HTMLElement;
    expect(fill.style.width).toBe('100%');
  });

  it('switches to the amber fill above 256 MB', async () => {
    renderGauge(300 * 1024 * 1024);
    await waitFor(() => expect(screen.getByText('300.0 MB')).toBeInTheDocument());
    const fill = document.querySelector('div.h-full');
    expect(fill?.className).toContain('bg-amber-500');
  });

  it('treats a failed query as 0 bytes', async () => {
    apiMock.api.backups.storage.mockRejectedValue(new Error('nope'));
    renderWithProviders(<StorageGauge databaseId={3} />, {
      queryClient: createQueryClient(),
    });
    await waitFor(() => expect(screen.getByText('0 MB')).toBeInTheDocument());
  });
});
