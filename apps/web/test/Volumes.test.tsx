import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Volumes } from '../src/routes/Volumes.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

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

const volumes = [
  { name: 'nd-data', sizeBytes: 512 * 1024 * 1024, owner: { id: 5, kind: 'database', name: 'db', engine: 'postgres' }, inUse: false },
  { name: 'nd-app', sizeBytes: 2 * 1024 ** 3, owner: { id: 7, kind: 'service', name: 'api', engine: null }, inUse: false },
  { name: 'nd-old', sizeBytes: 100, owner: null, inUse: false },
];

// r472: the page/queries are operator-gated — these tests exercise the
// operator view, so the auth mock hands out an operator.
vi.mock('../src/lib/auth.js', () => ({
  AuthProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useAuth: vi.fn(() => ({ user: { id: 1, isOperator: true }, loading: false })),
}));

describe('Volumes', () => {
  it('opens the volume browser from a volume card', async () => {
    mockOf(api.volumes.list).mockResolvedValue([
      { name: 'nd-svc-api-data', sizeBytes: 1024, owner: { kind: 'service', name: 'api' }, inUse: true },
    ] as never);
    renderWithProviders(<Volumes />);
    fireEvent.click(await screen.findByTitle('Browse files in this volume'));
    // Cards show the owner's name; the raw volume name appears in the browser header only.
    expect(await screen.findAllByText('nd-svc-api-data')).toHaveLength(1);
    expect(api.volumes.listFiles).toHaveBeenCalledWith('nd-svc-api-data', '');
    // close via the X button
    fireEvent.click(screen.getByLabelText('Close volume browser'));
    await waitFor(() => expect(screen.queryByLabelText('Close volume browser')).toBeNull());
  });

  it('expands and collapses the snapshot panel for a retained volume', async () => {
    mockOf(api.volumes.list).mockResolvedValue([volumes[2]] as never);
    mockOf(api.volumeBackups.list).mockResolvedValue([] as never);
    renderWithProviders(<Volumes />);

    // A retained volume has no owning service, so its snapshots were
    // previously unreachable from anywhere in the panel.
    const toggle = await screen.findByLabelText('Snapshots for nd-old');
    fireEvent.click(toggle);
    expect(await screen.findByTestId('volume-backups-panel')).toBeInTheDocument();
    await waitFor(() => expect(api.volumeBackups.list).toHaveBeenCalledWith('nd-old'));
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('volume-backups-panel')).toBeNull());
  });

  it('collapses the snapshot panel when its own toggle is pressed again', async () => {
    mockOf(api.volumes.list).mockResolvedValue([volumes[2]] as never);
    mockOf(api.volumeBackups.list).mockResolvedValue([] as never);
    renderWithProviders(<Volumes />);

    const toggle = await screen.findByLabelText('Snapshots for nd-old');
    fireEvent.click(toggle);
    expect(await screen.findByTestId('volume-backups-panel')).toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByTestId('volume-backups-panel')).toBeNull());
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows skeleton while loading', () => {
    mockOf(api.volumes.list).mockReturnValue(new Promise(() => {}));
    mockOf(api.system.resources).mockResolvedValue({} as never);
    renderWithProviders(<Volumes />);
    expect(document.querySelectorAll('.animate-pulse').length).toBe(3);
  });

  it('shows empty state when there are no volumes', async () => {
    mockOf(api.volumes.list).mockResolvedValue([] as never);
    mockOf(api.system.resources).mockResolvedValue({
      network: 'ninedeploy',
      containers: 2,
      volumes: 0,
      imagesSummary: { active: 3, total: 5, size: '1.2 GB', reclaimable: '0B' },
    } as never);
    renderWithProviders(<Volumes />);
    await screen.findByText('No volumes');
    expect(screen.getByText((_, el) => el?.textContent === '0 volumes · 0 B used')).toBeInTheDocument();
    // Docker resources card with metrics
    expect(screen.getByText('ninedeploy')).toBeInTheDocument();
    expect(screen.getByText('3/5 active')).toBeInTheDocument();
  });

  it('renders volume cards with owners, formats and retention', async () => {
    mockOf(api.volumes.list).mockResolvedValue(volumes as never);
    mockOf(api.system.resources).mockResolvedValue({
      network: 'ninedeploy',
      containers: 1,
      volumes: 3,
      imagesSummary: { active: 1, total: 1, size: '10 MB', reclaimable: '2 MB' },
    } as never);
    renderWithProviders(<Volumes />);
    await screen.findByText('db');
    expect(screen.getByText('536.9 MB')).toBeInTheDocument(); // decimal 1000-based formatting
    expect(screen.getByText('2.1 GB')).toBeInTheDocument();
    expect(screen.getByText('100 B')).toBeInTheDocument();
    expect(screen.getByText('Retained')).toBeInTheDocument();
    expect(screen.getByText('no active owner')).toBeInTheDocument();
    expect(screen.getAllByText('attached · stopped').length).toBe(2);
    expect(screen.getByText('retained · reusable')).toBeInTheDocument();
    // Owned volumes deep-link to their owner's detail page.
    expect(screen.getByRole('link', { name: /DB/ })).toHaveAttribute('href', '/databases/5');
    expect(screen.getByRole('link', { name: /Service/ })).toHaveAttribute('href', '/services/7');
    // retained count in subtitle
    expect(screen.getByText(/1 retained/)).toBeInTheDocument();
    // docker resources reclaimable rendered as a real element, not literal text
    expect(screen.getByText('2 MB')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Backups' })).toHaveAttribute('href', '/backups');
  });

  it('deletes a volume after typing its name', async () => {
    const user = userEvent.setup();
    mockOf(api.volumes.list).mockResolvedValue(volumes as never);
    mockOf(api.system.resources).mockResolvedValue({} as never);
    mockOf(api.volumes.remove).mockResolvedValue(undefined as never);
    renderWithProviders(<Volumes />);
    fireEvent.click((await screen.findAllByTitle('Delete volume (destructive)'))[0]!);
    // Delete stays disabled until the exact volume name is typed.
    const del = screen.getByRole('button', { name: /^Delete$/ });
    expect(del).toBeDisabled();
    await user.type(screen.getByPlaceholderText('nd-data'), 'nd-data');
    expect(del).toBeEnabled();
    fireEvent.click(del);
    await waitFor(() => expect(api.volumes.remove).toHaveBeenCalledWith('nd-data'));
  });

  it('keeps delete disabled for a mismatched volume name', async () => {
    const user = userEvent.setup();
    mockOf(api.volumes.list).mockResolvedValue(volumes as never);
    mockOf(api.system.resources).mockResolvedValue({} as never);
    renderWithProviders(<Volumes />);
    fireEvent.click((await screen.findAllByTitle('Delete volume (destructive)'))[0]!);
    await user.type(screen.getByPlaceholderText('nd-data'), 'wrong');
    expect(screen.getByRole('button', { name: /^Delete$/ })).toBeDisabled();
    expect(api.volumes.remove).not.toHaveBeenCalled();
  });

  it('hides the delete button for in-use volumes and shows the lock', async () => {
    mockOf(api.volumes.list).mockResolvedValue([
      { name: 'nd-live', sizeBytes: 10, owner: { kind: 'service', name: 'busy', engine: null }, inUse: true },
    ] as never);
    mockOf(api.system.resources).mockResolvedValue({} as never);
    renderWithProviders(<Volumes />);
    await screen.findByText('busy');
    expect(screen.getByText('in use · locked')).toBeInTheDocument();
    expect(screen.queryByTitle('Delete volume (destructive)')).not.toBeInTheDocument();
  });

  it('reports a non-Error delete failure with the generic toast', async () => {
    const user = userEvent.setup();
    mockOf(api.volumes.list).mockResolvedValue(volumes as never);
    mockOf(api.system.resources).mockResolvedValue({} as never);
    mockOf(api.volumes.remove).mockRejectedValue('plain' as never);
    renderWithProviders(<Volumes />);
    fireEvent.click((await screen.findAllByTitle('Delete volume (destructive)'))[0]!);
    await user.type(screen.getByPlaceholderText('nd-data'), 'nd-data');
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Delete failed', 'error'));
  });

  it('shows the lock title for an in-use volume without an owner kind', async () => {
    mockOf(api.volumes.list).mockResolvedValue([
      { name: 'nd-live', sizeBytes: 10, owner: null, inUse: true },
    ] as never);
    mockOf(api.system.resources).mockResolvedValue({} as never);
    renderWithProviders(<Volumes />);
    const lock = await screen.findByTitle('Attached to a running workload — stop it first');
    expect(lock).toBeInTheDocument();
  });

  it('closes the confirm dialog without deleting on cancel', async () => {
    mockOf(api.volumes.list).mockResolvedValue(volumes as never);
    mockOf(api.system.resources).mockResolvedValue({} as never);
    renderWithProviders(<Volumes />);
    fireEvent.click((await screen.findAllByTitle('Delete volume (destructive)'))[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText('nd-data')).not.toBeInTheDocument();
    expect(api.volumes.remove).not.toHaveBeenCalled();
  });

  it('reports delete failures via toast', async () => {
    const user = userEvent.setup();
    mockOf(api.volumes.list).mockResolvedValue(volumes as never);
    mockOf(api.system.resources).mockResolvedValue({} as never);
    mockOf(api.volumes.remove).mockRejectedValue(new Error('boom') as never);
    renderWithProviders(<Volumes />);
    fireEvent.click((await screen.findAllByTitle('Delete volume (destructive)'))[0]!);
    await user.type(screen.getByPlaceholderText('nd-data'), 'nd-data');
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('boom', 'error'));
  });

  it('shows an error card with retry when the volumes query fails', async () => {
    mockOf(api.volumes.list).mockRejectedValue(new Error('docker down') as never);
    mockOf(api.system.resources).mockResolvedValue({} as never);
    renderWithProviders(<Volumes />);
    expect(await screen.findByText("Couldn't load volumes")).toBeInTheDocument();
    expect(screen.getByText('docker down')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.volumes.list).toHaveBeenCalledTimes(2));
  });

  it('prunes images and shows reclaimed resources', async () => {
    mockOf(api.volumes.list).mockResolvedValue(volumes as never);
    mockOf(api.system.resources).mockResolvedValue({
      network: 'ninedeploy',
      containers: 3,
      volumes: 2,
      imagesSummary: { active: 2, total: 4, size: '500 MB', reclaimable: '300 MB' },
    } as never);
    mockOf(api.system.pruneImages).mockResolvedValue({ ok: true } as never);
    renderWithProviders(<Volumes />);
    fireEvent.click(await screen.findByRole('button', { name: /Prune images/ }));
    await waitFor(() => expect(api.system.pruneImages).toHaveBeenCalled());
    expect(screen.getByText('300 MB')).toBeInTheDocument();
  });

  it('toasts when a prune fails', async () => {
    mockOf(api.volumes.list).mockResolvedValue(volumes as never);
    mockOf(api.system.resources).mockResolvedValue({} as never);
    mockOf(api.system.pruneImages).mockRejectedValue(new Error('docker busy') as never);
    renderWithProviders(<Volumes />);
    fireEvent.click(await screen.findByRole('button', { name: /Prune images/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Prune failed', 'error'));
  });

  it('prunes all retained volumes through confirmation dialog', async () => {
    mockOf(api.volumes.list).mockResolvedValue(volumes as never);
    mockOf(api.system.resources).mockResolvedValue({} as never);
    mockOf(api.volumes.prune).mockResolvedValue({ ok: true, deleted: 1, freedBytes: 100 } as never);
    renderWithProviders(<Volumes />);
    fireEvent.click(await screen.findByRole('button', { name: /Prune retained/i }));
    expect(screen.getByText(/Permanently delete 1 retained volume\(s\) and free 100 B of disk space\?/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Prune all' }));
    await waitFor(() => expect(api.volumes.prune).toHaveBeenCalled());
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Pruned 1 retained volume(s) (freed 100 B)', 'success'));
  });

  it('handles prune retained volumes failure', async () => {
    mockOf(api.volumes.list).mockResolvedValue(volumes as never);
    mockOf(api.system.resources).mockResolvedValue({} as never);
    mockOf(api.volumes.prune).mockRejectedValue(new Error('prune lock error') as never);
    renderWithProviders(<Volumes />);
    fireEvent.click(await screen.findByRole('button', { name: /Prune retained/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Prune all' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('prune lock error', 'error'));
  });

  it('toasts generic error when prune fails with non-Error', async () => {
    mockOf(api.volumes.list).mockResolvedValue(volumes as never);
    mockOf(api.system.resources).mockResolvedValue({} as never);
    mockOf(api.volumes.prune).mockRejectedValue('prune failed string' as never);
    renderWithProviders(<Volumes />);
    fireEvent.click(await screen.findByRole('button', { name: /Prune retained/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Prune all' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Prune failed', 'error'));
  });
});
