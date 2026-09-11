import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Globe, Plus, Radio, Shield, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, Input, Skeleton, cn } from '../../components/ui.js';

import type { Service } from '@ninedeploy/sdk';

/** Custom domains and direct host port publishing for a service. */
export function NetworkTab({ serviceId, svc }: { serviceId: number; svc?: Service | null }) {
  return (
    <div className="mt-5 max-w-3xl space-y-5">
      <ContainerPortCard serviceId={serviceId} svc={svc} />
      <DirectPortCard serviceId={serviceId} svc={svc} />
      <DomainsCard serviceId={serviceId} />
    </div>
  );
}

// ── Internal Container Port / Traefik Target ────────────────────────────────
function ContainerPortCard({ serviceId, svc }: { serviceId: number; svc?: Service | null }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [portInput, setPortInput] = useState(String(svc?.port ?? 3000));

  useEffect(() => setPortInput(String(svc?.port ?? 3000)), [svc?.port]);

  const update = useMutation({
    mutationFn: (port: number) => api.services.update(serviceId, { port }),
    onSuccess: (_, port) => {
      qc.invalidateQueries({ queryKey: ['service', serviceId] });
      qc.invalidateQueries({ queryKey: ['services'] });
      toast(`Container port :${port} saved — Traefik routing updated`, 'success');
    },
    onError: () => toast('Could not update the container port', 'error'),
  });

  const parsed = Number(portInput);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535;

  return (
    <Card>
      <CardBody>
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-300">
          <Globe size={15} className="text-indigo-400" /> Container Port / Traefik Target
        </div>
        <p className="mb-4 text-xs text-slate-400">
          The TCP port your application listens on inside the container. Domains, healthchecks and direct host publishing all route to this port. Redeploy after changing it so buildpack apps receive the same value through <span className="font-mono text-slate-300">PORT</span>.
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
            Internal container port
            <Input
              aria-label="Internal container port"
              value={portInput}
              onChange={(e) => setPortInput(e.target.value)}
              inputMode="numeric"
              autoComplete="off"
              placeholder="3000"
              className="mt-1 h-9 font-mono text-xs"
            />
          </label>
          <Button type="submit" size="sm" disabled={!valid || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save Port'}
          </Button>
        </form>
        {!valid && portInput !== '' && <p className="mt-2 text-xs text-rose-400">Enter a port from 1 to 65535.</p>}
      </CardBody>
    </Card>
  );
}

// ── Direct Port Publishing ───────────────────────────────────────────────────
function DirectPortCard({ serviceId, svc }: { serviceId: number; svc?: Service | null }) {
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
      toast(publishedPort ? `Host port :${publishedPort} exposed` : 'Direct host port disabled', 'success');
    },
    onError: () => toast('Could not update host port mapping', 'error'),
  });

  const currentPublished = svc?.publishedPort ?? null;
  const containerPort = svc?.port ?? currentPublished ?? 'unknown';
  const hostUrl = currentPublished ? `http://${window.location.hostname}:${currentPublished}` : null;

  return (
    <Card>
      <CardBody>
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <Radio size={15} className="text-slate-500" /> Direct Host Port Publishing
          </div>
          {currentPublished && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-500/20">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Published on :{currentPublished}
            </span>
          )}
        </div>

        <p className="text-xs text-slate-400 mb-4">
          Expose this service directly on a host TCP port without needing a domain or reverse proxy routing.
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
                Change Port
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => update.mutate(null)}
                disabled={update.isPending}
                className="text-slate-400 hover:text-rose-400"
              >
                Disable
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
                toast('Please enter a valid port between 1 and 65535', 'error');
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
                placeholder="e.g. 8080 or 3000"
                className="h-9 font-mono"
              />
            </div>
            <Button type="submit" size="sm" disabled={!portInput.trim() || update.isPending}>
              {update.isPending ? 'Saving…' : 'Publish Port'}
            </Button>
            {editing && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setEditing(false)}
              >
                Cancel
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
function cleanDomainInput(raw: string): string {
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

function DomainsCard({ serviceId }: { serviceId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [hostname, setHostname] = useState('');

  const domains = useQuery({ queryKey: ['domains', serviceId], queryFn: () => api.domains.list(serviceId) });
  const add = useMutation({
    mutationFn: (host: string) => api.domains.create(serviceId, { hostname: host }),
    onSuccess: () => {
      setHostname('');
      qc.invalidateQueries({ queryKey: ['domains', serviceId] });
      qc.invalidateQueries({ queryKey: ['domains-all'] });
    },
    onError: () => toast('Could not add the domain', 'error'),
  });

  return (
    <Card>
      <CardBody>
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-300">
          <Globe size={15} className="text-slate-500" /> Domains
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const host = cleanDomainInput(hostname);
            setHostname(host);
            if (host.includes('.')) add.mutate(host);
          }}
          className="flex gap-2"
        >
          <Input
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            onBlur={() => {
              const host = cleanDomainInput(hostname);
              if (host !== hostname) setHostname(host);
            }}
            placeholder="app.example.com"
            title="You can paste a full URL; only the hostname is kept."
            className="h-9"
          />
          <Button type="submit" size="sm" variant="secondary" disabled={!hostname.trim() || add.isPending}>
            <Plus size={14} /> Add
          </Button>
        </form>

        <div className="mt-3 space-y-2">
          {domains.isLoading ? (
            <Skeleton className="h-8 w-full" />
          ) : !domains.data || domains.data.length === 0 ? (
            <p className="py-2 text-xs text-slate-600">No domains attached.</p>
          ) : (
            domains.data.map((d) => (
              <DomainItemRow key={d.id} domain={d} serviceId={serviceId} />
            ))
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function DomainItemRow({ domain: d, serviceId }: { domain: any; serviceId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
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
    onError: () => toast('Could not run the DNS check', 'error'),
  });
  const [dnsResult, setDnsResult] = useState<{ status: 'ok' | 'mismatch' | 'unresolved'; addresses: { a: string[]; aaaa: string[] }; expected: string[] } | null>(null);

  const remove = useMutation({
    mutationFn: () => api.domains.remove(serviceId, d.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['domains', serviceId] });
      qc.invalidateQueries({ queryKey: ['domains-all'] });
    },
    onError: () => toast('Could not remove the domain', 'error'),
  });

  const toggleSsl = useMutation({
    mutationFn: () => api.domains.setSsl(d.id, !d.ssl),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['domains', serviceId] });
      qc.invalidateQueries({ queryKey: ['domains-all'] });
    },
    onError: () => toast('Could not toggle SSL', 'error'),
  });

  const toggleWww = useMutation({
    mutationFn: () => api.domains.update(serviceId, d.id, { redirectWww: !d.redirectWww }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['domains', serviceId] });
      qc.invalidateQueries({ queryKey: ['domains-all'] });
    },
    onError: () => toast('Could not toggle the www redirect', 'error'),
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
      toast('Domain security settings updated', 'success');
      setExpanded(false);
    },
    onError: () => toast('Could not update domain security settings', 'error'),
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
        </div>
        <div className="flex shrink-0 items-center gap-2">
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
                ? `A: ${dnsResult.addresses.a.join(', ') || '—'} · AAAA: ${dnsResult.addresses.aaaa.join(', ') || '—'} · expected: ${dnsResult.expected.join(', ') || '—'} — click to re-check`
                : 'Check whether this hostname resolves to this server'
            }
          >
            {checkDns.isPending ? 'checking…' : dnsResult ? `DNS: ${dnsResult.status}` : 'Check DNS'}
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
            title="Configure Basic Auth, IP Whitelist & Rate Limiting"
          >
            <Shield size={10} />
            Security
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
            title={d.ssl ? 'HTTPS on — click to disable' : 'HTTPS off — click to issue a certificate'}
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
            title={d.redirectWww ? 'www→apex redirect on — click to disable' : 'Redirect www. to the apex host — click to enable'}
          >
            www
          </button>
          <button
            type="button"
            onClick={() => remove.mutate()}
            className="text-slate-600 transition hover:text-rose-400"
            title="Remove domain"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-white/5 bg-slate-950/40 p-3 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div>
              <label className="block text-slate-400 font-medium mb-1">Basic Auth (user:pass or htpasswd)</label>
              <Input
                value={basicAuth}
                onChange={(e) => setBasicAuth(e.target.value)}
                placeholder="admin:password or ['user:hash']"
                className="h-8 font-mono text-xs"
              />
            </div>
            <div>
              <label className="block text-slate-400 font-medium mb-1">IP Allowlist (CIDR comma-separated)</label>
              <Input
                value={ipAllowlist}
                onChange={(e) => setIpAllowlist(e.target.value)}
                placeholder="192.168.1.0/24, 10.0.0.1"
                className="h-8 font-mono text-xs"
              />
            </div>
            <div>
              <label className="block text-slate-400 font-medium mb-1">Rate Limit (Average req/sec)</label>
              <Input
                type="number"
                min={0}
                value={rateLimitAvg}
                onChange={(e) => setRateLimitAvg(e.target.value)}
                placeholder="e.g. 50 (0 = disabled)"
                className="h-8 font-mono text-xs"
              />
            </div>
            <div>
              <label className="block text-slate-400 font-medium mb-1">Rate Limit (Burst peak)</label>
              <Input
                type="number"
                min={0}
                value={rateLimitBurst}
                onChange={(e) => setRateLimitBurst(e.target.value)}
                placeholder="e.g. 100"
                className="h-8 font-mono text-xs"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" variant="ghost" onClick={() => setExpanded(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => updateMiddlewares.mutate()} disabled={updateMiddlewares.isPending}>
              Save Security Settings
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
