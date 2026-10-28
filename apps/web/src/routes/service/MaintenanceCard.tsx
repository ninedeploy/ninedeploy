import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Construction, FileWarning } from 'lucide-react';
import type { ErrorPagesView, MaintenanceView, ServiceDetail } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { useT } from '../../lib/i18n.js';
import { Button, Card, CardBody, Field, Input, Switch, Textarea } from '../../components/ui.js';

const STATUSES = ['502', '503', '504'] as const;
type Status = (typeof STATUSES)[number];

/**
 * Service → Settings (G2.2): maintenance mode, which sends the service's
 * domains to a panel-served 503 page (the bypass addresses still reach the
 * app), and custom 502/503/504 pages. Services on the panel host.
 */
export function MaintenanceCard({ svc }: { svc: ServiceDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const onHost = svc.serverId == null;
  const q = useQuery({ queryKey: ['maintenance', svc.id], queryFn: () => api.services.maintenance.get(svc.id), retry: false, enabled: onHost });
  const pagesQ = useQuery({ queryKey: ['error-pages', svc.id], queryFn: () => api.services.errorPages.get(svc.id), retry: false, enabled: onHost });

  const [title, setTitle] = useState('Down for maintenance');
  const [message, setMessage] = useState('We will be back shortly.');
  const [bypass, setBypass] = useState('');
  useEffect(() => {
    const m = q.data?.maintenance;
    if (!m) return;
    setTitle(m.title);
    setMessage(m.message);
    setBypass(m.bypass.join('\n'));
  }, [q.data]);
  const [pages, setPages] = useState<Partial<Record<Status, string>>>({});
  useEffect(() => {
    if (pagesQ.data) setPages(pagesQ.data.pages);
  }, [pagesQ.data]);
  const [editing, setEditing] = useState<Status>('502');

  const config = () => ({
    title,
    message,
    bypass: bypass.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
  });
  const save = useMutation({
    mutationFn: (on: boolean) => api.services.maintenance.set(svc.id, on ? config() : null),
    onSuccess: (view: MaintenanceView) => {
      qc.setQueryData(['maintenance', svc.id], view);
      toast(view.maintenance ? t('Maintenance mode is on') : t('Maintenance mode is off'), 'success');
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });
  const savePages = useMutation({
    mutationFn: () => api.services.errorPages.set(svc.id, pages),
    onSuccess: (view: ErrorPagesView) => {
      qc.setQueryData(['error-pages', svc.id], view);
      toast(t('Error pages saved'), 'success');
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });

  if (!onHost || !q.data || !pagesQ.data) return null;
  const on = q.data.maintenance !== null;

  return (
    <Card>
      <CardBody className="space-y-4 text-sm">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-medium text-slate-300">
              <Construction size={15} className="text-slate-500" /> {t('Maintenance mode')}
            </div>
            <Switch checked={on} onChange={(v) => save.mutate(v)} disabled={save.isPending} label={t('Maintenance mode')} />
          </div>
          <p className="text-xs text-slate-500">
            {t("While on, every domain of this service shows a maintenance page (503) instead of the app. Addresses on the bypass list still reach the app, to check the release before you switch it off.")}
          </p>
          {on && q.data.since && <p className="text-xs text-amber-300/80">{t('On since {time}', { time: formatDateTime(q.data.since) })}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('Title')}>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} className="h-9 text-xs" />
            </Field>
            <Field label={t('Bypass addresses')} hint={t('IP addresses or CIDR ranges, one per line')}>
              <Textarea value={bypass} onChange={(e) => setBypass(e.target.value)} rows={2} className="font-mono text-xs" />
            </Field>
          </div>
          <Field label={t('Message')}>
            <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} maxLength={1000} className="text-xs" />
          </Field>
          {on && (
            <Button size="sm" variant="secondary" onClick={() => save.mutate(true)} disabled={save.isPending}>
              {t('Update the page')}
            </Button>
          )}
        </div>

        <div className="space-y-3 border-t border-white/[0.06] pt-4">
          <div className="flex items-center gap-2 font-medium text-slate-300">
            <FileWarning size={15} className="text-slate-500" /> {t('Custom error pages')}
          </div>
          <p className="text-xs text-slate-500">
            {t('HTML shown instead of the proxy’s plain page when the app answers 502, 503 or 504, or cannot be reached. Leave one empty to keep the default.')}
          </p>
          <div className="flex gap-1" role="tablist">
            {STATUSES.map((s) => (
              <Button key={s} size="sm" variant={editing === s ? 'secondary' : 'ghost'} onClick={() => setEditing(s)} role="tab" aria-selected={editing === s}>
                {s}
                {pages[s]?.trim() ? ' •' : ''}
              </Button>
            ))}
          </div>
          <Textarea
            value={pages[editing] ?? ''}
            onChange={(e) => setPages({ ...pages, [editing]: e.target.value })}
            rows={6}
            className="font-mono text-xs"
            aria-label={t('HTML for {status}', { status: editing })}
            placeholder="<!doctype html>…"
          />
          <Button size="sm" onClick={() => savePages.mutate()} disabled={savePages.isPending}>
            {t('Save error pages')}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
