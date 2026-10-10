import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, renderWithProviders } from './web-utils.js';

const apiMock = vi.hoisted(() => ({
  api: {
    databases: {
      importFile: vi.fn(),
      imports: { list: vi.fn(), create: vi.fn(), wait: vi.fn(), start: vi.fn(), cancel: vi.fn() },
    },
    backupDestinations: { list: vi.fn(), objects: vi.fn() },
  },
}));
vi.mock('../src/lib/api.js', () => apiMock);

const authMock = vi.hoisted(() => ({ user: { id: 1, isOperator: false } as { id: number; isOperator: boolean } }));
vi.mock('../src/lib/auth.js', () => ({
  AuthProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useAuth: vi.fn(() => ({ user: authMock.user, loading: false })),
}));

import { ToastProvider } from '../src/components/Toast.js';
import { fileChunks, ImportCard } from '../src/routes/database/ImportCard.js';

const pg = { id: 7, name: 'main', engine: 'postgres' } as never;

const row = (over: Record<string, unknown> = {}) => ({
  id: 3, databaseId: 7, source: 'upload', status: 'completed', format: 'pg_custom', sizeBytes: 2048, receivedBytes: 2048,
  chunkSize: 8388608, sha256: null, filename: 'prod.dump', destinationId: null, objectKey: null, options: {},
  safetyBackupId: null, error: null, createdByUserId: 1, createdAt: '2026-10-08T10:00:00.000Z', updatedAt: '2026-10-08T10:00:00.000Z',
  startedAt: null, completedAt: null, ...over,
});

function renderCard(database = pg, queryClient = createQueryClient()) {
  return renderWithProviders(<ImportCard db={database} />, { queryClient, wrapper: (c) => <ToastProvider>{c}</ToastProvider> });
}

const pick = (file: File) => fireEvent.change(screen.getByLabelText('Dump file'), { target: { files: [file] } });

