import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Cable, Network, Plus, ShieldAlert, Trash2, Unplug } from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from '../components/Toast.js';
import { Button, Card, ConfirmDialog, EmptyState, ErrorCard, PageHeader, Skeleton } from '../components/ui.js';

type NetworkRow = {
  name: string;
  driver: string;
  members: string[];
  isManaged?: boolean;
};

// Mirror of the server-side `lib/managedNamespace.ts` prefixes. The server is
// the authority — this is purely so the attach form can warn the operator
// *before* the round-trip, not to authorize anything.
const MANAGED_CONTAINER_PREFIXES = [/^nd-svc-/, /^nd-db-/, /^ninedeploy/];
const isLikelyManagedContainer = (name: string): boolean =>
  MANAGED_CONTAINER_PREFIXES.some((re) => re.test(name));

/** Docker network management: list, create, delete, attach/detach containers. */
export function Networks() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const list = useQuery({ queryKey: ['networks'], queryFn: () => api.networks.list(), refetchInterval: 15000 });

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDriver, setNewDriver] = useState<'bridge' | 'overlay'>('bridge');
  const [attachTo, setAttachTo] = useState<string | null>(null);
  const [container, setContainer] = useState('');
  const [pendingDelete, setPendingDelete] = useState<NetworkRow | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['networks'] });

  const create = useMutation({
    mutationFn: () => api.networks.create({ name: newName, driver: newDriver }),
    onSuccess: () => {
      setNewName('');
      setShowCreate(false);
      invalidate();
      toast('Network created', 'success');
    },
    onError: (err) => toast(err instanceof Error ? err.message : 'Create failed', 'error'),
  });

  const remove = useMutation({
    mutationFn: (name: string) => api.networks.remove(name),
    onSuccess: () => {
      invalidate();
      toast('Network deleted', 'success');
    },
    onError: (err) => toast(err instanceof Error ? err.message : 'Delete failed', 'error'),
  });

  const attach = useMutation({
    // The attach card only renders while attachTo is set, so it is non-null here.
    mutationFn: () => api.networks.attach({ network: attachTo!, container }),
    onSuccess: () => {
      setAttachTo(null);
      setContainer('');
      invalidate();
      toast('Container attached', 'success');
    },
    onError: (err) => toast(err instanceof Error ? err.message : 'Attach failed', 'error'),
  });

  const detach = useMutation({
    mutationFn: (input: { network: string; container: string }) => api.networks.detach(input),
    onSuccess: () => {
      invalidate();
      toast('Container detached', 'success');
    },
    onError: (err) => toast(err instanceof Error ? err.message : 'Detach failed', 'error'),
  });

  const networks = list.data?.networks ?? [];
  const attachLooksManaged = isLikelyManagedContainer(container);

  return (
    <div>
      <PageHeader
        icon={<Network size={18} />}
        title="Docker Networks"
        subtitle={`${networks.length} user-defined networks`}
        actions={
          <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
            <Plus size={13} /> New network
          </Button>
        }
      />

      {showCreate && (
        <Card className="mb-5 p-5">
          <div className="flex max-w-lg items-end gap-3">
            <label className="flex-1">
              <span className="mb-1 block text-xs text-slate-500">Name</span>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="my-network"
                className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm outline-none focus:border-indigo-500"
              />
            </label>
            <label>
              <span className="mb-1 block text-xs text-slate-500">Driver</span>
              <select
                value={newDriver}
                onChange={(e) => setNewDriver(e.target.value as 'bridge' | 'overlay')}
                className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm outline-none focus:border-indigo-500"
              >
                <option value="bridge">bridge</option>
                <option value="overlay">overlay</option>
              </select>
            </label>
            <Button
              size="sm"
              onClick={() => create.mutate()}
              disabled={create.isPending || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(newName)}
            >
              {create.isPending ? 'Creating…' : 'Create'}
            </Button>
          </div>
        </Card>
      )}

      {attachTo && (
        <Card className="mb-5 p-5">
          <p className="mb-3 text-sm text-slate-300">
            Attach a container to <span className="font-mono text-indigo-300">{attachTo}</span>
          </p>
          <div className="flex max-w-lg items-end gap-3">
            <label className="flex-1">
              <span className="mb-1 block text-xs text-slate-500">Container name</span>
              <input
                value={container}
                onChange={(e) => setContainer(e.target.value)}
                placeholder="my-app-42"
                className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm outline-none focus:border-indigo-500"
              />
            </label>
            <Button size="sm" onClick={() => attach.mutate()} disabled={attach.isPending || !container}>
              <Cable size={13} /> {attach.isPending ? 'Attaching…' : 'Attach'}
            </Button>
            <button type="button" onClick={() => setAttachTo(null)} className="text-xs text-slate-400 hover:underline">
              Cancel
            </button>
          </div>
          {attachLooksManaged && (
            <div
              role="alert"
              className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
            >
              <ShieldAlert size={13} className="mt-0.5 shrink-0" />
              <span>
                <span className="font-mono">{container}</span> looks like a NineDeploy-managed container. The
                server will reject this attach — managed containers must stay on their reserved networks.
              </span>
            </div>
          )}
        </Card>
      )}

      {list.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : list.isError ? (
        <ErrorCard title="Couldn't load networks" error={list.error} onRetry={() => list.refetch()} />
      ) : networks.length === 0 ? (
        <Card>
          <EmptyState icon={<Network size={26} />} title="No user-defined networks" hint="Create one to connect containers across services." />
        </Card>
      ) : (
        <div className="space-y-3">
          {networks.map((n) => (
            <Card key={n.name} className="p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-slate-100">{n.name}</span>
                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-medium uppercase text-slate-500">{n.driver}</span>
                    {n.isManaged && (
                      <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-medium text-indigo-300">managed</span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {n.members.length === 0 ? 'No attached containers' : `${n.members.length} container${n.members.length === 1 ? '' : 's'} attached`}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setAttachTo(n.name)}>
                    <Cable size={13} /> Attach
                  </Button>
                  {!n.isManaged && (
                    <Button size="sm" variant="danger" onClick={() => setPendingDelete(n)} disabled={remove.isPending}>
                      <Trash2 size={13} /> Delete
                    </Button>
                  )}
                </div>
              </div>
              {n.members.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {n.members.map((m) => (
                    <span
                      key={m}
                      className="group flex items-center gap-1.5 rounded-lg bg-white/[0.03] px-2 py-1 font-mono text-[11px] text-slate-400 ring-1 ring-inset ring-white/5"
                    >
                      {m}
                      {isLikelyManagedContainer(m) && (
                        <span
                          title="NineDeploy-managed container"
                          className="rounded bg-indigo-500/15 px-1 text-[9px] font-medium text-indigo-300"
                        >
                          managed
                        </span>
                      )}
                      <button
                        type="button"
                        title="Detach"
                        onClick={() => detach.mutate({ network: n.name, container: m })}
                        className="text-slate-600 opacity-0 transition-opacity group-hover:opacity-100 hover:text-rose-400"
                      >
                        <Unplug size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete != null}
        title="Delete network"
        message={
          pendingDelete ? (
            <div className="space-y-3">
              <p>
                Network{' '}
                <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-[11px]">{pendingDelete.name}</code>{' '}
                will be removed. Every attached container will be disconnected from it.
              </p>
              {pendingDelete.members.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs uppercase tracking-wider text-slate-500">
                    Containers that will lose connectivity
                  </p>
                  <ul className="flex flex-wrap gap-1.5">
                    {pendingDelete.members.map((m) => (
                      <li
                        key={m}
                        className="flex items-center gap-1.5 rounded bg-white/[0.04] px-2 py-0.5 font-mono text-[11px] text-slate-300 ring-1 ring-inset ring-white/5"
                      >
                        {m}
                        {isLikelyManagedContainer(m) && (
                          <span className="rounded bg-amber-500/15 px-1 text-[9px] font-medium text-amber-300">managed</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            ''
          )
        }
        confirmLabel="Delete"
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete.name)}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}
