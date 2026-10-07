/**
 * `ninedeploy domain {transfer, accept-transfer,
 *  cancel-transfer, preview-transfer}` — HTTP surface for
 * G-29 domain transfer.
 *
 * Two plugins in one file because the routes split across
 * two URL prefixes:
 *
 *   - `domainTransferStartRoutes` (mounted at /domains)
 *     holds `POST /:id/transfer` — the start endpoint
 *     lives next to the other /v1/domains/* routes so the
 *     panel's domain-detail page can render a "Transfer"
 *     button without a second navigation.
 *
 *   - `domainTransferTokenRoutes` (mounted at
 *     /domain-transfers) holds the token-based
 *     preview / accept / cancel endpoints. The token is
 *     the only credential these need; the accept endpoint
 *     additionally authenticates and checks the caller's
 *     email matches the target.
 *
 * Both plugins reuse `lib/domainTransfer.ts` for the
 * database reads / writes; the routes are thin shells
 * around auth, validation, and audit.
 */
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import {
  acceptTransfer,
  cancelTransfer,
  previewTransfer,
  startTransfer,
} from '../lib/domainTransfer.js';
import { writeDynamicConfig } from '../engine/proxy.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, HttpError, notFound, parseId as num, unprocessable } from '../lib/errors.js';
import { loadServiceForUser, assertServiceRole, roleAtLeast, serviceRole } from '../lib/resourceAccess.js';
import { ownZoneClaimRefusal } from '../lib/domainVerification.js';
import { eq } from 'drizzle-orm';
import { domainTransfers, domains, services, users } from '@ninedeploy/db';

const startBody = z.object({
  targetEmail: z.string().min(3).max(254),
});

/**
 * `POST /v1/domains/:id/transfer` — start a transfer.
 * Source user must be admin on the source service; the
 * target email can be a brand-new user (a future signup
 * just needs to register with that email) or an existing
 * one.
 */
export const domainTransferStartRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.post<{ Params: { id: string }; Body: { targetEmail?: string } }>(
    '/:id/transfer',
    async (req) => {
      const id = num((req.params as { id: string }).id);
      const body = startBody.safeParse(req.body ?? {});
      if (!body.success) {
        throw unprocessable(body.error.issues[0]!.message);
      }
      const domain = await app.db.query.domains.findFirst({ where: eq(domains.id, id) });
      if (!domain) throw notFound('Domain not found');
      // Admin on the source service — same gate as deleting
      // the domain (a transfer is no less destructive).
      // r361: a domain on a service the caller cannot see answers the SAME 404
      // as a missing domain. The loader's "Service not found" told the two
      // apart, so domain ids across tenants could be enumerated.
      const svc = await loadServiceForUser(app.db, domain.serviceId, req.user!).catch((err: unknown) => {
        throw err instanceof HttpError && err.statusCode === 404 ? notFound('Domain not found') : err;
      });
      await assertServiceRole(app.db, svc, req.user!, 'admin');
      const panelOrigin = readPanelOrigin(req);
      let result: Awaited<ReturnType<typeof startTransfer>>;
      try {
        result = await startTransfer(app.db, {
          domainId: id,
          sourceUserId: req.user!.id,
          targetEmail: body.data.targetEmail,
          panelOrigin,
        });
      } catch (err) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      }
      void audit(
        app.db,
        req.user!.id,
        'domain.transfer_start',
        `${domain.hostname} -> ${body.data.targetEmail}`,
      );
      return {
        ok: true,
        transferId: result.transferId,
        acceptUrl: result.acceptUrl,
        expiresAt: result.expiresAt,
      };
    },
  );
};

const acceptBody = z.object({
  targetServiceId: z.number().int().positive(),
});

/**
 * Token-based transfer routes. `preview` is unauthenticated
 * (the token is the secret); `accept` and `cancel` require
 * an authenticated session whose email / source matches the
 * row.
 */
