import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { CloudDownload, RotateCcw, Upload, X } from 'lucide-react';
import { DATABASE_IMPORT_ENGINE_OPTIONS, type DatabaseImportEngine, type DatabaseImportOptions } from '@ninedeploy/schemas';
import { DATABASE_IMPORT_FINISHED_STATUSES, type DatabaseDetail, type DatabaseImport } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { formatBytes, formatDateTime } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Badge, Button, Card, CardBody, Field, Input, Select } from '../../components/ui.js';

type OptionKey = keyof DatabaseImportOptions;

/** What each engine accepts (the server detects the format by magic bytes). */
const FORMATS: Record<DatabaseImportEngine, string> = {
  postgres: 'a pg_dump custom-format (-Fc) archive or plain SQL, optionally gzipped',
  mysql: 'a plain SQL dump (mysqldump), optionally gzipped',
  mariadb: 'a plain SQL dump (mariadb-dump), optionally gzipped',
  mongo: 'a mongodump --archive file, optionally gzipped',
  redis: 'an RDB snapshot (dump.rdb)',
  valkey: 'an RDB snapshot (dump.rdb)',
};

const OPTION_LABELS: Record<OptionKey, string> = {
  clean: 'Drop existing objects first (--clean --if-exists; custom-format dumps only)',
  singleTransaction: 'Single transaction: roll everything back on the first error',
  drop: 'Drop each collection before restoring it (--drop)',
  confirmReplace: 'I understand the RDB file replaces the whole dataset',
  skipSafetyBackup: 'Skip the pre-import safety backup',
};

const ACTIVE = new Set<DatabaseImport['status']>(['uploading', 'pending', 'running']);
const FINISHED = new Set<DatabaseImport['status']>(DATABASE_IMPORT_FINISHED_STATUSES);

const STATUS_TONE: Record<DatabaseImport['status'], 'neutral' | 'indigo' | 'emerald' | 'amber' | 'rose' | 'sky'> = {
  uploading: 'sky',
  pending: 'indigo',
  running: 'amber',
  completed: 'emerald',
  completed_with_warnings: 'amber',
  failed: 'rose',
  cancelled: 'neutral',
  expired: 'neutral',
};

/** Read a file in 4 MiB slices from `offset` on: the SDK re-cuts them to the server's chunk size. */
export function fileChunks(file: Blob, step = 4 * 1024 * 1024): (offset: number) => AsyncIterable<Uint8Array> {
  return (offset: number) =>
    (async function* () {
      for (let at = offset; at < file.size; at += step) {
        yield new Uint8Array(await file.slice(at, Math.min(at + step, file.size)).arrayBuffer());
      }
    })();
}

const message = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);
const isEngine = (engine: string): engine is DatabaseImportEngine => Object.hasOwn(DATABASE_IMPORT_ENGINE_OPTIONS, engine);

/**
 * "Import a dump" card on the database Backups tab (0.14). Uploads go up in
 * chunks (Traefik's 60 s read timeout would cut a single multi-GB request)
 * and can be resumed; operators may also import an object from a backup
 * destination. Every import takes a safety backup first unless skipped.
 */
