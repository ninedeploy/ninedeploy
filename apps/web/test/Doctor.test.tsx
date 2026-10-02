import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { Doctor } from '../src/routes/Doctor.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';
import type { DoctorFinding, DoctorReport } from '@ninedeploy/sdk';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', async () => {
  const actual = await vi.importActual<typeof import('../src/components/Toast.js')>('../src/components/Toast.js');
  return { ...actual, useToast: () => toastSpy };
});

// Doctor is operator-gated, so the auth mock has to hand out a mutable user.
const authState = vi.hoisted(() => ({ user: { id: 1, isOperator: true } as { id: number; isOperator: boolean } | null }));
vi.mock('../src/lib/auth.js', () => ({
  // AuthProvider stub passes children through — with lib/api.js mocked there
  // is no network work left for the real provider to do anyway.
  AuthProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useAuth: vi.fn(() => ({ user: authState.user, loading: false })),
}));

function finding(overrides: Partial<DoctorFinding>): DoctorFinding {
  return {
    id: 'exited_container:nd-x',
    kind: 'exited_container',
    severity: 'warn',
    title: 'Exited container',
    detail: 'Nobody claims it.',
    target: { type: 'container', name: 'nd-x', id: null },
    action: 'remove_container',
    sizeBytes: null,
    ...overrides,
  };
}

function report(overrides: Partial<DoctorReport>): DoctorReport {
  return {
    generatedAt: '2026-09-01T00:00:00.000Z',
    healthy: false,
    totals: { findings: 1, critical: 0, warn: 1, info: 0, reclaimableBytes: 2048 },
    host: {
      diskUsedPercent: 41,
      diskTotalBytes: 100 * 1024 ** 3,
      diskFreeBytes: 59 * 1024 ** 3,
      dockerImagesBytes: 12 * 1024 ** 3,
      dockerVolumesBytes: 512 * 1024,
      dockerBuildCacheBytes: null,
    },
    findings: [finding({})],
    ...overrides,
  };
}

