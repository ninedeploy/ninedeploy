import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useMemo, useState } from 'react';
import { FileCode, GitPullRequest, KeyRound, Layers, Lock, Plus, Rows3, Save, Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { downloadBlob } from '../lib/format.js';
import { fill, useT } from '../lib/i18n.js';
import { useToast } from './Toast.js';
import { Button, Card, CardBody, ErrorCard, Input, Skeleton, Textarea, cn } from './ui.js';

// Vault reference examples (escaped so linters don't read them as template placeholders).
const REF_INFISICAL = '\u0024\u007B\u007Binfisical:KEY\u007D\u007D';
const REF_DOPPLER = '\u0024\u007B\u007Bdoppler:KEY\u007D\u007D';

interface EnvEntry {
  id: number;
  key: string;
  value: string;
  isSecret: boolean;
  /** 0.16.13: a protected lane's value, kept from this caller (`value` is ''). */
  hidden?: boolean;
}

/**
 * Parses pasted/edited `.env` text into entries. Accepts blank lines,
 * `#` comments, an optional `export ` prefix, and one pair of surrounding
 * quotes around values (the pair itself is syntactic, not stored). Later
 * duplicate keys win, matching dotenv-loader conventions.
 */
export function parseEnvText(text: string): { entries: Array<{ key: string; value: string }>; errors: string[] } {
  const entries: Array<{ key: string; value: string }> = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const lineNo = i + 1;
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    if (line.startsWith('export ') || line.startsWith('export\t')) line = line.slice(6).trimStart();

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match?.[1]) {
      errors.push(`Line ${lineNo}: expected KEY=VALUE`);
      return;
    }
    let value = match[2] ?? '';
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) value = value.slice(1, -1);

    const key = match[1];
    const existing = entries.find((e) => e.key === key);
    if (existing) {
      existing.value = value;
    } else {
      entries.push({ key, value });
    }
  });
  return { entries, errors };
}

/**
 * `variant="preview"` (0.12) edits the service's preview-only set: values only
 * its PR previews receive, through `/env/preview` — same table UI, its own
 * query key, and no vault references (a preview never resolves one).
 *
 * `variant="project"` (0.16.1) edits a project's shared variables through
 * `/projects/:id/env`; `serviceId` is then the PROJECT id. Every service in
 * the project receives them; a service's own variable of the same name wins.
 */
