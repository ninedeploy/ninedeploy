import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Loader2, RefreshCw, Route } from 'lucide-react';
import type { RoutingHopVerdict, ServicePortRoute } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { Badge, Button, Card, CardBody, Skeleton } from '../../components/ui.js';

const TONE: Record<RoutingHopVerdict, 'emerald' | 'amber' | 'rose' | 'neutral'> = {
  ok: 'emerald',
  warn: 'amber',
  error: 'rose',
  unknown: 'neutral',
};

function hostSide(p: ServicePortRoute): string {
  const ip = p.hostIp ? (p.hostIp.includes(':') ? `[${p.hostIp}]` : p.hostIp) : '*';
  const ports = p.hostPortEnd ? `${p.hostPort}-${p.hostPortEnd}` : String(p.hostPort);
  return `${ip}:${ports}/${p.protocol}`;
}

function containerSide(p: ServicePortRoute): string {
  const end = p.hostPortEnd ? p.containerPort + (p.hostPortEnd - p.hostPort) : null;
  return `${end ? `${p.containerPort}-${end}` : p.containerPort}/${p.protocol}`;
}

const VIA: Record<ServicePortRoute['via'], string> = {
  docker: 'Docker DNAT',
  portproxy: 'allow-list proxy',
  direct: 'published port',
};

/**
 * Network → Live routing: where each domain and host port of the service
 * actually leads right now — the router Traefik was given and what Docker
 * bound — so a 502 or a dead SIP port points at the hop that is wrong.
 */
export function RoutingCard({ serviceId }: { serviceId: number }) {
  const view = useQuery({ queryKey: ['service-routing', serviceId], queryFn: () => api.services.routing(serviceId) });
  const data = view.data;

  return (
    <Card>
      <CardBody>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <Route size={15} className="text-indigo-400" /> Live routing
          </div>
          <Button variant="secondary" onClick={() => void view.refetch()} disabled={view.isFetching} aria-label="Refresh routing">
            {view.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
        <p className="mb-4 text-xs text-slate-400">
          Where traffic goes right now: each domain through the router Traefik was given, each host port through what Docker bound.
        </p>

        {view.isLoading && <Skeleton className="h-24" />}
        {view.isError && <p className="text-sm text-rose-300">Could not load the routing view.</p>}

        {data && (
          <div className="space-y-4">
            {data.liveNote && <p className="text-xs text-amber-300">{data.liveNote}</p>}
            {data.container && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <span>Container</span>
                <span className="font-mono text-slate-200">{data.container.name}</span>
                <Badge tone={data.container.state === 'running' ? 'emerald' : 'rose'}>{data.container.state}</Badge>
                {data.container.health && <Badge tone={data.container.health === 'healthy' ? 'emerald' : 'amber'}>{data.container.health}</Badge>}
                {data.container.ip && <span className="font-mono">{data.container.ip}</span>}
              </div>
            )}

            <section>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Domains (HTTP via Traefik)</h4>
              {data.http.length === 0 ? (
                <p className="text-xs text-slate-500">No domains.</p>
              ) : (
                <ul className="space-y-2">
                  {data.http.map((r) => (
                    <li key={r.domainId} className="rounded-lg border border-white/5 p-2 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={TONE[r.verdict]}>{r.verdict}</Badge>
                        <span className="font-mono text-slate-200">{r.ssl ? 'https' : 'http'}://{r.hostname}{r.path ?? ''}</span>
                        <ArrowRight size={12} className="text-slate-500" />
                        <span className="font-mono text-slate-400">{r.router ?? 'no router'}</span>
                        {r.upstreams.length > 0 && <ArrowRight size={12} className="text-slate-500" />}
                        {r.upstreams.map((u) => (
                          <span key={u} className="break-all font-mono text-slate-300">{u}</span>
                        ))}
                      </div>
                      {r.note && <p className="mt-1 text-slate-400">{r.note}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Host ports (TCP / UDP)</h4>
              {data.ports.length === 0 ? (
                <p className="text-xs text-slate-500">No host ports are published.</p>
              ) : (
                <ul className="space-y-2">
                  {data.ports.map((p, i) => (
                    <li key={`${hostSide(p)}-${i}`} className="rounded-lg border border-white/5 p-2 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={TONE[p.verdict]}>{p.verdict}</Badge>
                        <span className="font-mono text-slate-200">{hostSide(p)}</span>
                        <ArrowRight size={12} className="text-slate-500" />
                        <span className="text-slate-400">{VIA[p.via]}</span>
                        <ArrowRight size={12} className="text-slate-500" />
                        <span className="font-mono text-slate-300">container {containerSide(p)}</span>
                      </div>
                      {p.allowFrom && <p className="mt-1 text-slate-500">Allowed from {p.allowFrom.join(', ')}</p>}
                      {p.note && <p className="mt-1 text-slate-400">{p.note}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
