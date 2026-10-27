import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { KeyRound, Pause, Play, Trash2 } from 'lucide-react';
import type { AccessGrant, AccessGrantCreate, AccessGrantRole } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { type Translate, translate, useT } from '../../lib/i18n.js';
import { useToast } from '../Toast.js';
import { Badge, Button, Card, ConfirmDialog, ErrorCard, Field, Input, Select } from '../ui.js';

const ROLES: AccessGrantRole[] = ['viewer', 'member', 'admin'];
const RANK: Record<AccessGrantRole, number> = { viewer: 0, member: 1, admin: 2 };

type TargetKind = 'project' | 'environment' | 'both';

const english: Translate = (text, vars) => translate('en', text, vars);

export const grantTargetLabel = (g: Pick<AccessGrant, 'project' | 'environment'>, t: Translate = english): string =>
  [
    g.project ? t('project {name}', { name: g.project.name }) : null,
    g.environment ? t('environment {name}', { name: g.environment.name }) : null,
  ]
    .filter(Boolean)
    .join(' · ');

/**
 * Workspace → Project & environment access (0.15, raise-only grants). A grant
 * gives one user a role on a project, an environment, or the services linked
 * to a project AND in an environment, on top of (never below) their seat.
 * A user with grants and no seat is a guest: they see only what grants cover.
 * The server enforces the cap (no higher than the caller's own role, at most
 * admin) and answers an unknown email exactly like a member add does.
 */
