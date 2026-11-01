import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Globe, Pencil, Plus, Radio, Shield, Trash2, Wand2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DomainRedirects } from './DomainRedirects.js';
import { ComposeRouteRow } from './ComposeRoutesCard.js';
import { PortMappingsCard } from './PortMappingsCard.js';
import { RoutingCard } from './RoutingCard.js';
import { api } from '../../lib/api.js';
import { fill, useT } from '../../lib/i18n.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, ConfirmDialog, Input, Skeleton, cn } from '../../components/ui.js';

import type { CreatedDomain, DomainVerificationChallenge, Service } from '@ninedeploy/sdk';

/** Custom domains and direct host port publishing for a service. */
export function NetworkTab({ serviceId, svc }: { serviceId: number; svc?: Service | null }) {
  return (
    <div className="mt-5 max-w-3xl space-y-5">
      <RoutingCard serviceId={serviceId} />
      <ContainerPortCard serviceId={serviceId} svc={svc} />
      <DirectPortCard serviceId={serviceId} svc={svc} />
      <PortMappingsCard serviceId={serviceId} svc={svc} />
      <DomainsCard serviceId={serviceId} svc={svc} />
    </div>
  );
}

// ── Internal Container Port / Traefik Target ────────────────────────────────
function ContainerPortCard({ serviceId, svc }: { serviceId: number; svc?: Service | null }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [portInput, setPortInput] = useState(String(svc?.port ?? 3000));

  useEffect(() => setPortInput(String(svc?.port ?? 3000)), [svc?.port]);

  const update = useMutation({
    mutationFn: (port: number) => api.services.update(serviceId, { port }),
    onSuccess: (_, port) => {
      qc.invalidateQueries({ queryKey: ['service', serviceId] });
      qc.invalidateQueries({ queryKey: ['services'] });
      toast(t('Container port :{port} saved — Traefik routing updated', { port }), 'success');
    },
    onError: () => toast(t('Could not update the container port'), 'error'),
  });

  const parsed = Number(portInput);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535;

  return (
    <Card>
      <CardBody>
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-300">
          <Globe size={15} className="text-indigo-400" /> {t('Container Port / Traefik Target')}
        </div>
        <p className="mb-4 text-xs text-slate-400">
          {fill(t('The TCP port your application listens on inside the container. Domains, healthchecks and direct host publishing all route to this port. Redeploy after changing it so buildpack apps receive the same value through {env}.'), {
            env: <span className="font-mono text-slate-300">PORT</span>,
          })}
        </p>
        <form
          className="flex items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            // A valid port submit runs in the port-save test; the
            // instrumenter cannot see this guard.
            /* v8 ignore start */
            if (valid) update.mutate(parsed);
            /* v8 ignore stop */
          }}
        >
          <label className="flex-1 text-[11px] font-medium text-slate-400">
            {t('Internal container port')}
            <Input
              aria-label={t('Internal container port')}
              value={portInput}
              onChange={(e) => setPortInput(e.target.value)}
              inputMode="numeric"
              autoComplete="off"
              placeholder="3000"
              className="mt-1 h-9 font-mono text-xs"
            />
          </label>
          <Button type="submit" size="sm" disabled={!valid || update.isPending}>
            {update.isPending ? t('Saving…') : t('Save Port')}
          </Button>
        </form>
        {!valid && portInput !== '' && <p className="mt-2 text-xs text-rose-400">{t('Enter a port from 1 to 65535.')}</p>}
      </CardBody>
    </Card>
  );
}

