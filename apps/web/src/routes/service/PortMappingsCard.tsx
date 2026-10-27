import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Network, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatPortMapping, MAX_MAPPED_PORTS, MAX_PORT_MAPPINGS, mappedPortCount, type PortMapping, parsePortMapping, portMappingsProblem } from '@ninedeploy/schemas';
import type { Service } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { fill, translate, type Translate, useT } from '../../lib/i18n.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, Input, Select } from '../../components/ui.js';

export interface PortRow {
  ip: string;
  host: string;
  container: string;
  protocol: 'tcp' | 'udp';
  /** Comma-separated addresses or CIDR ranges; empty = anyone. TCP, one port. */
  allow?: string;
}

const toRow = (m: PortMapping): PortRow => ({
  ip: m.hostIp ?? '',
  host: m.hostPortEnd ? `${m.hostPort}-${m.hostPortEnd}` : String(m.hostPort),
  container: String(m.containerPort),
  protocol: m.protocol ?? 'tcp',
  allow: (m.allowFrom ?? []).join(', '),
});

/** Short label for a list of mappings: the first one's host side, and how many more (`27015-27030/udp +1`). */
export function portMappingLabel(list: readonly PortMapping[]): string {
  const [first, ...rest] = list;
  if (!first) return '';
  const host = first.hostPortEnd ? `${first.hostPort}-${first.hostPortEnd}` : String(first.hostPort);
  return `${first.hostIp ? `${first.hostIp.includes(':') ? `[${first.hostIp}]` : first.hostIp}:` : ':'}${host}/${first.protocol ?? 'tcp'}${rest.length > 0 ? ` +${rest.length}` : ''}`;
}

/** A row as a mapping, or why it is not one. An empty container port means the same ports inside. */
export function rowToMapping(r: PortRow, t: Translate = (text, vars) => translate('en', text, vars)): PortMapping | string {
  const ip = r.ip.trim();
  if (!r.host.trim()) return t('Enter a host port or range.');
  const prefix = ip ? (ip.includes(':') ? `[${ip}]:` : `${ip}:`) : '';
  const container = r.container.trim() ? `:${r.container.trim()}` : '';
  const allow = allowable(r) && r.allow?.trim() ? `@${r.allow.trim()}` : '';
  return parsePortMapping(`${prefix}${r.host.trim()}${container}/${r.protocol}${allow}`);
}

/** Whether a row can take an allow list: one TCP port. */
const allowable = (r: PortRow) => r.protocol === 'tcp' && !r.host.includes('-');

/**
 * 0.16.1 Network → Port mappings: extra host ports of a docker service, TCP
 * or UDP, single ports or ranges, on every address or one dedicated IP
 * (`docker run -p`). Applied by the next deploy, on the panel host or the
 * service's node (agent `docker.ports`).
 * Rendered only on a panel that reports `portMappings`.
 */
