import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { Service, VolumeImport } from '@ninedeploy/schemas';
import { Button, Card, CardBody, ConfirmDialog, Field, Input } from '../../components/ui.js';
import { api, getApiSessionGeneration } from '../../lib/api.js';
import { formatBytes } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { fileChunks, importFileChecksum, IMPORT_VOLUME_ANCHOR } from '../../lib/importFile.js';

const active = (row: VolumeImport) => ['uploading', 'pending', 'running'].includes(row.status);
const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

export function VolumeImportCard({ svc, userId, focus }: { svc: Service; userId: number; focus: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const section = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const live = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [resume, setResume] = useState<VolumeImport | null>(null);
  const [confirm, setConfirm] = useState<VolumeImport | null>(null);
  const [sentBytes, setSentBytes] = useState<number | null>(null);
  const target = `nd-svc-${svc.slug}-data`;
  const stopped = ['idle', 'stopped', 'error'].includes(svc.status);

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  useEffect(() => {
    if (!focus) return;
    section.current?.scrollIntoView?.({ block: 'start' });
    section.current?.focus({ preventScroll: true });
  }, [focus]);

  const targets = useQuery({ queryKey: ['fanout-targets', svc.id], queryFn: () => api.fanout.get(svc.id) });
  const supported = targets.isSuccess && targets.data.length === 0;
  const history = useQuery({
    queryKey: ['volume-imports', svc.id], queryFn: () => api.volumeImports.list(svc.id), enabled: supported,
    refetchInterval: (q) => (q.state.data ?? []).some(active) ? 3000 : false,
  });
  const rows = history.data ?? [];
  const restoreRunning = rows.some(({ status }) => status === 'running');
  const completedId = rows.find(({ status }) => status === 'completed')?.id;
  useEffect(() => {
    if (completedId === undefined) return;
    void qc.invalidateQueries({ queryKey: ['volumes'] });
    void qc.invalidateQueries({ queryKey: ['volume-backups', target] });
  }, [completedId, qc, target]);
  const refresh = () => qc.invalidateQueries({ queryKey: ['volume-imports', svc.id] });

  const upload = useMutation({
    mutationFn: async ({ archive, generation }: { archive: File; generation: number }) => {
      const checkSession = () => {
        if (!live.current || generation !== getApiSessionGeneration()) throw new Error(t('Archive upload cancelled. Open the service and try again.'));
      };
      const chunks = fileChunks(archive);
      const sha256 = await importFileChecksum(chunks(0));
      checkSession();
      if (resume && sha256 !== resume.sha256) throw new Error(t('This archive differs from the original upload. Choose the original archive.'));
      setSentBytes(resume?.receivedBytes ?? 0);
      return api.volumeImports.importFile(svc.id, async function* (offset) {
        for await (const chunk of chunks(offset)) {
          checkSession();
          yield chunk;
        }
      }, {
        sizeBytes: archive.size, filename: archive.name, sha256, start: false,
        ...(resume ? { resumeImportId: resume.id } : {}),
        onCreated: () => void refresh(), onProgress: ({ receivedBytes }) => setSentBytes(receivedBytes),
      });
    },
    onSuccess: () => { setFile(null); setResume(null); if (input.current) input.current.value = ''; },
    onSettled: async () => { setSentBytes(null); await refresh(); },
  });
  const restore = useMutation({ mutationFn: (importId: number) => api.volumeImports.start(svc.id, importId), onSettled: refresh });
  const cancel = useMutation({
    mutationFn: (importId: number) => api.volumeImports.cancel(svc.id, importId),
    onSuccess: (row) => { if (row.id === resume?.id) setResume(null); },
    onSettled: refresh,
  });
  const busy = upload.isPending || restore.isPending || cancel.isPending;
  const canUpload = !busy && !restoreRunning && svc.status !== 'deleting' && (resume !== null || !rows.some(active));
  const canRestore = supported && stopped && !busy && !restoreRunning;
  const sizeMismatch = file && resume && file.size !== resume.sizeBytes;
  const actionError = upload.error ?? restore.error ?? cancel.error;
  const status = {
    uploading: t('Uploading'), pending: t('Ready to restore'), running: t('Restoring…'), completed: t('Completed'),
    failed: t('Failed'), cancelled: t('Cancelled'), expired: t('Expired'),
  };

  return (
    <section id={IMPORT_VOLUME_ANCHOR} ref={section} tabIndex={-1} aria-label={t('Import a volume archive')}>
      <Card>
        <CardBody className="space-y-3">
          <h3 className="text-sm font-semibold text-white">{t('Import a volume archive')}</h3>
          {targets.isPending && <p role="status" className="text-sm text-slate-400">{t('Checking volume placement…')}</p>}
          {(targets.isError || history.isError) && (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-sm text-red-300">{t('Could not load volume imports.')}</p>
              <Button size="sm" variant="ghost" onClick={() => void (targets.isError ? targets.refetch() : history.refetch())}>{t('Retry')}</Button>
            </div>
          )}
          {targets.isSuccess && !supported && <p className="text-sm text-slate-400">{t('Archive restore requires a service on the panel host without extra targets.')}</p>}
          {supported && history.isSuccess && (
            <>
              <p className="text-sm text-slate-400">{t('Upload a .tar.gz archive for the primary mount at {path}. Stop the service before restoring.', { path: svc.volumeMount ?? '' })}</p>
              {resume && (
                <div className="flex items-center gap-2 text-sm">
                  <p>{t('Choose the original archive for upload #{id}.', { id: resume.id })}</p>
                  <Button size="sm" variant="ghost" onClick={() => setResume(null)} disabled={busy}>{t('Stop resuming')}</Button>
                </div>
              )}
              <div className="flex flex-wrap items-end gap-2">
                <Field label={t('Volume archive')}>
                  <Input ref={input} type="file" accept=".tar.gz,.tgz,application/gzip" disabled={!canUpload} onChange={(e) => {
                    upload.reset();
                    setFile(e.currentTarget.files?.[0] ?? null);
                  }} />
                </Field>
                <Button size="sm" disabled={!canUpload || !file?.size || !!sizeMismatch}
                  onClick={() => file && upload.mutate({ archive: file, generation: getApiSessionGeneration() })}>
                  {resume ? t('Resume upload') : t('Upload archive')}
                </Button>
              </div>
              {file?.size === 0 && <p role="alert" className="text-sm text-red-300">{t('Choose a non-empty archive.')}</p>}
              {sizeMismatch && <p role="alert" className="text-sm text-red-300">{t('The original archive is {size}. Choose that file to resume.', { size: formatBytes(resume!.sizeBytes) })}</p>}
              {upload.isPending && <p role="status" className="text-sm text-slate-400">{sentBytes === null
                ? t('Checking archive…') : t('{received} of {total}', { received: formatBytes(sentBytes), total: formatBytes(file?.size ?? sentBytes) })}</p>}
              {actionError && <p role="alert" className="text-sm text-red-300">{errorText(actionError, t('The volume import request failed.'))}</p>}
              {rows.length > 0 && (
                <ul className="divide-y divide-white/10" aria-label={t('Recent volume imports')}>
                  {rows.map((row) => (
                    <li key={row.id} className="space-y-2 py-2 text-sm" data-testid={`volume-import-${row.id}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="break-all text-slate-200">{row.filename ?? row.volumeName}</span>
                        <span className="text-slate-400">{status[row.status]}</span>
                        {row.status === 'uploading' && <span className="text-slate-400">{t('{received} of {total}', { received: formatBytes(row.receivedBytes), total: formatBytes(row.sizeBytes) })}</span>}
                        {row.createdByUserId === userId && row.status === 'uploading' && (
                          <Button size="sm" variant="secondary" disabled={busy || restoreRunning} onClick={() => { upload.reset(); setResume(row); }}>{t('Resume')}</Button>
                        )}
                        {row.createdByUserId === userId && row.status === 'pending' && row.volumeName === target && (
                          <Button size="sm" variant="secondary" disabled={!canRestore} onClick={() => setConfirm(row)}>{t('Restore archive')}</Button>
                        )}
                        {row.createdByUserId === userId && (row.status === 'uploading' || row.status === 'pending') && (
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => cancel.mutate(row.id)}>{t('Cancel import')}</Button>
                        )}
                      </div>
                      {row.error && <p className="break-words text-red-300">{row.error}</p>}
                      {row.safetyBackupId != null && <Link className="text-indigo-300 underline" to="/volumes">{t('Safety backup #{id}', { id: row.safetyBackupId })}</Link>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </CardBody>
      </Card>
      {confirm && <ConfirmDialog open title={t('Restore primary volume')} confirmLabel={t('Confirm restore')} confirmDisabled={!canRestore}
        message={t('This replaces {volume} at {path}. If the volume exists, the panel takes a safety backup first.', { volume: target, path: svc.volumeMount ?? '' })}
        onConfirm={() => restore.mutate(confirm.id)} onClose={() => setConfirm(null)} />}
    </section>
  );
}
