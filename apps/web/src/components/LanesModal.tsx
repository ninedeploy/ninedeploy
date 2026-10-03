import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api.js';
import { useWorkspace } from '../lib/workspace.js';
import { useToast } from './Toast.js';
import { Button, Input, Modal, Skeleton, Spinner } from './ui.js';

/**
 * Manage deployment lanes (environments): create, rename, delete. The
 * server enforces the role floors (create/rename `member`, delete `admin`)
 * — failures surface as toasts instead of being pre-filtered here.
 */
export function LanesModal({ onClose }: { onClose: () => void }) {
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
      toast(`Lane "${env.name}" created`, 'info');
    },
    onError: (err: unknown) => toast(err instanceof Error ? err.message : 'Create failed', 'error'),
  });

  const rename = useMutation({
    mutationFn: (input: { id: number; name: string }) => api.environments.rename(input.id, input.name),
    onSuccess: (env) => {
      invalidate();
      setEditingId(null);
      toast(`Lane renamed to "${env.name}"`, 'info');
    },
    onError: (err: unknown) => toast(err instanceof Error ? err.message : 'Rename failed', 'error'),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.environments.remove(id),
    onSuccess: () => {
      invalidate();
      setConfirmDeleteId(null);
      toast('Lane deleted', 'info');
    },
    onError: (err: unknown) => toast(err instanceof Error ? err.message : 'Delete failed', 'error'),
  });

  const busy = create.isPending || rename.isPending || remove.isPending;

  return (
    <Modal title="Deployment lanes" onClose={onClose}>
      <p className="mb-4 text-xs text-slate-500">
        Lanes group services per workspace — production, staging, … — and power the promote flow on the deploy tab.
      </p>

      {lanes.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : !lanes.data || lanes.data.length === 0 ? (
        <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-3 text-xs text-slate-500">
          <Layers size={14} className="shrink-0 text-slate-600" />
          No lanes yet — services live in a single undifferentiated pool until you create one.
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
                    aria-label="Lane name"
                    autoFocus
                  />
                  <Button type="submit" size="sm" disabled={!editName.trim() || busy}>
                    Save
                  </Button>
                  <Button type="button" variant="secondary" size="sm" onClick={() => setEditingId(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-slate-200">{e.name}</span>
                    <span className="text-[11px] text-slate-500">
                      {e.serviceCount} service{e.serviceCount === 1 ? '' : 's'}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {confirmDeleteId === e.id ? (
                      <>
                        <span className="text-[11px] text-rose-300">Delete lane?</span>
                        <Button
                          type="button"
                          size="sm"
                          variant="danger"
                          disabled={busy}
                          onClick={() => remove.mutate(e.id)}
                        >
                          {remove.isPending ? <Spinner className="h-3 w-3" /> : 'Yes, delete'}
                        </Button>
                        <Button type="button" size="sm" variant="secondary" onClick={() => setConfirmDeleteId(null)}>
                          Keep
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
                          title={`Rename ${e.name}`}
                          aria-label={`Rename ${e.name}`}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(e.id)}
                          className="rounded p-1.5 text-slate-500 transition hover:bg-white/5 hover:text-rose-300"
                          title={`Delete ${e.name}`}
                          aria-label={`Delete ${e.name}`}
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
          placeholder="New lane name (e.g. staging)"
          className="text-xs"
          aria-label="New lane name"
          maxLength={80}
        />
        <Button type="submit" size="sm" disabled={!currentWorkspace || !name.trim() || create.isPending}>
          {create.isPending ? <Spinner className="h-3 w-3" /> : <Plus size={14} />} Create lane
        </Button>
      </form>
    </Modal>
  );
}
