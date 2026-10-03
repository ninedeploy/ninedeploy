import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Filter, Plus, Tag, X } from 'lucide-react';
import { api } from '../lib/api.js';
import { useTagScope } from '../lib/projects.js';
import { useAuth } from '../lib/auth.js';
import { useWorkspace } from '../lib/workspace.js';
import { useToast } from './Toast.js';
import { Badge, Button, cn } from './ui.js';
import type { LabelColor } from '@ninedeploy/sdk';

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

/**
 * Top-bar filter chips (replaces the old project switcher).
 *
 * Three chip groups — workspace, project, label — composed with AND
 * across groups and OR within a group. Adding a new label here also creates
 * it (workspace-scoped); chips without a row in their group are filtered out
 * of the dropdown so a stale URL doesn't show empty placeholders.
 */
export function TopBarFilters() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const scope = useTagScope();
  const { workspaces, currentWorkspace, switchWorkspace } = useWorkspace();
  const isOperator = user?.isOperator === true;

  // ── Label create / chip wiring ────────────────────────────────────────
  const { data: labels = [], refetch: refetchLabels } = useQuery({
    queryKey: ['labels', currentWorkspace?.id ?? null],
    queryFn: async () => {
      return (await api.labels.list(currentWorkspace ? `?workspaceId=${currentWorkspace.id}` : '')) ?? [];
    },
  });
  const { data: projects = [] } = useQuery({
    queryKey: ['projects', currentWorkspace?.id ?? null],
    queryFn: async () => {
      return (await api.projects.list(currentWorkspace ? `?workspaceId=${currentWorkspace.id}` : '')) ?? [];
    },
  });

  const [openGroup, setOpenGroup] = useState<null | 'workspaces' | 'projects' | 'labels'>(null);
  const [newLabel, setNewLabel] = useState('');
  const [newLabelColor, setNewLabelColor] = useState<LabelColor>('indigo');
  const [busy, setBusy] = useState(false);

  const toggle = (group: 'workspaceIds' | 'projectIds' | 'labelIds', id: number) => {
    const current = scope[group];
    if (current.includes(id)) {
      if (group === 'workspaceIds') scope.setWorkspaceIds(current.filter((x) => x !== id));
      else if (group === 'projectIds') scope.setProjectIds(current.filter((x) => x !== id));
      else scope.setLabelIds(current.filter((x) => x !== id));
    } else {
      if (group === 'workspaceIds') scope.setWorkspaceIds([...current, id]);
      else if (group === 'projectIds') scope.setProjectIds([...current, id]);
      else scope.setLabelIds([...current, id]);
    }
  };

  const createLabel = async () => {
    if (!newLabel.trim()) {
      toast('Label name is required', 'error');
      return;
    }
    setBusy(true);
    try {
      const created = await api.labels.create({
        name: newLabel.trim(),
        color: newLabelColor,
        workspaceId: currentWorkspace?.id ?? null,
      });
      // Refresh BOTH label queries before selecting the new chip: the tag
      // scope prunes any id missing from its own (unscoped) `['labels']`
      // query, which would otherwise drop the chip the moment it is added.
      await Promise.all([refetchLabels(), queryClient.invalidateQueries({ queryKey: ['labels'] })]);
      scope.setLabelIds([...scope.labelIds, created.id]);
      setNewLabel('');
      toast(`Label "${created.name}" created`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create label', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2 flex-wrap text-xs">
      <span className="flex items-center gap-1 text-slate-500 mr-1">
        <Filter size={12} />
        Filter
      </span>

      {/* Workspace chip — operates on the global workspace context; this */}
      {/* is the "current workspace" pointer used by the menu. The multi- */}
      {/* select chips below scope the *list* inside that workspace.       */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpenGroup(openGroup === 'workspaces' ? null : 'workspaces')}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition',
            currentWorkspace
              ? 'border-indigo-500/40 bg-indigo-500/15 text-indigo-200'
              : 'border-slate-700 bg-slate-900/60 text-slate-400',
          )}
        >
          <span>Workspace</span>
          <span className="font-semibold">{currentWorkspace ? currentWorkspace.name : 'All'}</span>
          <ChevronDown size={11} className="opacity-70" />
        </button>
        {openGroup === 'workspaces' && (
          <Popover onClose={() => setOpenGroup(null)}>
            <div className="px-3 py-2 text-[11px] uppercase tracking-wide text-slate-500">
              Filter by additional workspaces
            </div>
            {workspaces.length === 0 ? (
              <Empty>No workspaces</Empty>
            ) : (
              <ul className="max-h-72 overflow-auto">
                {workspaces.map((w) => {
                  const checked = scope.workspaceIds.includes(w.id);
                  return (
                    <li key={w.id}>
                      <button
                        type="button"
                        onClick={() => {
                          if (currentWorkspace?.id !== w.id) switchWorkspace(w.id);
                          toggle('workspaceIds', w.id);
                        }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/5"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          readOnly
                          className="pointer-events-none h-3.5 w-3.5 rounded border-slate-600 bg-slate-800 text-indigo-500"
                        />
                        <span className="flex-1 truncate">{w.name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <Divider />
            <div className="flex justify-end gap-1 px-3 py-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  scope.setWorkspaceIds([]);
                  setOpenGroup(null);
                }}
              >
                Clear
              </Button>
            </div>
          </Popover>
        )}
      </div>

      {scope.workspaceIds.filter((id) => id !== currentWorkspace?.id).map((id) => {
        const ws = workspaces.find((w) => w.id === id);
        if (!ws) return null;
        return (
          <ActiveChip key={id} label={ws.name} onRemove={() => toggle('workspaceIds', id)} />
        );
      })}

      {/* Project chip */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpenGroup(openGroup === 'projects' ? null : 'projects')}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition',
            scope.projectIds.length > 0
              ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
              : 'border-slate-700 bg-slate-900/60 text-slate-400',
          )}
        >
          <span>Project</span>
          <span className="font-semibold">{scope.projectIds.length || 'Any'}</span>
          <ChevronDown size={11} className="opacity-70" />
        </button>
        {openGroup === 'projects' && (
          <Popover onClose={() => setOpenGroup(null)}>
            {projects.length === 0 ? (
              <Empty>No projects in this workspace</Empty>
            ) : (
              <ul className="max-h-72 overflow-auto py-1">
                {projects.map((p) => {
                  const checked = scope.projectIds.includes(p.id);
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => toggle('projectIds', p.id)}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/5"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          readOnly
                          className="pointer-events-none h-3.5 w-3.5 rounded border-slate-600 bg-slate-800 text-emerald-500"
                        />
                        <span className="flex-1 truncate">
                          <span className="block">{p.name}</span>
                          {p.workspaceName != null && p.workspaceName !== '' && (
                            <span className="block text-[10px] text-slate-500">{p.workspaceName}</span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <Divider />
            <div className="flex justify-end gap-1 px-3 py-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  scope.setProjectIds([]);
                  setOpenGroup(null);
                }}
              >
                Clear
              </Button>
            </div>
          </Popover>
        )}
      </div>

      {scope.projectIds.map((id) => {
        const p = projects.find((proj) => proj.id === id);
        return (
          <ActiveChip
            key={id}
            label={p?.name ?? `Project #${String(id)}`}
            tone="emerald"
            onRemove={() => toggle('projectIds', id)}
          />
        );
      })}

      {/* Label chip — supports inline-create (workspace-scoped by default) */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpenGroup(openGroup === 'labels' ? null : 'labels')}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition',
            scope.labelIds.length > 0
              ? 'border-amber-500/40 bg-amber-500/15 text-amber-200'
              : 'border-slate-700 bg-slate-900/60 text-slate-400',
          )}
        >
          <Tag size={10} />
          <span>Label</span>
          <span className="font-semibold">{scope.labelIds.length || 'Any'}</span>
          <ChevronDown size={11} className="opacity-70" />
        </button>
        {openGroup === 'labels' && (
          <Popover onClose={() => setOpenGroup(null)} widthClass="w-72">
            {labels.length === 0 ? (
              <Empty>No labels yet</Empty>
            ) : (
              <ul className="max-h-64 overflow-auto py-1">
                {labels.map((l) => {
                  const checked = scope.labelIds.includes(l.id);
                  const tone = COLOR_HEX[(l.color as LabelColor) ?? 'indigo'] ?? COLOR_HEX.indigo;
                  return (
                    <li key={l.id}>
                      <button
                        type="button"
                        onClick={() => toggle('labelIds', l.id)}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/5"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          readOnly
                          className="pointer-events-none h-3.5 w-3.5 rounded border-slate-600 bg-slate-800 text-amber-500"
                        />
                        <Badge tone="amber" className={cn('border', tone)}>
                          {l.name}
                        </Badge>
                        {l.workspaceId == null && <span className="text-[10px] text-slate-500">global</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {isOperator || currentWorkspace ? (
              <>
                <Divider />
                <div className="px-3 py-2 space-y-1.5">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">Create new label</div>
                  <div className="flex items-center gap-1.5">
                    <input
                      value={newLabel}
                      onChange={(e) => setNewLabel(e.target.value)}
                      placeholder="e.g. production"
                      className="flex-1 rounded-lg border border-slate-700 bg-slate-900/60 px-2 py-1 text-xs outline-none focus:border-amber-500"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') createLabel();
                      }}
                    />
                    <select
                      value={newLabelColor}
                      onChange={(e) => setNewLabelColor(e.target.value as LabelColor)}
                      className="rounded-lg border border-slate-700 bg-slate-900/60 px-1.5 py-1 text-xs outline-none"
                    >
                      {(['indigo', 'emerald', 'amber', 'rose', 'sky', 'slate', 'violet', 'lime'] as const).map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                    <Button size="sm" onClick={createLabel} disabled={busy || !newLabel.trim()}>
                      <Plus size={12} />
                    </Button>
                  </div>
                </div>
              </>
            ) : null}
            <Divider />
            <div className="flex justify-end gap-1 px-3 py-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  scope.setLabelIds([]);
                  setOpenGroup(null);
                }}
              >
                Clear
              </Button>
            </div>
          </Popover>
        )}
      </div>

      {scope.labelIds.map((id) => {
        const l = labels.find((lab) => lab.id === id);
        const tone = l ? COLOR_HEX[(l.color as LabelColor) ?? 'indigo'] ?? COLOR_HEX.indigo : COLOR_HEX.indigo;
        return (
          <Badge key={id} tone="amber" className={cn('inline-flex items-center gap-1 border px-2 py-0.5', tone)}>
            {l?.name ?? `Label #${String(id)}`}
            <button
              type="button"
              onClick={() => toggle('labelIds', id)}
              className="ml-0.5 -mr-1 rounded-full p-0.5 hover:bg-white/10"
              aria-label="Remove label filter"
            >
              <X size={10} />
            </button>
          </Badge>
        );
      })}

      {scope.isFiltered && (
        <button
          type="button"
          onClick={() => scope.clearAll()}
          className="ml-1 text-[10px] uppercase tracking-wide text-slate-500 hover:text-rose-300 transition"
        >
          Clear all
        </button>
      )}
    </div>
  );
}

function Popover({
  children,
  onClose,
  widthClass = 'w-60',
}: {
  children: React.ReactNode;
  onClose: () => void;
  widthClass?: string;
}) {
  return (
    <div className={`absolute right-0 z-30 mt-1 ${widthClass} rounded-lg border border-slate-700 bg-slate-900/95 shadow-2xl backdrop-blur`}>
      <div onClick={(e) => e.stopPropagation()}>{children}</div>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute -top-2 -right-2 hidden h-4 w-4 items-center justify-center rounded-full bg-slate-800 text-slate-500"
      />
    </div>
  );
}

function ActiveChip({
  label,
  tone = 'indigo',
  onRemove,
}: {
  label: string;
  tone?: 'indigo' | 'emerald';
  onRemove: () => void;
}) {
  const palette =
    tone === 'emerald'
      ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
      : 'border-indigo-500/40 bg-indigo-500/15 text-indigo-200';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${palette}`}>
      {label}
      <button
        type="button"
        onClick={onRemove}
        className="-mr-1 ml-0.5 rounded-full p-0.5 hover:bg-white/10"
        aria-label="Remove"
      >
        <X size={10} />
      </button>
    </span>
  );
}

function Divider() {
  return <div className="h-px bg-white/5" />;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-3 text-[11px] text-slate-500">{children}</div>;
}
