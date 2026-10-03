import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Check, Cloud, Copy, ExternalLink, Info, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from '../components/Toast.js';
import { Button, Card, ConfirmDialog, EmptyState, ErrorCard, Field, Input, PageHeader, Skeleton, StatusBadge } from '../components/ui.js';

const TRAEFIK_ORIGIN = 'http://ninedeploy-traefik:80';

function CloudflareSetupGuide({ onCopy }: { onCopy: (label: string, value: string) => Promise<void> }) {
  return (
    <Card className="mb-5 overflow-hidden">
      <div className="border-b border-white/5 bg-cyan-500/[0.04] px-5 py-4">
        <div className="flex items-start gap-3">
          <Info size={18} className="mt-0.5 shrink-0 text-cyan-400" />
          <div>
            <h2 className="font-semibold text-slate-100">Cloudflare Tunnel setup</h2>
            <p className="mt-1 text-sm leading-relaxed text-slate-400">
              Use a remotely managed <strong className="text-slate-200">Cloudflare Tunnel with cloudflared</strong>. Do not choose Mesh, WARP Connector or a private CIDR route; those options are not public hostname routing to NineDeploy.
            </p>
          </div>
        </div>
      </div>

      <ol className="space-y-5 p-5 text-sm text-slate-300">
        <li className="flex gap-3">
          <StepNumber value={1} />
          <div>
            <p className="font-medium text-slate-100">Create a remotely managed cloudflared tunnel</p>
            <p className="mt-1 leading-relaxed text-slate-400">
              Open Cloudflare Zero Trust, go to <span className="text-slate-200">Networks → Tunnels</span>, select <span className="text-slate-200">Create a tunnel</span>, then choose <span className="text-slate-200">Cloudflare Tunnel / cloudflared</span>.
            </p>
            <a className="mt-2 inline-flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300" href="https://one.dash.cloudflare.com/" target="_blank" rel="noreferrer">
              Open Cloudflare Zero Trust <ExternalLink size={12} />
            </a>
          </div>
        </li>

        <li className="flex gap-3">
          <StepNumber value={2} />
          <div>
            <p className="font-medium text-slate-100">Copy only the connector token</p>
            <p className="mt-1 leading-relaxed text-slate-400">
              On the connector installation screen choose Docker or Linux. Copy the long value after <code className="text-cyan-300">--token</code> (usually beginning with <code className="text-cyan-300">eyJ</code>). It is not a Cloudflare API token, Global API Key, Tunnel ID or certificate.
            </p>
          </div>
        </li>

        <li className="flex gap-3">
          <StepNumber value={3} />
          <div>
            <p className="font-medium text-slate-100">Start the connector in NineDeploy</p>
            <p className="mt-1 leading-relaxed text-slate-400">
              Click <span className="text-slate-200">New tunnel</span> below, enter a name, paste the connector token and start it. The tunnel status should become <span className="text-emerald-400">running</span> and Cloudflare should report a Healthy or Connected connector.
            </p>
          </div>
        </li>

        <li className="flex gap-3">
          <StepNumber value={4} />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-slate-100">Add a Published application route in Cloudflare</p>
            <p className="mt-1 leading-relaxed text-slate-400">
              Open the tunnel, add a Published application route, enter the public hostname (for example <code className="text-cyan-300">app.example.com</code>), choose <span className="text-slate-200">HTTP</span>, and use this exact service URL:
            </p>
            <div className="mt-2 flex max-w-xl items-center justify-between gap-3 rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2">
              <code className="truncate text-xs text-cyan-300">{TRAEFIK_ORIGIN}</code>
              <button type="button" aria-label="Copy Traefik origin" onClick={() => void onCopy('Traefik origin', TRAEFIK_ORIGIN)} className="shrink-0 text-slate-500 transition hover:text-cyan-300">
                <Copy size={14} />
              </button>
            </div>
          </div>
        </li>

        <li className="flex gap-3">
          <StepNumber value={5} />
          <div>
            <p className="font-medium text-slate-100">Add the same hostname to the NineDeploy service</p>
            <p className="mt-1 leading-relaxed text-slate-400">
              In the service's <span className="text-slate-200">Network → Domains</span> section add the exact same hostname and path <code className="text-cyan-300">/</code>. Keep <strong className="text-amber-300">SSL off in NineDeploy</strong>: Cloudflare terminates public HTTPS, while the tunnel connects to Traefik over HTTP port 80.
            </p>
          </div>
        </li>
      </ol>

      <div className="border-t border-white/5 bg-emerald-500/[0.035] px-5 py-4">
        <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-emerald-400"><Check size={14} /> Before testing</p>
        <p className="mt-2 text-xs leading-relaxed text-slate-400">
          Confirm that the NineDeploy tunnel is running, Cloudflare shows the connector as Healthy, the service is running with the correct Container Port, and both sides use the identical hostname. Then open the public URL with HTTPS.
        </p>
      </div>
    </Card>
  );
}

