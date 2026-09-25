/**
 * `ninedeploy email-templates {list,get,set,reset,preview}` —
 * G-30 transactional email templates (HTTP surface).
 *
 * The list / get / preview routes are member-accessible
 * (the operator needs to see the current text to write a
 * reasonable override); the set / reset routes are
 * admin-only on the workspace.
 */
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { emailTemplateOverrides, type DB, workspaces } from '@ninedeploy/db';
import { audit } from '../lib/audit.js';
import { badRequest, notFound, parseId as num, unprocessable } from '../lib/errors.js';
import {
  ALL_TEMPLATE_NAMES,
  type EmailTemplateName,
  renderTemplate,
  setOverride,
  clearOverride,
} from '../lib/emailTemplates.js';
import { assertWorkspaceRole, isWorkspaceMember, type AuthedUser } from '../lib/resourceAccess.js';

/** Lightweight workspace loader — the route needs the
 *  workspace's name for audit messages; the role check is
 *  `assertWorkspaceRole`, run after it. A caller with no seat
 *  gets this loader's 404, never that check's 403 (r361). */
async function loadWorkspaceRow(db: DB, id: number, user: AuthedUser): Promise<{ id: number; name: string }> {
  const row = await db.query.workspaces.findFirst({ where: eq(workspaces.id, id) });
  if (!row) throw notFound('Workspace not found');
  // r361: another tenant's workspace answers the same 404 as a missing one.
  // The admin check that follows used to 403 it, confirming the id existed.
  if (!user.isOperator && !(await isWorkspaceMember(db, id, user))) throw notFound('Workspace not found');
  return row;
}

const NAME_ENUM = z.enum(ALL_TEMPLATE_NAMES as [EmailTemplateName, ...EmailTemplateName[]]);

const setBody = z.object({
  name: NAME_ENUM,
  subject: z.string().min(1).max(500),
  text: z.string().min(1).max(10_000),
});

const previewBody = z.object({
  name: NAME_ENUM,
  vars: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).default({}),
});

export const emailTemplateRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  // `GET /:wid/email-templates` — list the built-in names
  // AND every override the workspace has set. Member
  // access (the read side is open to anyone with a seat).
  app.get<{ Params: { wid: string } }>('/:wid/email-templates', async (req) => {
    const wid = num((req.params as { wid: string }).wid);
    await assertWorkspaceRole(app.db, wid, req.user!, 'member');
    const overrides = await app.db.query.emailTemplateOverrides.findMany({
      where: eq(emailTemplateOverrides.workspaceId, wid),
    });
    return {
      workspaceId: wid,
      templates: ALL_TEMPLATE_NAMES.map((name) => {
        const ov = overrides.find((o) => o.name === name);
        return {
          name,
          overridden: !!ov,
          subject: ov?.subject ?? null,
          text: ov?.text ?? null,
        };
      }),
    };
  });

  // `POST /:wid/email-templates/preview` — render a
  // template with the supplied vars. Returns the same
  // shape the auth.ts / invitations call sites would see,
  // so the operator can paste the result into a test
  // inbox. Member access.
  app.post<{ Params: { wid: string }; Body: { name: string; vars?: Record<string, string | number | null> } }>(
    '/:wid/email-templates/preview',
    async (req) => {
      const wid = num((req.params as { wid: string }).wid);
      await assertWorkspaceRole(app.db, wid, req.user!, 'member');
      const body = previewBody.safeParse(req.body);
      if (!body.success) throw unprocessable(body.error.issues[0]!.message);
      const result = await renderTemplate(
        app.db,
        body.data.name,
        body.data.vars as Record<string, string | number | null | undefined>,
        { workspaceId: wid },
      );
      return result;
    },
  );

  // Write-side: workspace admin, enforced per route by assertWorkspaceRole.
  // r185: a plugin-level `requireAdmin` (instance operator) hook used to sit
  // here — it gated EVERY route of this plugin, reads included, and made the
  // documented "workspace admins manage their own templates" impossible.

  // `PUT /:wid/email-templates/:name` — upsert the
  // workspace override. The (workspace, name) pair is
  // unique; re-PUT replaces in place.
  app.put<{ Params: { wid: string; name: string }; Body: { subject?: string; text?: string } }>(
    '/:wid/email-templates/:name',
    async (req) => {
      const wid = num((req.params as { wid: string }).wid);
      const name = (req.params as { name: string }).name as EmailTemplateName;
      if (!ALL_TEMPLATE_NAMES.includes(name)) {
        throw badRequest(`Unknown email template: ${name}`);
      }
      const ws = await loadWorkspaceRow(app.db, wid, req.user!);
      await assertWorkspaceRole(app.db, wid, req.user!, 'admin');
      const body = setBody.safeParse({ ...req.body, name });
      if (!body.success) throw unprocessable(body.error.issues[0]!.message);
      await setOverride(app.db, wid, body.data.name, body.data.subject, body.data.text);
      void audit(
        app.db,
        req.user!.id,
        'email_template.override',
        `${ws.name}/${body.data.name}`,
      );
      return { ok: true, workspaceId: wid, name: body.data.name };
    },
  );

  // `DELETE /:wid/email-templates/:name` — drop the override.
  app.delete<{ Params: { wid: string; name: string } }>(
    '/:wid/email-templates/:name',
    async (req) => {
      const wid = num((req.params as { wid: string }).wid);
      const name = (req.params as { name: string }).name as EmailTemplateName;
      if (!ALL_TEMPLATE_NAMES.includes(name)) {
        throw badRequest(`Unknown email template: ${name}`);
      }
      const ws = await loadWorkspaceRow(app.db, wid, req.user!);
      await assertWorkspaceRole(app.db, wid, req.user!, 'admin');
      await clearOverride(app.db, wid, name);
      void audit(
        app.db,
        req.user!.id,
        'email_template.reset',
        `${ws.name}/${name}`,
      );
      return { ok: true, workspaceId: wid, name };
    },
  );
};

// `notFound` is currently unused at the module level
// (the routes throw via zod/loadWorkspaceForUser) but
// re-exported so a future GET-by-id surface doesn't trip
// the unused-import linter on first import.
export { notFound };
