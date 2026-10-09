import { type FormEvent, type ReactNode, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button, Field, Input, Modal } from './ui.js';

/**
 * The password re-check (step-up) before a risky switch, the same prompt as
 * Settings → Security → Terminals uses for host shells. The server checks the
 * password (403 `invalid_password`); an account that signs in only through
 * SSO leaves it empty within 10 minutes of signing in (403 `reauth_required`
 * otherwise). An empty field sends no password at all.
 */
export function StepUpModal({
  title,
  warning,
  confirmLabel,
  pending,
  error,
  children,
  onConfirm,
  onClose,
}: {
  title: string;
  /** Why this needs the password: rendered in the amber callout. */
  warning: ReactNode;
  confirmLabel: string;
  pending?: boolean;
  /** The server's refusal, shown under the field (e.g. a wrong password). */
  error?: string | null;
  /** Extra fields above the password (e.g. the Swarm advertise address). */
  children?: ReactNode;
  onConfirm: (password: string | undefined) => void;
  onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onConfirm(password ? password : undefined);
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="flex gap-3 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3 text-xs text-amber-200">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>{warning}</div>
        </div>
        {children}
        <Field
          label="Your password"
          hint="Accounts that sign in only through SSO: leave it empty within 10 minutes of signing in."
          error={error ?? undefined}
        >
          <Input type="password" aria-label="Your password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={pending}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
