import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import type { ForwardAuthView, ServiceDetail } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { useT } from '../../lib/i18n.js';
import { Card, CardBody, Select, Switch } from '../../components/ui.js';

type Role = 'viewer' | 'member' | 'admin' | 'owner';

/**
 * Service → Settings (G2.3): put a domain of this service behind panel
 * sign-in. Visitors sign in on the panel and need the chosen role on the
 * service. Services on the panel host.
 */
export function ForwardAuthCard({ svc }: { svc: ServiceDetail }) {
  const t = useT();
  const onHost = svc.serverId == null;
  const domains = useQuery({ queryKey: ['domains', svc.id], queryFn: () => api.domains.list(svc.id), enabled: onHost, retry: false });
  const rows = (domains.data ?? []).filter((d) => d.status === 'active');
  if (!onHost || rows.length === 0) return null;

  return (
    <Card>
      <CardBody className="space-y-3 text-sm">
        <div className="flex items-center gap-2 font-medium text-slate-300">
          <Lock size={15} className="text-slate-500" /> {t('Panel sign-in')}
        </div>
        <p className="text-xs text-slate-500">
          {t('Visitors of a protected domain sign in on this panel first and need the chosen role on this service. The app receives their email in the X-Forwarded-User header. Signing out everywhere ends their access.')}
        </p>
        {rows.map((d) => (
          <DomainRow key={d.id} domainId={d.id} hostname={`${d.hostname}${d.path && d.path !== '/' ? d.path : ''}`} />
        ))}
      </CardBody>
    </Card>
  );
}

function DomainRow({ domainId, hostname }: { domainId: number; hostname: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ['forward-auth', domainId], queryFn: () => api.domains.forwardAuth.get(domainId), retry: false });
  const save = useMutation({
    mutationFn: (value: { minRole: Role } | null) => api.domains.forwardAuth.set(domainId, value),
    onSuccess: (view: ForwardAuthView) => {
      qc.setQueryData(['forward-auth', domainId], view);
      toast(view.forwardAuth ? t('{host} is behind panel sign-in', { host: hostname }) : t('{host} is open again', { host: hostname }), 'success');
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });
  if (!q.data) return null;
  const fa = q.data.forwardAuth;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded bg-black/20 px-2 py-1.5">
      <span className="font-mono text-xs text-slate-300">{hostname}</span>
      <div className="flex items-center gap-2">
        {fa && (
          <Select
            value={fa.minRole}
            onChange={(e) => save.mutate({ minRole: e.target.value as Role })}
            disabled={save.isPending}
            className="h-8 text-xs"
            aria-label={t('Least role for {host}', { host: hostname })}
          >
            <option value="viewer">{t('Viewer')}</option>
            <option value="member">{t('Member')}</option>
            <option value="admin">{t('Admin')}</option>
            <option value="owner">{t('Owner')}</option>
          </Select>
        )}
        <Switch
          checked={!!fa}
          onChange={(on) => save.mutate(on ? { minRole: 'viewer' } : null)}
          disabled={save.isPending}
          label={t('Panel sign-in for {host}', { host: hostname })}
        />
      </div>
    </div>
  );
}