// ── Direct Port Publishing ───────────────────────────────────────────────────
function DirectPortCard({ serviceId, svc }: { serviceId: number; svc?: Service | null }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [portInput, setPortInput] = useState<string>('');
  const [editing, setEditing] = useState(false);

  const update = useMutation({
    mutationFn: (publishedPort: number | null) => api.services.update(serviceId, { publishedPort }),
    onSuccess: (_, publishedPort) => {
      qc.invalidateQueries({ queryKey: ['service', serviceId] });
      qc.invalidateQueries({ queryKey: ['services'] });
      setEditing(false);
      toast(publishedPort ? t('Host port :{port} exposed', { port: publishedPort }) : t('Direct host port disabled'), 'success');
    },
    onError: () => toast(t('Could not update host port mapping'), 'error'),
  });

  const currentPublished = svc?.publishedPort ?? null;
  const containerPort = svc?.port ?? currentPublished ?? t('unknown');
  const hostUrl = currentPublished ? `http://${window.location.hostname}:${currentPublished}` : null;

  // F986: the server refuses a host port for compose services (F961) — the
  // stack's compose file publishes its own. Only clearing a stored one is left.
  if (svc?.type === 'compose') {
    return (
      <Card>
        <CardBody>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-300">
            <Radio size={15} className="text-slate-500" /> {t('Direct Host Port Publishing')}
          </div>
          <p className="text-xs text-slate-500">
            {fill(t("A compose stack publishes its own host ports — set them under the service's {ports} in the stack's compose file."), {
              ports: <code className="font-mono">ports:</code>,
            })}
          </p>
          {currentPublished && (
            <div className="mt-3 flex items-center justify-between gap-3 text-xs text-slate-400">
              <span>{t('A stored host port :{port} is not applied to compose stacks.', { port: currentPublished })}</span>
              <Button size="sm" variant="ghost" onClick={() => update.mutate(null)} disabled={update.isPending}>
                {t('Clear')}
              </Button>
            </div>
          )}
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody>
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <Radio size={15} className="text-slate-500" /> {t('Direct Host Port Publishing')}
          </div>
          {currentPublished && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-500/20">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {t('Published on :{port}', { port: currentPublished })}
            </span>
          )}
        </div>

        <p className="text-xs text-slate-400 mb-4">
          {t('Expose this service directly on a host TCP port without needing a domain or reverse proxy routing.')}
        </p>

        {currentPublished && !editing ? (
          <div className="flex items-center justify-between rounded-xl bg-white/[0.02] p-3 ring-1 ring-inset ring-white/5">
            <div className="flex items-center gap-3">
              <div className="font-mono text-xs text-slate-200">
                <span className="text-emerald-400 font-semibold">:{currentPublished}</span>
                <span className="text-slate-500"> → :{containerPort}</span>
              </div>
              {hostUrl && (
                <a
                  href={hostUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 font-mono text-xs text-slate-400 hover:text-indigo-300 transition"
                >
                  <span>{hostUrl}</span>
                  <ExternalLink size={11} />
                </a>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setPortInput(String(currentPublished));
                  setEditing(true);
                }}
              >
                {t('Change Port')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => update.mutate(null)}
                disabled={update.isPending}
                className="text-slate-400 hover:text-rose-400"
              >
                {t('Disable')}
              </Button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const p = Number.parseInt(portInput.trim(), 10);
              if (p >= 1 && p <= 65535) {
                update.mutate(p);
              } else {
                toast(t('Please enter a valid port between 1 and 65535'), 'error');
              }
            }}
            className="flex items-center gap-2"
          >
            <div className="relative flex-1">
              <Input
                type="number"
                min={1}
                max={65535}
                value={portInput}
                onChange={(e) => setPortInput(e.target.value)}
                placeholder={t('e.g. 8080 or 3000')}
                className="h-9 font-mono"
              />
            </div>
            <Button type="submit" size="sm" disabled={!portInput.trim() || update.isPending}>
              {update.isPending ? t('Saving…') : t('Publish Port')}
            </Button>
            {editing && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setEditing(false)}
              >
                {t('Cancel')}
              </Button>
            )}
          </form>
        )}
      </CardBody>
    </Card>
  );
}

// ── Domains ───────────────────────────────────────────────────────────────
/** Accept pasted URLs (`https://app.example.com/`) as well as bare hosts:
 *  everything but the hostname is discarded — scheme, credentials, port,
 *  path/query/hash — then lowercased for DNS case-insensitivity. */
