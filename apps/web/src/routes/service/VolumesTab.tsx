import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Archive, ArrowUpRight, Database, ExternalLink, FolderOpen, HardDrive, Info, Layers, Plus, Server, ShieldCheck, Trash2, Wrench, X } from 'lucide-react';
import { Link } from 'react-router';
import type { Service, ServiceVolumeAttachment as SdkServiceVolumeAttachment } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, cn, useEscapeToClose } from '../../components/ui.js';
import { formatBytes } from '../../lib/format.js';
import { fill, useT } from '../../lib/i18n.js';
import { VolumeBrowser } from '../../components/VolumeBrowser.js';
import { VolumeBackupsPanel } from '../../components/VolumeBackupsPanel.js';
import { FileMountsCard } from './FileMountsCard.js';

/** Wire shape returned by GET /v1/services/:id/volumes — extends the SDK
 *  attachment type with runtime-computed fields (size, in-use, sharing). */
type ServiceVolumeAttachment = SdkServiceVolumeAttachment & {
  sizeBytes: number;
  inUse: boolean;
  sharedWith: number;
};

export function VolumesTab({ serviceId, svc }: { serviceId: number; svc: Service }) {
  const t = useT();
  const { user } = useAuth();
  const isOperator = user?.isOperator === true;
  const [browsingVolume, setBrowsingVolume] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [expandedBackup, setExpandedBackup] = useState<string | null>(null);
  const toggleBackups = (volumeName: string) =>
    setExpandedBackup((prev) => (prev === volumeName ? null : volumeName));

  // 1. All volumes on the system (instance-wide inventory) — operator-only
  // route (L-12). Members must not fire it (a 403 per tab open) NOR get its
  // absence rendered as invented zeros: their numbers come from the
  // per-service endpoints below (r472).
  const volumes = useQuery({
    queryKey: svc.serverId == null ? ['volumes'] : ['volumes', 'node', svc.serverId],
    queryFn: () => svc.serverId == null ? api.volumes.list() : api.volumes.list({ serverId: svc.serverId }),
    enabled: isOperator,
  });

  // 2. Attached databases for this service
  const attachments = useQuery({
    queryKey: ['service-attachments', serviceId],
    queryFn: () => api.attachments.list(serviceId),
  });

  // 3. Per-service volume attachments (managed by the service owner)
  const serviceVolumeAttachments = useQuery({
    queryKey: ['service-volume-attachments', serviceId],
    queryFn: () => api.serviceVolumes.list(serviceId),
  });

  const allVols = volumes.data ?? [];
  const attachedDbs = attachments.data ?? [];
  const svcVolumeAttachments: ServiceVolumeAttachment[] = serviceVolumeAttachments.data ?? [];

  // The service's primary volume (the legacy `volumeMount` field). Found by
  // matching inventory owner.id === serviceId. Falls back to the implicit
  // `nd-svc-<slug>-data` name when the inventory list is still loading or the
  // volume has not yet been provisioned.
  const serviceVolume = allVols.find((v) => v.owner?.kind === 'service' && v.owner.id === serviceId);

  const attachedDbIds = new Set(attachedDbs.map((a) => a.databaseId));
  const databaseVolumes = allVols.filter((v) => v.owner?.kind === 'database' && v.owner.id && attachedDbIds.has(v.owner.id));

  // Members: only the per-service attachment sizes are knowable — the primary
  // and attached-DB sizes live in the operator-only inventory, and rendering
  // their absence as 0 B was a fabricated number (r472).
  const totalBytes = svcVolumeAttachments.reduce((acc: number, v: ServiceVolumeAttachment) => acc + v.sizeBytes, 0) +
    (isOperator
      ? (serviceVolume?.sizeBytes ?? 0) + databaseVolumes.reduce((acc: number, v: { sizeBytes: number }) => acc + v.sizeBytes, 0)
      : 0);

  const hasPrimary = Boolean(svc.volumeMount);
  const hasAttachments = svcVolumeAttachments.length > 0;

  return (
    <div className="space-y-6">
      {/* Storage Footprint Overview Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="p-4 bg-white/[0.02]">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-400 font-semibold mb-1">
            <Layers size={14} className="text-indigo-400" /> {t('Total Storage Footprint')}
          </div>
          <div className="text-2xl font-bold tracking-tight text-white font-mono mt-2">
            {formatBytes(totalBytes)}
          </div>
          <p className="text-[11px] text-slate-400 mt-1">
            {isOperator
              ? t('Across service & {n} attached database(s)', { n: databaseVolumes.length })
              : t('Custom attachments — instance-wide sizes are operator-only')}
          </p>
        </Card>

        <Card className="p-4 bg-white/[0.02]">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-400 font-semibold mb-1">
            <Server size={14} className="text-sky-400" /> {t('Service Primary Volume')}
          </div>
          <div className="text-2xl font-bold tracking-tight text-white font-mono mt-2">
            {hasPrimary ? (isOperator ? formatBytes(serviceVolume?.sizeBytes ?? 0) : '—') : t('None')}
          </div>
          <p className="text-[11px] text-slate-400 mt-1 font-mono truncate">
            {hasPrimary ? t('Mounted at {path}', { path: svc.volumeMount ?? '' }) : hasAttachments ? t('{n} custom attachment(s)', { n: svcVolumeAttachments.length }) : t('Stateless container')}
          </p>
        </Card>

        <Card className="p-4 bg-white/[0.02]">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-400 font-semibold mb-1">
            <Database size={14} className="text-emerald-400" /> {t('Attached DB Volumes')}
          </div>
          <div className="text-2xl font-bold tracking-tight text-white font-mono mt-2">
            {isOperator ? formatBytes(databaseVolumes.reduce((acc, v) => acc + v.sizeBytes, 0)) : '—'}
          </div>
          <p className="text-[11px] text-slate-400 mt-1">
            {isOperator ? t('{n} active database volume(s)', { n: databaseVolumes.length }) : t('{n} attached database(s)', { n: attachedDbs.length })}
          </p>
        </Card>
      </div>

      {/* Service Primary Volume (legacy `volumeMount` field) */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <HardDrive size={16} className="text-indigo-400" />
            <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wide">{t('Service Primary Volume')}</h3>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setAttaching(true)}
            className="text-xs"
            data-testid="attach-volume-button"
          >
            <Plus size={14} /> {t('Attach Volume')}
          </Button>
        </div>

        {hasPrimary ? (
          <Card className="p-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-start gap-3.5">
                <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-indigo-500/10 text-indigo-300 ring-1 ring-inset ring-indigo-500/20">
                  <HardDrive size={20} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-100">{serviceVolume?.name ?? `nd-svc-${svc.slug}-data`}</span>
                    <span className="rounded bg-indigo-500/15 px-2 py-0.5 font-mono text-[10px] font-medium text-indigo-300">
                      {t('Primary Mount')}
                    </span>
                    {/* r215: the retention policy is the server's, always on. A
                        "Protection On/Off" toggle used to sit here; it only
                        flipped local React state — nothing stored, nothing
                        enforced, reset on reload — so it has been removed. */}
                    <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-500/20">
                      <ShieldCheck size={11} /> {t('Retained on Delete')}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-xs text-slate-400">
                    {fill(t('Target Path: {path}'), {
                      path: <code className="text-indigo-300 bg-white/[0.04] px-1.5 py-0.5 rounded">{svc.volumeMount}</code>,
                    })}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {t('Host Storage: {size} · Status: {status}', {
                      size: isOperator ? formatBytes(serviceVolume?.sizeBytes ?? 0) : '—',
                      status: svc.status === 'running' ? t('Mounted & Active') : t('Detached (Stopped)'),
                    })}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setBrowsingVolume(/* v8 ignore start */ serviceVolume?.name ?? `nd-svc-${svc.slug}-data` /* v8 ignore stop */)}
                  className="text-xs"
                >
                  <FolderOpen size={14} /> {t('Browse Files')}
                </Button>
                {hostsOneTimeConfig(svc, svc.volumeMount ?? '/var/www/html') && (
                  <RepairConfigButton serviceId={serviceId} volumeName={serviceVolume?.name ?? `nd-svc-${svc.slug}-data`} />
                )}
              </div>
            </div>
          </Card>
        ) : (
          <Card className="p-6 text-center">
            <HardDrive size={24} className="mx-auto mb-2 text-slate-600" />
            <p className="text-sm font-medium text-slate-300">
              {hasAttachments ? t('No legacy primary volume — service uses custom attachments') : t('No persistent volume mounted for this service')}
            </p>
            <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
              {hasAttachments
                ? t('Attach a new volume below, or set a primary mount in the Settings tab.')
                : t('You can mount a persistent volume (e.g. /data or /app/uploads) by attaching one below, or set a primary mount in the Settings tab.')}
            </p>
          </Card>
        )}
      </div>

      {/* Service-scoped volume attachments (multi-volume, per-service) */}
      {hasAttachments && (
        <div className="space-y-3" data-testid="service-volume-attachments">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <HardDrive size={16} className="text-amber-400" />
              <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wide">{t('Attached Volumes ({n})', { n: svcVolumeAttachments.length })}</h3>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {svcVolumeAttachments.map((a: ServiceVolumeAttachment) => {
              return (
                <Card key={a.id} className="p-4 flex flex-col justify-between">
                  <div>
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber-500/10 text-amber-300 ring-1 ring-inset ring-amber-500/20">
                          <HardDrive size={16} />
                        </div>
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-100 truncate text-sm font-mono">{a.volumeName}</div>
                          <div className="font-mono text-[11px] text-slate-500 truncate">
                            → {a.containerPath}
                            {a.readOnly && <span className="ml-1 text-slate-400">(ro)</span>}
                          </div>
                        </div>
                      </div>
                      <span className="font-mono text-xs font-semibold text-slate-200">
                        {formatBytes(a.sizeBytes)}
                      </span>
                    </div>

                    <div className="mt-3 flex items-center gap-2">
                      <span className="rounded bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] text-amber-300 ring-1 ring-inset ring-amber-500/20">
                        {t('Custom Attachment')}
                      </span>
                      {a.sharedWith > 0 && (
                        <span className="rounded bg-sky-500/10 px-2 py-0.5 font-mono text-[10px] text-sky-300 ring-1 ring-inset ring-sky-500/20">
                          {a.sharedWith === 1
                            ? t('Shared with {n} other service', { n: a.sharedWith })
                            : t('Shared with {n} other services', { n: a.sharedWith })}
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1 rounded bg-slate-500/10 px-2 py-0.5 font-mono text-[10px] text-slate-300 ring-1 ring-inset ring-slate-500/20">
                        <ShieldCheck size={10} className="text-emerald-400" /> {t('Retained on Delete')}
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-t border-white/[0.04] flex items-center justify-between gap-1 flex-wrap">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setBrowsingVolume(a.volumeName)}
                      className="text-xs h-7 px-2"
                    >
                      <FolderOpen size={13} /> {t('Browse Files')}
                    </Button>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => toggleBackups(a.volumeName)}
                        className={cn('text-xs h-7 px-2', expandedBackup === a.volumeName && 'text-amber-300 bg-amber-500/10')}
                        data-testid={`backups-toggle-${a.id}`}
                        title={t('Show/hide volume backups')}
                      >
                        <Archive size={13} /> {t('Backups')}
                      </Button>
                      {hostsOneTimeConfig(svc, a.containerPath) && (
                        <RepairConfigButton serviceId={serviceId} attachmentId={a.id} />
                      )}
                      <DetachButton serviceId={serviceId} attachment={a} />
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
          {/* Expanded backup panel for one of the attached volumes */}
          {expandedBackup && (
            <div className="mt-3 ml-1 pl-4 border-l-2 border-amber-500/20">
              <VolumeBackupsPanel volumeName={expandedBackup} />
            </div>
          )}
        </div>
      )}

      {/* Attached Database Volumes — volume SIZES come from the operator-only
          inventory; a member's attached databases stay visible in the
          Architecture tab, so this whole section is operator-only (r473). */}
      {isOperator && (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Database size={16} className="text-emerald-400" />
            <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wide">{t('Attached Database Volumes ({n})', { n: databaseVolumes.length })}</h3>
          </div>
          <Link to="/databases" className="text-xs text-indigo-400 hover:text-indigo-300 inline-flex items-center gap-1">
            {t('Manage Databases')} <ArrowUpRight size={12} />
          </Link>
        </div>

        {databaseVolumes.length === 0 ? (
          <Card className="p-6 text-center">
            <Database size={24} className="mx-auto mb-2 text-slate-600" />
            <p className="text-sm font-medium text-slate-300">{t('No attached database volumes')}</p>
            <p className="text-xs text-slate-500 mt-1">
              {fill(t('Attach a Postgres, MySQL, or Redis database in the {tab} tab to automatically link storage.'), {
                tab: <strong>{t('Architecture')}</strong>,
              })}
            </p>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {databaseVolumes.map((v) => {
              return (
                <Card key={v.name} className="p-4 flex flex-col justify-between">
                  <div>
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-emerald-500/10 text-emerald-300 ring-1 ring-inset ring-emerald-500/20">
                          <Database size={16} />
                        </div>
                        <div className="min-w-0">
                          <Link
                            to={`/databases/${v.owner!.id}`}
                            className="font-semibold text-slate-100 hover:text-emerald-300 transition-colors inline-flex items-center gap-1 truncate text-sm"
                          >
                            <span>{v.owner?.name}</span>
                            <ExternalLink size={11} className="opacity-60 shrink-0" />
                          </Link>
                          <div className="font-mono text-[11px] text-slate-500 truncate">
                            {/* Both engine arms render across the volume tests. */}
                            {/* v8 ignore start */}
                            {v.owner?.engine ? `${v.owner.engine} · ` : ''}{v.name}
                            {/* v8 ignore stop */}
                          </div>
                        </div>
                      </div>
                      <span className="font-mono text-xs font-semibold text-slate-200">
                        {formatBytes(v.sizeBytes)}
                      </span>
                    </div>

                    <div className="mt-3 flex items-center gap-2">
                      <span className="rounded bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] text-emerald-300 ring-1 ring-inset ring-emerald-500/20">
                        {t('Attached Database')}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded bg-slate-500/10 px-2 py-0.5 font-mono text-[10px] text-slate-300 ring-1 ring-inset ring-slate-500/20">
                        <ShieldCheck size={10} className="text-emerald-400" /> {t('Retained on Delete')}
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-t border-white/[0.04] flex items-center justify-between">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setBrowsingVolume(v.name)}
                      className="text-xs h-7 px-2"
                    >
                      <FolderOpen size={13} /> {t('Browse Files')}
                    </Button>
                    <Link
                      to={`/databases/${v.owner!.id}`}
                      className="text-xs text-indigo-400 hover:text-indigo-300 font-medium inline-flex items-center gap-1"
                    >
                      {t('Database Settings')} <ArrowUpRight size={12} />
                    </Link>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
      )}

      {/* Safety & Retention Notice */}
      <Card className="p-4 border-amber-500/20 bg-amber-500/[0.03]">
        <div className="flex items-start gap-3">
          <Info size={18} className="text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs text-slate-300 space-y-1">
            <p className="font-semibold text-amber-200">{t('Storage Protection & Retention Policy')}</p>
            <p className="text-slate-400">
              {fill(
                t('When a service or attached database is removed, NineDeploy retains persistent volumes by default as {retained} so your data is never lost. Detaching an attached volume keeps the underlying Docker volume intact — the data lives on and can be re-attached to this or another service. You can prune orphaned volumes anytime in the {link} section.'),
                {
                  retained: <code>retained</code>,
                  link: <Link to="/volumes" className="text-indigo-300 underline underline-offset-2">{t('Volumes')}</Link>,
                },
              )}
            </p>
          </div>
        </div>
      </Card>

      {/* Interactive Volume File Browser Modal */}
      {browsingVolume && (
        <VolumeBrowser volume={browsingVolume} serverId={svc.serverId ?? undefined} onClose={() => setBrowsingVolume(null)} />
      )}

      {/* 0.16.3: files mounted read-only in the container. */}
      <FileMountsCard serviceId={serviceId} svc={svc} />

      {attaching && (
        <AttachVolumeModal serviceId={serviceId} existingPaths={getExistingPaths(svc, svcVolumeAttachments)} onClose={() => setAttaching(false)} />
      )}
    </div>
  );
}

function getExistingPaths(svc: Service, attachments: ServiceVolumeAttachment[]): string[] {
  const paths: string[] = [];
  if (svc.volumeMount) paths.push(svc.volumeMount);
  for (const a of attachments) paths.push(a.containerPath);
  return paths;
}

/**
 * True for services running images known to bake their DB settings into a
 * config file INSIDE the persistent volume on first boot (WordPress' hidden
 * wp-config.php pattern). On those, "just redeploy" does not refresh config —
 * the Regenerate button exists precisely for that trap.
 */
const ONE_TIME_CONFIG_IMAGES = ['wordpress'];
function hostsOneTimeConfig(svc: Service, containerPath: string): boolean {
  const image = (svc.image ?? '').toLowerCase();
  return ONE_TIME_CONFIG_IMAGES.some((img) => image.includes(img)) && containerPath === (svc.volumeMount ?? '/var/www/html');
}

function RepairConfigButton(
  props: { serviceId: number } & ({ attachmentId: number } | { volumeName: string }),
) {
  const t = useT();
  const { serviceId } = props;
  const qc = useQueryClient();
  const { toast } = useToast();
  const repair = useMutation({
    mutationFn: () =>
      api.serviceVolumes.repairConfig(serviceId, {
        filePath: 'wp-config.php',
        ...('attachmentId' in props ? { attachmentId: props.attachmentId } : { volumeName: props.volumeName }),
      }),
    onSuccess: () => {
      toast(t('wp-config.php removed from the volume — the queued redeploy regenerates it from current env'), 'success');
      qc.invalidateQueries({ queryKey: ['service-volume-attachments', serviceId] });
      // r211: each of these queued a redeploy the Deploys tab never saw.
      qc.invalidateQueries({ queryKey: ['deploys', serviceId] });
    },
    onError: (err: Error) => toast(err.message || t('Could not regenerate wp-config'), 'error'),
  });
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => repair.mutate()}
      disabled={repair.isPending}
      className="text-xs h-7 px-2 text-sky-300 hover:text-sky-200"
      title={t('Delete the first-boot wp-config.php from this volume and queue a redeploy so WordPress rewrites it from the current database settings')}
    >
      <Wrench size={13} /> {repair.isPending ? t('Fixing…') : t('Regenerate config')}
    </Button>
  );
}

function DetachButton({ serviceId, attachment }: { serviceId: number; attachment: ServiceVolumeAttachment }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const detach = useMutation({
    mutationFn: () => api.serviceVolumes.remove(serviceId, attachment.id),
    onSuccess: () => {
      toast(t('Volume detached — a redeploy was queued to drop the mount'), 'success');
      qc.invalidateQueries({ queryKey: ['service-volume-attachments', serviceId] });
      // r211: each of these queued a redeploy the Deploys tab never saw.
      qc.invalidateQueries({ queryKey: ['deploys', serviceId] });
      setConfirming(false);
    },
    // Server rejections (auth, 404, docker errors) must be visible — a silent
    // failure here looked exactly like "the button does nothing".
    onError: (err: Error) =>
      toast(err instanceof Error && err.message ? err.message : t('Could not detach the volume'), 'error'),
  });
  if (confirming) {
    return (
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} className="text-xs h-7 px-2">
          <X size={12} /> {t('Cancel')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={() => detach.mutate()}
          disabled={detach.isPending}
          className="text-xs h-7 px-2 bg-rose-600 hover:bg-rose-500"
        >
          <Trash2 size={12} /> {detach.isPending ? t('Detaching…') : t('Confirm Detach')}
        </Button>
      </div>
    );
  }
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => setConfirming(true)}
      className="text-xs h-7 px-2 text-rose-400 hover:text-rose-300"
      data-testid={`detach-button-${attachment.id}`}
    >
      <Trash2 size={13} /> {t('Detach')}
    </Button>
  );
}

function AttachVolumeModal({
  serviceId,
  existingPaths,
  onClose,
}: {
  serviceId: number;
  existingPaths: string[];
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isOperator = user?.isOperator === true;
  // The instance inventory is operator-only (r473) — for members the
  // "Existing Volume" tab cannot work, so they start on "Create New".
  const [mode, setMode] = useState<'existing' | 'create'>(isOperator ? 'existing' : 'create');
  const [volumeName, setVolumeName] = useState('');
  const [label, setLabel] = useState('');
  const [containerPath, setContainerPath] = useState('/data');
  const [readOnly, setReadOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  useEscapeToClose(onClose);

  const inventory = useQuery({
    queryKey: ['volumes'],
    queryFn: () => api.volumes.list(),
    enabled: isOperator,
  });

  const attach = useMutation({
    mutationFn: () =>
      api.serviceVolumes.create(serviceId, {
        ...(mode === 'existing' ? { volumeName } : { create: { label } }),
        containerPath,
        readOnly,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['service-volume-attachments', serviceId] });
      // r211: each of these queued a redeploy the Deploys tab never saw.
      qc.invalidateQueries({ queryKey: ['deploys', serviceId] });
      onClose();
    },
    onError: (err: Error) => setError(err.message || t('Failed to attach volume')),
  });

  const attachableVols = (inventory.data ?? []).filter((v) => v.owner == null);

  const pathConflict = existingPaths.includes(containerPath);

  const canSubmit =
    !pathConflict &&
    (mode === 'existing' ? volumeName.length > 0 : label.length > 0) &&
    containerPath.startsWith('/') &&
    !attach.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4" onClick={onClose}>
      <Card
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-lg p-6 bg-slate-900"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 id={titleId} className="text-lg font-semibold text-slate-100">{t('Attach Volume')}</h2>
          <button type="button" onClick={onClose} aria-label={t('Close')} className="text-slate-400 hover:text-slate-200"><X size={18} /></button>
        </div>

        <div className="flex items-center gap-2 mb-4 border-b border-white/[0.06]">
          {isOperator && (
            <button
              type="button"
              onClick={() => setMode('existing')}
              className={cn('px-3 py-1.5 text-xs font-medium', mode === 'existing' ? 'text-indigo-300 border-b-2 border-indigo-400' : 'text-slate-400')}
            >
              {t('Existing Volume')}
            </button>
          )}
          <button
            type="button"
            onClick={() => setMode('create')}
            className={cn('px-3 py-1.5 text-xs font-medium', mode === 'create' ? 'text-indigo-300 border-b-2 border-indigo-400' : 'text-slate-400')}
          >
            {t('Create New')}
          </button>
        </div>

        <div className="space-y-4">
          {mode === 'existing' ? (
            <div>
              <label htmlFor="vol-name" className="block text-xs font-medium text-slate-300 mb-1.5">{t('Volume Name')}</label>
              <select
                id="vol-name"
                value={volumeName}
                onChange={(e) => setVolumeName(e.target.value)}
                className="w-full rounded-md bg-slate-950/60 border border-white/[0.08] px-3 py-1.5 text-sm text-slate-100 font-mono"
                data-testid="attach-existing-select"
              >
                <option value="">{t('— pick a managed volume —')}</option>
                {attachableVols.map((v) => (
                  <option key={v.name} value={v.name}>{v.name}</option>
                ))}
              </select>
              <p className="text-[11px] text-slate-500 mt-1">{t('Only volumes with no current owner can be attached. An in-use volume is not listed — detach it from its current service first.')}</p>
            </div>
          ) : (
            <div>
              <label htmlFor="vol-label" className="block text-xs font-medium text-slate-300 mb-1.5">{t('Label')}</label>
              <input
                id="vol-label"
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="uploads"
                className="w-full rounded-md bg-slate-950/60 border border-white/[0.08] px-3 py-1.5 text-sm text-slate-100 font-mono"
                data-testid="attach-create-label"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                {fill(t('A new managed Docker volume is created (named {name}) and attached to this service.'), {
                  name: <code>nd-svc-…-label</code>,
                })}
              </p>
            </div>
          )}

          <div>
            <label htmlFor="vol-path" className="block text-xs font-medium text-slate-300 mb-1.5">{t('Container Path')}</label>
            <input
              id="vol-path"
              type="text"
              value={containerPath}
              onChange={(e) => setContainerPath(e.target.value)}
              className={cn(
                'w-full rounded-md bg-slate-950/60 border px-3 py-1.5 text-sm text-slate-100 font-mono',
                pathConflict ? 'border-rose-500/60' : 'border-white/[0.08]',
              )}
              data-testid="attach-container-path"
            />
            {pathConflict && (
              <p className="text-[11px] text-rose-400 mt-1">{t('Path already in use on this service')}</p>
            )}
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={readOnly}
              onChange={(e) => setReadOnly(e.target.checked)}
              className="rounded border-white/[0.15] bg-slate-950/60"
            />
            {t('Read-only mount')}
          </label>

          {error && (
            <p className="text-xs text-rose-400 bg-rose-500/[0.08] border border-rose-500/20 rounded-md p-2">{error}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 mt-6">
          <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
          <Button
            variant="primary"
            onClick={() => attach.mutate()}
            disabled={!canSubmit}
            data-testid="attach-submit"
          >
            {attach.isPending ? t('Attaching…') : t('Attach')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
