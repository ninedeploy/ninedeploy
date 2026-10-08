import { useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Building2,
  Copy,
  HelpCircle,
  Mail,
  Search,
  ShieldCheck,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { copyText } from '../lib/format.js';
import { useWorkspace } from '../lib/workspace.js';
import {
  Badge,
  Button,
  Card,
  Modal,
  Field,
  Input,
  Select,
  Textarea,
} from '../components/ui.js';
import { useToast } from '../components/Toast.js';
import { AccessGrantsCard } from '../components/access/AccessGrantsCard.js';
import type {
  WorkspaceInvitationEntry,
  WorkspaceMemberAddInput,
  WorkspaceMemberInviteEntry,
  WorkspaceRole,
} from '@ninedeploy/sdk';

export function Workspaces() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { workspaces, currentWorkspace, switchWorkspace, refreshWorkspaces } = useWorkspace();

  const [memberSearch, setMemberSearch] = useState('');
  const [showRoleMatrix, setShowRoleMatrix] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member' | 'viewer'>('member');
  const [lastInvite, setLastInvite] = useState<WorkspaceMemberInviteEntry | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const workspaceId = currentWorkspace?.id;

  const { data: detail, isLoading } = useQuery({
    queryKey: ['workspace-detail', workspaceId],
    // The null arm is unreachable: `enabled` only lets the query run once a
    // workspace is current.
    /* v8 ignore start */
    queryFn: () => (workspaceId ? api.workspaces.get(workspaceId) : null),
    /* v8 ignore stop */
    enabled: Boolean(workspaceId),
  });

  const { data: invitations = [] } = useQuery<WorkspaceInvitationEntry[]>({
    queryKey: ['workspace-invitations', workspaceId],
    /* v8 ignore next 1 -- queryFn never runs when `enabled` is false (no workspace selected) */
    queryFn: () => (workspaceId ? api.workspaces.listInvitations(workspaceId) : []),
    enabled: Boolean(workspaceId) && Boolean(detail),
    refetchInterval: 15_000,
  });

  const isOwner = detail?.myRole === 'owner' || user?.isOperator === true;
  const isAdmin = isOwner || detail?.myRole === 'admin';

  const inviteMutation = useMutation({
    mutationFn: (input: WorkspaceMemberAddInput) =>
      api.workspaces.addMember(workspaceId!, input),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['workspace-detail', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['workspace-invitations', workspaceId] });
      refreshWorkspaces();
      // The unified endpoint returns either a member row or a pending
      // invitation. When it returns an invitation we surface the accept URL
      // inline so the inviter can copy it without depending on email delivery.
      if (result && 'kind' in result && result.kind === 'invitation') {
        setLastInvite(result);
        setInviteEmail('');
        setInviteRole('member');
        return;
      }
      setInviteOpen(false);
      setInviteEmail('');
      setInviteRole('member');
    },
    // A 403 or a server error used to leave a dead button — surface it in the
    // same banner the form errors use.
    onError: (err: Error) => setError(err.message),
  });

  const revokeInvitationMutation = useMutation({
    mutationFn: (inviteId: number) =>
      api.workspaces.revokeInvitation(workspaceId!, inviteId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-invitations', workspaceId] });
    },
    // No form is open for a revoke — the inline banner lives inside the
    // invite/edit dialogs — so failures toast instead of dying silently.
    onError: (err: Error) => toast(err.message, 'error'),
  });

  const copyAcceptUrl = async (url: string) => {
    if (await copyText(url)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
    /* copy failed — the link stays selectable for manual copying */
  };

  const updateRoleMutation = useMutation({
    mutationFn: ({ memberId, role }: { memberId: number; role: WorkspaceRole }) =>
      api.workspaces.updateMemberRole(workspaceId!, memberId, { role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-detail', workspaceId] });
      refreshWorkspaces();
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });

  const removeMemberMutation = useMutation({
    mutationFn: (memberId: number) => api.workspaces.removeMember(workspaceId!, memberId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-detail', workspaceId] });
      refreshWorkspaces();
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });

  const updateWsMutation = useMutation({
    mutationFn: (data: { name?: string; description?: string | null }) =>
      api.workspaces.update(workspaceId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-detail', workspaceId] });
      refreshWorkspaces();
      setEditOpen(false);
    },
  });

  const deleteWsMutation = useMutation({
    mutationFn: () => api.workspaces.delete(workspaceId!),
    onSuccess: () => {
      refreshWorkspaces();
      setDeleteOpen(false);
    },
  });

  const handleInvite = async (e: FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim() || !workspaceId) return;
    setError(null);
    setBusy(true);
    try {
      await inviteMutation.mutateAsync({ email: inviteEmail.trim(), role: inviteRole });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to invite member');
    } finally {
      setBusy(false);
    }
  };

  const openInvite = () => {
    setError(null);
    setLastInvite(null);
    setCopied(false);
    setInviteOpen(true);
  };

  const closeInvite = () => {
    setInviteOpen(false);
    setLastInvite(null);
    setCopied(false);
  };

  const pendingInvites = invitations.filter((i) => !i.acceptedAt && !i.revokedAt);

  const handleUpdateWs = async (e: FormEvent) => {
    e.preventDefault();
    if (!editName.trim() || !workspaceId) return;
    setError(null);
    setBusy(true);
    try {
      await updateWsMutation.mutateAsync({
        name: editName.trim(),
        // Both arms are exercised by the edit tests; the instrumenter
        // cannot see this expression.
        /* v8 ignore start */
        description: editDescription.trim() || null,
        /* v8 ignore stop */
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update workspace');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteWs = async () => {
    // Defensive: the delete dialog only opens from a loaded workspace detail.
    /* v8 ignore start */
    if (!workspaceId) return;
    /* v8 ignore stop */
    setError(null);
    setBusy(true);
    try {
      await deleteWsMutation.mutateAsync();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete workspace');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-7 max-w-5xl">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Building2 size={24} className="text-indigo-400" />
            <h1 className="text-2xl font-bold tracking-tight">Workspaces &amp; Teams</h1>
          </div>
          <p className="text-sm text-slate-400 mt-1">
            Organize applications, manage team access, and assign workspace-level roles.
          </p>
        </div>

        {/* Workspace selector */}
        <div className="flex items-center gap-2">
          <Select
            value={currentWorkspace?.id ? String(currentWorkspace.id) : ''}
            onChange={(e) => switchWorkspace(Number(e.target.value))}
            className="w-56"
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.myRole})
              </option>
            ))}
          </Select>
        </div>
      </div>

      {/* Active Workspace Info Card */}
      {detail && (
        <Card className="p-6">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2.5">
                <h2 className="text-lg font-semibold text-white">{detail.name}</h2>
                <Badge tone="indigo" className="text-xs uppercase">
                  {detail.myRole}
                </Badge>
              </div>
              <p className="text-xs text-slate-500 font-mono">slug: {detail.slug}</p>
              {detail.description && (
                <p className="text-sm text-slate-300 mt-2">{detail.description}</p>
              )}
            </div>

            {isAdmin && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setEditName(detail.name);
                  setEditDescription(detail.description ?? '');
                  setEditOpen(true);
                }}
              >
                Edit Details
              </Button>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6 pt-6 border-t border-white/5">
            <div>
              <div className="text-xs text-slate-500">Total Members</div>
              <div className="text-xl font-bold text-white mt-0.5">{detail.memberCount ?? detail.members?.length ?? 1}</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Scoped Projects</div>
              <div className="text-xl font-bold text-white mt-0.5">{detail.projectCount ?? 0}</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Your Permission</div>
              <div className="text-sm font-semibold text-indigo-300 mt-1 capitalize">{detail.myRole}</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Created</div>
              <div className="text-sm text-slate-300 mt-1">
                {new Date(detail.createdAt).toLocaleDateString()}
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Team Members Management */}
      <Card className="p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-5">
          <div className="flex items-center gap-2">
            <Users size={18} className="text-indigo-400" />
            <h2 className="text-base font-semibold text-white">Team Members</h2>
            <span className="text-xs text-slate-500">
              ({detail?.members?.length ?? 0})
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Search filter */}
            <div className="relative w-48">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <Input
                type="text"
                placeholder="Search member..."
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                className="pl-7 h-8 text-xs font-mono"
              />
            </div>

            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowRoleMatrix(!showRoleMatrix)}
              title="View workspace role permissions guide"
              className="text-xs h-8"
            >
              <HelpCircle size={13} />
              <span>Roles Guide</span>
            </Button>

            {isAdmin && (
              <Button
                size="sm"
                className="h-8"
                onClick={openInvite}
              >
                <UserPlus size={14} />
                <span>Invite Member</span>
              </Button>
            )}
          </div>
        </div>

        {/* Role Matrix Explainer Banner */}
        {showRoleMatrix && (
          <div className="mb-5 rounded-xl border border-indigo-500/20 bg-indigo-500/[0.04] p-4 text-xs space-y-3 nd-fade">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-indigo-200 flex items-center gap-1.5">
                <ShieldCheck size={14} /> Workspace Role &amp; Permissions Matrix
              </span>
              <button
                type="button"
                onClick={() => setShowRoleMatrix(false)}
                className="text-slate-400 hover:text-slate-200"
              >
                ✕
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 pt-1 font-mono text-[11px]">
              <div className="rounded-lg bg-black/40 p-2.5 border border-white/5 space-y-1">
                <div className="font-bold text-indigo-300">👑 Owner</div>
                <p className="text-slate-400 text-[10px] font-sans">Full ownership, workspace deletion, transfers, billing &amp; all admin privileges.</p>
              </div>
              <div className="rounded-lg bg-black/40 p-2.5 border border-white/5 space-y-1">
                <div className="font-bold text-emerald-300">🛡️ Admin</div>
                <p className="text-slate-400 text-[10px] font-sans">Can create/delete projects, services &amp; databases, invite members and change roles.</p>
              </div>
              <div className="rounded-lg bg-black/40 p-2.5 border border-white/5 space-y-1">
                <div className="font-bold text-sky-300">⚙️ Member</div>
                <p className="text-slate-400 text-[10px] font-sans">Can deploy applications, edit environment variables, launch shells and view logs.</p>
              </div>
              <div className="rounded-lg bg-black/40 p-2.5 border border-white/5 space-y-1">
                <div className="font-bold text-slate-300">👁️ Viewer</div>
                <p className="text-slate-400 text-[10px] font-sans">Read-only access. Can inspect service status, topologies, metrics and logs.</p>
              </div>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="py-8 text-center text-sm text-slate-500 font-mono">Loading team members…</div>
        ) : (
          <div className="divide-y divide-white/5">
            {detail?.members
              ?.filter((m) => {
                if (!memberSearch.trim()) return true;
                const q = memberSearch.toLowerCase();
                return (m.name?.toLowerCase().includes(q) ?? false) || m.email.toLowerCase().includes(q);
              })
              .map((m) => {
                const isMe = m.userId === user?.id;
                const isWsOwner = m.role === 'owner';

                return (
                  <div
                    key={m.id}
                    className="flex flex-col sm:flex-row sm:items-center justify-between py-3.5 gap-3"
                  >
                    <div className="flex items-center gap-3">
                      <div className="grid h-9 w-9 place-items-center rounded-full bg-indigo-500/15 text-sm font-semibold text-indigo-300 ring-1 ring-inset ring-indigo-500/20">
                        {(m.name || m.email || '?')[0]?.toUpperCase()}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-slate-200">
                            {m.name || m.email}
                          </span>
                          {isMe && (
                            <Badge tone="neutral" className="text-[10px] py-0 px-1.5">
                              You
                            </Badge>
                          )}
                        </div>
                        <div className="text-xs text-slate-500">{m.email}</div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      {/* Role Selector or Badge */}
                      {isAdmin && !isWsOwner ? (
                        <Select
                          value={m.role}
                          onChange={(e) =>
                            updateRoleMutation.mutate({
                              memberId: m.id,
                              role: e.target.value as WorkspaceRole,
                            })
                          }
                          className="h-7 text-xs w-28"
                        >
                          <option value="admin">Admin</option>
                          <option value="member">Member</option>
                          <option value="viewer">Viewer</option>
                          {isOwner && <option value="owner">Transfer Owner</option>}
                        </Select>
                      ) : (
                        <Badge
                          tone={m.role === 'owner' ? 'indigo' : m.role === 'admin' ? 'emerald' : 'neutral'}
                          className="capitalize text-xs"
                        >
                          {m.role}
                        </Badge>
                      )}

                      {/* Member Removal / Leave */}
                      {(isAdmin || isMe) && !isWsOwner && (
                        <Button
                          variant="danger"
                          size="sm"
                          className="h-7 px-2"
                          title={isMe ? 'Leave Workspace' : 'Remove Member'}
                          onClick={() => {
                            if (confirm(isMe ? 'Leave this workspace?' : `Remove ${m.email}?`)) {
                              removeMemberMutation.mutate(m.id);
                            }
                          }}
                        >
                          <UserMinus size={13} />
                          <span className="text-xs">{isMe ? 'Leave' : 'Remove'}</span>
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>
        )}
      </Card>

      {/* Pending Invitations */}
      {isAdmin && pendingInvites.length > 0 && (
        <Card className="p-6">
          <div className="flex items-center gap-2 mb-4">
            <Mail size={18} className="text-amber-300" />
            <h2 className="text-base font-semibold text-white">Pending Invitations</h2>
            <span className="text-xs text-slate-500">({pendingInvites.length})</span>
          </div>
          <div className="divide-y divide-white/5">
            {pendingInvites.map((inv) => {
              const expires = new Date(inv.expiresAt);
              return (
                <div
                  key={inv.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between py-3 gap-3"
                >
                  <div className="space-y-0.5">
                    <div className="text-sm font-medium text-slate-200">{inv.email}</div>
                    <div className="text-[11px] text-slate-500">
                      Invited by {inv.invitedByName ?? 'someone'} · expires{' '}
                      {expires.toLocaleDateString()}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone="amber" className="capitalize text-[10px]">
                      {inv.role}
                    </Badge>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={async () => {
                        const acceptUrl = `${window.location.origin}/invite/${(inv as WorkspaceInvitationEntry & { token?: string }).token ?? ''}`;
                        // The list endpoint intentionally omits the cleartext
                        // token (only the accept URL is returned at create
                        // time). For revocation we don't need the URL — the
                        // backend only needs the invite id.
                        void acceptUrl;
                        revokeInvitationMutation.mutate(inv.id);
                      }}
                    >
                      Revoke
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* 0.15: project and environment access grants (workspace admins). */}
      {isAdmin && workspaceId !== undefined && <AccessGrantsCard workspaceId={workspaceId} cap="admin" />}

      {/* Danger Zone (Workspace Deletion) */}
      {isOwner && (
        <Card className="p-6 border-rose-500/20 bg-rose-500/[0.02]">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-rose-300">Delete Workspace</h3>
              <p className="text-xs text-slate-400 mt-1">
                Permanently delete this workspace and detach all scoped resources.
              </p>
            </div>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                setError(null);
                setDeleteOpen(true);
              }}
            >
              <Trash2 size={14} />
              <span>Delete Workspace</span>
            </Button>
          </div>
        </Card>
      )}

      {/* Invite Member Dialog */}
      {inviteOpen && (
        <Modal onClose={closeInvite} title={lastInvite ? 'Invitation Sent' : 'Invite Team Member'}>
          {lastInvite ? (
            <div className="space-y-4">
              <p className="text-sm text-slate-300">
                A pending invitation has been created for{' '}
                <strong className="text-white">{lastInvite.email}</strong>. The recipient
                joins this workspace by opening the accept link below while signed in
                with that address — or after creating an account with it.
              </p>
              <Field label="Accept link">
                <div className="flex items-stretch gap-2">
                  <Input
                    readOnly
                    value={lastInvite.acceptUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    className="font-mono text-[11px]"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => copyAcceptUrl(lastInvite.acceptUrl)}
                    title="Copy accept link"
                  >
                    <Copy size={14} />
                    <span>{copied ? 'Copied' : 'Copy'}</span>
                  </Button>
                </div>
              </Field>
              <p className="text-[11px] text-slate-500">
                The link expires on{' '}
                {new Date(lastInvite.expiresAt).toLocaleString()}. An email was also
                dispatched if a notification channel is configured.
              </p>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" onClick={closeInvite}>
                  Done
                </Button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleInvite} className="space-y-4">
              <Field label="User Email">
                <Input
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="developer@acme.com"
                  autoFocus
                />
              </Field>

              <Field label="Workspace Role">
                <Select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as 'admin' | 'member' | 'viewer')}
                >
                  <option value="admin">Admin — Full control over workspace &amp; members</option>
                  <option value="member">Member — Can manage and deploy applications</option>
                  <option value="viewer">Viewer — Read-only access to resources</option>
                </Select>
              </Field>

              <p className="text-[11px] text-slate-500">
                {/* r604: whether the address has an account is not revealed here. */}
                {user?.isOperator
                  ? 'If the email already belongs to a user, they are added immediately; otherwise a pending invitation is created.'
                  : 'A pending invitation is created for the address — whether or not it already has an account — and the recipient accepts it from the link.'}
              </p>

              {error && <p className="text-xs text-rose-400">{error}</p>}

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="secondary" onClick={closeInvite}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy || !inviteEmail.trim()}>
                  {busy ? 'Inviting…' : 'Send Invite'}
                </Button>
              </div>
            </form>
          )}
        </Modal>
      )}

      {/* Edit Workspace Dialog */}
      {editOpen && (
        <Modal onClose={() => setEditOpen(false)} title="Edit Workspace">
          <form onSubmit={handleUpdateWs} className="space-y-4">
            <Field label="Workspace Name">
              <Input
                required
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                autoFocus
              />
            </Field>

            <Field label="Description">
              <Textarea
                rows={2}
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="Workspace description"
              />
            </Field>

            {error && <p className="text-xs text-rose-400">{error}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" onClick={() => setEditOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !editName.trim()}>
                {busy ? 'Saving…' : 'Save Changes'}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {/* Delete Workspace Confirmation Dialog */}
      {deleteOpen && (
        <Modal onClose={() => setDeleteOpen(false)} title="Delete Workspace">
          <div className="space-y-4">
            <p className="text-sm text-slate-300">
              Are you sure you want to permanently delete <strong className="text-white">{detail?.name}</strong>?
              This action cannot be undone.
            </p>

            {error && <p className="text-xs text-rose-400">{error}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" onClick={() => setDeleteOpen(false)}>
                Cancel
              </Button>
              <Button variant="danger" disabled={busy} onClick={handleDeleteWs}>
                {busy ? 'Deleting…' : 'Yes, Delete Workspace'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