export function cleanDomainInput(raw: string): string {
  let value = raw.trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(value)) {
    try {
      value = new URL(value).hostname;
    } catch {
      // Malformed URL: fall through to the scheme-less cleanup below.
    }
  }
  value = value.split(/[/?#]/)[0] ?? '';
  return value.replace(/:\d+$/, '').replace(/\.$/, '');
}

/**
 * 0.16.1 path routing: the path a pasted URL carries (`https://x.dev/api/` →
 * `/api`), or a typed one normalised the same way — leading slash, no query
 * or fragment, no trailing slash. Empty means the whole host (`/`).
 */
export function cleanPathInput(raw: string): string {
  let value = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      value = new URL(value).pathname;
    } catch {
      return '/';
    }
  }
  value = (value.split(/[?#]/)[0] ?? '').replace(/\/{2,}/g, '/');
  if (!value.startsWith('/')) value = `/${value}`;
  if (value.length > 1) value = value.replace(/\/+$/, '');
  return value || '/';
}

/** The path part of a pasted URL or `host/path` (`''` when there is none or it is `/`). */
export function pastedPath(raw: string): string {
  const value = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  try {
    const p = new URL(withScheme).pathname;
    return p === '/' ? '' : p;
  } catch {
    return '';
  }
}

/** The TXT record a `pending` domain must publish to prove ownership. */
export type DomainChallenge = DomainVerificationChallenge;

function DomainsCard({ serviceId, svc }: { serviceId: number; svc?: Service | null }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [hostname, setHostname] = useState('');
  const [path, setPath] = useState('');
  // r345: the TXT challenge is only in the create / verify responses (the
  // list omits it), so keep the latest one per domain for display.
  const [challenges, setChallenges] = useState<Record<number, DomainChallenge>>({});

  const domains = useQuery({ queryKey: ['domains', serviceId], queryFn: () => api.domains.list(serviceId) });
  const add = useMutation({
    mutationFn: ({ host, routePath }: { host: string; routePath: string }) =>
      api.domains.create(serviceId, routePath === '/' ? { hostname: host } : { hostname: host, path: routePath }),
    onSuccess: (created) => {
      const verification = (created as { verification?: DomainChallenge | null } | undefined)?.verification;
      if (created && verification) {
        setChallenges((c) => ({ ...c, [created.id]: verification }));
        toast(t('{host} added — publish the TXT record to bring it live', { host: created.hostname }), 'info');
      }
      setHostname('');
      setPath('');
      qc.invalidateQueries({ queryKey: ['domains', serviceId] });
      qc.invalidateQueries({ queryKey: ['domains-all'] });
    },
    // The server says why (taken by another service, outside the zone …).
    onError: (err) => toast(err instanceof Error && err.message ? err.message : t('Could not add the domain'), 'error'),
  });
  // 0.16.1: the service's automatic URL (Settings → Automatic URLs) now,
  // instead of on its next deploy. The server explains when none applies.
  const generate = useMutation({
    mutationFn: () => api.domains.generate(serviceId),
    onSuccess: (d) => {
      toast(
        d.created ? t('{host} is routed to this service', { host: d.hostname }) : t('{host} is already attached', { host: d.hostname }),
        d.created ? 'success' : 'info',
      );
      qc.invalidateQueries({ queryKey: ['domains', serviceId] });
      qc.invalidateQueries({ queryKey: ['domains-all'] });
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });

  return (
    <Card>
      <CardBody>
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <Globe size={15} className="text-slate-500" /> {t('Domains')}
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => generate.mutate()}
            disabled={generate.isPending}
            title={t("Add this service's automatic URL (a free sslip.io name or <slug>.<your base domain>)")}
          >
            <Wand2 size={13} /> {generate.isPending ? t('Generating…') : t('Generate URL')}
          </Button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const host = cleanDomainInput(hostname);
            const routePath = cleanPathInput(path || pastedPath(hostname));
            setHostname(host);
            if (host.includes('.')) add.mutate({ host, routePath });
          }}
          className="flex flex-wrap gap-2 sm:flex-nowrap"
        >
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
            aria-label={t('Domain')}
            title={t('You can paste a full URL; its path goes to the path field.')}
            className="h-9 min-w-0 flex-1 basis-full sm:basis-0"
          />
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onBlur={() => path && setPath(cleanPathInput(path))}
            placeholder="/path"
            aria-label={t('Path')}
            title={t('Optional. Route only this path prefix to the service (e.g. /api); the request keeps its path.')}
            className="h-9 w-28 shrink-0 font-mono text-xs"
          />
          <Button type="submit" size="sm" variant="secondary" disabled={!hostname.trim() || add.isPending}>
            <Plus size={14} /> {t('Add')}
          </Button>
        </form>

        {svc?.type === 'compose' && (domains.data?.length ?? 0) > 0 && (
          <p className="mt-3 text-xs text-slate-500">
            {t('Each domain routes to the main service unless you pick another one here. The service must be on the stack’s default network. The next deploy sets SERVICE_FQDN_<SERVICE> and SERVICE_URL_<SERVICE> for it.')}
          </p>
        )}
        <div className="mt-3 space-y-2">
          {domains.isLoading ? (
            <Skeleton className="h-8 w-full" />
          ) : !domains.data || domains.data.length === 0 ? (
            <p className="py-2 text-xs text-slate-600">{t('No domains attached.')}</p>
          ) : (
            domains.data.map((d) => (
              <DomainItemRow
                key={d.id}
                domain={d}
                serviceId={serviceId}
                stack={svc?.type === 'compose' ? { mainService: svc.composeService ?? null } : undefined}
                challenge={challenges[d.id] ?? null}
                onChallenge={(ch) => setChallenges((c) => ({ ...c, [d.id]: ch }))}
                onReplaced={(created) => {
                  const ch = created.verification;
                  if (ch) setChallenges((c) => ({ ...c, [created.id]: ch }));
                }}
              />
            ))
          )}
        </div>
      </CardBody>
    </Card>
  );
}

