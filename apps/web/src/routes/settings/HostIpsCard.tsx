import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Network, Star } from 'lucide-react';
import { useState } from 'react';
import type { HostIpEntry } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Badge, Button, Card, CardBody, ErrorCard, Input, Select, Skeleton } from '../../components/ui.js';
import { fill, useT } from '../../lib/i18n.js';

interface Draft {
  label: string;
  serviceId: string;
}

const draftOf = (a: HostIpEntry): Draft => ({ label: a.label ?? '', serviceId: a.dedicatedTo ? String(a.dedicatedTo.id) : '' });

/**
 * Settings → Security, 0.16.1 (operator): the panel host's IP addresses.
 * Read live from the host; the operator labels them, marks the primary one
 * (what DNS records point at, offered for automatic URLs) and dedicates an
 * address to one service, which is then the only one that may publish ports
 * on it explicitly.
 */
export function HostIpsCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useT();
  const list = useQuery({ queryKey: ['host-ips'], queryFn: () => api.hostIps.list() });
  const services = useQuery({ queryKey: ['services'], queryFn: () => api.services.list() });
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const done = (message: string) => {
    void qc.invalidateQueries({ queryKey: ['host-ips'] });
    toast(message, 'success');
  };
  const fail = (err: Error) => toast(err.message || t('Could not save the address'), 'error');
  const save = useMutation({
    mutationFn: ({ ip, draft }: { ip: string; draft: Draft }) =>
      api.hostIps.set(ip, { label: draft.label.trim() || null, serviceId: draft.serviceId ? Number(draft.serviceId) : null }),
    onSuccess: (_, { ip }) => {
      setDrafts(({ [ip]: _saved, ...rest }) => rest);
      done(t('{ip} saved', { ip }));
    },
    onError: fail,
  });
  const primary = useMutation({
    mutationFn: (ip: string) => api.hostIps.set(ip, { primary: true }),
    onSuccess: (_, ip) => done(t('{ip} is the primary address', { ip })),
    onError: fail,
  });
  const forget = useMutation({
    mutationFn: (ip: string) => api.hostIps.remove(ip),
    onSuccess: (_, ip) => done(t('{ip} forgotten', { ip })),
    onError: fail,
  });

  if (list.isError && !list.data) return <ErrorCard title={t("Couldn't load the host's addresses")} error={list.error} onRetry={() => list.refetch()} />;
  const panelServices = (services.data ?? []).filter((s) => s.type === 'docker' && s.serverId == null);

  return (
    <Card className="mb-5">
      <CardBody>
        <div className="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200">
          <Network size={15} className="text-slate-500" /> {t('IP addresses')}
        </div>
        <p className="mb-4 max-w-3xl text-xs text-slate-500">
          {fill(
            t('The addresses of this server. The {primary} one is where DNS records should point and the address offered for automatic sslip.io URLs. An address {dedicated} to a service can only be chosen by that service in its port mappings; services that publish on every address still listen on it for their own ports.'),
            { primary: <strong>{t('primary')}</strong>, dedicated: <strong>{t('dedicated')}</strong> },
          )}
        </p>
        {!list.data ? (
          <Skeleton className="h-16" />
        ) : (
          <>
            {!list.data.detected && (
              <p className="mb-3 text-xs text-amber-300/90">{t("The host's interfaces could not be read (is Docker reachable?). Saved addresses are listed below.")}</p>
            )}
            {list.data.addresses.length === 0 ? (
              <p className="text-xs text-slate-500">{t('No public or LAN address found.')}</p>
            ) : (
              <div className="space-y-2">
                {list.data.addresses.map((a) => {
                  const draft = drafts[a.ip] ?? draftOf(a);
                  const dirty = drafts[a.ip] !== undefined && JSON.stringify(draft) !== JSON.stringify(draftOf(a));
                  const set = (patch: Partial<Draft>) => setDrafts((prev) => ({ ...prev, [a.ip]: { ...draft, ...patch } }));
                  return (
                    <div key={a.ip} className="flex flex-wrap items-center gap-2 rounded-md border border-white/5 px-3 py-2">
                      <span className="w-52 shrink-0 font-mono text-xs text-slate-200">{a.ip}</span>
                      <span className="w-24 shrink-0 text-[11px] text-slate-500">{a.iface ?? t('not detected')}</span>
                      {a.primary ? (
                        <Badge tone="emerald">
                          <Star size={10} className="mr-1 inline" />
                          {t('primary')}
                        </Badge>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => primary.mutate(a.ip)} disabled={primary.isPending || !a.detected}>
                          {t('Make primary')}
                        </Button>
                      )}
                      <Input
                        value={draft.label}
                        onChange={(e) => set({ label: e.target.value })}
                        placeholder={t('label')}
                        aria-label={t('{ip} label', { ip: a.ip })}
                        className="h-8 w-36 text-xs"
                      />
                      <Select
                        value={draft.serviceId}
                        onChange={(e) => set({ serviceId: e.target.value })}
                        aria-label={t('{ip} dedicated to', { ip: a.ip })}
                        className="h-8 w-44 text-xs"
                      >
                        <option value="">{t('Shared')}</option>
                        {a.dedicatedTo && !panelServices.some((s) => s.id === a.dedicatedTo!.id) && (
                          <option value={String(a.dedicatedTo.id)}>{a.dedicatedTo.name}</option>
                        )}
                        {panelServices.map((s) => (
                          <option key={s.id} value={String(s.id)}>
                            {t('Dedicated to {name}', { name: s.name })}
                          </option>
                        ))}
                      </Select>
                      <Button size="sm" variant="secondary" onClick={() => save.mutate({ ip: a.ip, draft })} disabled={!dirty || save.isPending}>
                        {t('Save')}
                      </Button>
                      {!a.detected && (
                        <Button size="sm" variant="ghost" onClick={() => forget.mutate(a.ip)} disabled={forget.isPending}>
                          {t('Forget')}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