export function EnvCard({
  serviceId,
  literalNewlines = false,
  variant = 'service',
  previewsEnabled = true,
}: {
  serviceId: number;
  literalNewlines?: boolean;
  variant?: 'service' | 'preview' | 'project';
  previewsEnabled?: boolean;
}) {
  const t = useT();
  const preview = variant === 'preview';
  const shared = variant === 'project';
  const envApi = preview ? api.previewEnv : shared ? api.projectEnv : api.env;
  const queryKey = preview ? ['preview-env', serviceId] : shared ? ['project-env', serviceId] : ['env', serviceId];
  const qc = useQueryClient();
  const { toast } = useToast();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [secret, setSecret] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [filter, setFilter] = useState('');

  // Raw-text editing: bulk-paste or edit an entire .env file in one go.
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState('');

  const env = useQuery({ queryKey, queryFn: () => envApi.list(serviceId) });
  const invalidate = () => qc.invalidateQueries({ queryKey });
  // r562: the raw editor DIFFS against the loaded list — every key it does not
  // see is deleted on Apply. A failed load used to read as "no variables", so
  // applying a pasted .env over it would have wiped every existing one.
  const envLoaded = env.data !== undefined;

  const enterRaw = () => {
    if (!envLoaded) return;
    setRawText((env.data ?? []).map((v) => `${v.key}=${v.value}`).join('\n'));
    setDrafts({});
    setFilter('');
    setRawMode(true);
  };
  const parsed = useMemo(() => parseEnvText(rawText), [rawText]);

  const add = useMutation({
    mutationFn: () => envApi.create(serviceId, { key, value, isSecret: secret }),
    // r217: the inputs clear only once the variable is stored. They used to
    // clear on submit, so a refused add (an invalid key name, a 403) lost
    // what was typed — and the toast blamed a duplicate key the server would
    // have upserted anyway.
    onSuccess: () => {
      setKey('');
      setValue('');
      setSecret(false);
      invalidate();
    },
    onError: (err) => toast(err instanceof Error ? err.message : t('Could not add the variable'), 'error'),
  });
  const update = useMutation({
    // isSecret is passed through explicitly: the server preserves the stored
    // classification when it is omitted, but sending it removes any doubt.
    mutationFn: (v: { id: number; key: string; value: string; isSecret: boolean }) =>
      envApi.update(serviceId, v.id, { key: v.key, value: v.value, isSecret: v.isSecret }),
    onSuccess: invalidate,
    onError: () => toast(t('Could not save the variable'), 'error'),
  });
  const remove = useMutation({
    mutationFn: (id: number) => envApi.remove(serviceId, id),
    onSuccess: invalidate,
    onError: () => toast(t('Could not delete the variable'), 'error'),
  });
  const saveRaw = useMutation({
    mutationFn: async () => {
      // r562: never diff against a list we do not have (see envLoaded).
      if (env.data === undefined) throw new Error('The current variables could not be loaded');
      const current: EnvEntry[] = env.data;
      const wanted = new Map(parsed.entries.map((e) => [e.key, e.value]));
      const creates = [...wanted]
        .filter(([k]) => !current.some((v) => v.key === k))
        .map(([k, val]) => envApi.create(serviceId, { key: k, value: val, isSecret: false }));
      const updates = current
        .filter((v) => wanted.has(v.key) && wanted.get(v.key) !== v.value)
        .map((v) => envApi.update(serviceId, v.id, { key: v.key, value: wanted.get(v.key) ?? '' }));
      const removes = current.filter((v) => !wanted.has(v.key)).map((v) => envApi.remove(serviceId, v.id));
      // Independent single-variable calls; one failure among many still leaves
      // a coherent subset persisted, which the refetch below renders truthfully.
      // r297: wait for every call to land (Promise.all rejected on the first
      // failure while the rest were still in flight) before reporting.
      const results = await Promise.allSettled([...creates, ...updates, ...removes]);
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
      return { added: creates.length, updated: updates.length, removed: removes.length };
    },
    // r297: refetch on failure too — a partial apply left the table showing
    // the pre-edit values for variables that had in fact been saved.
    onSettled: invalidate,
    onSuccess: ({ added, updated, removed }) => {
      toast(t('Saved {added} added · {updated} updated · {removed} removed', { added, updated, removed }), 'success');
      setRawMode(false);
    },
    onError: () => toast(t('Could not apply the .env edit — some values may be saved'), 'error'),
  });

  const onAdd = (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    add.mutate();
  };

  return (
    <Card>
      <CardBody>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            {preview ? (
              <>
                <GitPullRequest size={15} className="text-slate-500" /> {t('Preview deployments')}
              </>
            ) : shared ? (
              <>
                <Layers size={15} className="text-slate-500" /> {t('Shared variables')}
              </>
            ) : (
              <>
                <KeyRound size={15} className="text-slate-500" /> {t('Environment')}
              </>
            )}
          </div>
          {/* r409/r465: docker-builder services with multi-line env values
              start through a one-service compose bridge whose dotenv parser
              delivers REAL newlines — the old warning (values arriving as a
              literal \n) is resolved on panels ≥0.10.21. The hint stays for
              older panels: the dashboard may be newer than its server. */}
          {(env.data ?? []).some((v) => v.hidden) && (
            <p className="w-full text-[11px] leading-relaxed text-violet-300/80">
              {t('This service is in a protected lane: its values are for workspace admins. You can still set new values.')}
            </p>
          )}
          {literalNewlines &&
            (value.includes('\n') ||
              Object.values(drafts).some((d) => d.includes('\n')) ||
              (env.data ?? []).some((v) => v.value.includes('\n'))) && (
              <p className="w-full text-[11px] leading-relaxed text-slate-400">
                {fill(t('Multi-line values (PEM keys, JSON documents) are delivered with real line breaks on panels ≥0.10.21; on older panels they arrived as a literal {nl} — base64-encode them there, or upgrade the server.'), { nl: <code className="font-mono">\n</code> })}
              </p>
            )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const content = `${(env.data ?? [])
                  .filter((v) => !v.isSecret && !v.hidden)
                  .map((v) => `${v.key}=${v.value}`)
                  .join('\n')}\n`;
                // downloadBlob delays the URL revoke — a synchronous revoke
                // cancels the download in Safari (r409).
                downloadBlob(content, preview ? '.env.preview' : shared ? '.env.shared' : '.env', 'text/plain');
              }}
              disabled={(env.data?.length ?? 0) === 0}
              className="flex items-center gap-1.5 rounded-lg bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-slate-400 ring-1 ring-inset ring-white/10 transition hover:bg-white/[0.08] hover:text-slate-200 disabled:opacity-30"
              title={t('Download non-secret env vars as a .env file')}
            >
              <FileCode size={12} /> {t('Export')}
            </button>
            <button
              type="button"
              onClick={() => (rawMode ? setRawMode(false) : enterRaw())}
              disabled={!rawMode && !envLoaded}
              className="flex items-center gap-1.5 rounded-lg bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-slate-400 ring-1 ring-inset ring-white/10 transition hover:bg-white/[0.08] hover:text-slate-200 disabled:opacity-30"
              title={
                rawMode
                  ? t('Back to the variable table')
                  : envLoaded
                    ? t('Paste or edit the whole .env file as text')
                    : t('Unavailable until the current variables load')
              }
            >
              {rawMode ? <Rows3 size={12} /> : <FileCode size={12} />}
              {rawMode ? t('Table view') : t('Edit as .env')}
            </button>
            {!rawMode && (env.data?.length ?? 0) > 5 && (
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t('Filter keys…')}
                className="h-7 w-36 text-xs sm:w-44"
              />
            )}
          </div>
        </div>

        {rawMode ? (
          <>
            <p className="mb-2 text-[11px] text-slate-600">
              {fill(t('One {kv} per line; {hash} comments, quoting and {export} are fine. Missing keys are deleted, new keys are added (non-secret — mark secrets in table view).'), {
                kv: <code className="rounded bg-white/5 px-1 font-mono text-[10px]">KEY=VALUE</code>,
                hash: <code className="rounded bg-white/5 px-1 font-mono text-[10px]">#</code>,
                export: <code className="rounded bg-white/5 px-1 font-mono text-[10px]">export</code>,
              })}
            </p>
            <Textarea
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              spellCheck={false}
              aria-label={t('Raw .env content')}
              className="min-h-64 font-mono text-xs leading-relaxed"
            />
            {parsed.errors.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-[11px] text-rose-300/90">
                {parsed.errors.map((err) => (
                  <li key={err}>{err}</li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setRawMode(false)} disabled={saveRaw.isPending}>
                {t('Cancel')}
              </Button>
              <Button
                size="sm"
                onClick={() => saveRaw.mutate()}
                disabled={parsed.errors.length > 0 || saveRaw.isPending}
              >
                <Save size={13} /> {parsed.entries.length === 1 ? t('Apply {n} var', { n: parsed.entries.length }) : t('Apply {n} vars', { n: parsed.entries.length })}
              </Button>
            </div>
          </>
        ) : (
          <>
            {preview ? (
              <div className="mb-2 space-y-1 text-[11px] leading-relaxed text-slate-500">
                <p>
                  {t("Values here reach only this service's pull-request previews, never the service itself. They override the non-secret values a preview inherits. Previews never receive this service's secrets, project-shared secrets or vault references — PR branches are untrusted code, so use test or staging credentials here.")}
                </p>
                {!previewsEnabled && (
                  <p className="text-amber-300/80">{t('PR previews are off for this service — turn them on under Settings.')}</p>
                )}
              </div>
            ) : shared ? (
              <p className="mb-2 text-[11px] leading-relaxed text-slate-500">
                {fill(t("Every service in this project receives these on its next deploy. A service's own variable with the same name wins. PR previews get the non-secret ones only. Values may reference an external secret store: {ref}"), {
                  ref: <code className="rounded bg-white/5 px-1 font-mono text-[10px] text-slate-500">{REF_INFISICAL}</code>,
                })}
              </p>
            ) : (
              <p className="mb-2 text-[11px] text-slate-600">
                {fill(t('Values may reference an external secret store and are resolved at deploy time: {a} / {b}'), {
                  a: <code className="rounded bg-white/5 px-1 font-mono text-[10px] text-slate-500">{REF_INFISICAL}</code>,
                  b: <code className="rounded bg-white/5 px-1 font-mono text-[10px] text-slate-500">{REF_DOPPLER}</code>,
                })}
              </p>
            )}

            <form onSubmit={onAdd} className="space-y-2">
              <div className="flex gap-2">
                <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="KEY" className="h-9 min-w-0 flex-[2] font-mono text-xs" />
                <Input
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={secret ? t('secret value') : t('value')}
                  type={secret ? 'password' : 'text'}
                  className="h-9 min-w-0 flex-[3] font-mono text-xs"
                />
                <Button type="submit" size="sm" variant="secondary" disabled={!key.trim() || add.isPending}>
                  <Plus size={14} />
                </Button>
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-400">
                <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} className="accent-indigo-500" />
                <Lock size={11} /> {t('Secret (encrypted, hidden in UI)')}
              </label>
            </form>

            <div className="mt-3 space-y-1.5">
              {env.isLoading ? (
                <Skeleton className="h-8 w-full" />
              ) : env.isError && !env.data ? (
                // r562: a failed load is not an empty list.
                <ErrorCard title={t('Could not load environment variables')} error={env.error} onRetry={() => void env.refetch()} />
              ) : !env.data || env.data.length === 0 ? (
                <p className="py-2 text-xs text-slate-600">{t('No environment variables.')}</p>
              ) : (
                env.data
                  .filter((v) => !filter || v.key.toLowerCase().includes(filter.toLowerCase()))
                  .map((v) => {
                    const draft = drafts[v.id] ?? v.value;
                    // An emptied field is a real edit (clearing a value) — only
                    // an untouched field is not dirty.
                    const dirty = drafts[v.id] !== undefined && draft !== v.value;
                    return (
                      <div key={v.id} className="flex items-center gap-2 rounded-lg bg-white/[0.02] px-2 py-1.5 ring-1 ring-inset ring-white/5">
                        <div className="w-32 shrink-0 sm:w-48" title={v.key}>
                          <div className="truncate font-mono text-[11px] font-medium text-slate-200">{v.key}</div>
                          {v.isSecret && <span className="text-[9px] uppercase tracking-wide text-amber-400/80">{t('secret')}</span>}
                        </div>
                        <Input
                          value={dirty ? draft : v.value}
                          type={v.isSecret || v.hidden ? 'password' : 'text'}
                          placeholder={v.isSecret ? t('•••• hidden') : v.hidden ? t('•••• protected lane') : ''}
                          onChange={(e) => setDrafts((d) => ({ ...d, [v.id]: e.target.value }))}
                          className="h-7 min-w-0 flex-1 font-mono text-[11px]"
                        />
                        <button type="button"
                          onClick={() => update.mutate({ id: v.id, key: v.key, value: draft, isSecret: v.isSecret })}
                          disabled={!dirty}
                          className={cn('shrink-0 text-slate-600 transition', dirty ? 'hover:text-emerald-400' : 'opacity-30')}
                          title={t('Save')}
                        >
                          <Save size={13} />
                        </button>
                        <button type="button" onClick={() => remove.mutate(v.id)} className="shrink-0 text-slate-600 transition hover:text-rose-400" title={t('Delete')}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    );
                  })
              )}
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
