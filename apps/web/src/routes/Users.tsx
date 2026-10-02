import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Link2 as LinkIcon, ShieldCheck, Trash2, UserPlus, Users as UsersIcon, Building2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useToast } from '../components/Toast.js';
import { Card, ConfirmDialog, EmptyState, ErrorCard, PageHeader, Skeleton, cn } from '../components/ui.js';
import { formatDateTime, useCopy } from '../lib/format.js';

/**
 * People view (post team-overhaul).
 *
 * The legacy "Role" column is gone — there is no global `users.role` anymore.
 * Every user is an operator when they own/admin at least one workspace; the
 * column now shows that badge plus how many workspaces they belong to. Role
 * changes go through the workspace membership page (`/workspaces`).
 */
export function Users() {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const { toast } = useToast();
  const { copy } = useCopy();
  const list = useQuery({
    queryKey: ['users'],
    queryFn: () => api.users.list(),
    // Instance-wide user management is operator-only (r472).
    enabled: me?.isOperator === true,
  });

  // ── Operator user creation ───────────────────────────────────────────────
  const [showAdd, setShowAdd] = useState(false);
  const [addEmail, setAddEmail] = useState('');
  const [addName, setAddName] = useState('');
  const [addPassword, setAddPassword] = useState('');
  const createUser = useMutation({
    mutationFn: () =>
      api.users.create({
        email: addEmail.trim(),
        password: addPassword,
        name: addName.trim() || undefined,
      }),
    onSuccess: (u) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      setShowAdd(false);
      setAddEmail('');
      setAddName('');
      setAddPassword('');
      toast(`User ${u.email} created — invite them into a workspace from /workspaces`, 'success');
    },
    onError: () => toast('Could not create the user (email taken?)', 'error'),
  });
  const submitCreate = () => {
    if (!/^\S+@\S+\.\S+$/.test(addEmail.trim())) {
      toast('Enter a valid email', 'error');
      return;
    }
    if (addPassword.length < 8) {
      toast('Password must be at least 8 characters', 'error');
      return;
    }
    createUser.mutate();
  };

  const remove = useMutation({
    mutationFn: (id: number) => api.users.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast('User deleted', 'success');
    },
    onError: () => toast('Could not delete the user', 'error'),
  });

  // ── Operator password reset ────────────────────────────────────────────
  const [resetFor, setResetFor] = useState<number | null>(null);
  const [resetPw, setResetPw] = useState('');
  const resetPassword = useMutation({
    mutationFn: ({ id, newPassword }: { id: number; newPassword: string }) => api.users.resetPassword(id, { newPassword }),
    onSuccess: () => {
      setResetFor(null);
      setResetPw('');
      toast('Password reset — the user must sign in again', 'success');
    },
    onError: () => toast('Password reset failed', 'error'),
  });
  const submitReset = () => {
    if (resetPw.length < 8) {
      toast('Password must be at least 8 characters', 'error');
      return;
    }
    // The Save button only renders while a reset row is open, so resetFor is set.
    resetPassword.mutate({ id: resetFor as number, newPassword: resetPw });
  };

  // ── One-time reset link (works without an email channel) ──────────────
  const [revealedLink, setRevealedLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    id: number;
    email: string;
    ownedWorkspaces?: Array<{ id: number; name: string }>;
  } | null>(null);
  // Instance-operator flag. This is NOT a workspace role: it gates the
  // operator-only routes and the host-privilege boundary (PM2/compose deploys,
  // lifecycle hooks, docker-socket templates). Creating a workspace used to
  // confer it implicitly; it is now granted explicitly, here.
  const setOperator = useMutation({
    mutationFn: ({ id, isOperator }: { id: number; isOperator: boolean }) =>
      api.users.setOperator(id, isOperator),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });
  // Granting instance-operator is full host control (host-privileged deploys,
  // exec, the Docker socket) — a single misclick on a member row used to
  // grant it, while deleting a user asks for a typed confirmation.
  const [pendingOperator, setPendingOperator] = useState<{ id: number; name: string; grant: boolean } | null>(null);

  const resetLink = useMutation({
    mutationFn: (id: number) => api.users.resetLink(id),
    onSuccess: (res) => setRevealedLink(res),
    onError: () => toast('Could not generate the reset link', 'error'),
  });
  const copyLink = async (url: string) => {
    const ok = await copy(url);
    if (ok) toast('Reset link copied', 'success');
    else toast('Copy failed — select the link manually', 'error');
  };

  // r472: people management is operator-only server-side — a member landing
  // here directly gets the honest one-liner instead of an error card.
  if (!me?.isOperator) {
    return <PageHeader icon={<UsersIcon size={18} />} title="People" subtitle="Instance user management — operators only." />;
  }

  return (
    <div className="max-w-3xl">
      <PageHeader
        icon={<UsersIcon size={18} />}
        title="People"
        subtitle="Manage operators and team members. Roles live in workspaces, not here."
      />

      {revealedLink && (
        <Card className="mb-4 border-amber-500/30">
          <div className="p-4">
            <p className="text-xs font-medium text-amber-200">
              Copy this one-time link now — it is shown only once and expires{' '}
              {formatDateTime(revealedLink.expiresAt)}.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-black/40 px-2 py-1.5 font-mono text-[11px] text-amber-100">
                {revealedLink.url}
              </code>
              <button type="button" onClick={() => copyLink(revealedLink.url)} className="shrink-0 text-xs font-medium text-amber-200 hover:text-amber-100">
                Copy
              </button>
              <button type="button" onClick={() => setRevealedLink(null)} className="shrink-0 text-xs text-amber-200/70 hover:underline">
                Done
              </button>
            </div>
          </div>
        </Card>
      )}

      {/* Add-user form (operator) */}
      <Card className="mb-4">
        <div className="p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
              <UserPlus size={14} /> Add user
            </h2>
            <button type="button"
              onClick={() => setShowAdd(!showAdd)}
              className="rounded-lg bg-white/[0.04] px-3 py-1.5 text-xs text-slate-400 transition hover:bg-white/[0.08] hover:text-slate-200"
            >
              {showAdd ? 'Cancel' : 'New user…'}
            </button>
          </div>
          {showAdd && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input value={addEmail} onChange={(e) => setAddEmail(e.target.value)}
                placeholder="email@example.com" aria-label="New user email"
                className="w-56 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-xs outline-none focus:border-indigo-500" />
              <input value={addName} onChange={(e) => setAddName(e.target.value)}
                placeholder="name (optional)" aria-label="New user name"
                className="w-40 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-xs outline-none focus:border-indigo-500" />
              <input value={addPassword} onChange={(e) => setAddPassword(e.target.value)}
                type="password" placeholder="password (min 8)" aria-label="New user password"
                className="w-44 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-xs outline-none focus:border-indigo-500" />
              <button type="button" onClick={submitCreate} disabled={createUser.isPending}
                className="rounded-lg bg-[var(--nd-accent)] px-4 py-1.5 text-xs font-semibold text-black transition hover:brightness-110 disabled:opacity-50">
                {createUser.isPending ? 'Creating…' : 'Create user'}
              </button>
            </div>
          )}
        </div>
      </Card>

      {list.isLoading ? (
        <Card className="p-5"><Skeleton className="h-10 w-full" /></Card>
      ) : list.isError ? (
        <ErrorCard title="Couldn't load users" error={list.error} onRetry={() => list.refetch()} />
      ) : !list.data || list.data.length === 0 ? (
        <Card><EmptyState icon={<UsersIcon size={26} />} title="No users" /></Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/5 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3 font-medium">User</th>
                <th className="px-5 py-3 font-medium">Workspaces</th>
                <th className="px-5 py-3 font-medium">Access</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {list.data.map((u) => {
                const isMe = u.id === me?.id;
                return (
                  <tr key={u.id} className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="grid h-8 w-8 place-items-center rounded-full bg-indigo-500/20 text-xs font-semibold text-indigo-300 ring-1 ring-inset ring-indigo-500/30">
                          {(u.email)[0]?.toUpperCase()}
                        </div>
                        <div>
                          <div className="font-medium text-slate-200">
                            {u.email} {isMe && <span className="text-xs text-slate-500">(you)</span>}
                          </div>
                          {u.name && <div className="text-xs text-slate-500">{u.name}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <span className="inline-flex items-center gap-1.5 text-xs text-slate-300">
                        <Building2 size={11} className="text-slate-500" />
                        {u.workspaceCount} {u.workspaceCount === 1 ? 'workspace' : 'workspaces'}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
                          u.isOperator
                            ? 'bg-indigo-500/15 text-indigo-300 ring-indigo-500/20'
                            : 'bg-slate-500/15 text-slate-300 ring-slate-500/20',
                        )}
                        title={
                          u.isOperator
                            ? 'Instance operator — full access, including host-privileged deploys'
                            : 'Regular user — access comes from workspace membership only'
                        }
                      >
                        {u.isOperator ? <ShieldCheck size={11} /> : null}
                        {u.isOperator ? 'Operator' : 'Member'}
                      </span>
                      {!isMe && (
                        <button
                          type="button"
                          onClick={() => setPendingOperator({ id: u.id, name: u.name || u.email, grant: !u.isOperator })}
                          disabled={setOperator.isPending}
                          className="ml-2 text-xs text-slate-500 underline-offset-2 transition hover:text-indigo-300 hover:underline"
                          title={
                            u.isOperator
                              ? 'Revoke instance-operator access'
                              : 'Grant instance-operator access (full control of this server)'
                          }
                        >
                          {u.isOperator ? 'Revoke' : 'Make operator'}
                        </button>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-3">
                        {!isMe && (
                          <>
                            {resetFor === u.id ? (
                              <span className="inline-flex items-center gap-1.5">
                                <input
                                  type="password"
                                  value={resetPw}
                                  onChange={(e) => setResetPw(e.target.value)}
                                  placeholder="new password (min 8)"
                                  className="w-44 rounded-lg border border-slate-700 bg-slate-900/60 px-2 py-1 text-xs outline-none focus:border-indigo-500"
                                />
                                <button type="button"
                                  onClick={submitReset}
                                  disabled={resetPassword.isPending}
                                  className="text-xs font-medium text-emerald-400 transition hover:brightness-125"
                                  title="Apply the new password"
                                >
                                  {resetPassword.isPending ? 'Saving…' : 'Save'}
                                </button>
                                <button type="button"
                                  onClick={() => { setResetFor(null); setResetPw(''); }}
                                  className="text-xs text-slate-500 transition hover:text-slate-300"
                                >
                                  Cancel
                                </button>
                              </span>
                            ) : (
                              <>
                                <button type="button"
                                  onClick={() => { setResetFor(u.id); setResetPw(''); }}
                                  className="text-slate-600 transition hover:text-amber-400"
                                  title="Reset password (signs the user out everywhere)"
                                >
                                  <KeyRound size={14} />
                                </button>
                                <button type="button"
                                  onClick={() => resetLink.mutate(u.id)}
                                  disabled={resetLink.isPending}
                                  className="text-slate-600 transition hover:text-indigo-300"
                                  title="Generate a one-time reset link (no email needed)"
                                >
                                  <LinkIcon size={14} />
                                </button>
                              </>
                            )}
                            <button type="button"
                              onClick={() => setPendingDelete({ id: u.id, email: u.email, ownedWorkspaces: u.ownedWorkspaces })}
                              className="text-slate-600 transition hover:text-rose-400"
                              title="Delete user"
                            >
                              <Trash2 size={14} />
                            </button>
                          </>
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
      <p className="mt-3 text-xs text-slate-600">
        New users are created without any workspace membership. Open{' '}
        <code className="text-slate-400">/workspaces</code> to invite them into a workspace and pick a role.
      </p>

      <ConfirmDialog
        open={pendingDelete != null}
        title="Delete user"
        message={`Delete ${pendingDelete?.email}? Their sessions, API tokens and workspace memberships are removed.${
          // r540: owned workspaces are handed to you, not deleted with the user.
          pendingDelete?.ownedWorkspaces?.length
            ? ` Ownership of ${pendingDelete.ownedWorkspaces.map((w) => w.name).join(', ')} transfers to you.`
            : ''
        } Services and databases they own inside a workspace go to its owner.`}
        confirmLabel="Delete"
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
        onClose={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={pendingOperator != null}
        title={pendingOperator?.grant ? 'Grant instance-operator?' : 'Revoke instance-operator?'}
        message={
          pendingOperator?.grant
            ? `${pendingOperator.name} gains FULL control of this server: host-privileged deploys (PM2, compose, lifecycle hooks), the exec terminal, volumes and the Docker socket — on every workspace and service.`
            : `${pendingOperator?.name} loses instance-operator access. Workspace-level roles are unaffected. Deploys that need host privilege will refuse for them afterwards.`
        }
        confirmLabel={pendingOperator?.grant ? 'Grant' : 'Revoke'}
        onConfirm={() => pendingOperator && setOperator.mutate({ id: pendingOperator.id, isOperator: pendingOperator.grant })}
        onClose={() => setPendingOperator(null)}
      />
    </div>
  );
}
