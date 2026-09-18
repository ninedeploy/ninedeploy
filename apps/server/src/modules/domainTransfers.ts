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
import { badRequest, notFound, parseId as num, unprocessable } from '../lib/errors.js';
import { loadServiceForUser, assertServiceRole } from '../lib/resourceAccess.js';
import { eq } from 'drizzle-orm';
import { domains } from '@ninedeploy/db';

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
      const svc = await loadServiceForUser(app.db, domain.serviceId, req.user!);
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
      let result: Awaited<ReturnType<typeof cancelTransfer>>;
      try {
        result = await cancelTransfer(app.db, req.params.token, req.user!.id, req.user!.isOperator);
      } catch (err) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      }
      void audit(app.db, req.user!.id, 'domain.transfer_cancel', `#${result.transferId}`);
      return result;
    });
  });
};

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