function StepNumber({ value }: { value: number }) {
  return <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-cyan-500/20 bg-cyan-500/10 text-xs font-semibold text-cyan-300">{value}</span>;
}

export function Tunnels() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ id: number; name: string } | null>(null);
  const [name, setName] = useState('');
  const [token, setToken] = useState('');

  const copyValue = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast(`${label} copied`, 'success');
    } catch {
      toast(`Could not copy ${label.toLowerCase()}`, 'error');
    }
  };

  const list = useQuery({ queryKey: ['tunnels'], queryFn: () => api.tunnels.list() });
  const create = useMutation({
    mutationFn: () => api.tunnels.create({ name, token }),
    onSuccess: () => {
      setOpen(false);
      setName('');
      setToken('');
      qc.invalidateQueries({ queryKey: ['tunnels'] });
      toast('Tunnel started', 'success');
    },
    onError: () => toast('Could not start the tunnel', 'error'),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.tunnels.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tunnels'] });
      toast('Tunnel deleted', 'success');
    },
    onError: () => toast('Could not delete the tunnel', 'error'),
  });

  return (
    <div>
      <PageHeader
        icon={<Cloud size={18} />}
        title="Tunnels"
        subtitle="Cloudflare Tunnels — expose services without opening any ports."
      />

      <CloudflareSetupGuide onCopy={copyValue} />

      <div className="mb-5 flex justify-end">
        <Button onClick={() => setOpen((v) => !v)}><Plus size={16} /> New tunnel</Button>
      </div>

      {open && (
        <Card className="mb-5 p-5 nd-fade">
          <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (name.trim() && token.trim()) create.mutate(); }} className="space-y-4">
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="production" required /></Field>
            <Field label="Cloudflare tunnel token (not an API token)">
              <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="eyJhIjoi…" required autoComplete="off" spellCheck={false} className="font-mono text-xs" />
            </Field>
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/15 bg-amber-500/[0.06] p-3 text-xs leading-relaxed text-amber-200">
              <ShieldAlert size={14} className="mt-0.5 shrink-0" /> Paste only the long tunnel connector token from Cloudflare's install command. Do not paste a Global API Key, scoped API token, Tunnel ID or certificate.
            </div>
            <div className="flex justify-end"><Button type="submit" disabled={create.isPending}>{create.isPending ? 'Starting…' : 'Start tunnel'}</Button></div>
          </form>
        </Card>
      )}

      {list.isLoading ? (
        <Card className="p-5"><Skeleton className="h-10 w-full" /></Card>
      ) : list.isError ? (
        <ErrorCard title="Couldn't load tunnels" error={list.error} onRetry={() => list.refetch()} />
      ) : !list.data || list.data.length === 0 ? (
        <Card><EmptyState icon={<Cloud size={26} />} title="No tunnels" hint="Add a Cloudflare Tunnel token to expose services securely." /></Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/5 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Container</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {list.data.map((t) => (
                <tr key={t.id} className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]">
                  <td className="px-5 py-3 font-medium text-slate-200">{t.name}</td>
                  <td className="px-5 py-3"><StatusBadge status={t.status} /></td>
                  <td className="px-5 py-3 font-mono text-[11px] text-slate-500">{t.containerName}</td>
                  <td className="px-5 py-3 text-right">
                    <button type="button" aria-label={`Delete ${t.name}`} onClick={() => setPendingDelete({ id: t.id, name: t.name })} className="text-slate-600 transition hover:text-rose-400"><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <ConfirmDialog
        open={pendingDelete != null}
        title="Delete tunnel"
        message={`Delete "${pendingDelete?.name}"? The cloudflared container stops and its hostnames stop resolving.`}
        confirmLabel="Delete"
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}
