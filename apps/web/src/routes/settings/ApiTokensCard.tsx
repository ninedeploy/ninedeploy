import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeySquare } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import type { CreatedApiToken } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { formatDateTime, formatRelative, useCopy } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Badge, Button, Card, CardBody, ConfirmDialog, Field, Input, Select, Skeleton } from '../../components/ui.js';
import { fill, msg, useT } from '../../lib/i18n.js';

/** The access a new token gets: the server's coarse scopes (fine-grained `nd://scope/...` ones stay API/CLI-only). */
const LEVELS = [
  { scope: 'read', label: msg('Read only'), hint: msg('GET requests only: dashboards, monitoring, an MCP client that only looks.') },
  { scope: 'write', label: msg('Read & write'), hint: msg('Deploys and changes, always as a non-operator even if you are one.') },
  { scope: 'operator', label: msg('Full access'), hint: msg('Everything your account can do, operator rights included.') },
] as const;
type Level = (typeof LEVELS)[number]['scope'];

const LIFETIMES = [
  { days: 30, label: msg('30 days') },
  { days: 90, label: msg('90 days') },
  { days: 365, label: msg('1 year') },
  { days: 3650, label: msg('10 years') },
] as const;

/**
 * Settings → Security → API tokens (0.16.3): the signed-in user's tokens for
 * the CLI, CI, scripts and MCP clients. Create one (shown once), see when each
 * was last used and when it expires, revoke it. The routes existed since 0.3;
 * the docs pointed here before the page did.
 */
export function ApiTokensCard() {
  const { toast } = useToast();
  const t = useT();
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
    onError: (err: Error) => toast(err.message || t('Could not create the token'), 'error'),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api.auth.tokens.remove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['api-tokens'] });
      toast(t('Token revoked'), 'success');
    },
    onError: (err: Error) => toast(err.message || t('Could not revoke the token'), 'error'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  const levels = LEVELS.filter((l) => l.scope !== 'operator' || isOperator);
  const now = Date.now();
  const levelHint = levels.find((l) => l.scope === level)?.hint;

  return (
    <Card className="mb-5">
      <CardBody>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <KeySquare size={14} /> {t('API tokens')}
        </h2>
        <p className="mb-4 text-xs text-slate-500">
          {fill(
            t('For the CLI, CI jobs, scripts and MCP clients. A token acts as you, limited to the access it was given, and is sent as {header} (or {env} for the MCP server).'),
            {
              header: <code className="font-mono text-[11px] text-slate-400">Authorization: Bearer …</code>,
              env: <code className="font-mono text-[11px] text-slate-400">NINEDEPLOY_TOKEN</code>,
            },
          )}
        </p>

        {created && (
          <div className="mb-4 space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.05] p-3">
            <p className="text-xs font-medium text-emerald-200">{t('Token “{name}” created. Copy it now: it is not shown again.', { name: created.name })}</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-black/40 px-2 py-1.5 font-mono text-[11px] text-slate-200">{created.token}</code>
              <Button size="sm" variant="secondary" onClick={() => void copy(created.token)} aria-label={t('Copy token')}>
                {copied ? <Check size={13} /> : <Copy size={13} />} {t('Copy')}
              </Button>
            </div>
            <button type="button" onClick={() => setCreated(null)} className="text-xs text-slate-400 hover:text-slate-200 hover:underline">
              {t('Done')}
            </button>
          </div>
        )}

        <form onSubmit={submit} className="mb-5 grid gap-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.8fr)_auto] sm:items-start">
          <Field label={t('Name')}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="github-actions" maxLength={100} />
          </Field>
          <Field label={t('Access')} hint={levelHint && t(levelHint)}>
            <Select value={level} onChange={(e) => setLevel(e.target.value as Level)}>
              {levels.map((l) => (
                <option key={l.scope} value={l.scope}>
                  {t(l.label)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('Expires')}>
            <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
              {LIFETIMES.map((l) => (
                <option key={l.days} value={l.days}>
                  {t(l.label)}
                </option>
              ))}
            </Select>
          </Field>
          {/* Lined up with the fields, under their labels. */}
          <div className="sm:pt-[22px]">
            <Button type="submit" size="md" disabled={create.isPending} className="w-full sm:w-auto">
              {create.isPending ? t('Creating…') : t('Create token')}
            </Button>
          </div>
        </form>

        {tokens.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : tokens.isError ? (
          <p className="text-xs text-rose-300">{t('Could not load your tokens.')}</p>
        ) : !tokens.data?.length ? (
          <p className="text-xs text-slate-600">{t('No API tokens.')}</p>
        ) : (
          <ul className="space-y-1" aria-label={t('Your API tokens')}>
            {tokens.data.map((tok) => {
              const expired = tok.expiresAt !== null && new Date(tok.expiresAt).getTime() <= now;
              return (
                <li key={tok.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white/[0.02] px-3 py-2 text-xs ring-1 ring-inset ring-white/5">
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-1.5 text-slate-300">
                      <span className="font-medium">{tok.name}</span>
                      {tok.scopes.length === 0 ? (
                        <Badge tone="amber">{t('unrestricted (legacy)')}</Badge>
                      ) : (
                        tok.scopes.map((s) => (
                          <Badge key={s} tone={s === 'operator' ? 'rose' : s === 'read' ? 'sky' : 'indigo'}>
                            {s.replace('nd://scope/', '')}
                          </Badge>
                        ))
                      )}
                      {expired && <Badge tone="rose">{t('expired')}</Badge>}
                    </span>
                    <span className="mt-0.5 block text-slate-600">
                      {t('Created {date}', { date: formatDateTime(tok.createdAt) })} · {tok.lastUsedAt ? t('last used {when}', { when: formatRelative(tok.lastUsedAt) }) : t('never used')} ·{' '}
                      {tok.expiresAt === null
                        ? t('never expires')
                        : expired
                          ? t('expired {date}', { date: formatDateTime(tok.expiresAt) })
                          : t('expires {date}', { date: formatDateTime(tok.expiresAt) })}
                    </span>
                  </span>
                  <button type="button" onClick={() => setRevoking({ id: tok.id, name: tok.name })} className="shrink-0 text-rose-400 hover:text-rose-300">
                    {t('Revoke')}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
      <ConfirmDialog
        open={revoking !== null}
        title={t('Revoke this token?')}
        message={t('Anything using “{name}” stops working at once.', { name: revoking?.name ?? '' })}
        confirmLabel={t('Revoke')}
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking.id);
          setRevoking(null);
        }}
        onClose={() => setRevoking(null)}
      />
    </Card>
  );
}