export function PortMappingsCard({ serviceId, svc }: { serviceId: number; svc?: Service | null }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const stored = svc?.portMappings;
  const [rows, setRows] = useState<PortRow[]>(() => (stored ?? []).map(toRow));
  useEffect(() => setRows((stored ?? []).map(toRow)), [stored]);

  const parsed = rows.map((r) => rowToMapping(r, t));
  const rowProblems = parsed.map((p) => (typeof p === 'string' ? p : null));
  const mappings = parsed.filter((p): p is PortMapping => typeof p !== 'string');
  const listProblem = rowProblems.some(Boolean) ? null : portMappingsProblem(mappings);
  const total = mappings.reduce((n, m) => n + mappedPortCount(m), 0);

  const onNode = svc?.serverId != null;
  const visible = !!svc && svc.type === 'docker' && stored !== undefined;
  // The host's own IPs, offered in the Host IP field (any address is still accepted).
  const hostIps = useQuery({
    queryKey: ['host-addresses', serviceId],
    queryFn: () => api.services.hostAddresses(serviceId),
    enabled: visible && !onNode,
    staleTime: 60_000,
  });
  // An address dedicated to another service is not offered; this service's own comes first.
  const addresses = (hostIps.data?.addresses ?? [])
    .filter((a) => a.dedicated !== 'other')
    .sort((a, b) => Number(b.dedicated === 'self') - Number(a.dedicated === 'self'));

  const runningCheck = useMutation({
    mutationFn: () => api.services.update(serviceId, { healthCheck: 'running' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['service', serviceId] });
      toast(t('Healthcheck set to "container running"'), 'success');
    },
    onError: (err: Error) => toast(err.message || t('Could not change the healthcheck'), 'error'),
  });

  const save = useMutation({
    mutationFn: () => api.services.update(serviceId, { portMappings: mappings.length > 0 ? mappings : null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['service', serviceId] });
      toast(mappings.length > 0 ? t('Port mappings saved — redeploy to publish them') : t('Port mappings removed — redeploy to unpublish them'), 'success');
    },
    onError: (err: Error) => toast(err.message || t('Could not save the port mappings'), 'error'),
  });

  if (!visible) return null;
  const udpOnly = mappings.length > 0 && mappings.every((m) => m.protocol === 'udp');
  const update = (i: number, patch: Partial<PortRow>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Card>
      <CardBody>
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <Network size={15} className="text-indigo-400" /> {t('Port Mappings (TCP / UDP)')}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={rows.length >= MAX_PORT_MAPPINGS}
            onClick={() => setRows((prev) => [...prev, { ip: '', host: '', container: '', protocol: 'udp' }])}
          >
            <Plus size={12} /> {t('Mapping')}
          </Button>
        </div>
        <p className="mb-3 text-xs text-slate-400">
          {fill(
            t(
              'Publish extra host ports straight to the container, outside Traefik: game servers, VoIP/RTP, DNS, VPNs. A range such as {range} maps onto the same number of container ports starting at the container port (empty = the same ports). A single TCP port can take an allow list: only those addresses get in, which a host firewall cannot enforce on Docker ports. Leave the IP empty to listen on every address of the host, or enter one of its IPs to dedicate that address. At most {max} ports in total; the next deploy applies the change, stopping the old container first.',
              { max: MAX_MAPPED_PORTS },
            ),
            { range: <span className="font-mono text-slate-300">27015-27030</span> },
          )}
        </p>
        {onNode && (
          <p className="mb-3 text-xs text-amber-300/90">
            {t("This service runs on a node: the ports are published on the node's own addresses, and its agent must be v0.16.1 or newer (an older one refuses the deploy and says so).")}
          </p>
        )}
        {rows.length === 0 ? (
          <p className="text-xs text-slate-500">{t('No extra ports published.')}</p>
        ) : (
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="space-y-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Input
                    value={r.ip}
                    onChange={(e) => update(i, { ip: e.target.value })}
                    placeholder={t('every address')}
                    list={addresses.length > 0 ? `host-ips-${serviceId}` : undefined}
                    aria-label={t('Mapping {n} host IP', { n: i + 1 })}
                    className="h-8 w-36 font-mono text-[11px]"
                  />
                  <Input
                    value={r.host}
                    onChange={(e) => update(i, { host: e.target.value })}
                    placeholder="27015-27030"
                    aria-label={t('Mapping {n} host ports', { n: i + 1 })}
                    className="h-8 w-32 font-mono text-[11px]"
                  />
                  <span className="text-slate-600">→</span>
                  <Input
                    value={r.container}
                    onChange={(e) => update(i, { container: e.target.value })}
                    placeholder={t('same')}
                    aria-label={t('Mapping {n} container port', { n: i + 1 })}
                    className="h-8 w-24 font-mono text-[11px]"
                  />
                  <Select
                    value={r.protocol}
                    onChange={(e) => update(i, { protocol: e.target.value as 'tcp' | 'udp' })}
                    aria-label={t('Mapping {n} protocol', { n: i + 1 })}
                    className="h-8 w-20 text-[11px]"
                  >
                    <option value="udp">UDP</option>
                    <option value="tcp">TCP</option>
                  </Select>
                  {allowable(r) && (
                    <Input
                      value={r.allow ?? ''}
                      onChange={(e) => update(i, { allow: e.target.value })}
                      placeholder={t('allow from: anyone')}
                      title={t('Only these addresses or CIDR ranges may connect (comma-separated). The port is then published through a small proxy that filters the source address.')}
                      aria-label={t('Mapping {n} allow from', { n: i + 1 })}
                      className="h-8 w-48 font-mono text-[11px]"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                    className="shrink-0 text-slate-600 transition hover:text-rose-400"
                    aria-label={t('Remove mapping {n}', { n: i + 1 })}
                  >
                    <Trash2 size={13} />
                  </button>
                  {typeof parsed[i] !== 'string' && (
                    <span className="font-mono text-[11px] text-slate-500">
                      {(parsed[i] as PortMapping).allowFrom?.length
                        ? t('{mapping} via the allow-list proxy', { mapping: formatPortMapping(parsed[i] as PortMapping) })
                        : `-p ${formatPortMapping(parsed[i] as PortMapping)}`}
                    </span>
                  )}
                </div>
                {rowProblems[i] && <p className="text-[11px] text-rose-300/90">{rowProblems[i]}</p>}
              </div>
            ))}
          </div>
        )}
        {addresses.length > 0 && (
          <datalist id={`host-ips-${serviceId}`}>
            {addresses.map((a) => (
              <option key={a.ip} value={a.ip}>
                {[a.label, a.dedicated === 'self' ? t('dedicated to this service') : null, a.primary ? t('primary') : null, a.iface, `IPv${a.family}`].filter(Boolean).join(', ')}
              </option>
            ))}
          </datalist>
        )}
        {addresses.length > 0 && rows.length > 0 && (
          <p className="mt-2 text-[11px] text-slate-500">
            {fill(t('Host IPs: {ips}'), { ips: <span className="font-mono text-slate-400">{addresses.map((a) => a.ip).join(', ')}</span> })}
          </p>
        )}
        {udpOnly && svc.healthCheck === 'http' && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200/90">
            <span>
              {t('Only UDP is published. If the app has no HTTP or TCP port, the deploy healthcheck cannot reach it: let it only wait for the container to stay up.')}
            </span>
            <Button size="sm" variant="ghost" onClick={() => runningCheck.mutate()} disabled={runningCheck.isPending}>
              {t('Use "container running"')}
            </Button>
          </div>
        )}
        {listProblem && <p className="mt-2 text-[11px] text-rose-300/90">{listProblem}</p>}
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[11px] text-slate-500">{total > 0 ? (total === 1 ? t('{n} host port', { n: total }) : t('{n} host ports', { n: total })) : ''}</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => save.mutate()}
            disabled={save.isPending || rowProblems.some(Boolean) || Boolean(listProblem)}
          >
            {t('Save mappings')}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
