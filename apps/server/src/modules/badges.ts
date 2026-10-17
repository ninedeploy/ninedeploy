import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { deployments, services } from '@ninedeploy/db';
import { audit } from '../lib/audit.js';
import { parseId } from '../lib/errors.js';
import { panelOrigin } from '../lib/panelOrigin.js';
import { assertServiceRole } from '../lib/resourceAccess.js';
import { loadServiceForUser } from '../lib/serviceAccess.js';

/**
 * 0.16.1 deploy status badges: a public SVG a README can embed
 * (`![deploy](https://panel.example.com/v1/badges/<token>.svg)`).
 *
 * The URL's token is the only credential, so a badge exists only once a
 * member turns it on, can be rotated (the old URL stops working) or turned
 * off, and says nothing but the deploy state: no service name, no host, no
 * commit — the label is "deploy" unless the URL asks for another one.
 */

/** 32 url-safe characters. */
const newToken = () => randomBytes(24).toString('base64url');
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

export type BadgeState = 'running' | 'deploying' | 'failed' | 'stopped' | 'not deployed';

const COLORS: Record<BadgeState, string> = {
  running: '#2ea44f',
  deploying: '#1f6feb',
  failed: '#cf222e',
  stopped: '#6e7781',
  'not deployed': '#6e7781',
};

/**
 * What the badge says. The newest deployment decides while it is in flight or
 * when it failed (a failed release is news even while the previous one keeps
 * serving); otherwise the service's own status does.
 */
export function badgeState(serviceStatus: string, latestDeployment: string | null): BadgeState {
  if (latestDeployment === 'queued' || latestDeployment === 'building' || latestDeployment === 'deploying') return 'deploying';
  if (latestDeployment === 'failed') return 'failed';
  if (serviceStatus === 'running') return 'running';
  if (serviceStatus === 'deploying') return 'deploying';
  if (serviceStatus === 'error') return 'failed';
  if (serviceStatus === 'stopped') return 'stopped';
  return 'not deployed';
}

const escapeXml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** Verdana 11px is ~6.5 px a character; badges only need to be close. */
const textWidth = (s: string) => Math.round(s.length * 6.5 + 10);

/** A flat, shields.io-style two-part badge: `label | message` on `color`. */
export function renderBadge(label: string, message: string, color: string): string {
  const lw = textWidth(label);
  const rw = textWidth(message);
  const w = lw + rw;
  const l = escapeXml(label);
  const r = escapeXml(message);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${l}: ${r}">` +
    `<title>${l}: ${r}</title>` +
    '<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>' +
    `<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${rw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g>` +
    '<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">' +
    `<text x="${lw / 2}" y="14">${l}</text><text x="${lw + rw / 2}" y="14">${r}</text></g></svg>`
  );
}

/** `?label=` — letters, digits, spaces and `._-`, at most 32; anything else falls back to "deploy". */
export function badgeLabel(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return /^[A-Za-z0-9 ._-]{1,32}$/.test(s) ? s : 'deploy';
}

/** Badge management, mounted under `/services`. */
export const serviceBadgeRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  const view = async (token: string | null) =>
    token ? { enabled: true, url: `${await panelOrigin(app.db)}/v1/badges/${token}.svg` } : { enabled: false, url: null };

  app.get('/:id/badge', async (req) => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    // The URL is the credential: reading it is a member's, like changing it.
    await assertServiceRole(app.db, svc, req.user!, 'member');
    return view(svc.badgeToken ?? null);
  });

  // Turn the badge on, or rotate its URL (the old one stops working).
  app.post('/:id/badge', async (req) => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const token = newToken();
    await app.db.update(services).set({ badgeToken: token }).where(eq(services.id, svc.id));
    void audit(app.db, req.user!.id, svc.badgeToken ? 'service.badge.rotate' : 'service.badge.enable', svc.name, { serviceId: svc.id });
    return view(token);
  });

  app.delete('/:id/badge', async (req) => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    await app.db.update(services).set({ badgeToken: null }).where(eq(services.id, svc.id));
    void audit(app.db, req.user!.id, 'service.badge.disable', svc.name, { serviceId: svc.id });
    return view(null);
  });
};

/** The public badge, mounted under `/badges`. No session: the token is the credential. */
export const publicBadgeRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:badge', async (req, reply) => {
    const token = String((req.params as { badge: string }).badge).replace(/\.svg$/, '');
    const label = badgeLabel((req.query as { label?: unknown }).label);
    // An SVG is a document: nothing in it may run or load, and nothing may sniff it into HTML.
    reply
      .header('Content-Type', 'image/svg+xml; charset=utf-8')
      .header('Cache-Control', 'no-cache, max-age=0')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
      .header('X-Content-Type-Options', 'nosniff');
    const svc = TOKEN_RE.test(token)
      ? await app.db.query.services.findFirst({ where: eq(services.badgeToken, token), columns: { id: true, status: true } })
      : undefined;
    if (!svc) {
      reply.code(404);
      return renderBadge(label, 'not found', COLORS.stopped);
    }
    const latest = await app.db.query.deployments.findFirst({
      where: eq(deployments.serviceId, svc.id),
      orderBy: desc(deployments.id),
      columns: { status: true },
    });
    const state = badgeState(svc.status, latest?.status ?? null);
    return renderBadge(label, state, COLORS[state]);
  });
};
