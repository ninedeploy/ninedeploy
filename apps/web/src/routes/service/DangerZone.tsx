import { useQuery } from '@tanstack/react-query';
import { HardDrive, Trash2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { formatBytes } from '../../lib/format.js';
import { Button, Card, CardBody, Input } from '../../components/ui.js';

/** Delete-the-service zone (with the service's data volume surfaced). */
export function DangerZone({
  slug,
  name,
  confirmDelete,
  setConfirmDelete,
  onDelete,
  deleting,
}: {
  slug: string;
  name: string;
  confirmDelete: string;
  setConfirmDelete: (v: string) => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const volumeName = `nd-svc-${slug}-data`;
  const { user } = useAuth();
  const volumes = useQuery({
    queryKey: ['volumes'],
    queryFn: () => api.volumes.list(),
    select: (list) => list.find((v) => v.name === volumeName) ?? null,
    // r473: the inventory is operator-only — members keep the delete flow,
    // just without the volume-exists hint, instead of a swallowed 403 per
    // danger-tab view.
    enabled: user?.isOperator === true,
  });
  const dataVolume = volumes.data;

  return (
    <Card className="mt-6 border-rose-500/20">
      <CardBody>
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-rose-300">
          <Trash2 size={14} /> Danger zone
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Deleting removes the container, domains, webhooks, env vars and deployment history.
          The data volume is retained (delete it separately under Volumes if you want it gone).
        </p>
        {dataVolume && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-400">
            <HardDrive size={12} className="text-slate-500" />
            Data volume <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-[11px]">{volumeName}</code>
            exists ({formatBytes(dataVolume.sizeBytes)}){dataVolume.inUse ? ' · in use' : ''} and will be kept.
          </p>
        )}
        <div className="mt-3 flex max-w-md items-center gap-2">
          <Input
            value={confirmDelete}
            onChange={(e) => setConfirmDelete(e.target.value)}
            placeholder={`Type "${name}" to confirm`}
            className="h-8 text-xs"
            aria-label="Confirm service name"
          />
          <Button variant="danger" size="sm" className="h-8" disabled={confirmDelete !== name || deleting} onClick={onDelete}>
            {deleting ? 'Deleting…' : 'Delete service'}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