export function ImportCard({ db }: { db: DatabaseDetail }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const isOperator = user?.isOperator === true;
  const engine = db.engine;
  const supported = isEngine(engine);
  const keys: readonly OptionKey[] = supported
    ? (DATABASE_IMPORT_ENGINE_OPTIONS[engine] as readonly OptionKey[]).filter((k) => k !== 'skipSafetyBackup' || isOperator)
    : [];

  const [opts, setOpts] = useState<Required<DatabaseImportOptions>>({
    clean: false,
    singleTransaction: true,
    drop: false,
    confirmReplace: false,
    skipSafetyBackup: false,
  });
  const [file, setFile] = useState<File | null>(null);
  const [resumeTarget, setResumeTarget] = useState<DatabaseImport | null>(null);
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const [destId, setDestId] = useState('');
  const [prefixDraft, setPrefixDraft] = useState('');
  const [prefix, setPrefix] = useState<string | undefined>(undefined);
  const [objectKey, setObjectKey] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const history = useQuery({
    queryKey: ['database-imports', db.id],
    queryFn: () => api.databases.imports.list(db.id),
    enabled: supported,
    refetchInterval: (q) => ((q.state.data ?? []).some((r) => ACTIVE.has(r.status)) ? 3000 : false),
  });
  const destinations = useQuery({
    queryKey: ['backup-destinations'],
    queryFn: () => api.backupDestinations.list(),
    enabled: supported && isOperator,
  });
  const objects = useQuery({
    queryKey: ['backup-destination-objects', Number(destId), prefix],
    queryFn: () => api.backupDestinations.objects(Number(destId), prefix),
    enabled: isOperator && destId !== '',
  });

  // An import that finished since the last poll changed the data and added a
  // safety backup: refresh the snapshot list.
  const active = useRef<Set<number>>(new Set());
  useEffect(() => {
    const rows = history.data ?? [];
    if (rows.some((r) => active.current.has(r.id) && FINISHED.has(r.status))) {
      void qc.invalidateQueries({ queryKey: ['backups'] });
    }
    active.current = new Set(rows.filter((r) => ACTIVE.has(r.status)).map((r) => r.id));
  }, [history.data, qc]);

  const refreshHistory = () => void qc.invalidateQueries({ queryKey: ['database-imports', db.id] });

  const options = (): DatabaseImportOptions => {
    const out: DatabaseImportOptions = {};
    for (const k of keys) if (k === 'singleTransaction' || opts[k]) out[k] = opts[k];
    return out;
  };
  const needsConfirm = keys.includes('confirmReplace') && !opts.confirmReplace;

  const upload = useMutation({
    mutationFn: async (f: File) => {
      setProgress({ received: resumeTarget?.receivedBytes ?? 0, total: f.size });
      return api.databases.importFile(db.id, fileChunks(f), {
        sizeBytes: f.size,
        filename: f.name,
        options: options(),
        ...(resumeTarget ? { resumeImportId: resumeTarget.id } : {}),
        onCreated: refreshHistory,
        onProgress: (p) => setProgress({ received: p.receivedBytes, total: p.sizeBytes }),
      });
    },
    onSuccess: (row) => {
      toast(`Import #${row.id} started`, 'success');
      setFile(null);
      setResumeTarget(null);
      if (fileInput.current) fileInput.current.value = '';
    },
    onError: (err) => toast(message(err, 'The upload failed'), 'error'),
    onSettled: () => {
      setProgress(null);
      refreshHistory();
    },
  });

  const fromS3 = useMutation({
    mutationFn: async () => {
      const created = await api.databases.imports.create(db.id, {
        source: 's3',
        destinationId: Number(destId),
        key: objectKey,
        options: options(),
      });
      refreshHistory();
      const ready = await api.databases.imports.wait(db.id, created.id, { until: 'uploaded' });
      if (ready.status !== 'pending') throw new Error(ready.error ?? `The download ended as ${ready.status}`);
      return api.databases.imports.start(db.id, created.id);
    },
    onSuccess: (row) => {
      toast(`Import #${row.id} started`, 'success');
      setObjectKey('');
    },
    onError: (err) => toast(message(err, 'The import from the destination failed'), 'error'),
    onSettled: refreshHistory,
  });

  const cancel = useMutation({
    mutationFn: (importId: number) => api.databases.imports.cancel(db.id, importId),
    onSuccess: (row) => toast(`Import #${row.id} cancelled`, 'success'),
    onError: (err) => toast(message(err, 'Could not cancel the import'), 'error'),
    onSettled: refreshHistory,
  });

  const header = (
    <div className="p-4 border-b border-white/[0.06]">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
        <Upload size={14} /> Import a dump
      </h2>
    </div>
  );

  if (!supported) {
    return (
      <Card className="overflow-hidden">
        {header}
        <CardBody>
          <p className="text-sm text-slate-400">
            {db.engine} has no dump import. Restore one of this database’s snapshots instead, or load the data with the engine’s own tools.
          </p>
        </CardBody>
      </Card>
    );
  }
  if ((history.error as { status?: number } | null)?.status === 403) {
    return (
      <Card className="overflow-hidden">
        {header}
        <CardBody>
          <p className="text-sm text-slate-500">Importing a dump needs admin rights on this database.</p>
        </CardBody>
      </Card>
    );
  }

  const sizeMismatch = file && resumeTarget && file.size !== resumeTarget.sizeBytes;
  const busy = upload.isPending || fromS3.isPending;
  const rows = history.data ?? [];
  const pct = progress && progress.total > 0 ? Math.floor((progress.received / progress.total) * 100) : 0;

  return (
    <Card className="overflow-hidden">
      {header}
      <CardBody className="space-y-4">
        <p className="text-xs text-slate-400">
          Accepts {FORMATS[db.engine as DatabaseImportEngine]}. A safety backup is taken first; if the import goes wrong, restore it from the snapshot
          list. The database must be running.
        </p>

        {keys.length > 0 && (
          <div className="space-y-2">
            {keys.map((k) => (
              <label key={k} className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={opts[k]}
                  onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })}
                  className="rounded border-slate-700 bg-slate-900 text-indigo-500"
                />
                {OPTION_LABELS[k]}
              </label>
            ))}
          </div>
        )}

        {resumeTarget && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-sky-500/30 bg-sky-500/[0.06] p-2 text-xs text-sky-200">
            <span>
              Resuming import #{resumeTarget.id}: choose {resumeTarget.filename ? `“${resumeTarget.filename}”` : 'the same file'} (
              {formatBytes(resumeTarget.sizeBytes)}) again. {formatBytes(resumeTarget.receivedBytes)} already uploaded.
            </span>
            <Button variant="ghost" size="sm" onClick={() => setResumeTarget(null)} title="Stop resuming">
              <X size={12} />
            </Button>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <Field label="Dump file">
            <Input
              ref={fileInput}
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={busy}
            />
          </Field>
          <Button size="sm" onClick={() => file && upload.mutate(file)} disabled={!file || !!sizeMismatch || needsConfirm || busy}>
            <Upload size={12} /> {resumeTarget ? 'Resume upload' : 'Upload and import'}
          </Button>
        </div>
        {sizeMismatch && (
          <p className="text-[11px] text-rose-300">
            This file is {formatBytes(file.size)}; the interrupted upload expects {formatBytes(resumeTarget.sizeBytes)}. Choose the same file.
          </p>
        )}
        {progress && (
          <div className="space-y-1" data-testid="import-progress">
            <div className="h-1.5 w-full overflow-hidden rounded bg-white/5">
              <div className="h-1.5 rounded bg-indigo-500" style={{ width: `${pct}%` }} />
            </div>
            <p className="text-[11px] text-slate-500">
              {formatBytes(progress.received)} of {formatBytes(progress.total)} ({pct}%)
            </p>
          </div>
        )}

        {isOperator && (
          <div className="space-y-3 rounded-xl border border-white/[0.06] p-3">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              <CloudDownload size={12} /> From a backup destination
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Destination">
                <Select
                  value={destId}
                  onChange={(e) => {
                    setDestId(e.target.value);
                    setObjectKey('');
                    setPrefix(undefined);
                    setPrefixDraft('');
                  }}
                >
                  <option value="">Choose a destination…</option>
                  {(destinations.data ?? []).map((d) => (
                    <option key={d.id} value={String(d.id)}>
                      {d.name} ({d.bucket})
                    </option>
                  ))}
                </Select>
              </Field>
              {destId !== '' && (
                <div className="flex items-end gap-2">
                  <Field label="Prefix">
                    <Input value={prefixDraft} onChange={(e) => setPrefixDraft(e.target.value)} placeholder="destination prefix" />
                  </Field>
                  <Button variant="secondary" size="sm" onClick={() => setPrefix(prefixDraft.trim() || undefined)}>
                    List
                  </Button>
                </div>
              )}
            </div>
            {destId !== '' && (
              <Field label="Object" hint={objects.isLoading ? 'loading…' : undefined}>
                <Select value={objectKey} onChange={(e) => setObjectKey(e.target.value)}>
                  <option value="">Choose an object…</option>
                  {(objects.data ?? []).map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.key} ({formatBytes(o.sizeBytes)})
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {objects.isError && <p className="text-[11px] text-rose-300">{message(objects.error, 'Could not list the destination')}</p>}
            <div className="flex justify-end">
              <Button size="sm" variant="secondary" onClick={() => fromS3.mutate()} disabled={objectKey === '' || needsConfirm || busy}>
                <CloudDownload size={12} /> Import object
              </Button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Recent imports</p>
          {rows.length === 0 ? (
            <p className="text-xs text-slate-500">{history.isError ? 'Could not load the import history.' : 'No imports yet.'}</p>
          ) : (
            <ul className="divide-y divide-white/5 text-xs">
              {rows.map((r) => (
                <li key={r.id} className="py-2 space-y-1" data-testid={`import-${r.id}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-slate-500">#{r.id}</span>
                    <Badge tone={STATUS_TONE[r.status]}>{r.status.replace(/_/g, ' ')}</Badge>
                    <span className="font-mono text-slate-300 break-all">{r.source === 's3' ? r.objectKey : (r.filename ?? 'upload')}</span>
                    <span className="text-slate-500">
                      {r.status === 'uploading'
                        ? `${formatBytes(r.receivedBytes)} of ${formatBytes(r.sizeBytes)}`
                        : formatBytes(r.sizeBytes)}
                    </span>
                    {r.format && <span className="text-slate-500">{r.format}</span>}
                    <span className="ml-auto text-slate-500">{formatDateTime(r.createdAt)}</span>
                    {r.status === 'uploading' && r.source === 'upload' && r.createdByUserId === user?.id && (
                      <Button variant="ghost" size="sm" onClick={() => setResumeTarget(r)} disabled={busy} title={`Resume import #${r.id}`}>
                        <RotateCcw size={12} /> Resume
                      </Button>
                    )}
                    {(r.status === 'uploading' || r.status === 'pending') && (
                      <Button variant="ghost" size="sm" onClick={() => cancel.mutate(r.id)} disabled={cancel.isPending} title={`Cancel import #${r.id}`}>
                        <X size={12} /> Cancel
                      </Button>
                    )}
                  </div>
                  {r.error && <p className={r.status === 'completed_with_warnings' ? 'text-amber-300' : 'text-rose-300'}>{r.error}</p>}
                  {r.safetyBackupId != null && (
                    <p className="text-slate-500">
                      Pre-import safety backup #{r.safetyBackupId} is in the snapshot list below; restore it to undo this import.
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
