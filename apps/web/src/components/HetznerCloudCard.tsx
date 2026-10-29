import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useMemo, useState } from 'react';
import { Cloud, Plus, Trash2 } from 'lucide-react';
import type { CloudServer } from '@ninedeploy/sdk';
import { api } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import { useT } from '../lib/i18n.js';
import { useToast } from './Toast.js';
import { Badge, Button, Card, ConfirmDialog, Field, Input, Select } from './ui.js';

/**
 * G4.3: create nodes on Hetzner Cloud. The API token is write-only; a new
 * server installs Docker and starts the agent from its cloud-init user data,
 * then turns online on the Servers list when the agent first answers.
 */

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function HetznerCloudCard() {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const status = useQuery({ queryKey: ['hetzner-status'], queryFn: () => api.cloud.hetzner.status() });
  const cloudServers = useQuery({
    queryKey: ['hetzner-servers'],
    queryFn: () => api.cloud.hetzner.servers(),
    enabled: status.data?.configured === true,
    refetchInterval: 20_000,
  });
  const [token, setToken] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<CloudServer | null>(null);

  const saveToken = useMutation({
    mutationFn: () => api.cloud.hetzner.setToken(token.trim()),
    onSuccess: (res) => {
      qc.setQueryData(['hetzner-status'], res);
      setToken('');
      toast(t('Hetzner Cloud token saved'), 'success');
    },
    onError: (err) => toast(t('Token refused: {error}', { error: errorText(err) }), 'error'),
  });
  const forgetToken = useMutation({
    mutationFn: () => api.cloud.hetzner.deleteToken(),
    onSuccess: (res) => qc.setQueryData(['hetzner-status'], res),
  });
  const remove = useMutation({
    mutationFn: (serverId: number) => api.cloud.hetzner.deleteServer(serverId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hetzner-servers'] });
      qc.invalidateQueries({ queryKey: ['servers'] });
      toast(t('Server deleted on Hetzner Cloud'), 'success');
    },
    onError: (err) => toast(t('Could not delete the server: {error}', { error: errorText(err) }), 'error'),
  });

  return (
    <Card className="p-5" data-testid="hetzner-cloud">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <Cloud size={15} className="text-rose-400" /> {t('Hetzner Cloud')}
        </h2>
        {status.data?.configured && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span>{t('Token {hint}', { hint: status.data.tokenHint ?? '' })}</span>
            <Button size="sm" variant="ghost" onClick={() => forgetToken.mutate()} disabled={forgetToken.isPending}>
              {t('Forget token')}
            </Button>
            <Button size="sm" onClick={() => setCreating((v) => !v)}>
              <Plus size={13} /> {t('Create server')}
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
          aria-label={t('Hetzner Cloud token')}
        >
          <p className="text-xs leading-relaxed text-slate-500">
            {t('Create servers on Hetzner Cloud that join this panel by themselves. Paste a Cloud project API token with Read & Write access; it is stored encrypted and never shown again.')}
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
        <CreateServerForm
          onDone={() => {
            setCreating(false);
            qc.invalidateQueries({ queryKey: ['hetzner-servers'] });
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
                  <Badge tone={s.providerStatus === 'running' ? 'emerald' : s.providerStatus === 'deleted' ? 'rose' : 'neutral'}>
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
        title={t('Delete server')}
        message={t('Delete "{name}" on Hetzner Cloud and remove its node? The VM and everything on its disk are destroyed. This is refused while the node hosts services or databases.', {
          name: deleting?.name ?? '',
        })}
        confirmLabel={t('Delete server')}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.serverId);
          setDeleting(null);
        }}
        onClose={() => setDeleting(null)}
      />
    </Card>
  );
}

function CreateServerForm({ onDone }: { onDone: () => void }) {
  const t = useT();
  const { toast } = useToast();
  const options = useQuery({ queryKey: ['hetzner-options'], queryFn: () => api.cloud.hetzner.options(), staleTime: 5 * 60_000 });
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [serverType, setServerType] = useState('');
  const [image, setImage] = useState('');
  const [sshKeyIds, setSshKeyIds] = useState<number[]>([]);

  const types = useMemo(
    () => (options.data?.serverTypes ?? []).filter((st) => !location || st.locations.length === 0 || st.locations.includes(location)),
    [options.data, location],
  );
  const arch = types.find((st) => st.name === serverType)?.architecture;
  const images = (options.data?.images ?? []).filter((i) => !arch || i.architecture === arch);

  const create = useMutation({
    mutationFn: () => api.cloud.hetzner.createServer({ name: name.trim(), location, serverType, image, sshKeyIds }),
    onSuccess: (res) => {
      toast(t('Server created at {ip}; it joins as a node in a few minutes', { ip: res.ipv4 }), 'success');
      onDone();
    },
    onError: (err) => toast(t('Could not create the server: {error}', { error: errorText(err) }), 'error'),
  });
  const valid = !!name.trim() && !!location && !!serverType && !!image
    && !!options.data?.locations.some((item) => item.name === location)
    && types.some((item) => item.name === serverType)
    && images.some((item) => item.name === image);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) create.mutate();
  };

  if (options.isError) return <p className="text-xs text-rose-300">{t('Could not read the Hetzner project: {error}', { error: errorText(options.error) })}</p>;
  if (!options.data) return <p className="text-xs text-slate-500">{t('Reading the Hetzner project…')}</p>;

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-white/5 p-3" aria-label={t('Create server')}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('Name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="edge-1" />
        </Field>
        <Field label={t('Location')}>
          <Select value={location} onChange={(e) => {
            const next = e.target.value;
            setLocation(next);
            const selected = options.data?.serverTypes.find((st) => st.name === serverType);
            if (selected && next && selected.locations.length > 0 && !selected.locations.includes(next)) {
              setServerType('');
              setImage('');
            }
          }}>
            <option value="">{t('Choose…')}</option>
            {options.data.locations.map((l) => (
              <option key={l.name} value={l.name}>
                {l.name} · {l.city} ({l.country})
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('Server type')}>
          <Select value={serverType} onChange={(e) => {
            const next = e.target.value;
            setServerType(next);
            const nextArch = types.find((st) => st.name === next)?.architecture;
            if (image && nextArch && !options.data?.images.some((item) => item.name === image && item.architecture === nextArch)) setImage('');
          }}>
            <option value="">{t('Choose…')}</option>
            {types.map((st) => (
              <option key={st.name} value={st.name}>
                {st.name} · {t('{cores} vCPU, {memory} GB RAM, {disk} GB', { cores: st.cores, memory: st.memoryGb, disk: st.diskGb })} · {st.architecture}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('Image')}>
          <Select value={image} onChange={(e) => setImage(e.target.value)}>
            <option value="">{t('Choose…')}</option>
            {images.map((i) => (
              <option key={`${i.name}-${i.architecture}`} value={i.name}>
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
        {t('Hetzner bills the server from the moment it is created. Its cloud-init installs Docker and starts the NineDeploy agent on port 4600; the agent token travels in the server\'s user data.')}
      </p>
      <div className="flex justify-end">
        <Button type="submit" disabled={!valid || create.isPending}>
          {create.isPending ? t('Creating…') : t('Create server')}
        </Button>
      </div>
    </form>
  );
}
