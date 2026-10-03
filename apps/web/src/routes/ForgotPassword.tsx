import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api.js';
import { BrandMark, Button, Card, Field, Input } from '../components/ui.js';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  const request = useMutation({
    mutationFn: () => api.auth.forgotPassword(email),
    onSuccess: () => setSent(true),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (email.trim()) request.mutate();
  };

  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="w-full max-w-sm nd-fade">
        <div className="mb-7 flex flex-col items-center text-center">
          <BrandMark size={44} />
          <h1 className="mt-4 text-xl font-semibold tracking-tight">Reset your password</h1>
          <p className="text-sm text-slate-500">We'll send a one-time reset link.</p>
        </div>

        <Card className="p-6">
          {sent ? (
            <div className="space-y-4 text-center">
              <p className="text-sm text-slate-300">
                If an account exists for <span className="font-mono text-slate-100">{email}</span>, a reset link is on
                its way (valid for 30 minutes).
              </p>
              <p className="text-xs text-slate-500">
                No email channel configured? Ask an admin to generate a reset link for you from the Users page.
              </p>
              <Link to="/login">
                <Button variant="secondary" className="w-full">Back to sign in</Button>
              </Link>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <Field label="Email">
                <Input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                />
              </Field>
              {request.isError && (
                <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
                  {request.error instanceof Error ? request.error.message : 'Request failed'}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={request.isPending || !email.trim()}>
                {request.isPending ? 'Please wait…' : 'Send reset link'}
              </Button>
              <p className="text-center text-xs text-slate-500">
                <Link to="/login" className="underline-offset-2 hover:underline">Back to sign in</Link>
              </p>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
