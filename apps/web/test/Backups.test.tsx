import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { Backups } from '../src/routes/Backups.js';
import { api, getToken } from '../src/lib/api.js';
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

const backups = [
  { id: 1, databaseId: 10, databaseName: 'postgres-main', status: 'running', sizeBytes: 512 * 1024, createdAt: '2026-01-01T00:00:00Z' },
  { id: 2, databaseId: null, databaseName: null, status: 'failed', sizeBytes: 2 * 1024 ** 3, createdAt: '2026-01-02T00:00:00Z' },
  { id: 3, databaseId: 12, databaseName: 'cache', status: 'error', sizeBytes: 0, createdAt: '2026-01-03T00:00:00Z' },
  { id: 4, databaseId: 13, databaseName: 'tiny', status: 'idle', sizeBytes: 100, createdAt: '2026-01-04T00:00:00Z' },
  { id: 5, databaseId: 14, databaseName: 'medium', status: 'idle', sizeBytes: 50 * 1024 * 1024, createdAt: '2026-01-05T00:00:00Z' },
  { id: 6, databaseId: 99, databaseName: null, status: 'idle', sizeBytes: 10, createdAt: '2026-01-06T00:00:00Z' },
  // Volume snapshots now ride in the same list with their own NAME
  // (label) instead of an anonymous dash under "Database".
  {
    id: 7, databaseId: null, databaseName: null, scope: 'volumes',
    volumeName: 'nd-svc-web-data', label: 'pre-upgrade', status: 'completed',
    sizeBytes: 4096, createdAt: '2026-02-01T00:00:00Z',
  },
];

