import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeySquare } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import type { CreatedApiToken } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { formatDateTime, formatRelative, useCopy } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Badge, Button, Card, CardBody, ConfirmDialog, Field, Input, Select, Skeleton } from '../../components/ui.js';

/** The access a new token gets: the server's coarse scopes (fine-grained `nd://scope/...` ones stay API/CLI-only). */
const LEVELS = [
  { scope: 'read', label: 'Read only', hint: 'GET requests only: dashboards, monitoring, an MCP client that only looks.' },
  { scope: 'write', label: 'Read & write', hint: 'Deploys and changes, always as a non-operator even if you are one.' },
  { scope: 'operator', label: 'Full access', hint: 'Everything your account can do, operator rights included.' },
] as const;
type Level = (typeof LEVELS)[number]['scope'];

const LIFETIMES = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
  { days: 3650, label: '10 years' },
] as const;

/**
 * Settings → Security → API tokens (0.16.3): the signed-in user's tokens for
 * the CLI, CI, scripts and MCP clients. Create one (shown once), see when each
 * was last used and when it expires, revoke it. The routes existed since 0.3;
 * the docs pointed here before the page did.
 */
export function ApiTokensCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const isOperator = useAuth().user?.isOperator === true;
  const [name, setName] = useState('');
  const [level, setLevel] = useState<Level>('read');
  const [days, setDays] = useState(365);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [revoking, setRevoking] = useState<{ id: number; name: string } | null>(null);
  const { copied, copy } = useCopy();

  const tokens = useQuery({ queryKey: ['api-tokens'], queryFn: () => api.auth.tokens.list() });
  const create = useMutation({
    mutationFn: () => api.auth.tokens.create({ name: name.trim() || 'cli', scopes: [level], expiresInDays: days }),
    onSuccess: (tok) => {
      setCreated(tok);
      setName('');
      void qc.invalidateQueries({ queryKey: ['api-tokens'] });
    },
    onError: (err: Error) => toast(err.message || 'Could not create the token', 'error'),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api.auth.tokens.remove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['api-tokens'] });
      toast('Token revoked', 'success');
    },
    onError: (err: Error) => toast(err.message || 'Could not revoke the token', 'error'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  const levels = LEVELS.filter((l) => l.scope !== 'operator' || isOperator);
  const now = Date.now();

  return (
    <Card className="mb-5">
      <CardBody>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <KeySquare size={14} /> API tokens
        </h2>
        <p className="mb-4 text-xs text-slate-500">
          For the CLI, CI jobs, scripts and MCP clients. A token acts as you, limited to the access it was given, and is sent as{' '}
          <code className="font-mono text-[11px] text-slate-400">Authorization: Bearer …</code> (or{' '}
          <code className="font-mono text-[11px] text-slate-400">NINEDEPLOY_TOKEN</code> for the MCP server).
        </p>

        {created && (
          <div className="mb-4 space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.05] p-3">
            <p className="text-xs font-medium text-emerald-200">Token “{created.name}” created. Copy it now: it is not shown again.</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-black/40 px-2 py-1.5 font-mono text-[11px] text-slate-200">{created.token}</code>
              <Button size="sm" variant="secondary" onClick={() => void copy(created.token)} aria-label="Copy token">
                {copied ? <Check size={13} /> : <Copy size={13} />} Copy
              </Button>
            </div>
            <button type="button" onClick={() => setCreated(null)} className="text-xs text-slate-400 hover:text-slate-200 hover:underline">
              Done
            </button>
          </div>
        )}

        <form onSubmit={submit} className="mb-5 grid gap-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.8fr)_auto] sm:items-start">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="github-actions" maxLength={100} />
          </Field>
          <Field label="Access" hint={levels.find((l) => l.scope === level)?.hint}>
            <Select value={level} onChange={(e) => setLevel(e.target.value as Level)}>
              {levels.map((l) => (
                <option key={l.scope} value={l.scope}>
                  {l.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Expires">
            <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
              {LIFETIMES.map((l) => (
                <option key={l.days} value={l.days}>
                  {l.label}
                </option>
              ))}
            </Select>
          </Field>
          {/* Lined up with the fields, under their labels. */}
          <div className="sm:pt-[22px]">
            <Button type="submit" size="md" disabled={create.isPending} className="w-full sm:w-auto">
              {create.isPending ? 'Creating…' : 'Create token'}
            </Button>
          </div>
        </form>

        {tokens.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : tokens.isError ? (
          <p className="text-xs text-rose-300">Could not load your tokens.</p>
        ) : !tokens.data?.length ? (
          <p className="text-xs text-slate-600">No API tokens.</p>
        ) : (
          <ul className="space-y-1" aria-label="Your API tokens">
            {tokens.data.map((t) => {
              const expired = t.expiresAt !== null && new Date(t.expiresAt).getTime() <= now;
              return (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white/[0.02] px-3 py-2 text-xs ring-1 ring-inset ring-white/5">
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-1.5 text-slate-300">
                      <span className="font-medium">{t.name}</span>
                      {t.scopes.length === 0 ? (
                        <Badge tone="amber">unrestricted (legacy)</Badge>
                      ) : (
                        t.scopes.map((s) => (
                          <Badge key={s} tone={s === 'operator' ? 'rose' : s === 'read' ? 'sky' : 'indigo'}>
                            {s.replace('nd://scope/', '')}
                          </Badge>
                        ))
                      )}
                      {expired && <Badge tone="rose">expired</Badge>}
                    </span>
                    <span className="mt-0.5 block text-slate-600">
                      Created {formatDateTime(t.createdAt)} · {t.lastUsedAt ? `last used ${formatRelative(t.lastUsedAt)}` : 'never used'} ·{' '}
                      {t.expiresAt === null ? 'never expires' : `${expired ? 'expired' : 'expires'} ${formatDateTime(t.expiresAt)}`}
                    </span>
                  </span>
                  <button type="button" onClick={() => setRevoking({ id: t.id, name: t.name })} className="shrink-0 text-rose-400 hover:text-rose-300">
                    Revoke
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
      <ConfirmDialog
        open={revoking !== null}
        title="Revoke this token?"
        message={`Anything using “${revoking?.name ?? ''}” stops working at once.`}
        confirmLabel="Revoke"
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking.id);
          setRevoking(null);
        }}
        onClose={() => setRevoking(null)}
      />
    </Card>
  );
}