export function AccessGrantsCard({ workspaceId, cap }: { workspaceId: number; cap: AccessGrantRole }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [email, setEmail] = useState('');
  const [kind, setKind] = useState<TargetKind>('project');
  const [projectId, setProjectId] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [role, setRole] = useState<AccessGrantRole>('member');
  const [pendingDelete, setPendingDelete] = useState<AccessGrant | null>(null);

  const grantsKey = ['access-grants', workspaceId];
  const grants = useQuery({ queryKey: grantsKey, queryFn: () => api.accessGrants.list(workspaceId) });
  const projects = useQuery({
    queryKey: ['projects', workspaceId],
    queryFn: async () => (await api.projects.list(`?workspaceId=${workspaceId}`)) ?? [],
  });
  const environments = useQuery({ queryKey: ['environments'], queryFn: () => api.environments.list() });
  const workspaceEnvs = (environments.data ?? []).filter((e) => e.workspaceId === workspaceId);
  const grantable = ROLES.filter((r) => RANK[r] <= RANK[cap]);

  const onError = (fallback: string) => (err: unknown) => toast(err instanceof Error ? err.message : fallback, 'error');
  const refresh = () => qc.invalidateQueries({ queryKey: ['access-grants'] });

  const create = useMutation({
    mutationFn: (input: AccessGrantCreate) => api.accessGrants.create(workspaceId, input),
    onSuccess: () => {
      setEmail('');
      toast(t('Access granted'), 'success');
      void refresh();
    },
    onError: onError(t('Could not grant access')),
  });
  const update = useMutation({
    mutationFn: ({ id, role: next }: { id: number; role: AccessGrantRole }) => api.accessGrants.update(workspaceId, id, { role: next }),
    onSuccess: () => void refresh(),
    onError: onError(t('Could not change the role')),
  });
  // Suspend keeps the grant listed but stops it counting; reinstate makes it
  // count again. A grant the identity provider suspended stays suspended
  // until the provider re-enables the user (the server answers 409).
  const suspend = useMutation({
    mutationFn: ({ id, suspended }: { id: number; suspended: boolean }) => api.accessGrants.update(workspaceId, id, { suspended }),
    onSuccess: (_g, { suspended }) => {
      toast(suspended ? t('Grant suspended') : t('Grant reinstated'), 'success');
      void refresh();
    },
    onError: onError(t('Could not change the suspension')),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api.accessGrants.delete(workspaceId, id),
    onSuccess: () => {
      toast(t('Access revoked'), 'success');
      void refresh();
    },
    onError: onError(t('Could not revoke the grant')),
  });

  const needsProject = kind !== 'environment';
  const needsEnv = kind !== 'project';
  const canSubmit = email.trim() !== '' && (!needsProject || projectId !== '') && (!needsEnv || environmentId !== '');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({
      email: email.trim(),
      role,
      ...(needsProject ? { projectId: Number(projectId) } : {}),
      ...(needsEnv ? { environmentId: Number(environmentId) } : {}),
    });
  };

  return (
    <Card className="p-6">
      <div className="mb-2 flex items-center gap-2">
        <KeyRound size={18} className="text-indigo-400" />
        <h2 className="text-base font-semibold text-white">{t('Project & environment access')}</h2>
      </div>
      <p className="mb-5 text-xs text-slate-500">
        {t(
          "Raise one person's role on a project or an environment without changing their workspace seat. Someone without a seat becomes a guest: they see only the granted project or environment and what it covers, and cannot create services or databases.",
        )}
      </p>

      <form onSubmit={submit} className="mb-6 grid gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 sm:grid-cols-2 lg:grid-cols-5">
        <Field label={t('Email')}>
          <Input type="email" aria-label={t('Grant email')} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="person@example.com" />
        </Field>
        <Field label={t('Target')}>
          <Select aria-label={t('Grant target')} value={kind} onChange={(e) => setKind(e.target.value as TargetKind)}>
            <option value="project">{t('Project')}</option>
            <option value="environment">{t('Environment')}</option>
            <option value="both">{t('Project in an environment')}</option>
          </Select>
        </Field>
        {needsProject && (
          <Field label={t('Project')}>
            <Select aria-label={t('Grant project')} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Choose…</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {needsEnv && (
          <Field label={t('Environment')}>
            <Select aria-label={t('Grant environment')} value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
              <option value="">Choose…</option>
              {workspaceEnvs.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={t('Role')}>
          <Select aria-label={t('Grant role')} value={role} onChange={(e) => setRole(e.target.value as AccessGrantRole)}>
            {grantable.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-end">
          <Button type="submit" size="sm" disabled={!canSubmit || create.isPending}>
            {t('Grant access')}
          </Button>
        </div>
      </form>

      {grants.isError ? (
        <ErrorCard title={t("Couldn't load access grants")} error={grants.error} onRetry={() => grants.refetch()} />
      ) : (grants.data ?? []).length === 0 ? (
        <p className="py-4 text-center text-sm text-slate-500">{grants.isLoading ? t('Loading…') : t('No grants yet.')}</p>
      ) : (
        <div className="space-y-2">
          {(grants.data ?? []).map((g) => (
            <div key={g.id} className="flex flex-col gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-sm text-slate-200">
                  {g.user.email}
                  {g.isGuest && <Badge tone="sky">{t('guest')}</Badge>}
                  {g.suspended && <Badge tone="amber">{t('suspended')}</Badge>}
                </div>
                <div className="text-xs text-slate-500">
                  {grantTargetLabel(g, t)}
                  {g.createdBy && t(' · granted by {email}', { email: g.createdBy.email })}
                  {g.suspended && t(' · suspended: it gives no access until reinstated (a suspension by the identity provider lifts only there)')}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Select
                  aria-label={t('Role for {email}', { email: g.user.email })}
                  value={g.role}
                  disabled={RANK[g.role] > RANK[cap] || update.isPending}
                  onChange={(e) => update.mutate({ id: g.id, role: e.target.value as AccessGrantRole })}
                  className="w-28"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r} disabled={RANK[r] > RANK[cap]}>
                      {r}
                    </option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={g.suspended ? t('Reinstate access for {email}', { email: g.user.email }) : t('Suspend access for {email}', { email: g.user.email })}
                  title={g.suspended ? t('Reinstate') : t('Suspend')}
                  disabled={RANK[g.role] > RANK[cap] || suspend.isPending}
                  onClick={() => suspend.mutate({ id: g.id, suspended: !g.suspended })}
                >
                  {g.suspended ? <Play size={14} /> : <Pause size={14} />}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('Revoke access for {email}', { email: g.user.email })}
                  disabled={RANK[g.role] > RANK[cap]}
                  onClick={() => setPendingDelete(g)}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('Revoke this grant?')}
        message={pendingDelete ? t('{email} loses the {role} role on {target}.', { email: pendingDelete.user.email, role: pendingDelete.role, target: grantTargetLabel(pendingDelete, t) }) : ''}
        confirmLabel={t('Revoke')}
        onConfirm={() => {
          if (pendingDelete) revoke.mutate(pendingDelete.id);
        }}
        onClose={() => setPendingDelete(null)}
      />
    </Card>
  );
}