describe('fileChunks', () => {
  it('slices a file from the offset on', async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4, 5])], 'x.sql');
    const out: number[][] = [];
    for await (const part of fileChunks(file, 2)(1)) out.push([...part]);
    expect(out).toEqual([[2, 3], [4, 5]]);
    const all: number[] = [];
    for await (const part of fileChunks(file)(0)) all.push(...part);
    expect(all).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('ImportCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.user = { id: 1, isOperator: false };
    apiMock.api.databases.imports.list.mockResolvedValue([]);
    apiMock.api.backupDestinations.list.mockResolvedValue([{ id: 2, name: 'R2', bucket: 'nd' }]);
    apiMock.api.backupDestinations.objects.mockResolvedValue([{ key: 'db/prod.dump', sizeBytes: 4096, lastModified: null }]);
  });

  it('uploads a file with the postgres options, reporting progress', async () => {
    let finish: (v: unknown) => void = () => {};
    apiMock.api.databases.importFile.mockImplementation(
      (_id: number, _src: unknown, o: { onCreated: () => void; onProgress: (p: unknown) => void }) => {
        o.onCreated();
        o.onProgress({ receivedBytes: 1024, sizeBytes: 2048 });
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    );
    renderCard();
    expect(await screen.findByText('No imports yet.')).toBeInTheDocument();
    expect(screen.getByText(/pg_dump custom-format/)).toBeInTheDocument();
    // Members are not offered to skip the safety backup, nor the S3 picker.
    expect(screen.queryByText(/Skip the pre-import safety backup/)).not.toBeInTheDocument();
    expect(screen.queryByText('From a backup destination')).not.toBeInTheDocument();
    expect(apiMock.api.backupDestinations.list).not.toHaveBeenCalled();

    const upload = screen.getByRole('button', { name: /Upload and import/ });
    expect(upload).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/--clean --if-exists/));
    fireEvent.click(screen.getByLabelText(/Single transaction/));
    pick(new File([new Uint8Array(2048)], 'prod.dump'));
    fireEvent.click(upload);
    await waitFor(() =>
      expect(apiMock.api.databases.importFile).toHaveBeenCalledWith(7, expect.any(Function), expect.objectContaining({
        sizeBytes: 2048, filename: 'prod.dump', options: { clean: true, singleTransaction: false },
      })),
    );
    expect(apiMock.api.databases.importFile.mock.calls[0]![2]).not.toHaveProperty('resumeImportId');
    expect(await screen.findByTestId('import-progress')).toHaveTextContent('(50%)');
    await act(async () => finish(row({ id: 9, status: 'running' })));
    expect(await screen.findByText('Import #9 started')).toBeInTheDocument();
    expect(screen.queryByTestId('import-progress')).not.toBeInTheDocument();
  });

  it('reports a failed upload', async () => {
    apiMock.api.databases.importFile.mockRejectedValueOnce(new Error('Chunk 3 must be 1024 bytes'));
    renderCard();
    pick(new File([new Uint8Array(4)], 'a.sql'));
    fireEvent.click(await screen.findByRole('button', { name: /Upload and import/ }));
    expect(await screen.findByText('Chunk 3 must be 1024 bytes')).toBeInTheDocument();
    apiMock.api.databases.importFile.mockRejectedValueOnce('x');
    fireEvent.click(screen.getByRole('button', { name: /Upload and import/ }));
    expect(await screen.findByText('The upload failed')).toBeInTheDocument();
  });

  it('shows a 0% bar for an empty file', async () => {
    apiMock.api.databases.importFile.mockReturnValue(new Promise(() => {}));
    renderCard();
    pick(new File([], 'empty.sql'));
    fireEvent.change(screen.getByLabelText('Dump file'), { target: { files: [] } });
    pick(new File([], 'empty.sql'));
    fireEvent.click(await screen.findByRole('button', { name: /Upload and import/ }));
    expect(await screen.findByTestId('import-progress')).toHaveTextContent('(0%)');
  });

  it('resumes an interrupted upload of the same file, refusing a different size', async () => {
    apiMock.api.databases.imports.list.mockResolvedValue([
      row({ id: 5, status: 'uploading', receivedBytes: 1024 }),
      row({ id: 6, status: 'uploading', createdByUserId: 99, filename: null }),
    ]);
    apiMock.api.databases.importFile.mockResolvedValue(row({ id: 5, status: 'running' }));
    renderCard();
    expect(await screen.findByText('1.0 KB of 2.0 KB', { exact: false })).toBeInTheDocument();
    // Only the creator may resume; anyone may cancel.
    expect(screen.queryByTitle('Resume import #6')).not.toBeInTheDocument();
    expect(screen.getByTitle('Cancel import #6')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Resume import #5'));
    expect(screen.getByText(/Resuming import #5/)).toHaveTextContent('“prod.dump”');
    pick(new File([new Uint8Array(10)], 'other.dump'));
    expect(screen.getByText(/the interrupted upload expects/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Resume upload/ })).toBeDisabled();
    pick(new File([new Uint8Array(2048)], 'prod.dump'));
    fireEvent.click(screen.getByRole('button', { name: /Resume upload/ }));
    await waitFor(() =>
      expect(apiMock.api.databases.importFile).toHaveBeenCalledWith(7, expect.any(Function), expect.objectContaining({ resumeImportId: 5 })),
    );
    expect(await screen.findByText('Import #5 started')).toBeInTheDocument();
    expect(screen.queryByText(/Resuming import #5/)).not.toBeInTheDocument();
  });

  it('can stop resuming, and names an unnamed upload generically', async () => {
    apiMock.api.databases.imports.list.mockResolvedValue([row({ id: 5, status: 'uploading', filename: null })]);
    renderCard();
    fireEvent.click(await screen.findByTitle('Resume import #5'));
    expect(screen.getByText(/Resuming import #5/)).toHaveTextContent('the same file');
    fireEvent.click(screen.getByTitle('Stop resuming'));
    expect(screen.queryByText(/Resuming import/)).not.toBeInTheDocument();
  });

  it('cancels an import and reports a failed cancel', async () => {
    apiMock.api.databases.imports.list.mockResolvedValue([row({ id: 5, status: 'pending' })]);
    apiMock.api.databases.imports.cancel.mockResolvedValueOnce(row({ id: 5, status: 'cancelled' }));
    renderCard();
    fireEvent.click(await screen.findByTitle('Cancel import #5'));
    expect(await screen.findByText('Import #5 cancelled')).toBeInTheDocument();
    expect(apiMock.api.databases.imports.cancel).toHaveBeenCalledWith(7, 5);
    apiMock.api.databases.imports.cancel.mockRejectedValueOnce(new Error('The import is running'));
    fireEvent.click(screen.getByTitle('Cancel import #5'));
    expect(await screen.findByText('The import is running')).toBeInTheDocument();
    apiMock.api.databases.imports.cancel.mockRejectedValueOnce(null);
    fireEvent.click(screen.getByTitle('Cancel import #5'));
    expect(await screen.findByText('Could not cancel the import')).toBeInTheDocument();
  });

  it('renders the history: errors, warnings, safety backups and S3 keys', async () => {
    apiMock.api.databases.imports.list.mockResolvedValue([
      row({ id: 1, status: 'failed', error: 'pg_restore: error', format: null }),
      row({ id: 2, status: 'completed_with_warnings', error: 'the import changed credentials', safetyBackupId: 41 }),
      row({ id: 4, source: 's3', objectKey: 'db/prod.dump', filename: null }),
      row({ id: 8, filename: null }),
    ]);
    renderCard();
    expect(await screen.findByText('pg_restore: error')).toHaveClass('text-rose-300');
    expect(screen.getByText('the import changed credentials')).toHaveClass('text-amber-300');
    expect(screen.getByText(/Pre-import safety backup #41/)).toBeInTheDocument();
    expect(screen.getByText('completed with warnings')).toBeInTheDocument();
    expect(screen.getByTestId('import-4')).toHaveTextContent('db/prod.dump');
    expect(screen.getByTestId('import-8')).toHaveTextContent('upload');
  });

  it('refreshes the snapshot list once an active import finishes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      apiMock.api.databases.imports.list
        .mockResolvedValueOnce([row({ id: 5, status: 'running' })])
        .mockResolvedValue([row({ id: 5, status: 'completed' })]);
      const qc = createQueryClient();
      const spy = vi.spyOn(qc, 'invalidateQueries');
      renderCard(pg, qc);
      expect(await screen.findByText('running')).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['backups'] }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('requires the replace confirmation for redis and offers skipping the safety backup to operators', async () => {
    authMock.user = { id: 1, isOperator: true };
    apiMock.api.databases.importFile.mockResolvedValue(row({ id: 9 }));
    renderCard({ id: 7, name: 'cache', engine: 'redis' } as never);
    pick(new File([new Uint8Array(3)], 'dump.rdb'));
    const upload = await screen.findByRole('button', { name: /Upload and import/ });
    expect(upload).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/replaces the whole dataset/));
    fireEvent.click(screen.getByLabelText(/Skip the pre-import safety backup/));
    fireEvent.click(upload);
    await waitFor(() =>
      expect(apiMock.api.databases.importFile).toHaveBeenCalledWith(7, expect.any(Function), expect.objectContaining({
        options: { confirmReplace: true, skipSafetyBackup: true },
      })),
    );
  });

  it.each(['keydb', 'dragonfly'])('%s: an RDB import also needs the replace confirmation', async (engine) => {
    apiMock.api.databases.importFile.mockResolvedValue(row({ id: 9 }));
    renderCard({ id: 7, name: 'kv', engine } as never);
    expect(await screen.findByText(/an RDB snapshot \(dump\.rdb/)).toBeInTheDocument();
    pick(new File([new Uint8Array(3)], 'dump.rdb'));
    const upload = await screen.findByRole('button', { name: /Upload and import/ });
    expect(upload).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/replaces the whole dataset/));
    fireEvent.click(upload);
    await waitFor(() =>
      expect(apiMock.api.databases.importFile).toHaveBeenCalledWith(7, expect.any(Function), expect.objectContaining({
        options: { confirmReplace: true },
      })),
    );
  });

  it('mysql members get no option checkboxes', async () => {
    renderCard({ id: 7, name: 'm', engine: 'mysql' } as never);
    expect(await screen.findByText(/plain SQL dump \(mysqldump\)/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('operators import an object from a backup destination', async () => {
    authMock.user = { id: 1, isOperator: true };
    apiMock.api.databases.imports.create.mockResolvedValue(row({ id: 11, source: 's3', status: 'uploading' }));
    apiMock.api.databases.imports.wait.mockResolvedValue(row({ id: 11, source: 's3', status: 'pending' }));
    apiMock.api.databases.imports.start.mockResolvedValue(row({ id: 11, source: 's3', status: 'running' }));
    renderCard({ id: 7, name: 'docs', engine: 'mongo' } as never);
    await screen.findByRole('option', { name: 'R2 (nd)' });
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: '2' } });
    await waitFor(() => expect(apiMock.api.backupDestinations.objects).toHaveBeenCalledWith(2, undefined));
    fireEvent.change(screen.getByLabelText('Prefix'), { target: { value: ' db/ ' } });
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    await waitFor(() => expect(apiMock.api.backupDestinations.objects).toHaveBeenCalledWith(2, 'db/'));
    fireEvent.change(screen.getByLabelText('Prefix'), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    const object = await screen.findByRole('option', { name: /db\/prod.dump/ });
    fireEvent.change(screen.getByLabelText('Object'), { target: { value: (object as HTMLOptionElement).value } });
    fireEvent.click(screen.getByLabelText(/--drop/));
    fireEvent.click(screen.getByRole('button', { name: /Import object/ }));
    await waitFor(() => expect(apiMock.api.databases.imports.start).toHaveBeenCalledWith(7, 11));
    expect(apiMock.api.databases.imports.create).toHaveBeenCalledWith(7, {
      source: 's3', destinationId: 2, key: 'db/prod.dump', options: { drop: true },
    });
    expect(apiMock.api.databases.imports.wait).toHaveBeenCalledWith(7, 11, { until: 'uploaded' });
    expect(await screen.findByText('Import #11 started')).toBeInTheDocument();
  });

  it('reports a failed S3 download, a listing error and a refused create', async () => {
    authMock.user = { id: 1, isOperator: true };
    apiMock.api.databases.imports.create.mockResolvedValue(row({ id: 11, source: 's3', status: 'uploading' }));
    apiMock.api.databases.imports.wait
      .mockResolvedValueOnce(row({ id: 11, status: 'failed', error: 'object vanished' }))
      .mockResolvedValueOnce(row({ id: 11, status: 'cancelled' }));
    renderCard();
    await screen.findByRole('option', { name: 'R2 (nd)' });
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Object'), {
      target: { value: ((await screen.findByRole('option', { name: /db\/prod.dump/ })) as HTMLOptionElement).value },
    });
    const go = screen.getByRole('button', { name: /Import object/ });
    fireEvent.click(go);
    expect(await screen.findByText('object vanished')).toBeInTheDocument();
    expect(apiMock.api.databases.imports.start).not.toHaveBeenCalled();
    fireEvent.click(go);
    expect(await screen.findByText('The download ended as cancelled')).toBeInTheDocument();
    apiMock.api.databases.imports.create.mockRejectedValueOnce(undefined);
    fireEvent.click(go);
    expect(await screen.findByText('The import from the destination failed')).toBeInTheDocument();

    apiMock.api.backupDestinations.objects.mockRejectedValue(new Error('The backup destination could not be listed'));
    fireEvent.change(screen.getByLabelText('Prefix'), { target: { value: 'x/' } });
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(await screen.findByText('The backup destination could not be listed')).toBeInTheDocument();
    apiMock.api.backupDestinations.objects.mockRejectedValue('nope');
    fireEvent.change(screen.getByLabelText('Prefix'), { target: { value: 'y/' } });
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(await screen.findByText('Could not list the destination')).toBeInTheDocument();
  });

  it('operators see an empty destination list without crashing', async () => {
    authMock.user = { id: 1, isOperator: true };
    apiMock.api.backupDestinations.list.mockReturnValue(new Promise(() => {}));
    apiMock.api.backupDestinations.objects.mockReturnValue(new Promise(() => {}));
    renderCard();
    expect(await screen.findByText('From a backup destination')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Choose a destination…' })).toBeInTheDocument();
  });

  it('explains an engine without import', () => {
    renderCard({ id: 7, name: 'q', engine: 'rabbitmq' } as never);
    expect(screen.getByText(/rabbitmq has no dump import/)).toBeInTheDocument();
    expect(apiMock.api.databases.imports.list).not.toHaveBeenCalled();
  });

  it('shows a muted note on 403 and a history error otherwise', async () => {
    apiMock.api.databases.imports.list.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403 }));
    const { unmount } = renderCard();
    expect(await screen.findByText(/needs admin rights/)).toBeInTheDocument();
    unmount();
    apiMock.api.databases.imports.list.mockRejectedValueOnce(new Error('boom'));
    renderCard();
    expect(await screen.findByText('Could not load the import history.')).toBeInTheDocument();
  });
});
