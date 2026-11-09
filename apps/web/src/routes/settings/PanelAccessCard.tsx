import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { PanelAccessView } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Badge, Button, Card, CardBody, ErrorCard, Field, Skeleton, Switch, Textarea } from '../../components/ui.js';
import { fill, useT } from '../../lib/i18n.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const toLines = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Settings → Security (operator): the panel IP allow-list (O4). Only listed
 * addresses can sign in or use a session; webhooks, CI runners, status pages
 * and other integrations keep working from anywhere. The server refuses a list
 * that would lock out the address saving it.
 */
export function PanelAccessCard() {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const query = useQuery({ queryKey: ['panel-access'], queryFn: () => api.settings.panelAccess.get() });
  const [enabled, setEnabled] = useState(false);
  const [text, setText] = useState('');
  const [includeTokens, setIncludeTokens] = useState(false);

  useEffect(() => {
    if (!query.data) return;
    setEnabled(query.data.enabled);
    setText(query.data.cidrs.join('\n'));
    setIncludeTokens(query.data.includeTokens);
  }, [query.data]);

  const save = useMutation({
    mutationFn: () => api.settings.panelAccess.set({ enabled, cidrs: toLines(text), includeTokens }),
    onSuccess: (view: PanelAccessView) => {
      qc.setQueryData(['panel-access'], view);
      toast(view.enabled ? t('Panel allow-list on') : t('Panel allow-list off'), 'success');
    },
    onError: (err) => toast(t('Could not save the allow-list: {error}', { error: errorText(err) }), 'error'),
  });

  if (query.isLoading) {
    return (
      <Card className="mb-5">
        <CardBody>
          <Skeleton className="h-24" />
        </CardBody>
      </Card>
    );
  }
  if (query.isError || !query.data) {
    return <ErrorCard title={t('Could not load the panel allow-list')} error={query.error} onRetry={() => void query.refetch()} />;
  }
  const data = query.data;
  const yourIpListed = toLines(text).includes(data.yourIp);

  return (
    <Card className="mb-5">
      <div className="p-4 border-b border-white/[0.06]">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
          <ShieldCheck size={14} /> {t('Panel access')}
          {data.enabled ? <Badge tone="emerald">{t('On')}</Badge> : <Badge>{t('Off')}</Badge>}
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          {t('Only the addresses below can sign in to this panel or use it while signed in. Webhooks, CI runners, status pages, SCIM and other integrations keep working from anywhere.')}
        </p>
      </div>
      <CardBody className="space-y-4">
        {data.overridden && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
            {t('NINEDEPLOY_PANEL_ACCESS=off is set on the server, so the list is ignored until it is removed and the panel restarts.')}
          </p>
        )}
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-slate-200">{t('Restrict the panel to these addresses')}</span>
          <Switch checked={enabled} onChange={setEnabled} label={t('Restrict the panel to these addresses')} />
        </div>
        <Field
          label={t('Addresses and ranges')}
          hint={t('One per line: an IPv4 or IPv6 address, or a CIDR range such as 203.0.113.0/24.')}
        >
          <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={'203.0.113.0/24\n2001:db8::/32'} spellCheck={false} />
        </Field>
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <span>{fill(t('The panel sees you as {ip}.'), { ip: <code className="text-slate-200">{data.yourIp}</code> })}</span>
          {!yourIpListed && (
            <Button size="sm" variant="secondary" onClick={() => setText((prev) => (prev.trim() ? `${prev.trim()}\n${data.yourIp}` : data.yourIp))}>
              {t('Add my address')}
            </Button>
          )}
        </div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <span className="text-sm text-slate-200">{t('Also restrict API and MCP tokens')}</span>
            <p className="text-xs text-slate-500">{t('Off by default, so CI jobs and AI agents that deploy with a token keep working from anywhere.')}</p>
          </div>
          <Switch checked={includeTokens} onChange={setIncludeTokens} label={t('Also restrict API and MCP tokens')} />
        </div>
        <p className="text-xs text-slate-500">
          {t('Apps behind panel sign-in (forward auth) also need a listed address to sign in. If you lock yourself out, set NINEDEPLOY_PANEL_ACCESS=off on the server and restart the panel.')}
        </p>
        <div className="flex justify-end">
          <Button variant="primary" size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
            {t('Save')}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
