import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Copy, Layers } from 'lucide-react';
import type { DatabaseDetail, PgbouncerStatus } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { useCopy } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, ConfirmDialog, Field, Input, Skeleton, StatusBadge } from '../../components/ui.js';
import { useT } from '../../lib/i18n.js';

const errorStatus = (err: unknown): number | undefined => (err as { status?: number } | null)?.status;
const message = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

/** The sidecar's state as a status badge: the server reports `enabled` and `running` separately. */
function sidecarState(s: PgbouncerStatus): 'running' | 'error' | 'stopped' {
  if (!s.enabled) return 'stopped';
  return s.running ? 'running' : 'error';
}

/**
 * G1.5: the PgBouncer sidecar of a PostgreSQL database on the panel host.
 * The routes have existed since G-32 (API, CLI, SDK); this is their first
 * web control. Reading needs member rights on the database; enabling and
 * disabling start or remove a container on the host, so they are
 * operator-only (`requireAdmin` checks the instance-operator flag).
 */
export function PgbouncerCard({ db }: { db: DatabaseDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { copied, copy } = useCopy();
  const { user } = useAuth();
  const isOperator = user?.isOperator === true;
  const [port, setPort] = useState('');
  const [confirmDisable, setConfirmDisable] = useState(false);

  const status = useQuery({
    queryKey: ['database-pgbouncer', db.id],
    queryFn: () => api.databases.pgbouncerStatus(db.id),
  });

  const applied = (next: PgbouncerStatus, done: string) => {
    qc.setQueryData(['database-pgbouncer', db.id], (prev: PgbouncerStatus | undefined) => ({ ...prev, ...next }));
    void qc.invalidateQueries({ queryKey: ['database-pgbouncer', db.id] });
    toast(next.enabled && !next.running ? t('{done}, but the sidecar is not running yet', { done }) : done, next.enabled && !next.running ? 'error' : 'success');
  };

  const enable = useMutation({
    mutationFn: () => api.databases.enablePgbouncer(db.id, port.trim() ? { port: Number(port) } : {}),
    onSuccess: (next) => applied(next, t('PgBouncer enabled')),
    onError: (err) => toast(message(err, t('Could not enable PgBouncer')), 'error'),
  });

  const disable = useMutation({
    mutationFn: () => api.databases.disablePgbouncer(db.id),
    onSuccess: (next) => applied(next, t('PgBouncer disabled')),
    onError: (err) => toast(message(err, t('Could not disable PgBouncer')), 'error'),
  });

  const title = (
    <div className="p-4 border-b border-white/[0.06] flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
        <Layers size={14} /> {t('PgBouncer connection pooling')}
      </h2>
      {status.data && <StatusBadge status={sidecarState(status.data)} />}
    </div>
  );

  if (status.isLoading) {
    return (
      <Card>
        <CardBody>
          <Skeleton className="h-20" />
        </CardBody>
      </Card>
    );
  }
  if (status.isError || !status.data) {
    return (
      <Card className="overflow-hidden">
        {title}
        <CardBody>
          <p className="text-sm text-slate-500">
            {errorStatus(status.error) === 403 ? t('PgBouncer settings need access to this database.') : t('Could not load the PgBouncer status.')}
          </p>
        </CardBody>
      </Card>
    );
  }

  const s = status.data;
  const portNum = Number(port);
  const portError = port.trim() === '' || (/^\d+$/.test(port) && portNum >= 1024 && portNum <= 65535) ? null : t('A port between 1024 and 65535');
  const busy = enable.isPending || disable.isPending;

  return (
    <Card className="overflow-hidden">
      {title}
      <CardBody className="space-y-4">
        <p className="text-xs text-slate-400">
          {t('A PgBouncer sidecar in front of this database pools client connections. Apps that open many short connections (serverless handlers, PHP, many replicas) connect to the pooled URL instead of the database directly.')}
        </p>
        {s.enabled ? (
          <>
            <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
              <div>
                <dt className="text-slate-500">{t('Port')}</dt>
                <dd className="font-mono text-slate-200">{s.port}</dd>
              </div>
              <div>
                <dt className="text-slate-500">{t('Pool mode')}</dt>
                <dd className="font-mono text-slate-200">{s.poolMode ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-slate-500">{t('Container')}</dt>
                <dd className="font-mono text-slate-200 break-all">{s.containerName ?? '—'}</dd>
              </div>
            </dl>
            {s.pooledConnectionString ? (
              <div className="flex items-center gap-2 rounded-lg bg-black/30 p-2">
                <code className="flex-1 break-all text-[11px] text-slate-200" data-testid="pgbouncer-url">
                  {s.pooledConnectionString}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('Copy pooled connection URL')}
                  onClick={() => copy(s.pooledConnectionString ?? '')}
                >
                  <Copy size={12} /> {copied ? t('Copied') : t('Copy')}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-amber-300">{t('The sidecar is enabled but not running, so there is no pooled URL yet.')}</p>
            )}
            {isOperator && (
              <div className="flex justify-end">
                <Button size="sm" variant="danger" onClick={() => setConfirmDisable(true)} disabled={busy}>
                  {t('Disable PgBouncer')}
                </Button>
              </div>
            )}
          </>
        ) : !isOperator ? (
          <p className="text-xs text-slate-500">{t('PgBouncer is off. Only an instance operator can turn it on.')}</p>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('Port (optional)')} hint={t('default {port}', { port: s.port })} error={portError ?? undefined}>
              <Input
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder={String(s.port)}
                inputMode="numeric"
                className="w-32 font-mono text-xs"
              />
            </Field>
            <Button size="sm" onClick={() => enable.mutate()} disabled={busy || portError != null}>
              {t('Enable PgBouncer')}
            </Button>
          </div>
        )}
      </CardBody>
      <ConfirmDialog
        open={confirmDisable}
        title={t('Disable PgBouncer?')}
        message={t('The sidecar is removed. Apps using the pooled URL lose their connection until they switch back to the direct URL.')}
        confirmLabel={t('Disable')}
        onConfirm={() => disable.mutate()}
        onClose={() => setConfirmDisable(false)}
      />
    </Card>
  );
}
