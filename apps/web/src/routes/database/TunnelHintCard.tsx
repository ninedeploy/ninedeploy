import { Cable } from 'lucide-react';
import type { DatabaseDetail } from '@ninedeploy/sdk';
import { useToast } from '../../components/Toast.js';
import { useT } from '../../lib/i18n.js';
import { Button, Card, CardBody } from '../../components/ui.js';

/**
 * Database → Overview (G5.8): reach a panel-host database from a laptop
 * through the panel with `ninedeploy tunnel db <id>`, without public access.
 */
export function TunnelHintCard({ db }: { db: Pick<DatabaseDetail, 'id'> }) {
  const t = useT();
  const { toast } = useToast();
  const command = `ninedeploy tunnel db ${db.id}`;
  const copy = () => {
    void navigator.clipboard?.writeText(command).then(
      () => toast(t('Copied'), 'success'),
      () => undefined,
    );
  };
  return (
    <Card>
      <CardBody className="space-y-2 text-sm">
        <div className="flex items-center gap-2 font-semibold text-slate-200">
          <Cable size={15} className="text-sky-300" /> {t('Tunnel from your machine')}
        </div>
        <p className="text-xs text-slate-400">
          {t(
            'The CLI offers this database on a local port through the panel, so its port stays closed to the internet. It needs the admin role on the database; the database login still applies.',
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="break-all rounded-lg bg-black/30 px-2 py-1 font-mono text-xs text-slate-200">{command}</code>
          <Button size="sm" variant="secondary" onClick={copy}>
            {t('Copy')}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
