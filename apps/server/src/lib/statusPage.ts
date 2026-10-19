import { and, eq, gte, inArray } from 'drizzle-orm';
import { type DB, statusPages, uptimeDaily, uptimeMonitors } from '@ninedeploy/db';
import { overallStatus, type PublicStatusPage, STATUS_PAGE_DAYS } from '@ninedeploy/schemas';
import { uptimePercent, utcDay } from './uptime.js';

/**
 * 0.16.8 public status pages (docs/UPTIME.md). A page lists monitors by
 * NAME with their state and daily history; the target, the error text, the
 * service and every id stay out of it. An unpublished or unknown slug is a
 * 404, the same for both.
 */

/** A page is rebuilt at most this often; a status page can take a burst of visitors during an outage. */
export const STATUS_PAGE_CACHE_MS = 30_000;

const cache = new Map<string, { at: number; page: PublicStatusPage | null }>();

/** Forget cached pages (after an operator edits one). */
export function clearStatusPageCache(): void {
  cache.clear();
}

/** The public view of a page, or null when it does not exist or is not published. */
export async function buildPublicStatusPage(db: DB, slug: string, now: Date = new Date()): Promise<PublicStatusPage | null> {
  const page = await db.query.statusPages.findFirst({ where: eq(statusPages.slug, slug) });
  if (!page?.published) return null;
  const ids = (Array.isArray(page.monitorIds) ? page.monitorIds : []).filter((n) => Number.isInteger(n));
  const monitors = ids.length ? await db.select().from(uptimeMonitors).where(inArray(uptimeMonitors.id, ids)) : [];
  const days: string[] = [];
  for (let i = STATUS_PAGE_DAYS - 1; i >= 0; i--) days.push(utcDay(new Date(now.getTime() - i * 86_400_000)));
  const daily = monitors.length
    ? await db
        .select()
        .from(uptimeDaily)
        .where(and(inArray(uptimeDaily.monitorId, monitors.map((m) => m.id)), gte(uptimeDaily.day, days[0]!)))
    : [];
  const shown = ids.map((id) => monitors.find((m) => m.id === id)).filter((m) => m !== undefined);
  const list = shown.map((m) => {
    const rows = daily.filter((d) => d.monitorId === m.id);
    const checks = rows.reduce((a, d) => a + d.checks, 0);
    const failures = rows.reduce((a, d) => a + d.failures, 0);
    const okChecks = checks - failures;
    const status: 'up' | 'down' | 'unknown' = !m.enabled ? 'unknown' : m.status === 'up' ? 'up' : m.status === 'down' ? 'down' : 'unknown';
    return {
      name: m.name,
      status,
      uptime90d: uptimePercent(checks, failures),
      avgResponseMs: page.showResponseTimes && okChecks > 0 ? Math.round(rows.reduce((a, d) => a + d.responseMsSum, 0) / okChecks) : null,
      days: days.map((day) => {
        const r = rows.find((d) => d.day === day);
        return { day, uptime: r ? uptimePercent(r.checks, r.failures) : null };
      }),
    };
  });
  return {
    title: page.title,
    description: page.description ?? null,
    notice: page.notice ?? null,
    overall: overallStatus(list.map((m) => m.status)),
    monitors: list,
    generatedAt: now.toISOString(),
  };
}

