import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Edit2, FolderKanban, Plus, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useWorkspace } from '../lib/workspace.js';
import { useTagScope } from '../lib/projects.js';
import { useToast } from '../components/Toast.js';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorCard, Field, Input, Modal, PageHeader, Skeleton, Textarea } from '../components/ui.js';
import { formatDateTime } from '../lib/format.js';
import type { ProjectEntry } from '@ninedeploy/sdk';

/**
 * Projects page.
 *
 * Replaces the old placeholder that lived inside the top-bar project switcher.
 * Projects are N-N scoped: a single project can hold any number of services and
 * a service can be tagged into multiple projects, so this page is a flat list
 * with a per-row "scope" tag (workspace membership + service count). The
 * same flat structure makes it cheap to add a project — no service moves
 * around just because you reorganise the project hierarchy.
 */
export function Projects() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { workspaces, currentWorkspace } = useWorkspace();
  const scope = useTagScope();
  const operator = user?.isOperator === true;
  const activeWorkspaceId = currentWorkspace?.id ?? null;

  const { data: projects = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: ['projects', activeWorkspaceId],
    queryFn: async () => {
      const list = await api.projects.list(activeWorkspaceId ? `?workspaceId=${activeWorkspaceId}` : '');
      return list ?? [];
    },
  });

  // ── Create / edit / delete dialogs share a single set of state ─────────
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ProjectEntry | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [workspaceId, setWorkspaceId] = useState<number | ''>('');
  const [pendingDelete, setPendingDelete] = useState<ProjectEntry | null>(null);

  const openCreate = () => {
    setEditing(null);
    setName('');
    setSlug('');
    setDescription('');
    setWorkspaceId(activeWorkspaceId ?? '');
    setShowForm(true);
  };
  const openEdit = (p: ProjectEntry) => {
    setEditing(p);
    setName(p.name);
    setSlug(p.slug);
    setDescription(p.description ?? '');
    setWorkspaceId(p.workspaceId ?? '');
    setShowForm(true);
  };
  const closeForm = () => {
    setShowForm(false);
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      const descriptionValue: string | null = description.trim() ? description.trim() : null;
      const payload = {
        name: name.trim(),
        // r214: the slug is set once, at create. The update schema has no
        // slug, so an edited one was silently stripped while the form said
        // "changing it is fine" and the save toasted success.
        ...(!editing && slug.trim() ? { slug: slug.trim() } : {}),
        description: descriptionValue,
        workspaceId: workspaceId === '' ? null : Number(workspaceId),
      };
      return editing
        ? api.projects.update(editing.id, payload)
        : api.projects.create(payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setShowForm(false);
      toast(editing ? 'Project updated' : 'Project created', 'success');
    },
    onError: (err: unknown) => {
      toast(err instanceof Error ? err.message : 'Could not save the project', 'error');
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

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.projects.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['services'] });
      setPendingDelete(null);
      toast('Project deleted — services inside it were detached, not removed', 'success');
    },
    onError: (err: unknown) => {
      toast(err instanceof Error ? err.message : 'Could not delete the project', 'error');
    },
  });

  return (
    <div className="space-y-6 max-w-5xl">
      <PageHeader
        icon={<FolderKanban size={18} />}
        title="Projects"
        subtitle="Group services and shared environment variables by purpose. A service can be tagged into many projects."
        actions={
          <Button onClick={openCreate} disabled={!operator && workspaces.length === 0}>
            <Plus size={16} /> New project
          </Button>
        }
      />

      {!operator && workspaces.length === 0 && (
        <Card>
          <EmptyState
            icon={<FolderKanban size={26} />}
            title="No workspaces yet"
            hint="Projects need a workspace to live in. Ask an operator to invite you into one first."
          />
        </Card>
      )}

      {isLoading ? (
        <Card className="p-5"><Skeleton className="h-10 w-full" /></Card>
      ) : isError ? (
        <ErrorCard title="Couldn't load projects" error={error} onRetry={() => refetch()} />
      ) : projects.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FolderKanban size={26} />}
            title="No projects yet"
            hint={operator
              ? 'Create your first project to start grouping services and shared env vars.'
              : 'No projects in this workspace yet. Ask an operator to create one.'}
            action={
              operator ? (
                <Button onClick={openCreate}>
                  <Plus size={16} /> Create project
                </Button>
              ) : null
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/5 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Scope</th>
                <th className="px-5 py-3 font-medium">Resources</th>
                <th className="px-5 py-3 font-medium">Updated</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => {
                const ws = p.workspaceId ? workspaces.find((w) => w.id === p.workspaceId) : null;
                return (
                  <tr key={p.id} className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]">
                    <td className="px-5 py-3">
                      <button
                        type="button"
                        onClick={() => {
                          // `/services` filters off the shared tag scope, not
                          // a query string — set the chip so the list actually
                          // narrows and the selection stays visible.
                          scope.setProjectIds([p.id]);
                          navigate('/services');
                        }}
                        className="text-left"
                      >
                        <div className="font-medium text-slate-200 hover:text-indigo-300">{p.name}</div>
                        {p.description && (
                          <div className="text-xs text-slate-500 mt-0.5 line-clamp-1 max-w-md">{p.description}</div>
                        )}
                        <div className="text-[10px] font-mono text-slate-600 mt-0.5">/{p.slug}</div>
                      </button>
                    </td>
                    <td className="px-5 py-3">
                      <Badge tone={ws ? 'indigo' : 'neutral'} className="text-[10px] uppercase">
                        {ws ? ws.name : 'No workspace'}
                      </Badge>
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-300">
                      <span title={`${String(p.serviceCount)} service(s), ${String(p.databaseCount)} database(s)`}>
                        {p.serviceCount} svc · {p.databaseCount} db
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-500">
                      {formatDateTime(p.updatedAt)}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {operator && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => openEdit(p)}
                            title="Edit project"
                            className="h-7 w-7 p-0"
                            aria-label="Edit project"
                          >
                            <Edit2 size={13} />
                          </Button>
                        )}
                        {operator && (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => setPendingDelete(p)}
                            title="Delete project"
                            className="h-7 w-7 p-0"
                            aria-label="Delete project"
                          >
                            <Trash2 size={13} />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {/* Create / Edit form modal */}
      {showForm && (
        <Modal
          onClose={closeForm}
          title={editing ? 'Edit project' : 'New project'}
        >
          <form onSubmit={submitForm} className="space-y-4">
            <Field label="Name">
              <Input
                required
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Acme Web"
                maxLength={63}
              />
            </Field>
            <Field
              label="Slug"
              hint={editing
                ? 'The unique identifier. It is fixed once the project exists.'
                : 'Optional. Lower-case, hyphen-separated. Generated from the name when empty.'}
            >
              <Input
                value={slug}
                readOnly={!!editing}
                disabled={!!editing}
                onChange={(e) => setSlug(e.target.value)}
                placeholder={editing ? '' : 'acme-web'}
                maxLength={63}
              />
            </Field>
            <Field label="Description" hint="A short note about what this project is for. Optional.">
              <Textarea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Frontend, marketing site, and any related infra."
                maxLength={500}
              />
            </Field>
            <Field
              label="Workspace"
              hint="Pick a workspace to scope this project. Operators may also leave it unscoped (shared)."
            >
              <select
                value={String(workspaceId)}
                onChange={(e) => setWorkspaceId(e.target.value === '' ? '' : Number(e.target.value))}
                className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-sm outline-none focus:border-indigo-500"
              >
                <option value="">No workspace (operator-shared)</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" onClick={closeForm}>
                Cancel
              </Button>
              <Button type="submit" disabled={saveMutation.isPending || !name.trim()}>
                {saveMutation.isPending ? 'Saving…' : editing ? 'Save changes' : 'Create project'}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      <ConfirmDialog
        open={pendingDelete != null}
        title="Delete project"
        message={
          pendingDelete
            ? `Delete "${pendingDelete.name}"? Services and databases inside it are detached (their projectId is set to null) — they are NOT deleted.`
            : ''
        }
        confirmLabel="Delete"
        onConfirm={() => pendingDelete && deleteMutation.mutate(pendingDelete.id)}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}