describe('Backups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('fetch', vi.fn());
    // jsdom has no blob URL support
    URL.createObjectURL = vi.fn(() => 'blob:backup');
    URL.revokeObjectURL = vi.fn();
  });

  it('shows skeleton while loading', () => {
    mockOf(api.backups.list).mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Backups />);
    expect(document.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('shows empty state when there are no backups', async () => {
    mockOf(api.backups.list).mockResolvedValue([] as never);
    renderWithProviders(<Backups />);
    await screen.findByText('No backups yet');
    expect(screen.getByText(/Use the Backup button/)).toBeInTheDocument();
  });

  it('renders the table with formatted sizes, statuses and dates', async () => {
    mockOf(api.backups.list).mockResolvedValue(backups as never);
    renderWithProviders(<Backups />);
    await screen.findByText('postgres-main');
    expect(screen.getByText('524.3 KB')).toBeInTheDocument(); // decimal formatting
    expect(screen.getByText('2.1 GB')).toBeInTheDocument();
    expect(screen.getByText('52.4 MB')).toBeInTheDocument();
    expect(screen.getByText('100 B')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0); // null databaseName
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('error')).toBeInTheDocument();
    expect(screen.getAllByText('idle').length).toBeGreaterThan(0); // multiple idle backups
    expect(screen.getByText(/01 Jan 2026/)).toBeInTheDocument(); // formatDateTime (en-GB)
  });

  it('names volume snapshots instead of showing an anonymous row', async () => {
    mockOf(api.backups.list).mockResolvedValue(backups as never);
    renderWithProviders(<Backups />);
    await screen.findByText('pre-upgrade'); // the snapshot label…
    expect(screen.getByText('nd-svc-web-data')).toBeInTheDocument(); // …and its volume
  });

  it('shows an error card with retry when the backups query fails', async () => {
    mockOf(api.backups.list).mockRejectedValue(new Error('boom') as never);
    mockOf(api.backupDestinations.list).mockResolvedValue([] as never);
    renderWithProviders(<Backups />);
    expect(await screen.findByText("Couldn't load backups")).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.backups.list).toHaveBeenCalledTimes(2));
  });

  it('restores a backup after confirmation', async () => {
    mockOf(api.backups.list).mockResolvedValue(backups as never);
    mockOf(api.backups.restore).mockResolvedValue({ ok: true } as never);
    renderWithProviders(<Backups />);
    const buttons = await screen.findAllByTitle('Restore');
    fireEvent.click(buttons[0]!);
    // Two matches: the row icon button (title) and the dialog confirm button.
    const confirm = screen.getAllByRole('button', { name: 'Restore' }).at(-1)!;
    fireEvent.click(confirm);
    await waitFor(() => expect(api.backups.restore).toHaveBeenCalledWith(10, 1));
  });

  it('cancels a restore without calling the API', async () => {
    mockOf(api.backups.list).mockResolvedValue(backups as never);
    renderWithProviders(<Backups />);
    const buttons = await screen.findAllByTitle('Restore');
    fireEvent.click(buttons[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.backups.restore).not.toHaveBeenCalled();  });

  it('opens a restore dialog for a backup without a database name and ignores restores without a database', async () => {
    mockOf(api.backups.list).mockResolvedValue(backups as never);
    mockOf(api.backups.restore).mockResolvedValue({ ok: true } as never);
    renderWithProviders(<Backups />);
    await screen.findByText('postgres-main');
    // Rows without a databaseId cannot restore: a volume snapshot points at
    // the Volumes page, a database backup whose database is gone says so.
    // Clicking these used to do nothing at all, with zero feedback.
    expect(screen.getByTitle('Volume snapshots are restored from the Volumes page')).toBeDisabled();
    expect(screen.getByTitle('The source database no longer exists')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(api.backups.restore).not.toHaveBeenCalled();
    // Row with a databaseId but a null name falls back to generic copy.
    fireEvent.click(screen.getAllByTitle('Restore').at(-1)!);
    expect(await screen.findByText('Restore the database from this backup? Current data will be overwritten.')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore' }).at(-1)!);
    await waitFor(() => expect(api.backups.restore).toHaveBeenCalled());
  });

  it('deletes a backup after confirmation', async () => {
    mockOf(api.backups.list).mockResolvedValue(backups as never);
    mockOf(api.backups.remove).mockResolvedValue(undefined as never);
    renderWithProviders(<Backups />);
    const buttons = await screen.findAllByTitle('Delete');
    fireEvent.click(buttons[0]!);
    const confirm = screen.getAllByRole('button', { name: 'Delete' }).at(-1)!;
    fireEvent.click(confirm);
    await waitFor(() => expect(api.backups.remove).toHaveBeenCalledWith(1));
  });

  it('downloads a backup on success and does nothing on failure', async () => {
    mockOf(api.backups.list).mockResolvedValue(backups as never);
    const fetchMock = vi.mocked(fetch);
    const okResponse = {
      ok: true,
      blob: async () => new Blob(['data']),
    };
    fetchMock.mockResolvedValueOnce(okResponse as Response);
    renderWithProviders(<Backups />);
    const downloadButtons = await screen.findAllByTitle('Download');
    fireEvent.click(downloadButtons[0]!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/v1/backups/1/download');
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(`Bearer ${getToken()}`);
    expect(URL.createObjectURL).toHaveBeenCalled();
    // Revocation is deferred (Safari commits downloads asynchronously); wait
    // for the 10s cleanup timer instead of expecting a synchronous call.
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalled(), { timeout: 3_000 });

    // failure path
    fetchMock.mockResolvedValueOnce({ ok: false } as Response);
    fireEvent.click(downloadButtons[0]!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('downloads without an authorization header when no token is set', async () => {
    mockOf(api.backups.list).mockResolvedValue(backups as never);
    mockOf(getToken).mockReturnValue(null);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['x']) } as Response);
    renderWithProviders(<Backups />);
    const downloadButtons = await screen.findAllByTitle('Download');
    fireEvent.click(downloadButtons[0]!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(null);
  });

  it('toasts when the download request itself throws', async () => {
    mockOf(api.backups.list).mockResolvedValue(backups as never);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(new Error('network down') as never);
    renderWithProviders(<Backups />);
    const downloadButtons = await screen.findAllByTitle('Download');
    fireEvent.click(downloadButtons[0]!);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Download failed', 'error'));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('toasts on restore and delete failures', async () => {
    mockOf(api.backups.list).mockResolvedValue(backups as never);
    mockOf(api.backups.restore).mockRejectedValue(new Error('nope') as never);
    mockOf(api.backups.remove).mockRejectedValue(new Error('gone') as never);
    renderWithProviders(<Backups />);
    const restoreButtons = await screen.findAllByTitle('Restore');
    fireEvent.click(restoreButtons[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore' }).at(-1)!);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Restore failed', 'error'));
    fireEvent.click(screen.getAllByTitle('Delete')[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1)!);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not delete the backup', 'error'));
  });

  it('toasts when a destination create or removal fails', async () => {
    mockOf(api.backups.list).mockResolvedValue([] as never);
    mockOf(api.backupDestinations.list).mockResolvedValue([
      { id: 1, name: 'minio', endpoint: 'https://s3.example.com', region: 'eu', bucket: 'b', prefix: 'nd', active: true, createdAt: 'x' },
    ] as never);
    mockOf(api.backupDestinations.create).mockRejectedValueOnce(new Error('dup') as never);
    mockOf(api.backupDestinations.remove).mockRejectedValueOnce(new Error('busy') as never);
    renderWithProviders(<Backups />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add destination' }));
    const values = ['x', 'https://s3.example.com', 'eu', 'b', 'nd', 'ak'];
    const inputs = screen.getAllByRole('textbox');
    for (let i = 0; i < values.length; i++) fireEvent.change(inputs[i]!, { target: { value: values[i] } });
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="password"]')!, { target: { value: 'sk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save destination' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not save the destination', 'error'));
    fireEvent.click(screen.getAllByTitle('Remove destination')[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1)!);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not remove the destination', 'error'));
  });

  it('shows an error card with retry for destinations', async () => {
    mockOf(api.backups.list).mockResolvedValue([] as never);
    mockOf(api.backupDestinations.list).mockRejectedValue(new Error('s3 down') as never);
    renderWithProviders(<Backups />);
    expect(await screen.findByText("Couldn't load destinations")).toBeInTheDocument();
    expect(screen.getByText('s3 down')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.backupDestinations.list).toHaveBeenCalledTimes(2));
  });

  // ── off-site destinations ───────────────────────────────────────────────
  it('renders destinations with active/paused badges and test/remove actions', async () => {
    mockOf(api.backups.list).mockResolvedValue([] as never);
    mockOf(api.backupDestinations.list).mockResolvedValue([
      { id: 1, name: 'minio', endpoint: 'https://s3.example.com', region: 'eu', bucket: 'b', prefix: 'nd', active: true, createdAt: 'x' },
      { id: 2, name: 'b2', endpoint: 'https://s3.b2.example.net', region: 'us', bucket: 'b2', prefix: 'nd', active: false, createdAt: 'x' },
    ] as never);
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
    renderWithProviders(<Backups />);

    expect(await screen.findByText('minio')).toBeInTheDocument();
    expect(screen.getByText('https://s3.b2.example.net/b2/nd')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('paused')).toBeInTheDocument();

    fireEvent.click(screen.getAllByTitle('Test connection')[0]!);
    await waitFor(() => expect(api.backupDestinations.test).toHaveBeenCalledWith(1));
    fireEvent.click(screen.getAllByTitle('Remove destination')[1]!);
    // Removal goes through the shared confirm dialog now.
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1)!);
    await waitFor(() => expect(api.backupDestinations.remove).toHaveBeenCalledWith(2));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Destination removed', 'success'));
  });

  it('creates a destination from the form', async () => {
    mockOf(api.backups.list).mockResolvedValue([] as never);
    mockOf(api.backupDestinations.list).mockResolvedValue([] as never);
    mockOf(api.backupDestinations.create).mockResolvedValue({ id: 9 } as never);
    renderWithProviders(<Backups />);

    fireEvent.click(await screen.findByRole('button', { name: 'Add destination' }));
    // Inputs appear in form order: name, endpoint, region, bucket, prefix, accessKey + a password field for the secret.
    const values = ['minio-offsite', 'https://s3.example.com', 'eu', 'b', 'nd', 'ak'];
    const inputs = screen.getAllByRole('textbox');
    for (let i = 0; i < values.length && i < inputs.length; i++) {
      fireEvent.change(inputs[i]!, { target: { value: values[i] } });
    }
    const secretInput = document.querySelector<HTMLInputElement>('input[type="password"]');
    expect(secretInput).toBeTruthy();
    fireEvent.change(secretInput!, { target: { value: 'sk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save destination' }));
    await waitFor(() =>
      expect(api.backupDestinations.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'minio-offsite', endpoint: 'https://s3.example.com', bucket: 'b' })));
  });

  it('keeps the save button disabled until required fields are filled', async () => {
    mockOf(api.backups.list).mockResolvedValue([] as never);
    mockOf(api.backupDestinations.list).mockResolvedValue([] as never);
    renderWithProviders(<Backups />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add destination' }));
    expect(screen.getByRole('button', { name: 'Save destination' })).toBeDisabled();
    // An incomplete submit does not call the API.
    fireEvent.submit(screen.getAllByRole('textbox')[0]!.closest('form')!);
    expect(api.backupDestinations.create).not.toHaveBeenCalled();
  });

  it('shows the saving state while a destination create is in flight', async () => {
    mockOf(api.backups.list).mockResolvedValue([] as never);
    mockOf(api.backupDestinations.list).mockResolvedValue([] as never);
    mockOf(api.backupDestinations.create).mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<Backups />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add destination' }));
    const values = ['x', 'https://s3.example.com', 'eu', 'b', 'nd', 'ak'];
    const inputs = screen.getAllByRole('textbox');
    for (let i = 0; i < values.length; i++) fireEvent.change(inputs[i]!, { target: { value: values[i] } });
    const secretInput = document.querySelector<HTMLInputElement>('input[type="password"]');
    fireEvent.change(secretInput!, { target: { value: 'sk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save destination' }));
    expect(await screen.findByText('Saving…')).toBeInTheDocument();
  });

  it('toggles destination active state and surfaces test failures', async () => {
    mockOf(api.backups.list).mockResolvedValue([] as never);
    mockOf(api.backupDestinations.list).mockResolvedValue([
      { id: 1, name: 'minio', endpoint: 'https://s3.example.com', region: 'eu', bucket: 'b', prefix: 'nd', active: true, createdAt: 'x' },
    ] as never);
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
    renderWithProviders(<Backups />);
    fireEvent.click(await screen.findByText('active'));
    await waitFor(() => expect(api.backupDestinations.update).toHaveBeenCalledWith(1, { active: false }));
    // Test results surface via toasts now (non-Error rejections use the generic message).
    mockOf(api.backupDestinations.test).mockRejectedValueOnce(new Error('no route') as never);
    fireEvent.click(screen.getByTitle('Test connection'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('no route', 'error'));
    mockOf(api.backupDestinations.test).mockRejectedValueOnce('boom' as never);
    fireEvent.click(screen.getByTitle('Test connection'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Test failed', 'error'));
    // Success path toasts too.
    mockOf(api.backupDestinations.test).mockResolvedValueOnce({ ok: true } as never);
    fireEvent.click(screen.getByTitle('Test connection'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Destination reachable — credentials work', 'success'));
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
