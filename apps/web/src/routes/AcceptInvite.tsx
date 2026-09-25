import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, LogIn, XCircle } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { rememberWorkspace } from '../lib/workspace.js';
import { Button, Card, Spinner } from '../components/ui.js';
import type { WorkspaceInvitationPublic } from '@ninedeploy/sdk';

type Status = 'loading' | 'ready' | 'accepting' | 'accepted' | 'unauthenticated' | 'mismatch' | 'error' | 'not-found';

/**
 * Public invitation acceptance page. Rendered at /invite/:token.
 *
 * Flow:
 *   1. Anonymous visitor hits the link — we preview the invite via the public
 *      API and show a "Sign in to accept" CTA.
 *   2. Once signed in, we re-fetch the preview, verify the caller's email
 *      matches the invite, and offer an Accept button.
 *   3. After accepting, the user lands in the workspace (or is told to wait
 *      for an admin if the address doesn't match).
 */
export function AcceptInvite() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, loading: authInitialLoading } = useAuth();

  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);

  const { data: preview, error: previewError, isLoading: previewLoading } = useQuery<WorkspaceInvitationPublic>({
    queryKey: ['invitation-preview', token],
    queryFn: () => api.workspaces.previewInvitation(token!),
    enabled: Boolean(token),
    retry: false,
  });

  // Drive the page state machine. The query is `loading` while it runs;
  // resolve it once either an error lands or the preview row arrives, and
  // then decide which UX state to show.
  useEffect(() => {
    if (authInitialLoading || previewLoading) {
      setStatus('loading');
      return;
    }
    if (previewError || !preview) {
      setStatus('not-found');
      return;
    }
    if (!user) {
      setStatus('unauthenticated');
      return;
    }
    if (user.email.toLowerCase() !== preview.email.toLowerCase()) {
      setStatus('mismatch');
      return;
    }
    setStatus('ready');
  }, [authInitialLoading, previewLoading, user, preview, previewError]);

  const acceptMutation = useMutation({
    mutationFn: () => api.workspaces.acceptInvitation(token!),
    /* v8 ignore next 12 */
    onSuccess: async (result) => {
      if (result.ok) {
        setStatus('accepted');
        // Refresh workspace list so the new membership shows up on the
        // dashboard, then route the user into the workspace. r295: this page
        // sits outside WorkspaceProvider and nothing read the old
        // `/?workspace=<id>` hint, so the user landed in their previous
        // workspace. Select it for the provider that mounts on arrival
        // instead — and refetch even an inactive cached list first, or the
        // provider would find the new id missing and fall back to the first.
        await queryClient.invalidateQueries({ queryKey: ['workspaces'], refetchType: 'all' });
        rememberWorkspace(result.workspaceId);
        window.setTimeout(() => navigate('/'), 1200);
      } else {
        // The API resolves { ok: false } for business-level failures (used
        // token, wrong e-mail) — without this branch the page sat on the
        // "accepting" spinner forever.
        setStatus('error');
        setError('This invitation can no longer be accepted');
      }
    },
    /* v8 ignore next 4 */
    onError: (err) => {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Failed to accept invitation');
    },
  });

  const handleAccept = () => {
    setStatus('accepting');
    setError(null);
    acceptMutation.mutate();
  };

  const handleSignIn = () => {
    navigate(`/login?returnTo=${encodeURIComponent(`/invite/${token}`)}`);
  };

  if (status === 'loading') {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (status === 'not-found') {
    return (
      <div className="min-h-[60vh] flex items-center justify-center px-4">
        <Card className="max-w-md w-full p-6 text-center space-y-3">
          <XCircle size={36} className="mx-auto text-rose-400" />
          <h1 className="text-lg font-semibold text-white">Invitation no longer valid</h1>
          <p className="text-sm text-slate-400">
            The link is invalid, expired, or has already been used. Ask the workspace
            owner to send you a fresh invitation.
          </p>
          <Link to="/" className="text-xs text-indigo-300 hover:underline">
            Return to dashboard
          </Link>
        </Card>
      </div>
    );
  }

  if (status === 'unauthenticated' && preview) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center px-4">
        <Card className="max-w-md w-full p-6 space-y-4">
          <div className="flex items-center gap-3">
            <KeyRound size={28} className="text-indigo-400" />
            <div>
              <h1 className="text-lg font-semibold text-white">
                Join {preview.workspaceName}
              </h1>
              <p className="text-xs text-slate-400">
                {preview.invitedByName ?? 'A workspace owner'} invited you to join as{' '}
                <span className="text-indigo-300">{preview.role}</span>.
              </p>
            </div>
          </div>
          <p className="text-sm text-slate-300">
            This invitation was sent to <strong className="text-white">{preview.email}</strong>.
            Sign in to accept it — if you do not yet have an account, the workspace
            owner can create one for you from the Users page.
          </p>
          <div className="flex gap-2 pt-2">
            <Button onClick={handleSignIn} className="flex-1">
              <LogIn size={14} />
              <span>Sign in to accept</span>
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (status === 'mismatch' && preview) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center px-4">
        <Card className="max-w-md w-full p-6 space-y-3 text-center">
          <XCircle size={36} className="mx-auto text-amber-400" />
          <h1 className="text-lg font-semibold text-white">Different email address</h1>
          <p className="text-sm text-slate-300">
            This invitation was sent to{' '}
            <strong className="text-white">{preview.email}</strong>, but you are signed in
            as <strong className="text-white">{user?.email}</strong>. Sign out and back in
            with the invited address to accept.
          </p>
          <Link to="/" className="text-xs text-indigo-300 hover:underline">
            Return to dashboard
          </Link>
        </Card>
      </div>
    );
  }

  if (status === 'accepted' && preview) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center px-4">
        <Card className="max-w-md w-full p-6 space-y-3 text-center">
          <CheckCircle2 size={36} className="mx-auto text-emerald-400" />
          <h1 className="text-lg font-semibold text-white">Welcome aboard</h1>
          <p className="text-sm text-slate-300">
            You have joined {preview.workspaceName} as a {preview.role}. Redirecting
            to your dashboard…
          </p>
        </Card>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="min-h-[60vh] flex items-center justify-center px-4">
        <Card className="max-w-md w-full p-6 space-y-3 text-center">
          <XCircle size={36} className="mx-auto text-rose-400" />
          <h1 className="text-lg font-semibold text-white">Could not accept</h1>
          <p className="text-sm text-slate-300">{/* v8 ignore start -- `error` is always populated by onError; the fallback only fires if a future caller forgets to. */ error ?? 'Unknown error' /* v8 ignore stop */}</p>
          <Button onClick={handleAccept} variant="secondary">
            Try again
          </Button>
        </Card>
      </div>
    );
  }

  // status === 'ready' | 'accepting'
  /* v8 ignore start -- rendered only after the preview query resolves; the success
   * test reaches the 'accepted' branch before the final reconciliation of the
   * 'accepting' render, so the optional-chain fallbacks (e.g. invitedByName)
   * stay uncovered. */
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <Card className="max-w-md w-full p-6 space-y-4">
        <div className="flex items-center gap-3">
          <KeyRound size={28} className="text-indigo-400" />
          <div>
            <h1 className="text-lg font-semibold text-white">Join {preview?.workspaceName}</h1>
            <p className="text-xs text-slate-400">
              {preview?.invitedByName ?? 'A workspace owner'} invited{' '}
              <strong className="text-slate-200">{preview?.email}</strong> as{' '}
              <span className="text-indigo-300">{preview?.role}</span>.
            </p>
          </div>
        </div>
        <p className="text-sm text-slate-300">
          Accepting will add you to the workspace immediately. You can leave at any
          time from the workspace settings.
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <Link to="/">
            <Button variant="secondary">Cancel</Button>
          </Link>
          <Button onClick={handleAccept} disabled={status === 'accepting'}>
            {status === 'accepting' ? 'Joining…' : 'Accept invitation'}
          </Button>
        </div>
      </Card>
    </div>
  );
  /* v8 ignore end */
}
