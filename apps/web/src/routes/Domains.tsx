import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ChevronDown, Globe, Lock, Pencil, Plus, Trash2, Wand2 } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api.js';
import { useToast } from '../components/Toast.js';
import { Button, Card, CardBody, ConfirmDialog, EmptyState, ErrorCard, Input, PageHeader, Select, Skeleton, StatusBadge, Switch, cn } from '../components/ui.js';
import { cleanDomainInput, cleanPathInput, DomainItemRow, pastedPath, type DomainChallenge } from './service/NetworkTab.js';

import type { DomainEntry } from '@ninedeploy/sdk';

/** Whole days between now and an ISO expiry timestamp. */
function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export function Domains() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const list = useQuery({ queryKey: ['domains-all'], queryFn: () => api.domains.all() });
  const toggle = useMutation({
    mutationFn: (d: { id: number; ssl: boolean }) => api.domains.setSsl(d.id, d.ssl),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ['domains-all'] });
      toast(vars.ssl ? 'HTTPS enabled for the domain' : 'HTTPS disabled — the domain now serves plain HTTP', 'success');
    },
    onError: () => toast('Could not update the SSL setting', 'error'),
  });
  // Which row's management panel is open, and whether it opened on Edit.
  const [open, setOpen] = useState<{ id: number; editing: boolean } | null>(null);
  // The TXT challenge is only in create / verify responses, so keep it here.
  const [challenges, setChallenges] = useState<Record<number, DomainChallenge>>({});
  const [removing, setRemoving] = useState<DomainEntry | null>(null);
  const remove = useMutation({
    mutationFn: (d: DomainEntry) => api.domains.remove(d.serviceId, d.id),
    onSuccess: (_res, d) => {
      qc.invalidateQueries({ queryKey: ['domains-all'] });
      qc.invalidateQueries({ queryKey: ['domains', d.serviceId] });
      if (open?.id === d.id) setOpen(null);
      toast(`${d.hostname} removed`, 'success');
    },
    onError: (err) => toast(err instanceof Error && err.message ? err.message : 'Could not remove the domain', 'error'),
  });

  return (
    <div>
      <PageHeader
        icon={<Globe size={18} />}
        title="Domains"
        subtitle="Routing map & SSL — where each domain points."
      />

      <AddDomainCard onChallenge={(id, ch) => setChallenges((c) => ({ ...c, [id]: ch }))} />

      {list.isLoading ? (
        <Card className="p-5"><Skeleton className="h-10 w-full" /></Card>
      ) : list.isError ? (
        <ErrorCard title="Couldn't load domains" error={list.error} onRetry={() => list.refetch()} />
      ) : !list.data || list.data.length === 0 ? (
        <Card><EmptyState icon={<Globe size={26} />} title="No domains" hint="Add one above, or from a service's Network tab." /></Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/5 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3 font-medium">Domain</th>
                <th className="px-5 py-3 font-medium">Routes to</th>
                <th className="px-5 py-3 font-medium">Container</th>
                <th className="px-5 py-3 font-medium">SSL</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((d) => (
                <Fragment key={d.id}>
                <tr className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]">
                  <td className="px-5 py-3">
                    {/* r409: a pending domain is not routed — linking it just
                        opened a connection error. Plain text until verified. */}
                    {d.status === 'pending' ? (
                      <span className="font-mono text-xs text-slate-200" title="Awaiting DNS ownership proof — not routed yet">
                        {d.hostname}
                      </span>
                    ) : (
                      <a href={`http${d.ssl ? 's' : ''}://${d.hostname}`} target="_blank" rel="noreferrer" className="font-mono text-xs text-slate-200 hover:text-indigo-300">
                        {d.hostname}
                      </a>
                    )}
                    {d.path !== '/' && <span className="ml-1 font-mono text-[10px] text-slate-600">{d.path}</span>}
                  </td>
                  <td className="px-5 py-3">
                    {d.serviceName ? (
                      <Link to={`/services/${d.serviceId}`} className="flex items-center gap-1.5 text-slate-300 hover:text-indigo-300">
                        {d.serviceName} <ArrowRight size={11} className="text-slate-600" /> :{d.port ?? '?'}
                      </Link>
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3 font-mono text-[11px] text-slate-500">{d.container ?? '—'}</td>
                  <td className="px-5 py-3">
                    <Switch
                      checked={d.ssl}
                      onChange={(v) => toggle.mutate({ id: d.id, ssl: v })}
                      label={d.ssl ? 'HTTPS on' : 'Enable HTTPS'}
                    />
                    {d.ssl && <Lock size={11} className="ml-1.5 inline text-emerald-400" />}
                    {d.certExpiresAt && (() => {
                      // r409: an expired cert said "cert -3d" in amber; name
                      // the state and colour it like the failure it is.
                      const days = daysUntil(d.certExpiresAt);
                      const expired = days < 0;
                      return (
                        <span
                          className={cn(
                            'ml-2 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset',
                            expired
                              ? 'bg-rose-500/15 text-rose-300 ring-rose-500/20'
                              : days < 14
                                ? 'bg-amber-500/15 text-amber-300 ring-amber-500/20'
                                : 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20',
                          )}
                          title={expired ? 'Certificate EXPIRED — reissue by toggling HTTPS off/on' : "Certificate expiry (Let's Encrypt)"}
                        >
                          {expired ? `expired ${Math.abs(days)}d ago` : `cert ${days}d`}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-5 py-3">
                    {/* r345: the row's real routing status. `ssl` says nothing
                        about it — a `pending` domain (ownership unproven) is
                        not routed at all, whatever its HTTPS toggle. */}
                    <span title={d.status === 'pending' ? 'Awaiting DNS ownership proof — not routed yet. Open Manage to verify it.' : undefined}>
                      <StatusBadge status={d.status} />
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    {/* Every domain write is per service; a row without one
                        (its service is gone) has nothing to manage it through. */}
                    {d.serviceName != null && (
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setOpen(open?.id === d.id && open.editing ? null : { id: d.id, editing: true })}
                          className="text-slate-500 transition hover:text-indigo-300"
                          title="Change hostname or path"
                          aria-label={`Edit ${d.hostname}`}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setRemoving(d)}
                          className="text-slate-500 transition hover:text-rose-400"
                          title="Remove domain"
                          aria-label={`Remove ${d.hostname}`}
                        >
                          <Trash2 size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setOpen(open?.id === d.id ? null : { id: d.id, editing: false })}
                          className="flex items-center gap-1 rounded-full bg-slate-500/15 px-2 py-0.5 text-[10px] font-medium text-slate-300 ring-1 ring-inset ring-slate-500/20 transition hover:bg-slate-500/25"
                          title="Verify, DNS check, HTTPS, www redirect, security and redirect rules"
                          aria-expanded={open?.id === d.id}
                        >
                          Manage <ChevronDown size={11} className={cn('transition', open?.id === d.id && 'rotate-180')} />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
                {open?.id === d.id && d.serviceName != null && (
                  <tr className="border-b border-white/5 bg-slate-950/30">
                    <td colSpan={6} className="px-5 py-3">
                      <ManagedDomain
                        // Remount on Edit vs Manage so the row opens in the right mode.
                        key={open.editing ? 'edit' : 'manage'}
                        entry={d}
                        editing={open.editing}
                        challenges={challenges}
                        onChallenge={(id, ch) => setChallenges((c) => ({ ...c, [id]: ch }))}
                        onReplaced={() => setOpen(null)}
                      />
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <ConfirmDialog
        open={removing != null}
        title={`Remove ${removing?.hostname ?? 'domain'}?`}
        message="The domain stops routing immediately — requests to it will fail until it is added back and verified. The service itself keeps running."
        confirmLabel="Remove"
        onConfirm={() => removing && remove.mutate(removing)}
        onClose={() => setRemoving(null)}
      />
      <p className="mt-3 text-xs text-slate-600">HTTPS uses Traefik&apos;s certificate on :443. On a public domain, NineDeploy provisions a Let&apos;s Encrypt cert automatically.</p>
    </div>
  );
}

/**
 * The service Network tab's domain row, for one entry of the routing map:
 * the global list carries only the routing summary, so the full domain
 * (security, redirects) comes from its service.
 */
function ManagedDomain({
  entry,
  editing,
  challenges,
  onChallenge,
  onReplaced,
}: {
  entry: DomainEntry;
  editing: boolean;
  challenges: Record<number, DomainChallenge>;
  onChallenge: (domainId: number, ch: DomainChallenge) => void;
  onReplaced: () => void;
}) {
  const domains = useQuery({ queryKey: ['domains', entry.serviceId], queryFn: () => api.domains.list(entry.serviceId) });
  if (domains.isLoading) return <Skeleton className="h-8 w-full" />;
  if (domains.isError) return <ErrorCard title="Couldn't load this domain" error={domains.error} onRetry={() => domains.refetch()} />;
  const d = domains.data?.find((row) => row.id === entry.id);
  if (!d) return <p className="text-xs text-slate-500">This domain is no longer attached to {entry.serviceName}.</p>;
  return (
    <DomainItemRow
      domain={d}
      serviceId={entry.serviceId}
      challenge={challenges[d.id] ?? null}
      onChallenge={(ch) => onChallenge(d.id, ch)}
      onReplaced={(created) => {
        if (created.verification) onChallenge(created.id, created.verification);
        onReplaced();
      }}
      initialEditing={editing}
    />
  );
}

/** Attach a domain to any service — the same add / generate the service's Network tab offers. */
function AddDomainCard({ onChallenge }: { onChallenge: (domainId: number, ch: DomainChallenge) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const services = useQuery({ queryKey: ['services'], queryFn: () => api.services.list(), staleTime: 60_000 });
  const [serviceId, setServiceId] = useState('');
  const [hostname, setHostname] = useState('');
  const [path, setPath] = useState('');
  const [challenge, setChallenge] = useState<{ hostname: string; ch: DomainChallenge } | null>(null);
  const sid = Number(serviceId);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['domains-all'] });
    qc.invalidateQueries({ queryKey: ['domains', sid] });
  };
  const add = useMutation({
    mutationFn: ({ host, routePath }: { host: string; routePath: string }) =>
      api.domains.create(sid, routePath === '/' ? { hostname: host } : { hostname: host, path: routePath }),
    onSuccess: (created) => {
      if (created.verification) {
        onChallenge(created.id, created.verification);
        setChallenge({ hostname: created.hostname, ch: created.verification });
        toast(`${created.hostname} added — publish the TXT record to bring it live`, 'info');
      } else {
        setChallenge(null);
        toast(`${created.hostname} is routed to the service`, 'success');
      }
      setHostname('');
      setPath('');
      refresh();
    },
    onError: (err) => toast(err instanceof Error && err.message ? err.message : 'Could not add the domain', 'error'),
  });
  const generate = useMutation({
    mutationFn: () => api.domains.generate(sid),
    onSuccess: (d) => {
      toast(d.created ? `${d.hostname} is routed to the service` : `${d.hostname} is already attached`, d.created ? 'success' : 'info');
      refresh();
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });

  return (
    <Card className="mb-4">
      <CardBody>
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <Plus size={15} className="text-slate-500" /> Add domain
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => generate.mutate()}
            disabled={!sid || generate.isPending}
            title="Add the chosen service's automatic URL (a free sslip.io name or <slug>.<your base domain>)"
          >
            <Wand2 size={13} /> {generate.isPending ? 'Generating…' : 'Generate URL'}
          </Button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const host = cleanDomainInput(hostname);
            const routePath = cleanPathInput(path || pastedPath(hostname));
            setHostname(host);
            if (sid && host.includes('.')) add.mutate({ host, routePath });
          }}
          className="flex flex-wrap gap-2 md:flex-nowrap"
        >
          <Select
            value={serviceId}
            onChange={(e) => setServiceId(e.target.value)}
            aria-label="Service"
            className="h-9 basis-full text-xs md:w-48 md:basis-auto md:shrink-0"
          >
            <option value="">{services.isLoading ? 'Loading services…' : 'Choose a service'}</option>
            {services.data?.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </Select>
          <Input
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            onBlur={() => {
              // A pasted URL's path moves into the path field.
              const carried = pastedPath(hostname);
              if (carried && !path) setPath(cleanPathInput(carried));
              const host = cleanDomainInput(hostname);
              if (host !== hostname) setHostname(host);
            }}
            placeholder="app.example.com"
            aria-label="Domain"
            title="You can paste a full URL; its path goes to the path field."
            className="h-9 min-w-0 flex-1 basis-full md:basis-0"
          />
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onBlur={() => path && setPath(cleanPathInput(path))}
            placeholder="/path"
            aria-label="Path"
            title="Optional. Route only this path prefix to the service (e.g. /api); the request keeps its path."
            className="h-9 w-28 shrink-0 font-mono text-xs"
          />
          <Button type="submit" size="sm" variant="secondary" disabled={!sid || !hostname.trim() || add.isPending}>
            <Plus size={14} /> Add
          </Button>
        </form>
        {challenge && (
          <div className="mt-3 rounded-lg bg-amber-500/[0.04] px-3 py-2 text-[11px] text-slate-400 ring-1 ring-inset ring-amber-500/15">
            <p>Prove you control {challenge.hostname}: publish this DNS record, then press Verify under Manage.</p>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono">
              <dt className="text-slate-500">{challenge.ch.recordType}</dt>
              <dd className="break-all text-slate-200">{challenge.ch.recordName}</dd>
              <dt className="text-slate-500">value</dt>
              <dd className="break-all text-slate-200">{challenge.ch.recordValue}</dd>
            </dl>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
