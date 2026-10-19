import {
  DEFAULT_EXPECTED_STATUS,
  monitorCreate,
  monitorTargetProblem,
  monitorPatch,
  statusPageCreate,
  statusPagePatch,
  type MonitorCheckView,
  type MonitorKind,
  type MonitorStatus,
  type MonitorView,
  type StatusPageView,
} from '@ninedeploy/schemas';

/**
 * 0.16.8 uptime monitors and status pages: the pure helpers behind the
 * Monitoring → Uptime section and the service Overview card (formatting,
 * colours, form ↔ API conversion). No React, no network.
 */

/** Uptime percent as the list shows it: "100%", "99.95%", "—" without checks. */
export function formatUptime(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return '—';
  return `${Number(pct.toFixed(2))}%`;
}

export type UptimeTone = 'emerald' | 'amber' | 'rose' | 'neutral';

/** Colour for an uptime figure: 99%+ green, 95%+ amber, below rose. */
export function uptimeTone(pct: number | null | undefined): UptimeTone {
  if (pct == null || !Number.isFinite(pct)) return 'neutral';
  if (pct >= 99) return 'emerald';
  if (pct >= 95) return 'amber';
  return 'rose';
}

/** Text class per uptime tone (each one re-toned for the light theme in index.css). */
export const UPTIME_TONE_TEXT: Record<UptimeTone, string> = {
  emerald: 'text-emerald-300',
  amber: 'text-amber-300',
  rose: 'text-rose-300',
  neutral: 'text-slate-500',
};

export interface MonitorStatusUi {
  label: string;
  /** Badge classes (background, text, ring). */
  badge: string;
  /** The solid status dot. */
  dot: string;
  /** Stroke of the response-time sparkline. */
  spark: string;
}

const STATUS_UI: Record<MonitorStatus, MonitorStatusUi> = {
  up: { label: 'UP', badge: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/20', dot: 'bg-emerald-400', spark: '#34d399' },
  down: { label: 'DOWN', badge: 'bg-rose-500/15 text-rose-300 ring-rose-500/20', dot: 'bg-rose-500', spark: '#fb7185' },
  pending: { label: 'PENDING', badge: 'bg-slate-500/15 text-slate-400 ring-slate-500/20', dot: 'bg-slate-400', spark: '#94a3b8' },
  paused: { label: 'PAUSED', badge: 'bg-slate-500/15 text-slate-400 ring-slate-500/20', dot: 'bg-slate-400', spark: '#94a3b8' },
};

/** Badge, dot and sparkline colours for a monitor state (an unknown state reads as pending). */
export function monitorStatusUi(status: string): MonitorStatusUi {
  return STATUS_UI[status as MonitorStatus] ?? STATUS_UI.pending;
}

/** Response times oldest → newest for the sparkline (the API lists checks newest first). */
export function sparklinePoints(checks: readonly MonitorCheckView[]): number[] {
  const points: number[] = [];
  for (let i = checks.length - 1; i >= 0; i--) {
    const ms = checks[i]!.responseMs;
    if (ms != null && Number.isFinite(ms)) points.push(ms);
  }
  return points;
}

/** Whole days until `iso`, rounded down (negative once it has passed). */
export function daysUntil(iso: string, now: number = Date.now()): number {
  return Math.floor((new Date(iso).getTime() - now) / 86_400_000);
}

/** Days left before a certificate is flagged in the list. */
export const CERT_WARN_DAYS = 14;

/** How the certificate expiry reads, and whether it needs attention. */
export function certExpiry(iso: string, now: number = Date.now()): { text: string; tone: 'rose' | 'amber' | 'neutral' } {
  const days = daysUntil(iso, now);
  if (days < 0) return { text: 'certificate expired', tone: 'rose' };
  if (days === 0) return { text: 'certificate expires today', tone: 'rose' };
  const text = `certificate expires in ${days} day${days === 1 ? '' : 's'}`;
  return { text, tone: days < CERT_WARN_DAYS ? 'amber' : 'neutral' };
}

/** "123 ms" / "1.2 s" / "—". */
export function formatResponseMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms >= 1000) return `${Number((ms / 1000).toFixed(1))} s`;
  return `${Math.round(ms)} ms`;
}

/** "every 60s" / "every 5m" / "every 1h". */
export function formatInterval(seconds: number): string {
  if (seconds % 3600 === 0) return `every ${seconds / 3600}h`;
  if (seconds % 60 === 0) return `every ${seconds / 60}m`;
  return `every ${seconds}s`;
}

/** The target field's placeholder per check kind. */
export function targetPlaceholder(kind: MonitorKind): string {
  return kind === 'tcp' ? 'db.example.com:5432' : 'https://example.com/health';
}

// ── Monitor form ─────────────────────────────────────────────────────────

/** What the monitor modal edits: numbers stay text until they are submitted. */
export interface MonitorForm {
  name: string;
  serviceId: string;
  kind: MonitorKind;
  target: string;
  method: 'GET' | 'HEAD';
  expectedStatus: string;
  keyword: string;
  intervalSeconds: string;
  timeoutSeconds: string;
  failuresBeforeDown: string;
  followRedirects: boolean;
  verifyTls: boolean;
  enabled: boolean;
}

/** A blank form with the API's defaults, optionally prefilled. */
export function emptyMonitorForm(prefill: Partial<MonitorForm> = {}): MonitorForm {
  return {
    name: '',
    serviceId: '',
    kind: 'http',
    target: '',
    method: 'GET',
    expectedStatus: DEFAULT_EXPECTED_STATUS,
    keyword: '',
    intervalSeconds: '60',
    timeoutSeconds: '10',
    failuresBeforeDown: '2',
    followRedirects: true,
    verifyTls: true,
    enabled: true,
    ...prefill,
  };
}

