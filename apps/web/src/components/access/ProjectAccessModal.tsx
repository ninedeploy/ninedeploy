import { useQuery } from '@tanstack/react-query';
import type { ProjectAccessVia } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { Badge, Modal, Skeleton } from '../ui.js';

const VIA_LABEL: Record<ProjectAccessVia, string> = {
  operator: 'instance operator',
  seat: 'workspace seat',
  grant: 'access grant',
  creator: 'creator',
};

const VIA_TONE: Record<ProjectAccessVia, 'rose' | 'indigo' | 'sky' | 'neutral'> = {
  operator: 'rose',
  seat: 'indigo',
  grant: 'sky',
  creator: 'neutral',
};

/**
 * Project → Access (0.15): who reaches this project, with which effective
 * role, and why (`GET /v1/projects/:id/access`, project admins only). The
 * effective role is the higher of the seat and any grant: grants never lower
 * a role.
 */
export function ProjectAccessModal({ project, onClose }: { project: { id: number; name: string }; onClose: () => void }) {
  const q = useQuery({ queryKey: ['project-access', project.id], queryFn: () => api.access.project(project.id) });
  const status = (q.error as { status?: number } | null)?.status;

  return (
    <Modal title={`Access to ${project.name}`} onClose={onClose} wide>
      {q.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : q.isError ? (
        <p className="text-sm text-slate-400">
          {status === 403 || status === 404
            ? 'Only a project admin can see who has access to this project.'
            : q.error instanceof Error
              ? q.error.message
              : 'Could not load the access list.'}
        </p>
      ) : (q.data ?? []).length === 0 ? (
        <p className="text-sm text-slate-500">Nobody besides instance operators reaches this project.</p>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">
            Grants are managed under Workspaces → Project &amp; environment access. A grant on an environment of this project's
            services is not listed here.
          </p>
          {(q.data ?? []).map((e) => (
            <div key={e.user.id} className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm text-slate-200">{e.user.name ? `${e.user.name} · ${e.user.email}` : e.user.email}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {e.via.map((v) => (
                    <Badge key={v} tone={VIA_TONE[v]}>
                      {VIA_LABEL[v]}
                    </Badge>
                  ))}
                </div>
              </div>
              <span className="text-xs font-semibold capitalize text-slate-300">{e.role}</span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