describe('Doctor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: 1, isOperator: true };
  });

  it('shows the operators-only header for non-operators', () => {
    authState.user = { id: 2, isOperator: false };
    mockOf(api.doctor.scan).mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Doctor />);
    expect(screen.getByText('Host-wide analysis and cleanup — operators only.')).toBeInTheDocument();
    // r473: the guard is not just cosmetic — the admin-only scan must not
    // even fire (the enabled gate could regress while the header stays).
    expect(api.doctor.scan).not.toHaveBeenCalled();
  });

  it('shows the skeleton while the scan is in flight', () => {
    mockOf(api.doctor.scan).mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Doctor />);
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('r562: a failed scan shows an error with retry instead of a blank page', async () => {
    mockOf(api.doctor.scan).mockRejectedValueOnce(new Error('docker unreachable'));
    renderWithProviders(<Doctor />);
    expect(await screen.findByText('The Doctor scan failed')).toBeInTheDocument();
    expect(screen.getByText('docker unreachable')).toBeInTheDocument();
    mockOf(api.doctor.scan).mockResolvedValue(report({}));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('1 finding(s)', { exact: false })).toBeInTheDocument();
  });

  it('renders the all-clear summary and empty state for a healthy host', async () => {
    mockOf(api.doctor.scan).mockResolvedValue(
      report({ healthy: true, totals: { findings: 0, critical: 0, warn: 0, info: 0, reclaimableBytes: 0 }, findings: [], host: { ...report({}).host, dockerBuildCacheBytes: 0 } }),
    );
    renderWithProviders(<Doctor />);
    expect(await screen.findByText('All clear — no warnings')).toBeInTheDocument();
    expect(screen.getByText('Nothing to fix')).toBeInTheDocument();
    // Host facts render inside one combined span; null build cache shows the em-dash.
    expect(
      screen.getByText((_, el) => el?.textContent === 'Disk 41% · Images 12 GB · Volumes 512 KB · Build cache —'),
    ).toBeInTheDocument();
  });

  it('groups findings by severity with sizes and metadata', async () => {
    mockOf(api.doctor.scan).mockResolvedValue(
      report({
        totals: { findings: 3, critical: 1, warn: 1, info: 1, reclaimableBytes: 300 * 1024 ** 2 },
        findings: [
          finding({ id: 'orphan_volume:nd-db-ghost', kind: 'orphan_volume', severity: 'critical', title: 'Orphan volume', action: 'delete_volume', sizeBytes: 4096 }),
          finding({ id: 'exited_container:nd-x', severity: 'warn', title: 'Exited container' }),
          finding({ id: 'dangling_images:host', kind: 'dangling_images', severity: 'info', title: 'Dangling layers', action: 'prune_dangling_images', target: { type: 'host', name: null, id: null } }),
        ],
      }),
    );
    renderWithProviders(<Doctor />);
    expect(await screen.findByText('critical (1)')).toBeInTheDocument();
    expect(screen.getByText('warn (1)')).toBeInTheDocument();
    expect(screen.getByText('info (1)')).toBeInTheDocument();
    expect(screen.getByText('Orphan volume')).toBeInTheDocument();
    expect(screen.getByText('4.0 KB')).toBeInTheDocument(); // binary size chip on the finding
    expect(screen.getByText('300 MB')).toBeInTheDocument(); // reclaimable total in the summary card
    expect(screen.getByText('orphan_volume:nd-db-ghost')).toBeInTheDocument();
    // every finding with an action exposes a Fix button
    expect(screen.getAllByRole('button', { name: 'Fix' })).toHaveLength(3);
  });

  it('runs a non-destructive fix immediately and toasts the action', async () => {
    mockOf(api.doctor.scan).mockResolvedValue(report({ findings: [finding({ action: 'prune_dangling_images', target: { type: 'host', name: null, id: null } })] }));
    mockOf(api.doctor.fix).mockResolvedValue({ fixed: true, id: 'dangling_images:host', action: 'prune_dangling_images', log: ['pruned'], report: report({}) } as never);
    renderWithProviders(<Doctor />);
    fireEvent.click(await screen.findByRole('button', { name: 'Fix' }));
    await waitFor(() => expect(api.doctor.fix).toHaveBeenCalledWith({ findingId: 'exited_container:nd-x' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Fixed: prune_dangling_images', 'info'));
  });

  it('confirms before a destructive fix and runs it on Fix it', async () => {
    mockOf(api.doctor.scan).mockResolvedValue(report({ findings: [finding({ id: 'orphan_volume:nd-db-ghost', kind: 'orphan_volume', severity: 'critical', title: 'Orphan volume', action: 'delete_volume', target: { type: 'volume', name: 'nd-db-ghost', id: null } })] }));
    mockOf(api.doctor.fix).mockResolvedValue({ fixed: true, id: 'orphan_volume:nd-db-ghost', action: 'delete_volume', log: [], report: report({}) } as never);
    renderWithProviders(<Doctor />);
    fireEvent.click(await screen.findByRole('button', { name: 'Fix' }));
    // The dialog names the target and the destruction warning before anything runs.
    expect(await screen.findByText(/This will delete volume nd-db-ghost/)).toBeInTheDocument();
    expect(api.doctor.fix).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Fix it' }));
    await waitFor(() => expect(api.doctor.fix).toHaveBeenCalledWith({ findingId: 'orphan_volume:nd-db-ghost' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Fixed: delete_volume', 'info'));
  });

  it('closes the confirm dialog without running the fix on cancel', async () => {
    mockOf(api.doctor.scan).mockResolvedValue(report({ findings: [finding({ kind: 'orphan_network', severity: 'warn', title: 'Orphan network', action: 'remove_network', target: { type: 'network', name: 'nd-svc-old', id: null } })] }));
    renderWithProviders(<Doctor />);
    fireEvent.click(await screen.findByRole('button', { name: 'Fix' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Fix it' })).toBeNull());
    expect(api.doctor.fix).not.toHaveBeenCalled();
  });

  it('toasts the error message when a fix fails', async () => {
    mockOf(api.doctor.scan).mockResolvedValue(report({ findings: [finding({ action: 'prune_dangling_images', target: { type: 'host', name: null, id: null } })] }));
    mockOf(api.doctor.fix).mockRejectedValue(new Error('finding went stale (409)') as never);
    renderWithProviders(<Doctor />);
    fireEvent.click(await screen.findByRole('button', { name: 'Fix' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('finding went stale (409)', 'error'));
  });

  it('toasts the generic message when a fix fails with a non-Error', async () => {
    mockOf(api.doctor.scan).mockResolvedValue(report({ findings: [finding({ action: 'prune_dangling_images', target: { type: 'host', name: null, id: null } })] }));
    mockOf(api.doctor.fix).mockRejectedValue('plain' as never);
    renderWithProviders(<Doctor />);
    fireEvent.click(await screen.findByRole('button', { name: 'Fix' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Fix failed', 'error'));
  });

  it('re-scans from the Scan button', async () => {
    mockOf(api.doctor.scan).mockResolvedValue(report({ healthy: true, totals: { findings: 0, critical: 0, warn: 0, info: 0, reclaimableBytes: 0 }, findings: [] }));
    renderWithProviders(<Doctor />);
    await screen.findByText('All clear — no warnings');
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
    await waitFor(() => expect(api.doctor.scan).toHaveBeenCalledTimes(2));
  });
});