export const domainTransferTokenRoutes: FastifyPluginAsync = async (app) => {
  // `preview` lives in front of `onRequest: authenticate`
  // so the panel can render the accept page to a logged-out
  // visitor and only prompt for sign-in on click.
  app.get<{ Params: { token: string } }>('/:token', async (req) => {
    const t = req.params.token;
    const preview = await previewTransfer(app.db, t);
    if (!preview) throw notFound('Transfer not found');
    return preview;
  });

  // accept / cancel need auth — in a NESTED scope (r185). A plugin-level
  // hook also covers routes declared before it, so the "public" preview
  // above answered 401 to the logged-out visitor it was written for.
  await app.register(async (authed) => {
    authed.addHook('onRequest', authed.authenticate);

    authed.post<{ Params: { token: string }; Body: { targetServiceId?: number } }>(
      '/:token/accept',
      async (req) => {
        const body = acceptBody.safeParse(req.body ?? {});
        if (!body.success) {
          throw unprocessable(body.error.issues[0]!.message);
        }
        // The one-time token proves that the caller was invited to accept the
        // transfer; it must not authorize choosing an arbitrary target service.
        // Otherwise a recipient could point another tenant's hostname at a
        // victim container and bypass that service's routing middleware.
        const targetService = await loadServiceForUser(app.db, body.data.targetServiceId, req.user!);
        await assertServiceRole(app.db, targetService, req.user!, 'admin');
        // F308 / F309: re-check both ends of the move against the CURRENT state.
        const pending = await pendingTransferDomain(app, req.params.token);
        if (pending) {
          await assertInitiatorStillAdmin(app, pending.sourceUserId, pending.domain.serviceId);
          // r223 claim rules, as on every other path that puts a hostname on a
          // service: another service's automatic domain and `*.<zone>` stay
          // off a non-operator's target.
          if (!req.user!.isOperator) {
            const refusal = await ownZoneClaimRefusal(app.db, targetService.id, pending.domain.hostname);
            if (refusal) throw conflict(`${pending.domain.hostname} ${refusal}`);
          }
        }
        let result: Awaited<ReturnType<typeof acceptTransfer>>;
        try {
          result = await acceptTransfer(app.db, {
            token: req.params.token,
            userId: req.user!.id,
            targetServiceId: body.data.targetServiceId,
          });
        } catch (err) {
          throw badRequest(err instanceof Error ? err.message : String(err));
        }
        // r180: re-render the routing table like every other domain mutation.
        // The row moved to the new service, but Traefik kept sending the
        // hostname to the OLD owner's container until some unrelated change
        // happened to rewrite the dynamic config.
        await writeDynamicConfig(app.db);
        void audit(
          app.db,
          req.user!.id,
          'domain.transfer_accept',
          `${result.hostname}: svc ${result.fromServiceId} -> ${result.serviceId}`,
        );
        return {
          ok: true,
          transferId: result.transferId,
          domainId: result.domainId,
          serviceId: result.serviceId,
          hostname: result.hostname,
        };
      },
    );

    authed.post<{ Params: { token: string } }>('/:token/cancel', async (req) => {
      // F308: a current admin of the domain's service may withdraw a transfer
      // someone else started (an offboarded admin's link otherwise blocked
      // every new transfer of the domain until it expired).
      const pending = req.user!.isOperator ? null : await pendingTransferDomain(app, req.params.token);
      const svc = pending
        ? await app.db.query.services.findFirst({ where: eq(services.id, pending.domain.serviceId) })
        : undefined;
      const role = svc ? await serviceRole(app.db, svc, req.user!) : null;
      const mayCancelAny = req.user!.isOperator || (role !== null && roleAtLeast(role, 'admin'));
      let result: Awaited<ReturnType<typeof cancelTransfer>>;
      try {
        result = await cancelTransfer(app.db, req.params.token, req.user!.id, mayCancelAny);
      } catch (err) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      }
      void audit(app.db, req.user!.id, 'domain.transfer_cancel', `#${result.transferId}`);
      return result;
    });
  });
};

type AppInstance = Parameters<FastifyPluginAsync>[0];

/** The still-pending transfer behind `token` and the domain row it would move, else null (the lib reports why). */
async function pendingTransferDomain(app: AppInstance, token: string) {
  const preview = await previewTransfer(app.db, token);
  if (!preview || preview.status !== 'pending') return null;
  const row = await app.db.query.domainTransfers.findFirst({ where: eq(domainTransfers.id, preview.id) });
  if (!row) return null;
  const domain = await app.db.query.domains.findFirst({ where: eq(domains.id, row.domainId) });
  return domain ? { sourceUserId: row.sourceUserId, domain } : null;
}

/**
 * F308: the token is a deferred use of the initiator's admin seat on the
 * domain's service, so it dies with that seat. An offboarded or demoted admin
 * (r694) used to keep a 7-day bearer link that moved the team's hostname to a
 * service of their choosing, and the remaining admins could not cancel it.
 */
async function assertInitiatorStillAdmin(app: AppInstance, sourceUserId: number, serviceId: number): Promise<void> {
  const refuse = () =>
    conflict(
      'The user who started this transfer no longer administers the domain; a current admin of its service can cancel it and start a new one',
    );
  const initiator = await app.db.query.users.findFirst({ where: eq(users.id, sourceUserId) });
  const svc = await app.db.query.services.findFirst({ where: eq(services.id, serviceId) });
  if (!initiator || initiator.deactivatedAt || !svc) throw refuse();
  const role = await serviceRole(app.db, svc, { id: initiator.id, isOperator: initiator.isInstanceOperator === true });
  if (role === null || !roleAtLeast(role, 'admin')) throw refuse();
}

/**
 * Resolve the panel origin used to build the acceptUrl.
 * The panel UI passes a request-time override via the
 * `X-Panel-Origin` header (it knows its own URL better
 * than any env var); the CLI relies on
 * `NINEDEPLOY_PUBLIC_URL`; the fallback is the wildcard
 * apex so a local dev install still produces a clickable
 * URL. The token is the only secret in the URL, so
 * embedding it in `localhost` is fine.
 */
function readPanelOrigin(req: { headers: Record<string, string | string[] | undefined> }): string {
  const header = req.headers['x-panel-origin'];
  if (typeof header === 'string' && header) return header.replace(/\/$/, '');
  return process.env['NINEDEPLOY_PUBLIC_URL'] ?? 'http://localhost:3000';
}
