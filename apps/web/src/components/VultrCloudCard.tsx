import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Cloud, Plus, Trash2 } from 'lucide-react';
import type { CloudServer } from '@ninedeploy/sdk';
import { api } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import { useT } from '../lib/i18n.js';
import { useToast } from './Toast.js';
import { Badge, Button, Card, ConfirmDialog, Field, Input, Select } from './ui.js';

/**
 * G4.3: create nodes as Vultr instances, the same flow as HetznerCloudCard
 * and DigitalOceanCloudCard. The API key is write-only; a new instance
 * installs Docker and starts the agent from its user data, then turns online
 * on the Servers list when the agent first answers.
 */

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function VultrCloudCard() {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const status = useQuery({ queryKey: ['vultr-status'], queryFn: () => api.cloud.vultr.status() });
  const cloudServers = useQuery({
    queryKey: ['vultr-servers'],
    queryFn: () => api.cloud.vultr.servers(),
    enabled: status.data?.configured === true,
    refetchInterval: 20_000,
  });
  const [token, setToken] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<CloudServer | null>(null);

  const saveToken = useMutation({
    mutationFn: () => api.cloud.vultr.setToken(token.trim()),
    onSuccess: (res) => {
      qc.setQueryData(['vultr-status'], res);
      setToken('');
      toast(t('Vultr API key saved'), 'success');
    },
    onError: (err) => toast(t('Token refused: {error}', { error: errorText(err) }), 'error'),
  });
  const forgetToken = useMutation({
    mutationFn: () => api.cloud.vultr.deleteToken(),
    onSuccess: (res) => qc.setQueryData(['vultr-status'], res),
  });
  const remove = useMutation({
    mutationFn: (serverId: number) => api.cloud.vultr.deleteServer(serverId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vultr-servers'] });
      qc.invalidateQueries({ queryKey: ['servers'] });
      toast(t('Instance deleted on Vultr'), 'success');
    },
    onError: (err) => toast(t('Could not delete the server: {error}', { error: errorText(err) }), 'error'),
  });

  return (
    <Card className="p-5" data-testid="vultr-cloud">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <Cloud size={15} className="text-sky-400" /> Vultr
        </h2>
        {status.data?.configured && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span>{t('Token {hint}', { hint: status.data.tokenHint ?? '' })}</span>
            <Button size="sm" variant="ghost" onClick={() => forgetToken.mutate()} disabled={forgetToken.isPending}>
              {t('Forget token')}
            </Button>
            <Button size="sm" onClick={() => setCreating((v) => !v)}>
              <Plus size={13} /> {t('Create instance')}
            </Button>
          </div>
        )}
      </div>

      {status.data && !status.data.configured && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) saveToken.mutate();
          }}
          aria-label={t('Vultr API key')}
        >
          <p className="text-xs leading-relaxed text-slate-500">
            {t('Create instances on Vultr that join this panel by themselves. Paste an API key (Account → API) and allow the panel’s address in its access control; it is stored encrypted and never shown again.')}
          </p>
          <div className="flex gap-2">
            <Input value={token} onChange={(e) => setToken(e.target.value)} type="password" autoComplete="off" placeholder={t('API key')} aria-label={t('API key')} />
            <Button type="submit" disabled={saveToken.isPending || !token.trim()}>
              {saveToken.isPending ? t('Checking…') : t('Save')}
            </Button>
          </div>
        </form>
      )}

      {status.data?.configured && creating && (
        <CreateInstanceForm
          onDone={() => {
            setCreating(false);
            qc.invalidateQueries({ queryKey: ['vultr-servers'] });
            qc.invalidateQueries({ queryKey: ['servers'] });
          }}
        />
      )}

      {status.data?.configured && (
        <div className="mt-3">
          {cloudServers.isError ? (
            <p className="text-xs text-rose-300">{t('Could not load the servers: {error}', { error: errorText(cloudServers.error) })}</p>
          ) : (cloudServers.data ?? []).length === 0 ? (
            <p className="text-xs text-slate-500">{t('No server created from this panel yet.')}</p>
          ) : (
            <ul className="space-y-2 text-xs">
              {(cloudServers.data ?? []).map((s) => (
                <li key={s.serverId} className="flex flex-wrap items-center gap-2 rounded-lg border border-white/5 px-3 py-2">
                  <span className="font-medium text-slate-200">{s.name}</span>
                  <span className="font-mono text-slate-500">{s.ipv4}</span>
                  <span className="text-slate-500">
                    {s.serverType} · {s.location} · {s.image}
                  </span>
                  <Badge tone={s.providerStatus === 'active' ? 'emerald' : s.providerStatus === 'deleted' ? 'rose' : 'neutral'}>
                    {t('VM: {status}', { status: s.providerStatus ?? '—' })}
                  </Badge>
                  <Badge tone={s.nodeStatus === 'online' ? 'emerald' : 'amber'}>{t('node: {status}', { status: s.nodeStatus })}</Badge>
                  {s.nodeStatus !== 'online' && <span className="text-slate-500">{t('waiting for the agent to answer (a few minutes after creation)')}</span>}
                  <span className="text-slate-600">{formatDateTime(s.createdAt)}</span>
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setDeleting(s)} aria-label={t('Delete {name}', { name: s.name })}>
                    <Trash2 size={12} /> {t('Delete')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={t('Delete instance')}
        message={t('Delete the instance "{name}" on Vultr and remove its node? The instance and everything on its disk are destroyed. This is refused while the node hosts services or databases.', {
          name: deleting?.name ?? '',
        })}
        confirmLabel={t('Delete instance')}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.serverId);
          setDeleting(null);
        }}
        onClose={() => setDeleting(null)}
      />
    </Card>
  );
}

function CreateInstanceForm({ onDone }: { onDone: () => void }) {
  const t = useT();
  const { toast } = useToast();
  const options = useQuery({ queryKey: ['vultr-options'], queryFn: () => api.cloud.vultr.options(), staleTime: 5 * 60_000 });
  const [name, setName] = useState('');
  const [region, setRegion] = useState('');
  const [plan, setPlan] = useState('');
  const [osId, setOsId] = useState('');
  const [sshKeyIds, setSshKeyIds] = useState<string[]>([]);

  // Plans the region offers (Vultr offers every operating system everywhere).
  const plans = (options.data?.plans ?? []).filter((p) => !region || p.regions.includes(region));

  const create = useMutation({
    mutationFn: () => api.cloud.vultr.createServer({ name: name.trim(), region, plan, osId: Number(osId), sshKeyIds }),
    onSuccess: (res) => {
      toast(t('Server created at {ip}; it joins as a node in a few minutes', { ip: res.ipv4 }), 'success');
      onDone();
    },
    onError: (err) => toast(t('Could not create the server: {error}', { error: errorText(err) }), 'error'),
  });
  const valid =
    !!name.trim() &&
    !!options.data?.regions.some((r) => r.id === region) &&
    plans.some((p) => p.id === plan) &&
    !!options.data?.images.some((i) => String(i.id) === osId);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) create.mutate();
  };

  if (options.isError) return <p className="text-xs text-rose-300">{t('Could not read the Vultr account: {error}', { error: errorText(options.error) })}</p>;
  if (!options.data) return <p className="text-xs text-slate-500">{t('Reading the Vultr account…')}</p>;

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-white/5 p-3" aria-label={t('Create instance')}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('Name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="edge-1" />
        </Field>
        <Field label={t('Region')}>
          <Select
            value={region}
            onChange={(e) => {
              const next = e.target.value;
              setRegion(next);
              const chosen = options.data?.plans.find((p) => p.id === plan);
              if (next && chosen && !chosen.regions.includes(next)) setPlan('');
            }}
          >
            <option value="">{t('Choose…')}</option>
            {options.data.regions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id} · {r.city}, {r.country}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('Plan')}>
          <Select value={plan} onChange={(e) => setPlan(e.target.value)}>
            <option value="">{t('Choose…')}</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} · {t('{cpus} vCPU, {memory} GB RAM, {disk} GB, USD {price}/month', { cpus: p.vcpus, memory: p.memoryGb, disk: p.diskGb, price: p.priceMonthly })}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('Image')}>
          <Select value={osId} onChange={(e) => setOsId(e.target.value)}>
            <option value="">{t('Choose…')}</option>
            {options.data.images.map((i) => (
              <option key={i.id} value={String(i.id)}>
                {i.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {options.data.sshKeys.length > 0 && (
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-1 text-xs text-slate-400">{t('SSH keys for root')}</legend>
          <div className="flex flex-wrap gap-3 text-xs text-slate-300">
            {options.data.sshKeys.map((k) => (
              <label key={k.id} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={sshKeyIds.includes(k.id)}
                  onChange={(e) => setSshKeyIds((ids) => (e.target.checked ? [...ids, k.id] : ids.filter((x) => x !== k.id)))}
                />
                {k.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <p className="text-[11px] leading-relaxed text-slate-500">
        {t('Vultr bills the instance from the moment it is created. Its user data installs Docker and starts the NineDeploy agent on port 4600; the panel replaces the agent key as soon as the agent answers.')}
      </p>
      <div className="flex justify-end">
        <Button type="submit" disabled={!valid || create.isPending}>
          {create.isPending ? t('Creating…') : t('Create instance')}
        </Button>
      </div>
    </form>
  );
}
