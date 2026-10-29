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
 * G4.3: create nodes as DigitalOcean droplets, the same flow as
 * HetznerCloudCard. The API token is write-only; a new droplet installs
 * Docker and starts the agent from its user data, then turns online on the
 * Servers list when the agent first answers.
 */

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function DigitalOceanCloudCard() {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const status = useQuery({ queryKey: ['digitalocean-status'], queryFn: () => api.cloud.digitalocean.status() });
  const cloudServers = useQuery({
    queryKey: ['digitalocean-servers'],
    queryFn: () => api.cloud.digitalocean.servers(),
    enabled: status.data?.configured === true,
    refetchInterval: 20_000,
  });
  const [token, setToken] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<CloudServer | null>(null);

  const saveToken = useMutation({
    mutationFn: () => api.cloud.digitalocean.setToken(token.trim()),
    onSuccess: (res) => {
      qc.setQueryData(['digitalocean-status'], res);
      setToken('');
      toast(t('DigitalOcean token saved'), 'success');
    },
    onError: (err) => toast(t('Token refused: {error}', { error: errorText(err) }), 'error'),
  });
  const forgetToken = useMutation({
    mutationFn: () => api.cloud.digitalocean.deleteToken(),
    onSuccess: (res) => qc.setQueryData(['digitalocean-status'], res),
  });
  const remove = useMutation({
    mutationFn: (serverId: number) => api.cloud.digitalocean.deleteServer(serverId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['digitalocean-servers'] });
      qc.invalidateQueries({ queryKey: ['servers'] });
      toast(t('Droplet deleted on DigitalOcean'), 'success');
    },
    onError: (err) => toast(t('Could not delete the server: {error}', { error: errorText(err) }), 'error'),
  });

  return (
    <Card className="p-5" data-testid="digitalocean-cloud">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <Cloud size={15} className="text-sky-400" /> DigitalOcean
        </h2>
        {status.data?.configured && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span>{t('Token {hint}', { hint: status.data.tokenHint ?? '' })}</span>
            <Button size="sm" variant="ghost" onClick={() => forgetToken.mutate()} disabled={forgetToken.isPending}>
              {t('Forget token')}
            </Button>
            <Button size="sm" onClick={() => setCreating((v) => !v)}>
              <Plus size={13} /> {t('Create droplet')}
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
          aria-label={t('DigitalOcean token')}
        >
          <p className="text-xs leading-relaxed text-slate-500">
            {t('Create droplets on DigitalOcean that join this panel by themselves. Paste a personal access token with droplet read and write access; it is stored encrypted and never shown again.')}
          </p>
          <div className="flex gap-2">
            <Input value={token} onChange={(e) => setToken(e.target.value)} type="password" autoComplete="off" placeholder={t('API token')} aria-label={t('API token')} />
            <Button type="submit" disabled={saveToken.isPending || !token.trim()}>
              {saveToken.isPending ? t('Checking…') : t('Save')}
            </Button>
          </div>
        </form>
      )}

      {status.data?.configured && creating && (
        <CreateDropletForm
          onDone={() => {
            setCreating(false);
            qc.invalidateQueries({ queryKey: ['digitalocean-servers'] });
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
        title={t('Delete droplet')}
        message={t('Delete the droplet "{name}" on DigitalOcean and remove its node? The droplet and everything on its disk are destroyed. This is refused while the node hosts services or databases.', {
          name: deleting?.name ?? '',
        })}
        confirmLabel={t('Delete droplet')}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.serverId);
          setDeleting(null);
        }}
        onClose={() => setDeleting(null)}
      />
    </Card>
  );
}

function CreateDropletForm({ onDone }: { onDone: () => void }) {
  const t = useT();
  const { toast } = useToast();
  const options = useQuery({ queryKey: ['digitalocean-options'], queryFn: () => api.cloud.digitalocean.options(), staleTime: 5 * 60_000 });
  const [name, setName] = useState('');
  const [region, setRegion] = useState('');
  const [size, setSize] = useState('');
  const [image, setImage] = useState('');
  const [sshKeyIds, setSshKeyIds] = useState<number[]>([]);

  // Sizes and images a region offers (an empty region list means "anywhere").
  const offered = (regions: string[]) => !region || regions.length === 0 || regions.includes(region);
  const sizes = (options.data?.sizes ?? []).filter((s) => offered(s.regions));
  const images = (options.data?.images ?? []).filter((i) => offered(i.regions));

  const create = useMutation({
    mutationFn: () => api.cloud.digitalocean.createServer({ name: name.trim(), region, size, image, sshKeyIds }),
    onSuccess: (res) => {
      toast(t('Server created at {ip}; it joins as a node in a few minutes', { ip: res.ipv4 }), 'success');
      onDone();
    },
    onError: (err) => toast(t('Could not create the server: {error}', { error: errorText(err) }), 'error'),
  });
  const valid =
    !!name.trim() &&
    !!options.data?.regions.some((r) => r.slug === region) &&
    sizes.some((s) => s.slug === size) &&
    images.some((i) => i.slug === image);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) create.mutate();
  };

  if (options.isError) return <p className="text-xs text-rose-300">{t('Could not read the DigitalOcean account: {error}', { error: errorText(options.error) })}</p>;
  if (!options.data) return <p className="text-xs text-slate-500">{t('Reading the DigitalOcean account…')}</p>;

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-white/5 p-3" aria-label={t('Create droplet')}>
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
              const fits = (regions: string[] | undefined) => !next || !regions || regions.length === 0 || regions.includes(next);
              if (!fits(options.data?.sizes.find((s) => s.slug === size)?.regions)) setSize('');
              if (!fits(options.data?.images.find((i) => i.slug === image)?.regions)) setImage('');
            }}
          >
            <option value="">{t('Choose…')}</option>
            {options.data.regions.map((r) => (
              <option key={r.slug} value={r.slug}>
                {r.slug} · {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('Size')}>
          <Select value={size} onChange={(e) => setSize(e.target.value)}>
            <option value="">{t('Choose…')}</option>
            {sizes.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.slug} · {t('{cpus} vCPU, {memory} GB RAM, {disk} GB, USD {price}/month', { cpus: s.vcpus, memory: s.memoryGb, disk: s.diskGb, price: s.priceMonthly })}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('Image')}>
          <Select value={image} onChange={(e) => setImage(e.target.value)}>
            <option value="">{t('Choose…')}</option>
            {images.map((i) => (
              <option key={i.slug} value={i.slug}>
                {i.description}
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
        {t("DigitalOcean bills the droplet from the moment it is created. Its user data installs Docker and starts the NineDeploy agent on port 4600; the panel replaces the agent key as soon as the agent answers.")}
      </p>
      <div className="flex justify-end">
        <Button type="submit" disabled={!valid || create.isPending}>
          {create.isPending ? t('Creating…') : t('Create droplet')}
        </Button>
      </div>
    </form>
  );
}
