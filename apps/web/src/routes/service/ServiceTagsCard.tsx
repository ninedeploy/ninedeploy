import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, FolderKanban, Plus, Tag, X } from 'lucide-react';
import { useAuth } from '../../lib/auth.js';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Button, Field, Input, Modal, Select, cn } from '../../components/ui.js';
import type { Label, LabelColor, ProjectEntry, WorkspaceEntry } from '@ninedeploy/sdk';

const COLOR_HEX: Record<LabelColor, string> = {
  indigo: 'bg-indigo-500/20 text-indigo-200 border-indigo-500/30',
  emerald: 'bg-emerald-500/20 text-emerald-200 border-emerald-500/30',
  amber: 'bg-amber-500/20 text-amber-200 border-amber-500/30',
  rose: 'bg-rose-500/20 text-rose-200 border-rose-500/30',
  sky: 'bg-sky-500/20 text-sky-200 border-sky-500/30',
  slate: 'bg-slate-500/20 text-slate-200 border-slate-500/30',
  violet: 'bg-violet-500/20 text-violet-200 border-violet-500/30',
  lime: 'bg-lime-500/20 text-lime-200 border-lime-500/30',
};

interface ServiceTagsCardProps {
  serviceId: number;
  /** Initial values rendered without re-querying the tags endpoint. */
  initial: { projects: ProjectEntry[]; workspaces: WorkspaceEntry[]; labels: Label[] };
}

/**
 * Lets the operator / member manage the project / workspace / label tags of
 * a single service. Reads the current membership from `GET /v1/services/:id/tags`
 * and writes through `PUT /v1/services/:id/tags` (single round-trip, idempotent).
 *
 * Renders three pickers side by side. The label picker supports inline create
 * (workspace-scoped by default — operators may also create a global label).
 */
