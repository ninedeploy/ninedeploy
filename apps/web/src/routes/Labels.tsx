import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Edit2, Plus, Tag, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useWorkspace } from '../lib/workspace.js';
import { useTagScope } from '../lib/projects.js';
import { useToast } from '../components/Toast.js';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorCard, Field, Input, Modal, PageHeader, Skeleton, cn } from '../components/ui.js';
import { formatDateTime } from '../lib/format.js';
import type { Label, LabelColor } from '@ninedeploy/sdk';

/**
 * Labels page — the third tag dimension.
 *
 * Workspaces and projects both have their own management pages; labels used
 * to be creatable only as a side effect of the top-bar filter, which left no
 * way to rename one, recolour it or delete it once it was wrong. This page
 * owns the full CRUD for the flat, workspace-scoped label list. Deleting a
 * label only removes the tag — every service that carried it is untouched.
 */

const COLOR_CHOICES: readonly LabelColor[] = ['indigo', 'emerald', 'amber', 'rose', 'sky', 'slate', 'violet', 'lime'];

/** Chip classes per palette token — kept in sync with `TopBarFilters`. */
export const LABEL_COLOR_CLASS: Record<LabelColor, string> = {
  indigo: 'bg-indigo-500/20 text-indigo-200 border-indigo-500/30',
  emerald: 'bg-emerald-500/20 text-emerald-200 border-emerald-500/30',
  amber: 'bg-amber-500/20 text-amber-200 border-amber-500/30',
  rose: 'bg-rose-500/20 text-rose-200 border-rose-500/30',
  sky: 'bg-sky-500/20 text-sky-200 border-sky-500/30',
  slate: 'bg-slate-500/20 text-slate-200 border-slate-500/30',
  violet: 'bg-violet-500/20 text-violet-200 border-violet-500/30',
  lime: 'bg-lime-500/20 text-lime-200 border-lime-500/30',
};

/** Solid swatch for the colour picker. */
const SWATCH: Record<LabelColor, string> = {
  indigo: 'bg-indigo-500',
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  rose: 'bg-rose-500',
  sky: 'bg-sky-500',
  slate: 'bg-slate-500',
  violet: 'bg-violet-500',
  lime: 'bg-lime-500',
};

function colorOf(raw: string | null | undefined): LabelColor {
  return (COLOR_CHOICES as readonly string[]).includes(raw ?? '') ? (raw as LabelColor) : 'indigo';
}

