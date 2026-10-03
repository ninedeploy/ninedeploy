import { useState, type FormEvent } from 'react';
import { Building2, Check, ChevronDown, Plus, Users } from 'lucide-react';
import { Link } from 'react-router';
import { useWorkspace } from '../lib/workspace.js';
import { Badge, Button, Modal, Field, Input, Textarea, cn } from './ui.js';

export function WorkspaceSwitcher() {
  const { workspaces, currentWorkspace, switchWorkspace, createWorkspace } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    setBusy(true);
    try {
      await createWorkspace({ name: name.trim(), description: description.trim() || undefined });
      setName('');
      setDescription('');
      setShowModal(false);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
    } finally {
      setBusy(false);
    }
  };

  if (!currentWorkspace && workspaces.length === 0) return null;

  return (
    <>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="flex h-7 items-center gap-1.5 rounded-lg bg-white/[0.04] px-2.5 text-xs font-medium text-slate-300 ring-1 ring-inset ring-white/10 transition hover:bg-white/[0.08] focus:outline-none focus:ring-2 focus:ring-indigo-400/60"
        >
          <Building2 size={13} className="text-indigo-400" />
          <span className="max-w-[120px] truncate">{currentWorkspace?.name ?? 'Workspace'}</span>
          {currentWorkspace?.myRole && (
            <Badge tone="neutral" className="text-[10px] uppercase tracking-wider py-0 px-1">
              {currentWorkspace.myRole}
            </Badge>
          )}
          <ChevronDown size={12} className="text-slate-500" />
        </button>

        {open && (
          <>
            <button
              type="button"
              tabIndex={-1}
              aria-label="Close workspace menu"
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-30"
            />
            <div className="absolute left-0 top-full mt-1.5 z-40 w-64 rounded-xl border border-white/10 bg-slate-900 p-1.5 shadow-2xl backdrop-blur-md nd-fade">
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Workspaces
              </div>
              <div className="max-h-56 overflow-y-auto space-y-0.5 py-1">
                {workspaces.map((ws) => {
                  const active = ws.id === currentWorkspace?.id;
                  return (
                    <button
                      type="button"
                      key={ws.id}
                      onClick={() => {
                        switchWorkspace(ws.id);
                        setOpen(false);
                      }}
                      className={cn(
                        'flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs transition',
                        active ? 'bg-indigo-500/15 text-white font-medium' : 'text-slate-300 hover:bg-white/5 hover:text-white',
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{ws.name}</div>
                        <div className="text-[10px] text-slate-500">
                          {ws.myRole} · {ws.memberCount ?? 1} {ws.memberCount === 1 ? 'member' : 'members'}
                        </div>
                      </div>
                      {active && <Check size={14} className="shrink-0 text-indigo-400" />}
                    </button>
                  );
                })}
              </div>

              <div className="border-t border-white/5 mt-1 pt-1 space-y-0.5">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setShowModal(true);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-slate-400 hover:bg-white/5 hover:text-slate-200 transition"
                >
                  <Plus size={13} className="text-slate-400" />
                  <span>Create Workspace</span>
                </button>
                <Link
                  to="/workspaces"
                  onClick={() => setOpen(false)}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-slate-400 hover:bg-white/5 hover:text-slate-200 transition"
                >
                  <Users size={13} className="text-slate-400" />
                  <span>Manage Workspace &amp; Team</span>
                </Link>
              </div>
            </div>
          </>
        )}
      </div>

      {showModal && (
        <Modal title="Create New Workspace" onClose={() => setShowModal(false)}>
          <form onSubmit={handleCreate} className="space-y-4">
            <Field label="Workspace Name">
              <Input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Acme Production"
                autoFocus
              />
            </Field>
            <Field label="Description (optional)">
              <Textarea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Workspace for production workloads and team members."
              />
            </Field>
            {error && <p className="text-xs text-rose-400">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" onClick={() => setShowModal(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy ? 'Creating…' : 'Create Workspace'}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
