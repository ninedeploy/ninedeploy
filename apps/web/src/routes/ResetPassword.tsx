import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api } from '../lib/api.js';
import { BrandMark, Button, Card, Field, Input } from '../components/ui.js';

export function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const [manualToken, setManualToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const effectiveToken = token || manualToken;

  const reset = useMutation({
    mutationFn: () => api.auth.resetPasswordWithToken({ token: effectiveToken, newPassword }),
    onSuccess: () => navigate('/login?reset=ok', { replace: true }),
    onError: (err) => setError(err instanceof Error ? err.message : 'Reset failed'),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    reset.mutate();
  };

  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="w-full max-w-sm nd-fade">
        <div className="mb-7 flex flex-col items-center text-center">
          <BrandMark size={44} />
          <h1 className="mt-4 text-xl font-semibold tracking-tight">Set a new password</h1>
          <p className="text-sm text-slate-500">Reset links are valid for 30 minutes and work once.</p>
        </div>

        <Card className="p-6">
          <form onSubmit={onSubmit} className="space-y-4">
            {!token && (
              <Field label="Reset token">
                <Input
                  required
                  value={manualToken}
                  onChange={(e) => setManualToken(e.target.value)}
                  placeholder="Paste the token from your link"
                  className="font-mono text-xs"
                />
              </Field>
            )}
            <Field label="New password">
              <Input
                type="password"
                required
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="At least 8 characters"
                autoComplete="new-password"
              />
            </Field>
            <Field label="Confirm password">
              <Input
                type="password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Repeat the new password"
                autoComplete="new-password"
              />
            </Field>

            {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}

            <Button type="submit" className="w-full" disabled={reset.isPending || !effectiveToken || !newPassword}>
              {reset.isPending ? 'Please wait…' : 'Set new password'}
            </Button>
            <p className="text-center text-xs text-slate-500">
              <Link to="/login" className="underline-offset-2 hover:underline">Back to sign in</Link>
            </p>
          </form>
        </Card>
      </div>
    </div>
  );
}