/** The form for editing an existing monitor. */
export function monitorToForm(m: MonitorView): MonitorForm {
  return {
    name: m.name,
    serviceId: m.serviceId == null ? '' : String(m.serviceId),
    kind: m.kind,
    target: m.target,
    method: m.method,
    expectedStatus: m.expectedStatus,
    keyword: m.keyword ?? '',
    intervalSeconds: String(m.intervalSeconds),
    timeoutSeconds: String(m.timeoutSeconds),
    failuresBeforeDown: String(m.failuresBeforeDown),
    followRedirects: m.followRedirects,
    verifyTls: m.verifyTls,
    enabled: m.enabled,
  };
}

/** Text → number for the zod check; blank or non-numeric text stays invalid. */
function num(raw: string): number {
  const t = raw.trim();
  return t === '' ? Number.NaN : Number(t);
}

/**
 * The request body for a form. HTTP-only fields are sent as their defaults
 * for a TCP check, so switching kind never leaves a keyword the server refuses.
 */
export function formToMonitorInput(f: MonitorForm) {
  const http = f.kind === 'http';
  return {
    name: f.name.trim(),
    serviceId: f.serviceId ? Number(f.serviceId) : null,
    kind: f.kind,
    target: f.target.trim(),
    method: http ? f.method : 'GET',
    expectedStatus: http ? f.expectedStatus.trim() : DEFAULT_EXPECTED_STATUS,
    keyword: http && f.keyword.trim() ? f.keyword.trim() : null,
    intervalSeconds: num(f.intervalSeconds),
    timeoutSeconds: num(f.timeoutSeconds),
    failuresBeforeDown: num(f.failuresBeforeDown),
    followRedirects: f.followRedirects,
    verifyTls: f.verifyTls,
    enabled: f.enabled,
  } as const;
}

/** Field name → first problem with it. */
export type FieldErrors = Partial<Record<string, string>>;

function issuesToErrors(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : '_';
    errors[key] ??= issue.message;
  }
  return errors;
}

/** Validate a monitor form with the API's own schema (create, or patch for an edit). */
export function validateMonitorForm(f: MonitorForm, mode: 'create' | 'edit'): { ok: true; body: ReturnType<typeof formToMonitorInput> } | { ok: false; errors: FieldErrors } {
  const body = formToMonitorInput(f);
  const parsed = (mode === 'create' ? monitorCreate : monitorPatch).safeParse(body);
  if (parsed.success) return { ok: true, body };
  const errors = issuesToErrors(parsed.error.issues);
  // The schema checks the target only once every other field parses; say it at once.
  if (!errors.target && body.target) {
    const problem = monitorTargetProblem(body.kind, body.target);
    if (problem) errors.target = problem;
  }
  return { ok: false, errors };
}

/** A domain as the service page knows it. */
export interface DomainLike {
  hostname: string;
  path?: string | null;
  ssl?: boolean;
}

/** The URL a new monitor for a service starts with: its first domain, else its auto URL, else empty. */
export function serviceMonitorTarget(domains: readonly DomainLike[] | undefined, autoUrl?: string | null): string {
  const d = domains?.[0];
  if (d) {
    const path = d.path && d.path !== '/' ? (d.path.startsWith('/') ? d.path : `/${d.path}`) : '/';
    return `${d.ssl === false ? 'http' : 'https'}://${d.hostname}${path}`;
  }
  return autoUrl ? `http://${autoUrl}/` : '';
}

// ── Status page form ─────────────────────────────────────────────────────

export interface StatusPageForm {
  slug: string;
  title: string;
  description: string;
  notice: string;
  published: boolean;
  showResponseTimes: boolean;
  monitorIds: number[];
}

export function emptyStatusPageForm(): StatusPageForm {
  return { slug: '', title: '', description: '', notice: '', published: false, showResponseTimes: true, monitorIds: [] };
}

export function statusPageToForm(p: StatusPageView): StatusPageForm {
  return {
    slug: p.slug,
    title: p.title,
    description: p.description ?? '',
    notice: p.notice ?? '',
    published: p.published,
    showResponseTimes: p.showResponseTimes,
    monitorIds: [...p.monitorIds],
  };
}

export function formToStatusPageInput(f: StatusPageForm) {
  return {
    slug: f.slug.trim(),
    title: f.title.trim(),
    description: f.description.trim() || null,
    notice: f.notice.trim() || null,
    published: f.published,
    showResponseTimes: f.showResponseTimes,
    monitorIds: [...f.monitorIds],
  };
}

export function validateStatusPageForm(f: StatusPageForm, mode: 'create' | 'edit'): { ok: true; body: ReturnType<typeof formToStatusPageInput> } | { ok: false; errors: FieldErrors } {
  const body = formToStatusPageInput(f);
  const parsed = (mode === 'create' ? statusPageCreate : statusPagePatch).safeParse(body);
  return parsed.success ? { ok: true, body } : { ok: false, errors: issuesToErrors(parsed.error.issues) };
}

/** A slug suggestion from a title ("Acme Status" → "acme-status"). */
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

/** `items` with the entry at `index` moved one step up (-1) or down (+1); unchanged at the edges. */
export function moveItem<T>(items: readonly T[], index: number, dir: -1 | 1): T[] {
  const next = [...items];
  const to = index + dir;
  if (index < 0 || index >= next.length || to < 0 || to >= next.length) return next;
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}