/** {@link buildPublicStatusPage} behind a {@link STATUS_PAGE_CACHE_MS} cache. */
export async function cachedPublicStatusPage(db: DB, slug: string, nowMs: number = Date.now()): Promise<PublicStatusPage | null> {
  const hit = cache.get(slug);
  if (hit && nowMs - hit.at < STATUS_PAGE_CACHE_MS) return hit.page;
  const page = await buildPublicStatusPage(db, slug, new Date(nowMs));
  if (cache.size > 500) cache.clear();
  cache.set(slug, { at: nowMs, page });
  return page;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const OVERALL_TEXT: Record<PublicStatusPage['overall'], string> = {
  operational: 'All systems operational',
  degraded: 'Some systems are down',
  down: 'All systems are down',
  unknown: 'Status not known yet',
};

/** The bar colour for a day's uptime. */
export function dayClass(uptime: number | null): string {
  if (uptime == null) return 'none';
  if (uptime >= 99.9) return 'ok';
  if (uptime >= 95) return 'warn';
  return 'bad';
}

const pct = (n: number | null) => (n == null ? '—' : `${n.toFixed(n === 100 ? 0 : 2)}%`);

/**
 * The page as a self-contained HTML document: no script, no external asset,
 * a meta refresh every 60 s. The panel's CSP (no inline script) applies.
 */
export function renderStatusPageHtml(page: PublicStatusPage): string {
  const monitors = page.monitors
    .map((m) => {
      const bars = m.days
        .map((d) => `<i class="${dayClass(d.uptime)}" title="${d.day}: ${d.uptime == null ? 'no data' : pct(d.uptime)}"></i>`)
        .join('');
      return `<section class="monitor">
  <div class="row"><span class="name">${escapeHtml(m.name)}</span><span class="state ${m.status}">${m.status === 'up' ? 'Operational' : m.status === 'down' ? 'Down' : 'Unknown'}</span></div>
  <div class="bars" aria-label="Last ${m.days.length} days">${bars}</div>
  <div class="row meta"><span>${m.days.length} days ago</span><span>${pct(m.uptime90d)} uptime${m.avgResponseMs != null ? ` · ${m.avgResponseMs} ms average` : ''}</span><span>Today</span></div>
</section>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>${escapeHtml(page.title)}</title>
<style>
:root{--bg:#f8fafc;--card:#fff;--fg:#0f172a;--muted:#64748b;--line:#e2e8f0;--ok:#16a34a;--warn:#d97706;--bad:#dc2626;--none:#cbd5e1}
@media (prefers-color-scheme:dark){:root{--bg:#0b1120;--card:#111827;--fg:#e2e8f0;--muted:#94a3b8;--line:#1f2937;--none:#334155}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px}h1{font-size:24px;margin:0 0 4px}p.desc{color:var(--muted);margin:0 0 20px}
.banner{border-radius:10px;padding:14px 16px;margin:16px 0;font-weight:600;color:#fff}.banner.operational{background:var(--ok)}.banner.degraded{background:var(--warn)}.banner.down{background:var(--bad)}.banner.unknown{background:var(--muted)}
.notice{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--warn);border-radius:8px;padding:12px 14px;margin:0 0 16px;white-space:pre-wrap}
.monitor{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:0 0 12px}
.row{display:flex;justify-content:space-between;gap:8px;align-items:center}.name{font-weight:600;overflow-wrap:anywhere}
.state{font-size:13px;font-weight:600}.state.up{color:var(--ok)}.state.down{color:var(--bad)}.state.unknown{color:var(--muted)}
.bars{display:flex;gap:2px;height:30px;margin:10px 0 6px}.bars i{flex:1;border-radius:2px;background:var(--none)}.bars i.ok{background:var(--ok)}.bars i.warn{background:var(--warn)}.bars i.bad{background:var(--bad)}
.meta{font-size:12px;color:var(--muted)}footer{color:var(--muted);font-size:12px;text-align:center;margin-top:24px}
@media (max-width:520px){.bars{gap:1px}.meta span:first-child,.meta span:last-child{display:none}}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(page.title)}</h1>
${page.description ? `<p class="desc">${escapeHtml(page.description)}</p>` : ''}
<div class="banner ${page.overall}">${OVERALL_TEXT[page.overall]}</div>
${page.notice ? `<div class="notice">${escapeHtml(page.notice)}</div>` : ''}
${monitors || '<p class="desc">No monitors on this page yet.</p>'}
<footer>Updated ${escapeHtml(page.generatedAt.replace('T', ' ').slice(0, 16))} UTC · Powered by NineDeploy</footer>
</main>
</body>
</html>
`;
}
