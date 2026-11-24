import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import type { DomainCutoverResult } from '@ninedeploy/schemas';
import { api } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { Button } from './ui.js';

export function MigrationDomainCutover({ serviceId, serviceName, host, https }: { serviceId: number; serviceName: string; host: string; https: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [result, setResult] = useState<DomainCutoverResult>();
  const [confirm, setConfirm] = useState(false);
  const check = useMutation({ mutationFn: () => api.domains.cutoverCheck(serviceId, host), onSuccess: setResult });
  const apply = useMutation({
    mutationFn: () => api.domains.cutover(serviceId, { hostname: host, ssl: https }),
    onSuccess: (status) => {
      setResult(status);
      if (status.status === 'active') {
        void queryClient.invalidateQueries({ queryKey: ['domains', serviceId] });
        void queryClient.invalidateQueries({ queryKey: ['domains-all'] });
      }
    },
  });
  const statuses: Record<DomainCutoverResult['status'], string> = {
    ready: t('Deployment and DNS are ready.'), active: t('Domain is attached.'),
    ownership_required: t('Publish the TXT record, then verify ownership.'),
    deployment_required: t('Deploy this service successfully before cutover.'), manual: t('This hostname needs manual routing review.'),
    route_conflict: t('There is already a route for this hostname. Review it in Domains.'),
    expected_unavailable: t('Set the destination in Settings → DNS records.'),
    dns_unavailable: t('The DNS lookup failed. Check again.'), dns_unresolved: t('The hostname has no A or AAAA records.'),
    dns_mismatch: t('At least one DNS address differs from the configured destination.'),
  };
  const busy = check.isPending || apply.isPending;
  const canApply = result && (result.status === 'ready' || result.status === 'ownership_required');
  const scheme = https ? 'HTTPS' : 'HTTP';

  return (
    <section aria-label={t('Cutover for {host}', { host })} className="space-y-2">
      <p className="text-slate-400">{serviceName} · {scheme}</p>
      {result && <p role="status" className="text-slate-200">{statuses[result.status]}</p>}
      {result?.status === 'deployment_required' && <Link to={`/services/${serviceId}?tab=deploys`} className="text-indigo-300 underline">{t('Open deployments')}</Link>}
      {result?.expected && <p className="text-slate-400">{t('Expected DNS addresses')} <code>{result.expected.join(', ')}</code></p>}
      {!!result?.resolved?.length && <p className="text-slate-400">{t('Resolved DNS addresses')} <code>{result.resolved.join(', ')}</code></p>}
      {result?.verification && (
        <dl className="space-y-1 text-slate-300">
          <div><dt>{t('TXT record name')}</dt><dd><code>{result.verification.recordName}</code></dd></div>
          <div><dt>{t('TXT record value')}</dt><dd><code>{result.verification.recordValue}</code></dd></div>
        </dl>
      )}
      {(check.isError || apply.isError) && <p role="alert" className="text-red-300">{apply.error?.message ?? check.error?.message ?? t('Could not complete the cutover request.')}</p>}
      {confirm ? (
        <>
          <p>{t('Confirm {scheme} routing for {host} to {service}. DNS records are managed separately.', { scheme, host: result?.hostname ?? host, service: serviceName })}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => { setConfirm(false); apply.mutate(); }}>{t('Confirm domain cutover')}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(false)}>{t('Cancel')}</Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => { apply.reset(); setResult(undefined); check.mutate(); }}>
            {check.isPending ? t('Checking cutover…') : t('Check cutover')}
          </Button>
          {canApply && <Button type="button" size="sm" disabled={busy} onClick={() => setConfirm(true)}>{result.verification ? t('Verify ownership') : t('Attach domain')}</Button>}
          {apply.isPending && <p role="status" className="self-center text-slate-400">{t('Rechecking cutover…')}</p>}
        </div>
      )}
    </section>
  );
}