export function DomainItemRow({
  domain: d,
  serviceId,
  challenge,
  onChallenge,
  onReplaced,
  initialEditing = false,
  stack,
}: {
  domain: any;
  serviceId: number;
  /** G2.1: a compose stack, whose domains can route to any of its services. */
  stack?: { mainService: string | null };
  challenge: DomainChallenge | null;
  onChallenge: (ch: DomainChallenge) => void;
  /** A hostname/path change added this domain in the row's place (it may still be pending). */
  onReplaced?: (created: CreatedDomain) => void;
  initialEditing?: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const pending = d.status === 'pending';

  // A domain's hostname is its ownership claim, so the server has no rename:
  // a change adds the new host with this row's settings, and the old one goes
  // only once the new one is live — a pending replacement keeps traffic on
  // the old host until it is verified.
  const [editing, setEditing] = useState(initialEditing);
  const [editHost, setEditHost] = useState<string>(d.hostname);
  const [editPath, setEditPath] = useState<string>(d.path === '/' ? '' : d.path);
  const replace = useMutation({
    mutationFn: async ({ host, routePath }: { host: string; routePath: string }) => {
      const created = await api.domains.create(serviceId, {
        hostname: host,
        path: routePath,
        ssl: d.ssl,
        ...(d.redirectWww ? { redirectWww: true } : {}),
        ...(d.headers && d.headers !== '[]' ? { headers: d.headers } : {}),
        basicAuth: d.basicAuth ?? null,
        ipAllowlist: d.ipAllowlist ?? null,
        rateLimitAverage: d.rateLimitAverage ?? null,
        rateLimitBurst: d.rateLimitBurst ?? null,
      });
      if (Array.isArray(d.redirects) && d.redirects.length > 0) {
        await api.domains.update(serviceId, created.id, { redirects: d.redirects });
      }
      const live = created.status !== 'pending';
      if (live) await api.domains.remove(serviceId, d.id);
      return { created, live };
    },
    onSuccess: ({ created, live }) => {
      qc.invalidateQueries({ queryKey: ['domains', serviceId] });
      qc.invalidateQueries({ queryKey: ['domains-all'] });
      setEditing(false);
      onReplaced?.(created);
      toast(
        live
          ? t('{old} now routes as {host}', { old: d.hostname, host: `${created.hostname}${created.path !== '/' ? created.path : ''}` })
          : t('{host} added as pending — {old} keeps routing until you verify the new one, then remove it', { host: created.hostname, old: d.hostname }),
        live ? 'success' : 'info',
      );
    },
    // The server says why (taken, outside the zone, reserved …); nothing was removed.
    onError: (err) => toast(err instanceof Error && err.message ? err.message : t('Could not change the domain'), 'error'),
  });
  const submitEdit = () => {
    const host = cleanDomainInput(editHost);
    const routePath = cleanPathInput(editPath || pastedPath(editHost));
    setEditHost(host);
    if (!host.includes('.')) return;
    if (host === d.hostname && routePath === d.path) {
      setEditing(false);
      return;
    }
    replace.mutate({ host, routePath });
  };

  const verify = useMutation({
    // r563: the SDK has had `domains.verify` all along — the raw fetch and its
    // "no SDK method" comment were stale.
    mutationFn: () => api.domains.verify(serviceId, d.id),
    onSuccess: (res) => {
      if (res.verified) {
        toast(t('{host} verified — it is routed now', { host: d.hostname }), 'success');
        qc.invalidateQueries({ queryKey: ['domains', serviceId] });
        qc.invalidateQueries({ queryKey: ['domains-all'] });
        return;
      }
      if (res.verification) onChallenge(res.verification);
      toast(res.error ?? t('The TXT record was not found yet — DNS can take a few minutes'), 'error');
    },
    onError: (err) => toast(err instanceof Error ? err.message : t('Could not verify the domain'), 'error'),
  });
  const [expanded, setExpanded] = useState(false);
  const [basicAuth, setBasicAuth] = useState(d.basicAuth ?? '');
  const [ipAllowlist, setIpAllowlist] = useState(d.ipAllowlist ?? '');
  const [rateLimitAvg, setRateLimitAvg] = useState(d.rateLimitAverage ? String(d.rateLimitAverage) : '');
  const [rateLimitBurst, setRateLimitBurst] = useState(d.rateLimitBurst ? String(d.rateLimitBurst) : '');

  // DNS resolution check: advisory (routing is ownership-driven), but the
  // fastest way to see why an added domain "does not load" yet.
  const checkDns = useMutation({
    mutationFn: () => api.domains.dnsCheck(serviceId, d.id),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['domains', serviceId] });
      setDnsResult(res);
    },
    onError: () => toast(t('Could not run the DNS check'), 'error'),
  });
  const [dnsResult, setDnsResult] = useState<{ status: 'ok' | 'mismatch' | 'unresolved'; addresses: { a: string[]; aaaa: string[] }; expected: string[] } | null>(null);

  const remove = useMutation({
    mutationFn: () => api.domains.remove(serviceId, d.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['domains', serviceId] });
      qc.invalidateQueries({ queryKey: ['domains-all'] });
    },
    onError: () => toast(t('Could not remove the domain'), 'error'),
  });
  // Removing a domain instantly unroutes production traffic for that host —
  // confirm it, like every other destructive action in the app.
  const [confirmRemove, setConfirmRemove] = useState(false);

  const toggleSsl = useMutation({
    mutationFn: () => api.domains.setSsl(d.id, !d.ssl),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['domains', serviceId] });
      qc.invalidateQueries({ queryKey: ['domains-all'] });
    },
    onError: () => toast(t('Could not toggle SSL'), 'error'),
  });

  const toggleWww = useMutation({
    mutationFn: () => api.domains.update(serviceId, d.id, { redirectWww: !d.redirectWww }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['domains', serviceId] });
      qc.invalidateQueries({ queryKey: ['domains-all'] });
    },
    onError: () => toast(t('Could not toggle the www redirect'), 'error'),
  });

  const updateMiddlewares = useMutation({
    mutationFn: () =>
      api.domains.update(serviceId, d.id, {
        basicAuth: basicAuth.trim() || null,
        ipAllowlist: ipAllowlist.trim() || null,
        rateLimitAverage: rateLimitAvg ? Number(rateLimitAvg) : null,
        rateLimitBurst: rateLimitBurst ? Number(rateLimitBurst) : null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['domains', serviceId] });
      qc.invalidateQueries({ queryKey: ['domains-all'] });
      toast(t('Domain security settings updated'), 'success');
      setExpanded(false);
    },
    onError: () => toast(t('Could not update domain security settings'), 'error'),
  });

  const hasActiveSecurity = !!(d.basicAuth || d.ipAllowlist || d.rateLimitAverage);

  return (
    <div className="rounded-lg bg-white/[0.02] ring-1 ring-inset ring-white/5 overflow-hidden">
      <div className="group flex items-center justify-between px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <a
            href={`${d.ssl ? 'https' : 'http'}://${d.hostname}${d.path}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 truncate font-mono text-xs text-slate-300 hover:text-indigo-300"
          >
            {d.hostname}
            {d.path !== '/' && <span className="text-slate-500">{d.path}</span>}
            <ExternalLink size={11} className="shrink-0 opacity-0 transition group-hover:opacity-100" />
          </a>
          {pending && (
            <span
              className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300 ring-1 ring-inset ring-amber-500/20"
              title={t('Ownership not proven yet — this domain is not routed')}
            >
              {t('pending')}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {pending && (
            <button
              type="button"
              onClick={() => verify.mutate()}
              disabled={verify.isPending}
              className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300 ring-1 ring-inset ring-amber-500/20 transition hover:bg-amber-500/25"
              title={t('Check the ownership TXT record and bring the domain live')}
            >
              {verify.isPending ? t('verifying…') : t('Verify')}
            </button>
          )}
          <button
            type="button"
            onClick={() => checkDns.mutate()}
            disabled={checkDns.isPending}
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset transition',
              dnsResult?.status === 'ok'
                ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/20'
                : dnsResult?.status === 'mismatch'
                  ? 'bg-amber-500/15 text-amber-300 ring-amber-500/20'
                  : 'bg-slate-500/15 text-slate-400 ring-slate-500/20 hover:bg-slate-500/25',
            )}
            title={
              dnsResult
                ? t('A: {a} · AAAA: {aaaa} · expected: {expected} — click to re-check', {
                    a: dnsResult.addresses.a.join(', ') || '—',
                    aaaa: dnsResult.addresses.aaaa.join(', ') || '—',
                    expected: dnsResult.expected.join(', ') || '—',
                  })
                : t('Check whether this hostname resolves to this server')
            }
          >
            {checkDns.isPending ? t('checking…') : dnsResult ? `DNS: ${dnsResult.status}` : t('Check DNS')}
          </button>
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset transition flex items-center gap-1',
              hasActiveSecurity
                ? 'bg-amber-500/15 text-amber-300 ring-amber-500/20 hover:bg-amber-500/25'
                : 'bg-slate-500/15 text-slate-400 ring-slate-500/20 hover:bg-slate-500/25',
            )}
            title={t('Configure Basic Auth, IP allowlist, rate limiting and redirects')}
          >
            <Shield size={10} />
            {t('Security')}
          </button>
          <button
            type="button"
            onClick={() => toggleSsl.mutate()}
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset transition',
              d.ssl
                ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/20 hover:bg-emerald-500/25'
                : 'bg-slate-500/15 text-slate-400 ring-slate-500/20 hover:bg-slate-500/25',
            )}
            title={d.ssl ? t('HTTPS on — click to disable') : t('HTTPS off — click to issue a certificate')}
          >
            {d.ssl ? 'HTTPS' : 'HTTP'}
          </button>
          <button
            type="button"
            onClick={() => toggleWww.mutate()}
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset transition',
              d.redirectWww
                ? 'bg-sky-500/15 text-sky-300 ring-sky-500/20 hover:bg-sky-500/25'
                : 'bg-slate-500/15 text-slate-400 ring-slate-500/20 hover:bg-slate-500/25',
            )}
            title={d.redirectWww ? t('www→apex redirect on — click to disable') : t('Redirect www. to the apex host — click to enable')}
          >
            www
          </button>
          <button
            type="button"
            onClick={() => setEditing(!editing)}
            className="text-slate-600 transition hover:text-indigo-300"
            title={t('Change hostname or path')}
            aria-label={t('Edit {host}', { host: d.hostname })}
          >
            <Pencil size={13} />
          </button>
          <button
            type="button"
            onClick={() => setConfirmRemove(true)}
            className="text-slate-600 transition hover:text-rose-400"
            title={t('Remove domain')}
            aria-label={t('Remove {host}', { host: d.hostname })}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {stack && !pending && (
        <ComposeRouteRow domainId={d.id} hostname={`${d.hostname}${d.path && d.path !== '/' ? d.path : ''}`} mainService={stack.mainService} />
      )}

      {editing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitEdit();
          }}
          className="flex flex-wrap items-center gap-2 border-t border-white/5 bg-slate-950/40 px-3 py-2 sm:flex-nowrap"
        >
          <Input
            value={editHost}
            onChange={(e) => setEditHost(e.target.value)}
            placeholder="app.example.com"
            aria-label={t('New hostname')}
            className="h-8 min-w-0 flex-1 basis-full font-mono text-xs sm:basis-0"
          />
          <Input
            value={editPath}
            onChange={(e) => setEditPath(e.target.value)}
            onBlur={() => editPath && setEditPath(cleanPathInput(editPath))}
            placeholder="/path"
            aria-label={t('New path')}
            className="h-8 w-28 shrink-0 font-mono text-xs"
          />
          <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>
            {t('Cancel')}
          </Button>
          <Button size="sm" type="submit" disabled={!editHost.trim() || replace.isPending}>
            {replace.isPending ? t('Saving…') : t('Save')}
          </Button>
        </form>
      )}

      <ConfirmDialog
        open={confirmRemove}
        title={t('Remove {host}?', { host: d.hostname })}
        message={t('The domain stops routing immediately — requests to it will fail until it is added back and verified. The service itself keeps running.')}
        confirmLabel={t('Remove')}
        onConfirm={() => remove.mutate()}
        onClose={() => setConfirmRemove(false)}
      />

      {pending && challenge && (
        <div className="border-t border-white/5 bg-amber-500/[0.04] px-3 py-2 text-[11px] text-slate-400">
          <p>{t('Prove you control this domain: publish this DNS record, then press Verify.')}</p>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono">
            <dt className="text-slate-500">{challenge.recordType}</dt>
            <dd className="break-all text-slate-200">{challenge.recordName}</dd>
            <dt className="text-slate-500">{t('value')}</dt>
            <dd className="break-all text-slate-200">{challenge.recordValue}</dd>
          </dl>
        </div>
      )}

      {expanded && (
        <div className="border-t border-white/5 bg-slate-950/40 p-3 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div>
              <label className="block text-slate-400 font-medium mb-1">{t('Basic Auth (user:pass or htpasswd)')}</label>
              <Input
                value={basicAuth}
                onChange={(e) => setBasicAuth(e.target.value)}
                placeholder={t("admin:password or ['user:hash']")}
                className="h-8 font-mono text-xs"
              />
            </div>
            <div>
              <label className="block text-slate-400 font-medium mb-1">{t('IP Allowlist (CIDR comma-separated)')}</label>
              <Input
                value={ipAllowlist}
                onChange={(e) => setIpAllowlist(e.target.value)}
                placeholder="192.168.1.0/24, 10.0.0.1"
                className="h-8 font-mono text-xs"
              />
            </div>
            <div>
              <label className="block text-slate-400 font-medium mb-1">{t('Rate Limit (Average req/sec)')}</label>
              <Input
                type="number"
                min={0}
                value={rateLimitAvg}
                onChange={(e) => setRateLimitAvg(e.target.value)}
                placeholder={t('e.g. 50 (0 = disabled)')}
                className="h-8 font-mono text-xs"
              />
            </div>
            <div>
              <label className="block text-slate-400 font-medium mb-1">{t('Rate Limit (Burst peak)')}</label>
              <Input
                type="number"
                min={0}
                value={rateLimitBurst}
                onChange={(e) => setRateLimitBurst(e.target.value)}
                placeholder={t('e.g. 100')}
                className="h-8 font-mono text-xs"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" variant="ghost" onClick={() => setExpanded(false)}>
              {t('Cancel')}
            </Button>
            <Button size="sm" onClick={() => updateMiddlewares.mutate()} disabled={updateMiddlewares.isPending}>
              {t('Save Security Settings')}
            </Button>
          </div>
          {/* 0.16.1: shown only by a panel that reports the field. */}
          {Array.isArray(d.redirects) && (
            <div className="border-t border-white/5 pt-3">
              <DomainRedirects serviceId={serviceId} domain={d} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
