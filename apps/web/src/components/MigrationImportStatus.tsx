import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { dataImportStatusLabel, IMPORT_DUMP_ANCHOR, IMPORT_VOLUME_ANCHOR } from '../lib/importFile.js';
import { Button } from './ui.js';

export function MigrationImportStatus({ kind, id, name }: { kind: 'database' | 'volume'; id: number; name: string }) {
  const t = useT();
  const check = useMutation({
    mutationFn: async () => {
      // Both history endpoints return newest records first.
      const [latest] = await (kind === 'database' ? api.databases.imports.list(id) : api.volumeImports.list(id));
      return latest?.status ?? null;
    },
  });
  const to = kind === 'database' ? `/databases/${id}?tab=backups#${IMPORT_DUMP_ANCHOR}` : `/services/${id}?tab=volumes#${IMPORT_VOLUME_ANCHOR}`;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link to={to} className="font-medium text-indigo-300 underline underline-offset-2 hover:text-indigo-200">
          {kind === 'database' ? t('Import a dump into {name}', { name }) : t('Import a volume archive into {name}', { name })}
        </Link>
        <Button type="button" size="sm" variant="ghost" disabled={check.isPending} onClick={() => check.mutate()}>
          {check.isPending ? t('Checking import status…') : t('Check import status')}
        </Button>
      </div>
      {check.isError && <p role="alert" className="text-red-300">{t('Could not check import status. Try again.')}</p>}
      {check.isSuccess && <p role="status" className="text-slate-300">
        {check.data === null ? t('No data import recorded.') : t('Latest data import: {status}', { status: dataImportStatusLabel(t, check.data) })}
      </p>}
    </div>
  );
}
