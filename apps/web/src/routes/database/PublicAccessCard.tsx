import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { AlertTriangle, Copy, Globe, Plus, Save, Trash2, X } from 'lucide-react';
import {
  PUBLIC_ACCESS_ALLOWLIST_MAX,
  PUBLIC_ACCESS_PORT_MAX,
  PUBLIC_ACCESS_PORT_MIN,
  type PublicAccessStatus,
  type PublicAccessTlsMode,
} from '@ninedeploy/schemas';
import type { DatabaseCredentialsWithPublic, DatabaseDetail } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { formatDateTime, useCopy } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { isNodeDatabase } from '../../components/NodeDatabaseBadge.js';
import { Button, Card, CardBody, ConfirmDialog, Field, Input, Select, Skeleton, StatusBadge, Switch } from '../../components/ui.js';
import { fill, msg, translate, useT, type Translate } from '../../lib/i18n.js';

/** Engines whose wire protocol cannot carry TLS termination by the sidecar. */
const NO_TERMINATE = new Set(['mysql', 'mariadb']);

export interface AllowlistAnalysis {
  /** Blocks saving. */
  error: string | null;
  /** Shown, but the entry is still accepted. */
  warnings: string[];
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isIpv6(addr: string): boolean {
  if (!addr.includes(':') || !/^[0-9A-Fa-f:.]+$/.test(addr)) return false;
  try {
    new URL(`http://[${addr}]/`);
    return true;
  } catch {
    return false;
  }
}

const PROXY_NOTE = msg(
  'Docker’s userland proxy can rewrite the client address to the bridge gateway, so a private range may admit more than you expect.',
);

/** English, for callers (tests) that do not pass the component's translator. */
const ENGLISH: Translate = (text, vars) => translate('en', text, vars);

/**
 * Client-side mirror of the server's allow-list rules (the server re-checks
 * every entry with node:net): a valid address or CIDR, never a /0. Broad
 * prefixes (shorter than /16 IPv4, /48 IPv6) and private, loopback or
 * link-local ranges get a warning.
 */
export function analyzeAllowlistEntry(raw: string, t: Translate = ENGLISH): AllowlistAnalysis {
  const entry = raw.trim();
  if (entry === '') return { error: null, warnings: [] };
  const [addr = '', prefixRaw, extra] = entry.split('/');
  if (extra !== undefined) return { error: t('Use one address or CIDR per row'), warnings: [] };
  const v4 = IPV4_RE.test(addr);
  const v6 = !v4 && isIpv6(addr);
  if (!v4 && !v6) return { error: t('“{entry}” is not an IP address or CIDR range', { entry }), warnings: [] };
  if (v6 && /^::ffff:/i.test(addr)) return { error: t('IPv4-mapped IPv6 entries are refused; enter the IPv4 range'), warnings: [] };
  const max = v4 ? 32 : 128;
  let prefix = max;
  if (prefixRaw !== undefined) {
    if (!/^\d{1,3}$/.test(prefixRaw) || Number(prefixRaw) > max) return { error: t('The prefix must be between 1 and {max}', { max }), warnings: [] };
    prefix = Number(prefixRaw);
  }
  if (prefix === 0) return { error: t('A /0 range would admit the whole internet'), warnings: [] };
  const warnings: string[] = [];
  if (v4 ? prefix < 16 : prefix < 48) warnings.push(t('/{prefix} is a very broad range', { prefix }));
  if (v4) {
    const [a = 0, b = 0] = addr.split('.').map(Number);
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) warnings.push(t('Private range. {note}', { note: t(PROXY_NOTE) }));
    else if (a === 127) warnings.push(t('Loopback address: only the panel host itself could connect.'));
    else if (a === 169 && b === 254) warnings.push(t('Link-local range: not reachable from the internet.'));
  } else {
    const lower = addr.toLowerCase();
    if (lower === '::1') warnings.push(t('Loopback address: only the panel host itself could connect.'));
    else if (/^f[cd]/.test(lower)) warnings.push(t('Private (unique-local) range. {note}', { note: t(PROXY_NOTE) }));
    else if (/^fe[89ab]/.test(lower)) warnings.push(t('Link-local range: not reachable from the internet.'));
  }
  return { error: null, warnings };
}

