import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { MAX_SERVICE_FILE_BYTES, MAX_SERVICE_FILES, serviceFilePathProblem } from '@ninedeploy/schemas';
import type { Service } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { formatBytes, formatDateTime } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, ConfirmDialog, Field, Input, Textarea } from '../../components/ui.js';

/** What the editor holds: a new file (id null) or an existing one being changed. */
interface Draft {
  id: number | null;
  path: string;
  content: string;
}

/**
 * 0.16.3 Service → Volumes → Files: text files the panel keeps (encrypted)
 * and mounts read-only in the container, e.g. an nginx.conf or a
 * config.yaml. Docker services on the panel host or a node (0.16.5, agent
 * 0.16.5+), not Swarm; a change applies on the next deploy. Hidden on a panel
 * without the route.
 */
export function FileMountsCard({ serviceId, svc }: { serviceId: number; svc: Pick<Service, 'type' | 'serverId'> & { orchestrator?: string | null } }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<{ id: number; path: string } | null>(null);
  const files = useQuery({ queryKey: ['service-files', serviceId], queryFn: () => api.services.files.list(serviceId), retry: false });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['service-files', serviceId] });

  const open = useMutation({
    mutationFn: (id: number) => api.services.files.get(serviceId, id),
    onSuccess: (f) => setDraft({ id: f.id, path: f.path, content: f.content }),
    onError: (err: Error) => toast(err.message || 'Could not open the file', 'error'),
  });
  const save = useMutation({
    mutationFn: (d: Draft) => api.services.files.put(serviceId, { path: d.path.trim(), content: d.content }),
    onSuccess: () => {
      setDraft(null);
      refresh();
      toast('File saved — redeploy to apply', 'success');
    },
    onError: (err: Error) => toast(err.message || 'Could not save the file', 'error'),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.services.files.remove(serviceId, id),
    onSuccess: () => {
      refresh();
      toast('File removed — redeploy to apply', 'success');
    },
    onError: (err: Error) => toast(err.message || 'Could not remove the file', 'error'),
  });

  if (files.isError || !files.data) return null;
  const supported = svc.type === 'docker' && svc.orchestrator !== 'swarm';
  const list = files.data;
  const pathProblem = draft && draft.path.trim() ? (draft.path.trim().startsWith('/') ? serviceFilePathProblem(draft.path.trim()) : 'must be an absolute path') : null;
  const tooBig = draft ? new Blob([draft.content]).size > MAX_SERVICE_FILE_BYTES : false;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (draft && draft.path.trim() && !pathProblem && !tooBig) save.mutate(draft);
  };

  return (
    <Card>
      <CardBody>
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <FileText size={15} className="text-slate-500" /> Files
          </div>
          {supported && !draft && list.length < MAX_SERVICE_FILES && (
            <Button size="sm" variant="secondary" onClick={() => setDraft({ id: null, path: '', content: '' })}>
              <Plus size={13} /> Add file
            </Button>
          )}
        </div>
        <p className="mb-3 text-xs text-slate-500">
          Text files mounted read-only in the container, such as an nginx.conf or a config.yaml. Stored encrypted; a change applies on the
          next deploy.{svc.serverId != null && supported ? ' On a node they need agent 0.16.5 or newer.' : ''}
        </p>
        {!supported && (
          <p className="mb-3 rounded bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200">
            File mounts work for docker services only, not on Swarm{list.length > 0 ? '; this service will not deploy until they are removed' : ''}.
          </p>
        )}

        {draft && (
          <form onSubmit={submit} className="mb-4 space-y-3 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
            <Field label="Path in the container" error={pathProblem ?? undefined}>
              <Input
                value={draft.path}
                onChange={(e) => setDraft({ ...draft, path: e.target.value })}
                placeholder="/etc/nginx/nginx.conf"
                readOnly={draft.id !== null}
                className="font-mono text-xs"
              />
            </Field>
            <Field label="Content" error={tooBig ? `At most ${MAX_SERVICE_FILE_BYTES / 1024} KiB` : undefined}>
              <Textarea
                value={draft.content}
                onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                rows={12}
                spellCheck={false}
                className="font-mono text-xs"
              />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={!draft.path.trim() || !!pathProblem || tooBig || save.isPending}>
                {save.isPending ? 'Saving…' : 'Save file'}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </div>
          </form>
        )}

        {list.length === 0 ? (
          <p className="text-xs text-slate-600">No files.</p>
        ) : (
          <ul className="space-y-1" aria-label="Mounted files">
            {list.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.02] px-3 py-2 text-xs ring-1 ring-inset ring-white/5">
                <button
                  type="button"
                  onClick={() => open.mutate(f.id)}
                  className="min-w-0 truncate text-left font-mono text-slate-300 hover:text-white hover:underline"
                  title="Edit"
                >
                  {f.path}
                </button>
                <span className="flex shrink-0 items-center gap-3 text-slate-500">
                  {formatBytes(f.size)} · {formatDateTime(f.updatedAt)}
                  <button type="button" onClick={() => setRemoving({ id: f.id, path: f.path })} className="text-rose-400 hover:text-rose-300" aria-label={`Remove ${f.path}`}>
                    <Trash2 size={13} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
      <ConfirmDialog
        open={removing !== null}
        title="Remove this file?"
        message={`${removing?.path ?? ''} is no longer mounted after the next deploy.`}
        confirmLabel="Remove"
        onConfirm={() => {
          if (removing) remove.mutate(removing.id);
          setRemoving(null);
        }}
        onClose={() => setRemoving(null)}
      />
    </Card>
  );
}
