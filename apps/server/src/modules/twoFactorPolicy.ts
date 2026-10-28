import type { FastifyPluginAsync } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { users, webauthnCredentials, workspaceMembers, workspaces } from '@ninedeploy/db';
import { workspaceTwoFactorInput, type TwoFactorRequirementView, type WorkspaceTwoFactorView } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { forbidden, HttpError, notFound, parseId } from '../lib/errors.js';
import { getWorkspaceTwoFactor, setWorkspaceTwoFactor, twoFactorRequirement } from '../lib/twoFactorPolicy.js';

/**
 * G1.4 workspace-enforced 2FA: the workspace switch (admins and owners) and
 * what the policies ask of the caller's own session (the web app reads it to
 * show the enrolment screen).
 */

async function membersWithout(app: Parameters<FastifyPluginAsync>[0], workspaceId: number): Promise<number> {
  const [row] = await app.db
    .select({ n: sql<number>`count(*)` })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(users.totpEnabled, false),
        sql`not exists (select 1 from ${webauthnCredentials} where ${webauthnCredentials.userId} = ${users.id})`,
      ),
    );
  return Number(row?.n ?? 0);
}

/** Mounted under `/workspaces`. */
export const workspaceTwoFactorRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  const load = async (req: { params: unknown; user?: { id: number; isOperator: boolean } | null }, edit: boolean) => {
    const id = parseId((req.params as { id: string }).id);
    const ws = await app.db.query.workspaces.findFirst({ where: eq(workspaces.id, id) });
    const membership = ws
      ? await app.db.query.workspaceMembers.findFirst({ where: and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, req.user!.id)) })
      : undefined;
    // Non-members get the same 404 a missing row gets.
    if (!ws || (!membership && !req.user!.isOperator)) throw notFound('Workspace not found');
    if (edit && !req.user!.isOperator && membership?.role !== 'owner' && membership?.role !== 'admin') {
      throw forbidden('Admin or Owner role required to change the two-factor requirement');
    }
    return ws;
  };

  app.get('/:id/two-factor', async (req): Promise<WorkspaceTwoFactorView> => {
    const ws = await load(req, false);
    return { ...(await getWorkspaceTwoFactor(app.db, ws.id)), membersWithout: await membersWithout(app, ws.id) };
  });

  app.put('/:id/two-factor', async (req): Promise<WorkspaceTwoFactorView> => {
    const ws = await load(req, true);
    const input = workspaceTwoFactorInput.parse(req.body ?? {});
    if (input.required) {
      // Whoever turns it on has it already, so the switch never locks its own author out mid-change.
      const me = await hasSecondFactor(app, req.user!.id);
      if (!me) throw new HttpError(409, 'enrol_first', 'Set up an authenticator app or a passkey for your own account first');
    }
    await setWorkspaceTwoFactor(app.db, ws.id, { required: input.required, ssoExempt: input.ssoExempt });
    void audit(app.db, req.user!.id, 'workspace.two_factor.set', `${ws.name}: ${input.required ? `required${input.ssoExempt ? ' (SSO exempt)' : ''}` : 'off'}`, {
      workspaceId: ws.id,
      required: input.required,
      ssoExempt: input.ssoExempt,
    });
    return { ...(await getWorkspaceTwoFactor(app.db, ws.id)), membersWithout: await membersWithout(app, ws.id) };
  });
};

async function hasSecondFactor(app: Parameters<FastifyPluginAsync>[0], userId: number): Promise<boolean> {
  const user = await app.db.query.users.findFirst({ where: eq(users.id, userId), columns: { totpEnabled: true } });
  if (user?.totpEnabled) return true;
  return !!(await app.db.query.webauthnCredentials.findFirst({ where: eq(webauthnCredentials.userId, userId), columns: { id: true } }));
}

/** Mounted under `/auth/2fa`: always answers, enrolled or not. */
export const twoFactorRequirementRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  app.get('/requirement', async (req): Promise<TwoFactorRequirementView> => {
    if (req.user!.viaApiToken) return { required: false, enrolled: await hasSecondFactor(app, req.user!.id), workspaces: [] };
    return twoFactorRequirement(app.db, req.user!.id, { sso: req.user!.ssoSession === true });
  });
};