export function ServiceTagsCard({ serviceId, initial }: ServiceTagsCardProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isOperator = user?.isOperator === true;

  const { data } = useQuery({
    queryKey: ['service-tags', serviceId],
    queryFn: () => api.serviceTags.get(serviceId),
    // Use the pre-loaded initial data on the first render so this card is
    // non-blocking on the service detail page.
    initialData: initial
      ? {
          serviceId,
          projects: initial.projects,
          workspaces: initial.workspaces,
          labels: initial.labels,
        }
      : undefined,
  });

  const { data: allProjects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.projects.list() ?? [],
  });
  const { data: allWorkspaces = [] } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.workspaces.list() ?? [],
  });
  const { data: allLabels = [], refetch: refetchLabels } = useQuery({
    queryKey: ['labels'],
    queryFn: () => api.labels.list() ?? [],
  });

  const setMutation = useMutation({
    mutationFn: (next: { projectIds: number[]; workspaceIds: number[]; labelIds: number[] }) =>
      api.serviceTags.set(serviceId, next),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-tags', serviceId] });
      queryClient.invalidateQueries({ queryKey: ['services'] });
      toast('Tags updated', 'success');
    },
    onError: (err: unknown) => {
      toast(err instanceof Error ? err.message : 'Could not update tags', 'error');
    },
  });

  const [adding, setAdding] = useState<null | 'project' | 'workspace' | 'label'>(null);
  const [newLabel, setNewLabel] = useState<{ name: string; color: LabelColor; workspaceId: number | '' }>({
    name: '',
    color: 'indigo',
    workspaceId: '',
  });
  const [busy, setBusy] = useState(false);

  const current = useMemo(() => {
    return {
      projectIds: data?.projects.map((p) => p.id) ?? [],
      workspaceIds: data?.workspaces.map((w) => w.id) ?? [],
      labelIds: data?.labels.map((l) => l.id) ?? [],
    };
  }, [data]);

  const toggle = (dimension: 'projectIds' | 'workspaceIds' | 'labelIds', id: number) => {
    if (!data) return;
    const next = { ...current };
    if (next[dimension].includes(id)) {
      next[dimension] = next[dimension].filter((x) => x !== id);
    } else {
      next[dimension] = [...next[dimension], id];
    }
    setMutation.mutate(next);
  };

  const createLabel = async () => {
    if (!newLabel.name.trim()) {
      toast('Label name is required', 'error');
      return;
    }
    setBusy(true);
    try {
      const wsId = newLabel.workspaceId === '' ? null : Number(newLabel.workspaceId);
      const created = await api.labels.create({
        name: newLabel.name.trim(),
        color: newLabel.color,
        workspaceId: wsId,
      });
      await refetchLabels();
      setNewLabel({ name: '', color: 'indigo', workspaceId: '' });
      // Add the freshly minted label to the service in a single write.
      setMutation.mutate({ ...current, labelIds: [...current.labelIds, created.id] });
      setAdding(null);
      toast(`Label "${created.name}" created and added`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create label', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <Group
        title="Projects"
        icon={<FolderKanban size={14} />}
        items={data?.projects ?? []}
        allOptions={allProjects}
        getId={(p) => p.id}
        getLabel={(p) => p.name}
        getSublabel={(p) => {
          // Tags come from the resolved serviceTags response; the
          // ProjectEntry has a different shape. Just show the slug.
          return 'slug' in p ? (p as { slug: string }).slug : '';
        }}
        currentIds={current.projectIds}
        onToggle={(id) => toggle('projectIds', id)}
        onAdd={() => setAdding('project')}
      />
      <Group
        title="Workspaces"
        icon={<Building2 size={14} />}
        items={data?.workspaces ?? []}
        allOptions={allWorkspaces}
        getId={(w) => w.id}
        getLabel={(w) => w.name}
        currentIds={current.workspaceIds}
        onToggle={(id) => toggle('workspaceIds', id)}
        onAdd={() => setAdding('workspace')}
      />
      <Group
        title="Labels"
        icon={<Tag size={14} />}
        items={data?.labels ?? []}
        allOptions={allLabels}
        getId={(l) => l.id}
        getLabel={(l) => l.name}
        colorFor={(l) => COLOR_HEX[(l.color as LabelColor) ?? 'indigo'] ?? COLOR_HEX.indigo}
        currentIds={current.labelIds}
        onToggle={(id) => toggle('labelIds', id)}
        onAdd={() => setAdding('label')}
      />

      {adding === 'label' && (
        <Modal title="Create label" onClose={() => setAdding(null)}>
          <div className="space-y-3">
            <Field label="Name">
              <Input
                autoFocus
                value={newLabel.name}
                onChange={(e) => setNewLabel((s) => ({ ...s, name: e.target.value }))}
                placeholder="e.g. production"
                maxLength={40}
              />
            </Field>
            <Field label="Color">
              <Select
                value={newLabel.color}
                onChange={(e) => setNewLabel((s) => ({ ...s, color: e.target.value as LabelColor }))}
              >
                {(['indigo', 'emerald', 'amber', 'rose', 'sky', 'slate', 'violet', 'lime'] as const).map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </Select>
            </Field>
            <Field label="Workspace" hint="Operators may leave it global.">
              <Select
                value={String(newLabel.workspaceId)}
                onChange={(e) => setNewLabel((s) => ({ ...s, workspaceId: e.target.value === '' ? '' : Number(e.target.value) }))}
              >
                <option value="">{isOperator ? 'Global (no workspace)' : 'No workspace'}</option>
                {allWorkspaces.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </Select>
            </Field>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="secondary" onClick={() => setAdding(null)}>Cancel</Button>
              <Button onClick={createLabel} disabled={busy || !newLabel.name.trim()}>
                {busy ? 'Creating…' : 'Create & add'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

interface GroupProps<T> {
  title: string;
  icon: React.ReactNode;
  items: T[];
  allOptions: T[];
  getId: (item: T) => number;
  getLabel: (item: T) => string;
  getSublabel?: (item: T) => string;
  colorFor?: (item: T) => string;
  currentIds: number[];
  onToggle: (id: number) => void;
  onAdd: () => void;
}

function Group<T>({ title, icon, items, allOptions, getId, getLabel, getSublabel, colorFor, currentIds, onToggle, onAdd }: GroupProps<T>) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
          {icon}
          {title}
          <span className="ml-1 text-[10px] font-normal normal-case text-slate-500">
            ({items.length} of {allOptions.length})
          </span>
        </h3>
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center gap-0.5 text-[10px] uppercase tracking-wide text-slate-500 hover:text-slate-200"
          title="Add more"
        >
          <Plus size={11} />
          Add
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.length === 0 ? (
          <span className="text-[11px] text-slate-500">Not tagged</span>
        ) : (
          items.map((item) => {
            const id = getId(item);
            const isCurrent = currentIds.includes(id);
            const palette = colorFor?.(item);
            return (
              <button
                type="button"
                key={id}
                onClick={() => onToggle(id)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition',
                  isCurrent
                    ? palette ?? 'border-indigo-500/40 bg-indigo-500/15 text-indigo-200'
                    : 'border-slate-700 bg-slate-900/40 text-slate-500',
                )}
                title={`Click to remove (${getLabel(item)})`}
              >
                {getLabel(item)}
                {getSublabel && <span className="text-[9px] opacity-70">· {getSublabel(item)}</span>}
                {isCurrent && <X size={10} className="opacity-70" />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