export function Labels() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { workspaces, currentWorkspace } = useWorkspace();
  const scope = useTagScope();
  const operator = user?.isOperator === true;
  const activeWorkspaceId = currentWorkspace?.id ?? null;

  const { data: labels = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: ['labels', activeWorkspaceId],
    queryFn: async () => {
      const list = await api.labels.list(activeWorkspaceId ? `?workspaceId=${activeWorkspaceId}` : '');
      return list ?? [];
    },
  });

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Label | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState<LabelColor>('indigo');
  const [workspaceId, setWorkspaceId] = useState<number | ''>('');
  const [pendingDelete, setPendingDelete] = useState<Label | null>(null);

  const openCreate = () => {
    setEditing(null);
    setName('');
    setColor('indigo');
    setWorkspaceId(activeWorkspaceId ?? '');
    setShowForm(true);
  };
  const openEdit = (l: Label) => {
    setEditing(l);
    setName(l.name);
    setColor(colorOf(l.color));
    setWorkspaceId(l.workspaceId ?? '');
    setShowForm(true);
  };
  const closeForm = () => setShowForm(false);

  // Both queries are invalidated on every write: the tag-scope provider holds
  // its own unscoped `['labels']` list and prunes any chip missing from it,
  // so a workspace-scoped refresh alone would drop a freshly created label.
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['labels'] });

  const saveMutation = useMutation({
    mutationFn: () => {
      const trimmed = name.trim();
      return editing
        ? api.labels.update(editing.id, { name: trimmed, color })
        : api.labels.create({ name: trimmed, color, workspaceId: workspaceId === '' ? null : Number(workspaceId) });
    },
    onSuccess: () => {
      invalidate();
      setShowForm(false);
      toast(editing ? 'Label updated' : 'Label created', 'success');
    },
    onError: (err: unknown) => {
      toast(err instanceof Error ? err.message : 'Could not save the label', 'error');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.labels.remove(id),
    onSuccess: () => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['services'] });
      setPendingDelete(null);
      toast('Label deleted — the services that carried it were untouched', 'success');
    },
    onError: (err: unknown) => {
      toast(err instanceof Error ? err.message : 'Could not delete the label', 'error');
    },
  });

  const submitForm = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast('Name is required', 'error');
      return;
    }
    saveMutation.mutate();
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <PageHeader
        icon={<Tag size={18} />}
        title="Labels"
        subtitle="Free-form tags for slicing services outside the project hierarchy — production, staging, team-x. A service can carry any number of them."
        actions={
          <Button onClick={openCreate}>
            <Plus size={16} /> New label
          </Button>
        }
      />

      {isLoading ? (
        <Card className="p-5"><Skeleton className="h-10 w-full" /></Card>
      ) : isError ? (
        <ErrorCard title="Couldn't load labels" error={error} onRetry={() => refetch()} />
      ) : labels.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Tag size={26} />}
            title="No labels yet"
            hint="Create a label here, or add one inline from the tag filter in the top bar. Assign it to a service from the service's Tags card."
            action={<Button onClick={openCreate}><Plus size={16} /> Create label</Button>}
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/5 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3 font-medium">Label</th>
                <th className="px-5 py-3 font-medium">Scope</th>
                <th className="px-5 py-3 font-medium">Services</th>
                <th className="px-5 py-3 font-medium">Updated</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {labels.map((l) => {
                const ws = l.workspaceId ? workspaces.find((w) => w.id === l.workspaceId) : null;
                const tone = LABEL_COLOR_CLASS[colorOf(l.color)];
                return (
                  <tr key={l.id} className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]">
                    <td className="px-5 py-3">
                      <button
                        type="button"
                        onClick={() => {
                          // Drive the shared top-bar chip scope rather than a
                          // one-off query string — the services list reads its
                          // filter from the scope, and the chip stays visible.
                          scope.setLabelIds([l.id]);
                          navigate('/services');
                        }}
                        className="text-left"
                        title={`Show services labelled "${l.name}"`}
                      >
                        <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium', tone)}>
                          <Tag size={11} /> {l.name}
                        </span>
                      </button>
                    </td>
                    <td className="px-5 py-3">
                      <Badge tone={ws ? 'indigo' : 'neutral'} className="text-[10px] uppercase">
                        {ws ? ws.name : 'No workspace'}
                      </Badge>
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-300">{l.serviceCount} svc</td>
                    <td className="px-5 py-3 text-xs text-slate-500">{formatDateTime(l.updatedAt)}</td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => openEdit(l)}
                          title="Edit label"
                          className="h-7 w-7 p-0"
                          aria-label="Edit label"
                        >
                          <Edit2 size={13} />
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => setPendingDelete(l)}
                          title="Delete label"
                          className="h-7 w-7 p-0"
                          aria-label="Delete label"
                        >
                          <Trash2 size={13} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {showForm && (
        <Modal onClose={closeForm} title={editing ? 'Edit label' : 'New label'}>
          <form onSubmit={submitForm} className="space-y-4">
            <Field label="Name">
              <Input
                required
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. production"
                maxLength={40}
              />
            </Field>
            <Field label="Colour" hint="Used for the chip in the top-bar filter and on every service card.">
              <div className="flex flex-wrap gap-2">
                {COLOR_CHOICES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    aria-label={c}
                    aria-pressed={color === c}
                    title={c}
                    className={cn(
                      'h-7 w-7 rounded-full transition ring-offset-2 ring-offset-slate-950',
                      SWATCH[c],
                      color === c ? 'ring-2 ring-white' : 'opacity-60 hover:opacity-100',
                    )}
                  />
                ))}
              </div>
            </Field>
            {!editing && (
              <Field
                label="Workspace"
                hint="Labels are workspace-scoped. Operators may also leave a label unscoped so it is shared across the instance."
              >
                <select
                  value={String(workspaceId)}
                  onChange={(e) => setWorkspaceId(e.target.value === '' ? '' : Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-sm outline-none focus:border-indigo-500"
                >
                  {operator && <option value="">No workspace (operator-shared)</option>}
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </Field>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" onClick={closeForm}>Cancel</Button>
              <Button type="submit" disabled={saveMutation.isPending || !name.trim()}>
                {saveMutation.isPending ? 'Saving…' : editing ? 'Save changes' : 'Create label'}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      <ConfirmDialog
        open={pendingDelete != null}
        title="Delete label"
        message={
          pendingDelete
            ? `Delete "${pendingDelete.name}"? It is removed from the ${pendingDelete.serviceCount} service(s) carrying it — those services are NOT deleted.`
            : ''
        }
        confirmLabel="Delete"
        onConfirm={() => pendingDelete && deleteMutation.mutate(pendingDelete.id)}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}
