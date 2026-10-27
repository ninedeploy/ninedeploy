import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Database,
  Globe,
  Lock,
  Mail,
  Plus,
  Radio,
  RefreshCw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
  Zap,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, Input, cn } from '../../components/ui.js';
import { fill, msg, useT } from '../../lib/i18n.js';

interface PortPreset {
  id: string;
  name: string;
  category: 'Web' | 'Mail' | 'Database' | 'Remote';
  icon: typeof Globe;
  ports: Array<{ port: number; proto: 'tcp' | 'udp'; label: string }>;
  description: string;
}

const COMMON_PRESETS: PortPreset[] = [
  {
    id: 'web-ingress',
    name: msg('Web Ingress (Traefik)'),
    category: 'Web',
    icon: Globe,
    ports: [
      { port: 80, proto: 'tcp', label: 'HTTP (80)' },
      { port: 443, proto: 'tcp', label: 'HTTPS (443)' },
    ],
    description: msg('Reverse proxy, Let\'s Encrypt automatic SSL certificates and custom domains'),
  },
  {
    id: 'mail-poste',
    name: msg('Mail Server (Poste.io / Mailcow)'),
    category: 'Mail',
    icon: Mail,
    ports: [
      { port: 25, proto: 'tcp', label: 'SMTP (25)' },
      { port: 465, proto: 'tcp', label: 'SMTPS (465)' },
      { port: 587, proto: 'tcp', label: 'Submission (587)' },
      { port: 993, proto: 'tcp', label: 'IMAPS (993)' },
      { port: 995, proto: 'tcp', label: 'POP3S (995)' },
    ],
    description: msg('Inbound/outbound email protocols & secure mailbox sync for Poste.io/Mailcow'),
  },
  {
    id: 'ssh',
    name: msg('SSH Remote Console'),
    category: 'Remote',
    icon: Terminal,
    ports: [{ port: 22, proto: 'tcp', label: 'SSH (22)' }],
    description: msg('Secure shell remote terminal access to the host server'),
  },
  {
    id: 'postgres',
    name: msg('PostgreSQL Database'),
    category: 'Database',
    icon: Database,
    ports: [{ port: 5432, proto: 'tcp', label: 'Postgres (5432)' }],
    description: msg('Direct external database client access (DBeaver, TablePlus, pgAdmin)'),
  },
  {
    id: 'mysql',
    name: msg('MySQL / MariaDB'),
    category: 'Database',
    icon: Database,
    ports: [{ port: 3306, proto: 'tcp', label: 'MySQL (3306)' }],
    description: msg('Direct external MySQL/MariaDB database client access'),
  },
  {
    id: 'redis',
    name: msg('Redis Datastore'),
    category: 'Database',
    icon: Database,
    ports: [{ port: 6379, proto: 'tcp', label: 'Redis (6379)' }],
    description: msg('Direct external cache and message queue access'),
  },
  {
    id: 'mongodb',
    name: msg('MongoDB'),
    category: 'Database',
    icon: Database,
    ports: [{ port: 27017, proto: 'tcp', label: 'MongoDB (27017)' }],
    description: msg('Direct external document database client access'),
  },
];

/**
 * Whether a `ufw status numbered` "To" column (`80`, `443/tcp`,
 * `22/tcp (v6)`, `8000:8100/tcp`) covers `port`/`proto` exactly.
 */
export function ufwRuleMatchesPort(to: string, port: number, proto: 'tcp' | 'udp' | string): boolean {
  const m = /^(\d+)(?::(\d+))?(?:\/(tcp|udp))?(?:\s+\(v6\))?$/i.exec(to.trim());
  if (!m) return false;
  const lo = Number(m[1]);
  const hi = m[2] ? Number(m[2]) : lo;
  if (port < lo || port > hi) return false;
  return !m[3] || m[3].toLowerCase() === String(proto).toLowerCase();
}

