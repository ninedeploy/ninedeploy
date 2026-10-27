import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api.js';
import { useWorkspace } from '../lib/workspace.js';
import { useToast } from './Toast.js';
import { useT } from '../lib/i18n.js';
import { Button, Input, Modal, Skeleton, Spinner, Switch } from './ui.js';

/**
 * Manage deployment lanes (environments): create, rename, delete, and
 * (0.16.13) switch protection and deploy approvals. The server enforces the
 * role floors (create/rename `member`, delete and the switches `admin`) —
 * failures surface as toasts instead of being pre-filtered here.
 */
export function LanesModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { currentWorkspace } = useWorkspace();
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const lanes = useQuery({
    queryKey: ['environments'],
    queryFn: () => api.environments.list(),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['environments'] });
    // A deleted lane detaches its services (environment_id → NULL); the
    // cached service rows carry the stale lane otherwise.
    qc.invalidateQueries({ queryKey: ['services'] });
  };

  const create = useMutation({
    mutationFn: (input: { workspaceId: number; name: string }) => api.environments.create(input),
    onSuccess: (env) => {
      invalidate();
      setName('');
      toast(t('Lane "{name}" created', { name: env.name }), 'info');
    },
    onError: (err: unknown) => toast(err instanceof Error ? err.message : t('Create failed'), 'error'),
  });

  const rename = useMutation({
    mutationFn: (input: { id: number; name: string }) => api.environments.rename(input.id, input.name),
    onSuccess: (env) => {
      invalidate();
      setEditingId(null);
      toast(t('Lane renamed to "{name}"', { name: env.name }), 'info');
    },
    onError: (err: unknown) => toast(err instanceof Error ? err.message : t('Rename failed'), 'error'),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.environments.remove(id),
    onSuccess: () => {
      invalidate();
      setConfirmDeleteId(null);
      toast(t('Lane deleted'), 'info');
    },
    onError: (err: unknown) => toast(err instanceof Error ? err.message : t('Delete failed'), 'error'),
  });

  // 0.16.13: the two lane switches. Admin-only on the server; a member's
  // attempt surfaces as the server's 403 toast.
  const toggle = useMutation({
    mutationFn: (input: { id: number; protected?: boolean; requireApproval?: boolean }) => {
      const { id, ...patch } = input;
      return api.environments.update(id, patch);
    },
    onSuccess: (env, input) => {
      invalidate();
      if (input.protected !== undefined) {
        toast(input.protected ? t('"{name}" is protected', { name: env.name }) : t('"{name}" is no longer protected', { name: env.name }), 'info');
      } else {
        toast(
          input.requireApproval ? t('Deploys into "{name}" now wait for approval', { name: env.name }) : t('Deploys into "{name}" no longer wait for approval', { name: env.name }),
          'info',
        );
      }
    },
    onError: (err: unknown) => toast(err instanceof Error ? err.message : t('Could not change the lane'), 'error'),
  });

  const busy = create.isPending || rename.isPending || remove.isPending || toggle.isPending;

  return (
    <Modal title={t('Deployment lanes')} onClose={onClose}>
      <p className="mb-4 text-xs text-slate-500">
        {t('Lanes group services per workspace — production, staging, … — and power the promote flow on the deploy tab. A protected lane keeps its variable values and logs for workspace admins; with approval on, each deploy into it waits for one.')}
      </p>

      {lanes.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : !lanes.data || lanes.data.length === 0 ? (
        <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-3 text-xs text-slate-500">
          <Layers size={14} className="shrink-0 text-slate-600" />
          {t('No lanes yet — services live in a single undifferentiated pool until you create one.')}
        </div>
      ) : (
        <ul className="mb-4 space-y-1.5">
          {lanes.data.map((e) => (
            <li
              key={e.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2"
            >
              {editingId === e.id ? (
                <form
                  className="flex flex-1 items-center gap-2"
                  onSubmit={(ev) => {
                    ev.preventDefault();
                    if (editName.trim()) rename.mutate({ id: e.id, name: editName.trim() });
                  }}
                >
                  <Input
                    value={editName}
                    onChange={(ev) => setEditName(ev.target.value)}
                    className="h-8 text-xs"
                    aria-label={t('Lane name')}
                    autoFocus
                  />
                  <Button type="submit" size="sm" disabled={!editName.trim() || busy}>
                    {t('Save')}
                  </Button>
                  <Button type="button" variant="secondary" size="sm" onClick={() => setEditingId(null)}>
                    {t('Cancel')}
                  </Button>
                </form>
              ) : (
                <>
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-slate-200">{e.name}</span>
                    <span className="text-[11px] text-slate-500">
                      {e.serviceCount === 1 ? t('{n} service', { n: e.serviceCount }) : t('{n} services', { n: e.serviceCount })}
                    </span>
                    {/* Absent on panels before 0.16.13. */}
                    {e.protected !== undefined && (
                      <span className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                        <label
                          className="flex items-center gap-2 text-[11px] text-slate-400"
                          title={t("Variable values, deploy and runtime logs and mounted files of this lane's services are for workspace admins only")}
                        >
                          <Switch
                            checked={!!e.protected}
                            disabled={busy}
                            label={t('Protect {name}', { name: e.name })}
                            onChange={(v) => toggle.mutate({ id: e.id, protected: v })}
                          />
                          {t('Protected')}
                        </label>
                        <label
                          className="flex items-center gap-2 text-[11px] text-slate-400"
                          title={t("Every deploy into this lane waits for a workspace admin to approve it; an admin's own deploys go straight through")}
                        >
                          <Switch
                            checked={!!e.requireApproval}
                            disabled={busy}
                            label={t('Require approval for {name}', { name: e.name })}
                            onChange={(v) => toggle.mutate({ id: e.id, requireApproval: v })}
                          />
                          {t('Require approval')}
                        </label>
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {confirmDeleteId === e.id ? (
                      <>
                        <span className="text-[11px] text-rose-300">{t('Delete lane?')}</span>
                        <Button
                          type="button"
                          size="sm"
                          variant="danger"
                          disabled={busy}
                          onClick={() => remove.mutate(e.id)}
                        >
                          {remove.isPending ? <Spinner className="h-3 w-3" /> : t('Yes, delete')}
                        </Button>
                        <Button type="button" size="sm" variant="secondary" onClick={() => setConfirmDeleteId(null)}>
                          {t('Keep')}
                        </Button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(e.id);
                            setEditName(e.name);
                          }}
                          className="rounded p-1.5 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
                          title={t('Rename {name}', { name: e.name })}
                          aria-label={t('Rename {name}', { name: e.name })}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(e.id)}
                          className="rounded p-1.5 text-slate-500 transition hover:bg-white/5 hover:text-rose-300"
                          title={t('Delete {name}', { name: e.name })}
                          aria-label={t('Delete {name}', { name: e.name })}
                        >
                          <Trash2 size={12} />
                        </button>
                      </>
                    )}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex items-center gap-2 border-t border-white/[0.06] pt-4"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (currentWorkspace && name.trim()) create.mutate({ workspaceId: currentWorkspace.id, name: name.trim() });
        }}
      >
        <Input
          value={name}
          onChange={(ev) => setName(ev.target.value)}
          placeholder={t('New lane name (e.g. staging)')}
          className="text-xs"
          aria-label={t('New lane name')}
          maxLength={80}
        />
        <Button type="submit" size="sm" disabled={!currentWorkspace || !name.trim() || create.isPending}>
          {create.isPending ? <Spinner className="h-3 w-3" /> : <Plus size={14} />} {t('Create lane')}
        </Button>
      </form>
    </Modal>
  );
}
