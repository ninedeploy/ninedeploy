import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StorageSection } from '../src/routes/settings/StorageSection.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useToast: () => toastSpy,
}));

describe('StorageSection', () => {
  const fakeStatus = {
    enabled: true,
    thresholdPercent: 85,
    pruneImages: true,
    pruneBuildCache: true,
    pruneContainers: true,
    pruneVolumes: false,
    maxAgeHours: 168,
    diskUsedPercent: 65,
    diskTotalBytes: 100 * 1024 * 1024 * 1024,
    diskFreeBytes: 35 * 1024 * 1024 * 1024,
    lastPrunedAt: '2026-08-18T10:00:00.000Z',
    lastFreedBytes: 1073741824, // 1 GB
  };

  beforeEach(() => {
    vi.clearAllMocks();
    toastSpy.toast.mockClear();
    mockOf(api.housekeeping.getAutoPrune).mockResolvedValue(fakeStatus as never);
    mockOf(api.housekeeping.updateAutoPrune).mockResolvedValue({ ...fakeStatus, thresholdPercent: 90 } as never);
    mockOf(api.housekeeping.runPrune).mockResolvedValue({
      ok: true,
      freedBytes: 524288000, // ~500 MB
      details: { imagesFreed: 'Total reclaimed space: 500MB' },
    } as never);
  });

  it('r562: a failed load shows an error and offers no Save that would write the defaults', async () => {
    mockOf(api.housekeeping.getAutoPrune).mockRejectedValueOnce(new Error('HTTP 500'));
    renderWithProviders(<StorageSection />);
    expect(await screen.findByText('Could not load the storage settings')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save Auto-Prune Settings/ })).toBeNull();
    expect(api.housekeeping.updateAutoPrune).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('65%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save Auto-Prune Settings/ })).not.toBeDisabled();
  });

  it('r562: Save stays disabled until the real configuration has loaded', () => {
    mockOf(api.housekeeping.getAutoPrune).mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<StorageSection />);
    expect(screen.getByRole('button', { name: /Save Auto-Prune Settings/ })).toBeDisabled();
  });

  it('renders disk usage gauge, threshold, and cleanup targets', async () => {
    renderWithProviders(<StorageSection />);

    await waitFor(() => {
      expect(screen.getByText('65%')).toBeInTheDocument();
    });

    expect(screen.getByText(/used of 100.0 GB \(35.0 GB free\)/)).toBeInTheDocument();
    expect(screen.getByText('85%')).toBeInTheDocument();
    expect(screen.getByText('Unused Docker Images')).toBeInTheDocument();
    expect(screen.getByText('BuildKit Cache Layers')).toBeInTheDocument();
    expect(screen.getByText('Stopped Containers')).toBeInTheDocument();
    expect(screen.getByText('Anonymous Volumes')).toBeInTheDocument();
    expect(screen.getByText(/Last pruned:/)).toBeInTheDocument();
    expect(screen.getByText('1.0 GB')).toBeInTheDocument();
  });

  it('renders zero bytes and amber/rose thresholds when usage is medium/high', async () => {
    mockOf(api.housekeeping.getAutoPrune).mockResolvedValueOnce({
      ...fakeStatus,
      diskUsedPercent: 75,
      diskTotalBytes: 0,
      diskFreeBytes: 0,
      lastPrunedAt: '2026-08-18T10:00:00.000Z',
      lastFreedBytes: 0,
    } as never);

    renderWithProviders(<StorageSection />);
    await waitFor(() => {
      expect(screen.getByText('75%')).toBeInTheDocument();
      expect(screen.getByText('0 B')).toBeInTheDocument();
    });
  });

  it('renders fallback when data is null/missing', async () => {
    mockOf(api.housekeeping.getAutoPrune).mockResolvedValueOnce(null as never);

    renderWithProviders(<StorageSection />);
    await waitFor(() => {
      expect(screen.getByText('0%')).toBeInTheDocument();
      expect(screen.getByText(/used of 0 GB \(0 GB free\)/)).toBeInTheDocument();
    });
  });

  it('renders 92% disk usage with rose badge and null lastFreedBytes', async () => {
    mockOf(api.housekeeping.getAutoPrune).mockResolvedValueOnce({
      ...fakeStatus,
      diskUsedPercent: 92,
      lastPrunedAt: '2026-08-18T10:00:00.000Z',
      lastFreedBytes: null,
    } as never);

    renderWithProviders(<StorageSection />);
    await waitFor(() => {
      expect(screen.getByText('92%')).toBeInTheDocument();
      expect(screen.getByText(/Last pruned:/)).toBeInTheDocument();
      expect(screen.queryByText(/Reclaimed:/)).not.toBeInTheDocument();
    });
  });

  it('adjusts threshold slider, checkboxes, max age hours and saves settings', async () => {
    const user = userEvent.setup();
    renderWithProviders(<StorageSection />);

    await waitFor(() => expect(screen.getByText('Save Auto-Prune Settings')).toBeInTheDocument());
    expect(await screen.findByText('65%')).toBeInTheDocument();
    expect(await screen.findByText('Enabled')).toBeInTheDocument();

    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '90' } });

    // Toggle master switch
    const masterSwitch = await screen.findByText('Enabled');
    await user.click(masterSwitch);

    // Change max age hours
    const ageInput = screen.getByRole('spinbutton');
    fireEvent.change(ageInput, { target: { value: '72' } });
    fireEvent.change(ageInput, { target: { value: '' } });

    // Toggle target checkboxes
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]!); // pruneImages
    fireEvent.click(checkboxes[1]!); // pruneBuildCache
    fireEvent.click(checkboxes[2]!); // pruneContainers
    fireEvent.click(checkboxes[3]!); // pruneVolumes

    // Save
    await user.click(screen.getByText('Save Auto-Prune Settings'));

    await waitFor(() => {
      expect(api.housekeeping.updateAutoPrune).toHaveBeenCalledWith(
        expect.objectContaining({
          thresholdPercent: 90,
          enabled: false,
          maxAgeHours: 168,
        }),
      );
      expect(toastSpy.toast).toHaveBeenCalledWith(
        expect.stringContaining('Auto-prune settings saved'),
        'success',
      );
    });
  });

  it('executes manual cleanup on click and displays reclaimed space', async () => {
    const user = userEvent.setup();
    renderWithProviders(<StorageSection />);

    await waitFor(() => expect(screen.getByText('Run Cleanup Now')).toBeInTheDocument());
    await user.click(screen.getByText('Run Cleanup Now'));

    await waitFor(() => {
      expect(api.housekeeping.runPrune).toHaveBeenCalled();
      expect(toastSpy.toast).toHaveBeenCalledWith(
        expect.stringContaining('Disk clean completed! Reclaimed 500.0 MB'),
        'success',
      );
    });
  });

  it('handles update and prune execution errors gracefully', async () => {
    const user = userEvent.setup();
    mockOf(api.housekeeping.updateAutoPrune).mockRejectedValueOnce(new Error('Save failed'));
    mockOf(api.housekeeping.runPrune).mockRejectedValueOnce(new Error('Prune failed'));

    renderWithProviders(<StorageSection />);
    await waitFor(() => expect(screen.getByText('Run Cleanup Now')).toBeInTheDocument());

    await user.click(screen.getByText('Run Cleanup Now'));
    await waitFor(() => {
      expect(toastSpy.toast).toHaveBeenCalledWith('Failed to execute disk cleanup', 'error');
    });

    await user.click(screen.getByText('Save Auto-Prune Settings'));
    await waitFor(() => {
      expect(toastSpy.toast).toHaveBeenCalledWith('Failed to update auto-prune settings', 'error');
    });
  });
});
