import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ENV_IMPORT_MAX_CHARS, type ImportPlan } from '@ninedeploy/schemas';
import { api, getApiSessionGeneration } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { applyMigrationEnvironment, readMigrationEnvironment } from '../lib/migrationEnvironment.js';
import type { PreparedImportService } from '../lib/prepareImportResources.js';
import { Button, Field, Input } from './ui.js';

type Preview = { keys: string[]; references: string[]; invalid: string[]; missing: string[]; extra: number };

export function MigrationEnvironment({ plan, target }: { plan: ImportPlan; target: PreparedImportService }) {
  const t = useT();
  const qc = useQueryClient();
  const live = useRef(false);
  const selection = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reading, setReading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const selectFile = async (picked: File | null) => {
    const current = ++selection.current;
    setFile(null);
    setPreview(null);
    setFileError(null);
    setReading(false);
    if (!picked) return;
    if (picked.size > ENV_IMPORT_MAX_CHARS) {
      setFileError(t('Choose an environment file of 100 KB or less.'));
      return;
    }
    setReading(true);
    try {
      const { lines, ...review } = readMigrationEnvironment(await picked.text(), plan, target);
      if (!live.current || current !== selection.current) return;
      if ([...lines.values()].join('\n').length > ENV_IMPORT_MAX_CHARS) {
        setFileError(t('The selected settings exceed the import size limit.'));
        return;
      }
      setFile(picked);
      setPreview({ ...review, keys: [...lines.keys()] });
    } catch {
      if (live.current && current === selection.current) setFileError(t('Choose a file with unique, single-line KEY=value entries.'));
    } finally {
      if (live.current && current === selection.current) setReading(false);
    }
  };

  const apply = useMutation({
    mutationFn: async (generation: number) => {
      const lines = file ? readMigrationEnvironment(await file.text(), plan, target).lines : new Map<string, string>();
      return applyMigrationEnvironment(api, target, lines, () => live.current && getApiSessionGeneration() === generation);
    },
    onSettled: () => {
      setFile(null);
      void qc.invalidateQueries({ queryKey: ['env', target.id] });
      void qc.invalidateQueries({ queryKey: ['attachments', target.id] });
      void qc.invalidateQueries({ queryKey: ['service-attachments', target.id] });
    },
  });
  const hasWork = (file && preview && preview.keys.length > 0) || target.bindings.length > 0;
  const bindingStatus = {
    attached: t('Attached'), missing: t('Prepare and start the planned database.'),
    conflict: t('Review the existing variable or database attachment.'), failed: t('Could not attach the database.'),
  };

  return (
    <section aria-label={t('Environment for {service}', { service: target.name })} className="space-y-3">
      {target.service.env.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('Environment file')}>
            <Input type="file" accept=".env,.txt,text/plain" disabled={confirming || apply.isPending} onChange={(event) => {
              const picked = event.currentTarget.files?.[0] ?? null;
              event.currentTarget.value = '';
              apply.reset();
              void selectFile(picked);
            }} />
          </Field>
          {(file || fileError || reading) && <Button type="button" size="sm" variant="ghost" onClick={() => void selectFile(null)} disabled={confirming || apply.isPending}>{t('Clear file')}</Button>}
        </div>
      )}
      {reading && <p role="status" className="text-slate-400">{t('Checking environment file…')}</p>}
      {fileError && <p role="alert" className="text-red-300">{fileError}</p>}
      {preview && (
        <dl className="space-y-1 text-slate-300">
          {preview.keys.length > 0 && <div><dt>{t('Keys selected for import')}</dt><dd><code>{preview.keys.join(', ')}</code></dd></div>}
          {preview.missing.length > 0 && <div><dt>{t('Planned keys missing from the file')}</dt><dd><code>{preview.missing.join(', ')}</code></dd></div>}
          {preview.references.length > 0 && <div><dt>{t('Source connection keys to review')}</dt><dd><code>{preview.references.join(', ')}</code></dd></div>}
          {preview.invalid.length > 0 && <div><dt>{t('Keys with unsupported values')}</dt><dd><code>{preview.invalid.join(', ')}</code></dd></div>}
        </dl>
      )}
      {!!preview?.extra && <p>{t('{count} unplanned keys skipped.', { count: preview.extra })}</p>}
      {target.bindings.length > 0 && (
        <ul aria-label={t('Planned database attachments')} className="space-y-1 text-slate-300">
          {target.bindings.map(({ alias, databaseName }, index) => <li key={`${alias}:${index}`}><code>{alias}</code> → {databaseName}</li>)}
        </ul>
      )}
      {confirming ? (
        <>
          <p>{t('Save new planned values as secrets and apply the database attachments for {service}. Existing service values are kept.', { service: target.name })}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => { setConfirming(false); apply.mutate(getApiSessionGeneration()); }}>{t('Confirm environment migration')}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>{t('Cancel')}</Button>
          </div>
        </>
      ) : (
        <Button type="button" size="sm" variant="secondary" disabled={!hasWork || reading || !!fileError || apply.isPending} onClick={() => setConfirming(true)}>
          {apply.isPending ? t('Applying migration settings…') : t('Apply migration settings')}
        </Button>
      )}
      {apply.isError && <p role="alert" className="text-red-300">{t('Could not finish environment migration. Check the target before retrying.')}</p>}
      {apply.data && (
        <div className="space-y-1">
          <p role="status" className="text-slate-300">{t('{imported} secret values saved, {skipped} existing keys kept, {errors} refused.', {
            imported: apply.data.imported, skipped: apply.data.skipped, errors: apply.data.errors,
          })}</p>
          {apply.data.envFailed && <p role="alert" className="text-red-300">{t('The environment import request failed. Check the target before retrying.')}</p>}
          {apply.data.outcomes.length > 0 && <ul className="space-y-1 text-slate-300">{apply.data.outcomes.map(({ alias, status }) => <li key={alias}><code>{alias}</code> · {bindingStatus[status]}</li>)}</ul>}
        </div>
      )}
    </section>
  );
}