interface FormState {
  enabled: boolean;
  port: string;
  allow: string[];
  tlsMode: PublicAccessTlsMode;
  tlsHostname: string;
}

function formFrom(s: PublicAccessStatus): FormState {
  return {
    enabled: s.enabled,
    port: s.port == null ? '' : String(s.port),
    allow: s.ipAllowlist.length > 0 ? [...s.ipAllowlist] : [''],
    tlsMode: s.tlsMode,
    tlsHostname: s.tlsHostname ?? '',
  };
}

const errorStatus = (err: unknown): number | undefined => (err as { status?: number } | null)?.status;
const message = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

/** The public connection string with its password masked (the copy button copies it whole). */
function masked(creds: DatabaseCredentialsWithPublic | undefined): { shown: string; full: string } | null {
  if (!creds?.publicConnectionString) return null;
  const full = creds.publicConnectionString;
  return { shown: creds.password ? full.split(creds.password).join('••••••') : full, full };
}

/**
 * "Public access" card on the database Settings tab (0.14): a per-database
 * Traefik TCP sidecar publishing one host port behind a required IP
 * allow-list. Reading needs `admin` on the database; changing it is
 * operator-only, so other admins get a read-only view.
 */
export function PublicAccessCard({ db }: { db: DatabaseDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const isOperator = user?.isOperator === true;
  const { copied, copy } = useCopy();
  const [confirmDisable, setConfirmDisable] = useState(false);

  const status = useQuery({
    queryKey: ['database-public-access', db.id],
    queryFn: () => api.databases.publicAccess.get(db.id),
  });
  // Read from the Overview tab's cache only: this card never fetches (and so
  // never reveals) the credentials on its own.
  const creds = useQuery<DatabaseCredentialsWithPublic>({
    queryKey: ['database-credentials', db.id],
    queryFn: skipToken,
  });

  const [form, setForm] = useState<FormState | null>(null);
  useEffect(() => {
    if (status.data) setForm(formFrom(status.data));
  }, [status.data]);

  const refresh = (saved?: PublicAccessStatus) => {
    if (saved) qc.setQueryData(['database-public-access', db.id], saved);
    else void qc.invalidateQueries({ queryKey: ['database-public-access', db.id] });
    void qc.invalidateQueries({ queryKey: ['database-detail', db.id] });
    void qc.invalidateQueries({ queryKey: ['database-credentials', db.id] });
  };

  const save = useMutation({
    mutationFn: (f: FormState) =>
      api.databases.publicAccess.set(db.id, {
        enabled: true,
        port: Number(f.port),
        ipAllowlist: f.allow.map((a) => a.trim()).filter(Boolean),
        tlsMode: f.tlsMode,
        ...(f.tlsHostname.trim() ? { tlsHostname: f.tlsHostname.trim() } : {}),
      }),
    onSuccess: (saved) => {
      refresh(saved);
      toast(saved.status === 'error' ? t('Saved, but the sidecar reported: {error}', { error: saved.lastError ?? t('an error') }) : t('Public access applied'), saved.status === 'error' ? 'error' : 'success');
    },
    onError: (err) => toast(message(err, t('Could not apply public access')), 'error'),
  });

  const disable = useMutation({
    mutationFn: () => api.databases.publicAccess.disable(db.id),
    onSuccess: () => {
      refresh();
      toast(t('Public access disabled'), 'success');
    },
    onError: (err) => toast(message(err, t('Could not disable public access')), 'error'),
  });

  const title = (
    <div className="p-4 border-b border-white/[0.06] flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
        <Globe size={14} /> {t('Public access')}
      </h2>
      {status.data && <StatusBadge status={status.data.status} />}
    </div>
  );

  if (status.isLoading) {
    return (
      <Card>
        <CardBody>
          <Skeleton className="h-24" />
        </CardBody>
      </Card>
    );
  }
  if (status.isError || !status.data || !form) {
    return (
      <Card className="overflow-hidden">
        {title}
        <CardBody>
          <p className="text-sm text-slate-500">
            {errorStatus(status.error) === 403
              ? t('Public access settings need admin rights on this database.')
              : t('Could not load the public access settings.')}
          </p>
        </CardBody>
      </Card>
    );
  }

  const current = status.data;
  if (!current.supported) {
    return (
      <Card className="overflow-hidden">
        {title}
        <CardBody>
          <p className="text-sm text-slate-400">
            {t('This engine ({engine}) cannot be exposed through a TCP port. HTTP engines such as ClickHouse and Meilisearch are reached through a domain instead; RabbitMQ is not supported yet.', { engine: db.engine })}
          </p>
        </CardBody>
      </Card>
    );
  }

  const set = (patch: Partial<FormState>) => setForm({ ...form, ...patch });
  const setEntry = (i: number, value: string) => set({ allow: form.allow.map((a, j) => (j === i ? value : a)) });
  const analyses = form.allow.map((a) => analyzeAllowlistEntry(a, t));
  const entries = form.allow.map((a) => a.trim()).filter(Boolean);
  const portNum = Number(form.port);
  const portError =
    /^\d+$/.test(form.port) && portNum >= PUBLIC_ACCESS_PORT_MIN && portNum <= PUBLIC_ACCESS_PORT_MAX
      ? null
      : t('A port between {min} and {max}', { min: PUBLIC_ACCESS_PORT_MIN, max: PUBLIC_ACCESS_PORT_MAX });
  // A node database keeps TLS end to end: the certificates are on the panel.
  const onNode = isNodeDatabase(db);
  const terminateRefused = NO_TERMINATE.has(db.engine) || onNode;
  const invalid =
    portError != null || entries.length === 0 || analyses.some((a) => a.error) || (terminateRefused && form.tlsMode === 'terminate');
  const conn = masked(creds.data);
  const endpoint = current.enabled && current.publicHost && current.port != null ? `${current.publicHost}:${current.port}` : null;

  return (
    <Card className="overflow-hidden">
      {title}
      <CardBody className="space-y-4">
        <div className="flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3 text-xs text-amber-200" role="note">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>
            {fill(
              t('Public access exposes this database with its {root} credentials. Create a limited user for outside clients, keep the allow-list as narrow as you can, and disable access when you no longer need it.'),
              { root: <strong>root</strong> },
            )}
          </span>
        </div>

        {endpoint && (
          <div className="space-y-2 text-xs">
            <p className="text-slate-400">
              {fill(current.tlsMode === 'terminate' ? t('Connect to {endpoint} over TLS.') : t('Connect to {endpoint}.'), {
                endpoint: <span className="font-mono text-indigo-300" data-testid="public-endpoint">{endpoint}</span>,
              })}
            </p>
            {conn && (
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded-lg border border-white/[0.08] bg-black/40 p-2 font-mono text-indigo-300">{conn.shown}</code>
                <Button variant="secondary" size="sm" onClick={() => void copy(conn.full)} title={t('Copy public connection string')}>
                  <Copy size={12} /> {copied ? t('Copied') : t('Copy')}
                </Button>
              </div>
            )}
          </div>
        )}
        {current.lastError && <p className="text-xs text-rose-300">{t('Last error: {error}', { error: current.lastError })}</p>}
        {current.appliedAt && <p className="text-xs text-slate-500">{t('Applied {time}', { time: formatDateTime(current.appliedAt) })}</p>}

        {!isOperator ? (
          <div className="space-y-2 text-sm" data-testid="public-access-readonly">
            {current.configured ? (
              <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-xs">
                <dt className="text-slate-500">{t('State')}</dt>
                <dd className="text-slate-200">{current.enabled ? t('Enabled') : t('Disabled')}</dd>
                <dt className="text-slate-500">{t('Port')}</dt>
                <dd className="font-mono text-slate-200">{current.port ?? '—'}</dd>
                <dt className="text-slate-500">TLS</dt>
                <dd className="text-slate-200">{current.tlsMode === 'terminate' ? `${t('Terminate')}${current.tlsHostname ? ` (${current.tlsHostname})` : ''}` : t('None')}</dd>
                <dt className="text-slate-500">{t('Allowed')}</dt>
                <dd className="font-mono text-slate-200">{current.ipAllowlist.join(', ')}</dd>
              </dl>
            ) : (
              <p className="text-xs text-slate-400">{t('Public access is not configured.')}</p>
            )}
            <p className="text-xs text-slate-500">{t('Only an instance operator can change public access.')}</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm text-slate-200">{t('Expose on a host port')}</p>
                <p className="text-xs text-slate-500">{t('A Traefik sidecar forwards one host port to this database.')}</p>
              </div>
              <Switch checked={form.enabled} onChange={(v) => set({ enabled: v })} label={t('Public access')} />
            </div>

            {form.enabled && (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t('Public port')} hint={`${PUBLIC_ACCESS_PORT_MIN}–${PUBLIC_ACCESS_PORT_MAX}`} error={form.port === '' ? null : portError}>
                    <Input type="number" value={form.port} onChange={(e) => set({ port: e.target.value })} placeholder="15432" />
                  </Field>
                  <Field label="TLS" hint={onNode ? t('On a node, TLS stays end to end between the client and the database') : terminateRefused ? t('MySQL/MariaDB negotiate TLS themselves') : undefined}>
                    <Select value={form.tlsMode} onChange={(e) => set({ tlsMode: e.target.value as PublicAccessTlsMode })}>
                      <option value="none">{t('None (passthrough)')}</option>
                      <option value="terminate" disabled={terminateRefused}>
                        {t('Terminate at the sidecar')}
                      </option>
                    </Select>
                  </Field>
                  {form.tlsMode === 'terminate' && (
                    <Field label={t('TLS hostname')} hint={t('an uploaded certificate covering it is used')}>
                      <Input value={form.tlsHostname} onChange={(e) => set({ tlsHostname: e.target.value })} placeholder="db.example.com" />
                    </Field>
                  )}
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t('Allowed sources (IP or CIDR)')}</p>
                  {form.allow.map((value, i) => (
                    <div key={i} className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Input
                          aria-label={t('Allowed source {n}', { n: i + 1 })}
                          value={value}
                          onChange={(e) => setEntry(i, e.target.value)}
                          placeholder="203.0.113.0/24"
                          className="font-mono"
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          title={t('Remove source {n}', { n: i + 1 })}
                          onClick={() => set({ allow: form.allow.length > 1 ? form.allow.filter((_, j) => j !== i) : [''] })}
                        >
                          <X size={12} />
                        </Button>
                      </div>
                      {analyses[i]!.error && <p className="text-[11px] text-rose-300">{analyses[i]!.error}</p>}
                      {analyses[i]!.warnings.map((w) => (
                        <p key={w} className="text-[11px] text-amber-300">
                          {w}
                        </p>
                      ))}
                    </div>
                  ))}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => set({ allow: [...form.allow, ''] })}
                    disabled={form.allow.length >= PUBLIC_ACCESS_ALLOWLIST_MAX}
                  >
                    <Plus size={12} /> {t('Add source')}
                  </Button>
                  {entries.length === 0 && <p className="text-[11px] text-slate-500">{t('At least one source is required; an empty list never means “everyone”.')}</p>}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              {!form.enabled && current.enabled && (
                <Button variant="danger" size="sm" onClick={() => setConfirmDisable(true)} disabled={disable.isPending}>
                  <Trash2 size={12} /> {t('Disable public access')}
                </Button>
              )}
              {form.enabled && (
                <Button size="sm" onClick={() => save.mutate(form)} disabled={invalid || save.isPending}>
                  <Save size={12} /> {current.enabled ? t('Save and apply') : t('Enable')}
                </Button>
              )}
            </div>
          </>
        )}
      </CardBody>

      <ConfirmDialog
        open={confirmDisable}
        title={t('Disable public access?')}
        message={t('The sidecar for "{name}" is removed and clients connecting from outside lose access. The settings are kept for next time.', { name: db.name })}
        confirmLabel={t('Disable')}
        onConfirm={() => disable.mutate()}
        onClose={() => setConfirmDisable(false)}
      />
    </Card>
  );
}
