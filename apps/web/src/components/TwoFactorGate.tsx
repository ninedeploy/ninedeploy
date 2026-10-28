import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useT } from '../lib/i18n.js';
import { PasskeyCard, TwoFactorCard } from '../routes/settings/AccountSection.js';
import { Button, Card, CardBody } from './ui.js';

/**
 * G1.4: a workspace the user belongs to requires 2FA and they have none. The
 * server answers only the enrolment routes until they set up TOTP or a
 * passkey, so the app shows the enrolment screen instead of the layout.
 * A panel without the route (404) or a failed read lets the app through.
 */
export function TwoFactorGate({ children }: { children: ReactNode }) {
  const t = useT();
  const { logout } = useAuth();
  const q = useQuery({
    queryKey: ['2fa-requirement'],
    queryFn: () => api.auth.twoFactor.requirement(),
    retry: false,
    staleTime: 60_000,
  });
  const held = !!q.data && q.data.required && !q.data.enrolled;
  if (!held) return <>{children}</>;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <Card className="mb-5">
        <CardBody className="space-y-2">
          <h1 className="flex items-center gap-2 text-base font-semibold text-slate-200">
            <ShieldAlert size={18} className="text-amber-400" /> {t('Two-factor authentication required')}
          </h1>
          <p className="text-sm text-slate-400">
            {t('{workspaces} requires two-factor authentication of every member. Set up an authenticator app or a passkey to continue.', {
              workspaces: q.data!.workspaces.map((w) => w.name).join(', '),
            })}
          </p>
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="secondary" onClick={() => void q.refetch()}>
              {t('I have set it up')}
            </Button>
            <Button size="sm" variant="ghost" onClick={logout}>
              {t('Sign out')}
            </Button>
          </div>
        </CardBody>
      </Card>
      <TwoFactorCard />
      <PasskeyCard />
    </div>
  );
}