export function FirewallSection() {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [port, setPort] = useState('');
  const [proto, setProto] = useState<'tcp' | 'udp' | 'any'>('tcp');
  const [action, setAction] = useState<'allow' | 'deny' | 'limit'>('allow');
  const [fromIp, setFromIp] = useState('');
  const [comment, setComment] = useState('');

  const statusQuery = useQuery({
    queryKey: ['firewall-status'],
    queryFn: () => api.firewall.status(),
  });

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => api.firewall.toggle(enabled),
    onSuccess: (data, enabled) => {
      qc.setQueryData(['firewall-status'], data.status);
      toast(enabled ? t('Host firewall (UFW) enabled') : t('Host firewall (UFW) disabled'), 'success');
    },
    onError: (err: any) => toast(err?.message || t('Could not toggle firewall'), 'error'),
  });

  const applyRecommended = useMutation({
    mutationFn: () => api.firewall.applyRecommended(),
    onSuccess: (data) => {
      qc.setQueryData(['firewall-status'], data.status);
      toast(t('Recommended VPS firewall profile applied (22, 80, 443 allowed)'), 'success');
    },
    onError: (err: any) => toast(err?.message || t('Failed to apply recommended profile'), 'error'),
  });

  const addRuleMutation = useMutation({
    mutationFn: (args?: { port?: string | number; proto?: 'tcp' | 'udp' | 'any'; comment?: string; from?: string }) => {
      const targetPort = args?.port ?? port.trim();
      const targetProto = args?.proto ?? proto;
      const targetComment = args?.comment ?? comment.trim();
      const targetFrom = args?.from ?? fromIp.trim();
      return api.firewall.addRule({
        port: targetPort,
        proto: targetProto,
        action,
        from: targetFrom || undefined,
        comment: targetComment || undefined,
      });
    },
    onSuccess: (data) => {
      qc.setQueryData(['firewall-status'], data.status);
      setPort('');
      setFromIp('');
      setComment('');
      toast(t('Firewall port rule opened'), 'success');
    },
    onError: (err: any) => toast(err?.message || t('Failed to add rule'), 'error'),
  });

  const deleteRuleMutation = useMutation({
    mutationFn: (id: number) => api.firewall.deleteRule(id),
    onSuccess: (data) => {
      qc.setQueryData(['firewall-status'], data.status);
      toast(t('Firewall rule removed'), 'success');
    },
    onError: (err: any) => toast(err?.message || t('Failed to delete rule'), 'error'),
  });

  const status = statusQuery.data;
  const rules = status?.rules ?? [];

  // Helper to check if a port is permitted in active UFW rules
  const isPortAllowed = (p: number, pr: 'tcp' | 'udp') => {
    return rules.some((r) => r.action.toUpperCase().includes('ALLOW') && ufwRuleMatchesPort(r.to, p, pr));
  };

  // Helper to toggle a preset on or off
  const togglePreset = async (preset: PortPreset, currentlyOpen: boolean) => {
    try {
      if (!currentlyOpen) {
        // Open all ports in preset
        for (const item of preset.ports) {
          await api.firewall.addRule({
            port: item.port,
            proto: item.proto,
            action: 'allow',
            comment: `${preset.name} - ${item.label}`,
          });
        }
        toast(t('Opened all ports for {name}', { name: t(preset.name) }), 'success');
      } else {
        // r191: every matching ALLOW rule (IPv4 AND the "(v6)" twin), matched
        // on the exact port — `includes('22')` also hit 2222 — and deleted in
        // DESCENDING id order: `ufw delete N` renumbers every rule after N, so
        // ascending deletes removed the wrong rules (closing "Web" could drop
        // the SSH rule and leave 443 open).
        const matchingRuleIds = rules
          .filter(
            (r) =>
              r.action.toUpperCase().includes('ALLOW') &&
              preset.ports.some((item) => ufwRuleMatchesPort(r.to, item.port, item.proto)),
          )
          .map((r) => r.id)
          .sort((a, b) => b - a);
        for (const id of matchingRuleIds) {
          await api.firewall.deleteRule(id);
        }
        toast(t('Closed ports for {name}', { name: t(preset.name) }), 'success');
      }
      statusQuery.refetch();
    } catch (err: any) {
      toast(err?.message || t('Failed to toggle port preset'), 'error');
    }
  };

  return (
    <div className="space-y-6">
      {/* ── Status & Master Switch ────────────────────────────────────────── */}
      <Card>
        <CardBody className="p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-4">
              <div
                className={cn(
                  'flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ring-1',
                  status?.active
                    ? 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20'
                    : 'bg-amber-500/10 text-amber-400 ring-amber-500/20',
                )}
              >
                {status?.active ? <ShieldCheck size={26} /> : <ShieldAlert size={26} />}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold text-slate-100">{t('Host Firewall & Port Control (UFW)')}</h3>
                  {status?.installed ? (
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
                        status.active
                          ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20'
                          : 'bg-amber-500/10 text-amber-300 ring-amber-500/20',
                      )}
                    >
                      <span className={cn('h-1.5 w-1.5 rounded-full', status.active ? 'bg-emerald-400' : 'bg-amber-400')} />
                      {status.active ? t('Active & Enforcing') : t('Inactive')}
                    </span>
                  ) : (
                    <span className="rounded-full bg-slate-500/10 px-2.5 py-0.5 text-xs font-medium text-slate-400 ring-1 ring-slate-500/20">
                      {t('Not Installed')}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-slate-400 max-w-xl">
                  {t('Manage incoming network traffic and port exposure on your Ubuntu VPS. When active, all incoming ports are blocked by default except explicitly permitted ones.')}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => statusQuery.refetch()}
                disabled={statusQuery.isFetching}
                title={t('Refresh firewall state')}
              >
                <RefreshCw size={14} className={statusQuery.isFetching ? 'animate-spin' : ''} />
              </Button>
              {status?.installed && (
                <Button
                  variant={status.active ? 'ghost' : 'primary'}
                  size="sm"
                  onClick={() => toggleMutation.mutate(!status.active)}
                  disabled={toggleMutation.isPending}
                  className={status.active ? 'text-rose-400 hover:bg-rose-500/10' : ''}
                >
                  {status.active ? t('Disable Firewall') : t('Enable Firewall')}
                </Button>
              )}
            </div>
          </div>

          {/* Quick VPS Hardening Action */}
          {status?.installed && (!status.active || rules.length === 0) && (
            <div className="mt-4 flex items-center justify-between rounded-xl bg-indigo-500/10 p-3 ring-1 ring-indigo-500/20">
              <div className="flex items-center gap-2 text-xs text-indigo-300">
                <Zap size={14} className="shrink-0 text-indigo-400" />
                <span>
                  <strong>{t('Quick Start VPS Profile:')}</strong>{' '}
                  {t('Safely enable firewall with essential web & SSH access (22 SSH, 80 HTTP, 443 HTTPS).')}
                </span>
              </div>
              <Button
                size="sm"
                variant="primary"
                onClick={() => applyRecommended.mutate()}
                disabled={applyRecommended.isPending}
              >
                {t('Apply VPS Profile')}
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      {/* ── Popular Service Port Presets ──────────────────────────────────── */}
      <Card>
        <CardBody className="p-6">
          <div className="mb-4">
            <h4 className="text-sm font-semibold text-slate-200">{t('1-Click Service Port Presets')}</h4>
            <p className="text-xs text-slate-400">
              {t('Easily open or close standard port combinations for mail servers (Poste.io), databases, and web ingress.')}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {COMMON_PRESETS.map((preset) => {
              const Icon = preset.icon;
              const openCount = preset.ports.filter((p) => isPortAllowed(p.port, p.proto)).length;
              const allOpen = openCount === preset.ports.length;
              const someOpen = openCount > 0 && !allOpen;

              return (
                <div
                  key={preset.id}
                  className="flex flex-col justify-between rounded-xl border border-white/5 bg-slate-950/40 p-4 transition hover:border-white/10"
                >
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/5 text-indigo-400 ring-1 ring-white/10">
                          <Icon size={14} />
                        </div>
                        <span className="text-xs font-semibold text-slate-200">{t(preset.name)}</span>
                      </div>
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset',
                          allOpen
                            ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20'
                            : someOpen
                              ? 'bg-amber-500/10 text-amber-300 ring-amber-500/20'
                              : 'bg-slate-500/10 text-slate-400 ring-slate-500/20',
                        )}
                      >
                        <span
                          className={cn(
                            'h-1.5 w-1.5 rounded-full',
                            allOpen ? 'bg-emerald-400' : someOpen ? 'bg-amber-400' : 'bg-slate-500',
                          )}
                        />
                        {allOpen
                          ? t('All Open')
                          : someOpen
                            ? t('{open}/{total} Open', { open: openCount, total: preset.ports.length })
                            : t('Closed')}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400 mb-3">{t(preset.description)}</p>
                    <div className="flex flex-wrap gap-1.5 mb-4">
                      {preset.ports.map((p) => {
                        const open = isPortAllowed(p.port, p.proto);
                        return (
                          <span
                            key={p.port}
                            className={cn(
                              'font-mono text-[10px] px-2 py-0.5 rounded-md border flex items-center gap-1',
                              open
                                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300 font-semibold'
                                : 'bg-white/[0.02] border-white/5 text-slate-400',
                            )}
                          >
                            <span className={cn('h-1 w-1 rounded-full', open ? 'bg-emerald-400' : 'bg-slate-600')} />
                            {p.label}
                          </span>
                        );
                      })}
                    </div>
                  </div>

                  <div className="flex items-center justify-end pt-2 border-t border-white/5">
                    <Button
                      size="sm"
                      variant={allOpen ? 'ghost' : 'secondary'}
                      className={allOpen ? 'text-rose-400 hover:bg-rose-500/10 h-7 text-xs' : 'h-7 text-xs'}
                      onClick={() => togglePreset(preset, allOpen)}
                      disabled={!status?.installed}
                    >
                      {allOpen ? t('Close Ports') : t('Open All Ports')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </CardBody>
      </Card>

      {/* ── Active Rules Table ────────────────────────────────────────────── */}
      <Card>
        <CardBody className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h4 className="text-sm font-semibold text-slate-200">{t('Active Ingress & Port Rules')}</h4>
              <p className="text-xs text-slate-400">
                {t('All traffic matching these specific rules is permitted through the Linux host firewall.')}
              </p>
            </div>
            {rules.length > 0 && <span className="font-mono text-xs text-slate-400">{t('{n} rule(s)', { n: rules.length })}</span>}
          </div>

          {rules.length > 0 ? (
            <div className="overflow-x-auto rounded-xl border border-white/5 bg-slate-950/40">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-white/5 bg-white/[0.02] text-slate-400">
                    <th className="px-4 py-2.5 font-medium">#</th>
                    <th className="px-4 py-2.5 font-medium">{t('To / Port')}</th>
                    <th className="px-4 py-2.5 font-medium">{t('Action')}</th>
                    <th className="px-4 py-2.5 font-medium">{t('From (Source)')}</th>
                    <th className="px-4 py-2.5 font-medium">{t('Comment / Service')}</th>
                    <th className="px-4 py-2.5 text-right font-medium">{t('Manage')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 font-mono text-slate-300">
                  {rules.map((r) => (
                    <tr key={r.id} className="hover:bg-white/[0.01]">
                      <td className="px-4 py-2.5 text-slate-500">{r.id}</td>
                      <td className="px-4 py-2.5 font-semibold text-slate-200">{r.to}</td>
                      <td className="px-4 py-2.5">
                        <span
                          className={cn(
                            'rounded px-1.5 py-0.5 text-[10px] font-bold',
                            r.action.includes('ALLOW')
                              ? 'bg-emerald-500/10 text-emerald-400'
                              : 'bg-rose-500/10 text-rose-400',
                          )}
                        >
                          {r.action}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-slate-400">{r.from}</td>
                      <td className="px-4 py-2.5 font-sans text-xs text-slate-400">
                        {r.comment || <span className="text-slate-600">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => deleteRuleMutation.mutate(r.id)}
                          disabled={deleteRuleMutation.isPending}
                          className="h-7 w-7 p-0 text-slate-500 hover:text-rose-400"
                          title={t('Delete rule')}
                        >
                          <Trash2 size={13} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-white/10 p-8 text-center text-xs text-slate-500">
              {t('No active host firewall rules configured.')}
            </div>
          )}
        </CardBody>
      </Card>

      {/* ── Add Custom Firewall Rule ──────────────────────────────────────── */}
      <Card>
        <CardBody className="p-6">
          <h4 className="mb-1 text-sm font-semibold text-slate-200">{t('Open Custom Port')}</h4>
          <p className="mb-4 text-xs text-slate-400">
            {t('Open any custom TCP/UDP port with optional IP allowlist filtering (CIDR).')}
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              // The input is `required`, so a submit always carries a port.
              /* v8 ignore start */
              if (port.trim()) addRuleMutation.mutate({});
              /* v8 ignore stop */
            }}
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5"
          >
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">{t('Port Number')}</label>
              <Input
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder={t('e.g. 8080, 25565')}
                required
                className="h-9 font-mono text-xs"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">{t('Protocol')}</label>
              <select
                value={proto}
                onChange={(e) => setProto(e.target.value as any)}
                className="h-9 w-full rounded-lg border border-white/10 bg-slate-900 px-3 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none"
              >
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
                <option value="any">{t('ANY (TCP+UDP)')}</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">{t('Action')}</label>
              <select
                value={action}
                onChange={(e) => setAction(e.target.value as any)}
                className="h-9 w-full rounded-lg border border-white/10 bg-slate-900 px-3 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none"
              >
                <option value="allow">{t('ALLOW (Permit)')}</option>
                <option value="deny">{t('DENY (Block)')}</option>
                <option value="limit">{t('LIMIT (Rate limit)')}</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">{t('Source IP (Optional)')}</label>
              <Input
                value={fromIp}
                onChange={(e) => setFromIp(e.target.value)}
                placeholder={t('Anywhere (or 1.2.3.4)')}
                className="h-9 font-mono text-xs"
              />
            </div>
            <div className="flex items-end">
              <Button
                type="submit"
                variant="primary"
                disabled={!port.trim() || addRuleMutation.isPending}
                className="h-9 w-full"
              >
                <Plus size={14} className="mr-1" />
                {t('Open Port')}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      {/* ── Multi-Layer Security Architecture Card ────────────────────────── */}
      <Card>
        <CardBody className="p-6">
          <div className="flex items-center gap-2 mb-3 text-sm font-semibold text-slate-200">
            <Lock size={16} className="text-indigo-400" />
            <span>{t('Multi-Layer Firewall & Security Architecture')}</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-slate-400">
            <div className="rounded-xl border border-white/5 bg-slate-950/40 p-3 space-y-1.5">
              <div className="flex items-center gap-1.5 font-semibold text-slate-200">
                <Radio size={14} className="text-emerald-400" />
                <span>{t('1. Host Network (UFW)')}</span>
              </div>
              <p>
                {t('Controls physical machine network ports (22 SSH, 80 HTTP, 443 HTTPS, 25/587 Mail). Blocks raw port scanning and unauthorized network probing.')}
              </p>
            </div>

            <div className="rounded-xl border border-white/5 bg-slate-950/40 p-3 space-y-1.5">
              <div className="flex items-center gap-1.5 font-semibold text-slate-200">
                <Shield size={14} className="text-indigo-400" />
                <span>{t('2. Application WAF (Traefik)')}</span>
              </div>
              <p>
                {fill(
                  t('Configurable per-domain in {path}: IP allowlisting (CIDR), Rate Limiting (req/sec), and HTTP Basic Auth.'),
                  { path: <em>{t('Service → Network → Security')}</em> },
                )}
              </p>
            </div>

            <div className="rounded-xl border border-white/5 bg-slate-950/40 p-3 space-y-1.5">
              <div className="flex items-center gap-1.5 font-semibold text-slate-200">
                <Zap size={14} className="text-amber-400" />
                <span>{t('3. Zero Trust Tunnels')}</span>
              </div>
              <p>
                {fill(
                  t('Expose services globally with {ports} via Cloudflare Tunnels (Tunnels tab), bypassing traditional open-port firewalls entirely.'),
                  { ports: <strong>{t('0 inbound open ports')}</strong> },
                )}
              </p>
            </div>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
