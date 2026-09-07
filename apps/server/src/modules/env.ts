import { and, eq, like } from 'drizzle-orm';
import { envVars, services } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { upsertEnvVar } from '@ninedeploy/schemas';
import { decrypt, encrypt } from '../lib/crypto.js';
import { assertServiceRole, assertWorkspaceRole, loadProjectForUser, loadServiceForUser } from '../lib/resourceAccess.js';
import { badRequest, notFound, parseId as num } from '../lib/errors.js';

function serialize(e: typeof envVars.$inferSelect) {
  return {
    id: e.id,
    key: e.key,
    value: e.isSecret ? '' : decrypt(e.valueEncrypted),
    isSecret: e.isSecret,
  };
}

/** Environment variable management for a service. Mounted under /services. */
export const envRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/env', async (req) => {
    const id = num((req.params as { id: string }).id);
    await loadServiceForUser(app.db, id, req.user!);
    const rows = await app.db.query.envVars.findMany({ where: eq(envVars.serviceId, id), orderBy: (e, { asc }) => [asc(e.key)] });
    return rows.map(serialize);
  });

  app.post('/:id/env', async (req) => {
    const id = num((req.params as { id: string }).id);
    const input = upsertEnvVar.parse(req.body);
    // Existence check first: otherwise a bad service id surfaces as a
    // misleading "key already exists" (the FK violation is swallowed below).
    // Doubles as the ownership check for members.
    const svc = await loadServiceForUser(app.db, id, req.user!);
    // Environment variables are service configuration — `member`+ to write.
    await assertServiceRole(app.db, svc, req.user!, 'member');
    if (input.overwriteExisting) {
      const existing = await app.db.query.envVars.findFirst({
        where: and(eq(envVars.serviceId, id), eq(envVars.key, input.key)),
      });
      if (existing) {
        const [updated] = await app.db
          .update(envVars)
          // isSecret is optional in the payload (the web omits it on inline
          // edits): defaulting it to false silently DEMOTED stored secrets to
          // plain vars — preserve the stored classification instead.
          .set({ valueEncrypted: encrypt(input.value), isSecret: input.isSecret ?? existing.isSecret })
          .where(and(eq(envVars.id, existing.id), eq(envVars.serviceId, id)))
          .returning();
        if (!updated) throw badRequest('Could not update existing env var');
        return serialize(updated);
      }
    }
    const [created] = await app.db
      .insert(envVars)
      .values({
        serviceId: id,
        scope: 'service',
        scopeKey: id,
        key: input.key,
        valueEncrypted: encrypt(input.value),
        isSecret: input.isSecret ?? false,
      })
      .returning()
      .catch((err: unknown) => {
        if (err instanceof Error && /UNIQUE constraint/.test(err.message)) return [] as typeof envVars.$inferSelect[];
        throw err;
      });
    if (!created) throw badRequest('Env var with that key already exists');
    return serialize(created);
  });

  app.patch('/:id/env/:varId', async (req) => {
    const id = num((req.params as { id: string }).id);
    const varId = num((req.params as { varId: string }).varId);
    const target = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, target, req.user!, 'member');
    const input = upsertEnvVar.parse(req.body);
    const existing = await app.db.query.envVars.findFirst({
      where: and(eq(envVars.id, varId), eq(envVars.serviceId, id)),
    });
    if (!existing) throw notFound('Env var not found');
    const [updated] = await app.db
      .update(envVars)
      // Omitted isSecret preserves the stored classification (see the POST
      // overwrite path) instead of demoting a secret to a plain var.
      .set({ valueEncrypted: encrypt(input.value), isSecret: input.isSecret ?? existing.isSecret })
      .where(and(eq(envVars.id, varId), eq(envVars.serviceId, id)))
      .returning();
    if (!updated) throw notFound('Env var not found');
    return serialize(updated);
  });

  app.delete('/:id/env/:varId', async (req) => {
    const id = num((req.params as { id: string }).id);
    const varId = num((req.params as { varId: string }).varId);
    const target = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, target, req.user!, 'member');
    await app.db.delete(envVars).where(and(eq(envVars.id, varId), eq(envVars.serviceId, id)));
    return { ok: true };
  });
};

/** Shared (project-scope) env vars. Mounted under /projects. */
export const projectEnvRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/env', async (req) => {
    const id = num((req.params as { id: string }).id);
    // Project-scope env is injected into the runtime environment of every
    // service in the project (engine/pipeline.ts), so reading or writing it
    // across tenants is config injection — gate every handler on membership.
    await loadProjectForUser(app.db, id, req.user!);
    const rows = await app.db.query.envVars.findMany({
      where: and(eq(envVars.scope, 'project'), eq(envVars.scopeKey, id)),
      orderBy: (e, { asc }) => [asc(e.key)],
    });
    return rows.map(serialize);
  });

  app.post('/:id/env', async (req) => {
    const id = num((req.params as { id: string }).id);
    const project = await loadProjectForUser(app.db, id, req.user!);
    if (!req.user!.isOperator && project.workspaceId != null) {
      await assertWorkspaceRole(app.db, project.workspaceId, req.user!, 'member');
    }
    const input = upsertEnvVar.parse(req.body);
    const [created] = await app.db
      .insert(envVars)
      .values({
        serviceId: null,
        scope: 'project',
        scopeKey: id,
        key: input.key,
        valueEncrypted: encrypt(input.value),
        isSecret: input.isSecret ?? false,
      })
      .returning()
      .catch((err: unknown) => {
        if (err instanceof Error && /UNIQUE constraint/.test(err.message)) return [] as typeof envVars.$inferSelect[];
        throw err;
      });
    if (!created) throw badRequest('Env var with that key already exists');
    return serialize(created);
  });

  app.patch('/:id/env/:varId', async (req) => {
    const id = num((req.params as { id: string }).id);
    const varId = num((req.params as { varId: string }).varId);
    const project = await loadProjectForUser(app.db, id, req.user!);
    if (!req.user!.isOperator && project.workspaceId != null) {
      await assertWorkspaceRole(app.db, project.workspaceId, req.user!, 'member');
    }
    const input = upsertEnvVar.parse(req.body);
    const existing = await app.db.query.envVars.findFirst({
      where: and(eq(envVars.id, varId), eq(envVars.scope, 'project'), eq(envVars.scopeKey, id)),
    });
    if (!existing) throw notFound('Env var not found');
    const [updated] = await app.db
      .update(envVars)
      // Omitted isSecret preserves the stored classification (same rule as
      // the service-scope routes).
      .set({ valueEncrypted: encrypt(input.value), isSecret: input.isSecret ?? existing.isSecret })
      .where(and(eq(envVars.id, varId), eq(envVars.scope, 'project'), eq(envVars.scopeKey, id)))
      .returning();
    if (!updated) throw notFound('Env var not found');
    return serialize(updated);
  });

  app.delete('/:id/env/:varId', async (req) => {
    const id = num((req.params as { id: string }).id);
    const varId = num((req.params as { varId: string }).varId);
    const project = await loadProjectForUser(app.db, id, req.user!);
    if (!req.user!.isOperator && project.workspaceId != null) {
      await assertWorkspaceRole(app.db, project.workspaceId, req.user!, 'member');
    }
    await app.db
      .delete(envVars)
      .where(and(eq(envVars.id, varId), eq(envVars.scope, 'project'), eq(envVars.scopeKey, id)));
    return { ok: true };
  });
};

/** Cross-scope env key search: where is a given key defined? Mounted under /env. */
export const envSearchRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/search', async (req) => {
    const q = String((req.query as { q?: string }).q ?? '').trim();
    if (q.length < 1) return { results: [] };
    const needle = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const conditions = [like(envVars.key, needle)];
    if (!req.user?.isOperator) {
      conditions.push(eq(services.ownerUserId, req.user!.id));
    }
    const rows = await app.db
      .select({
        id: envVars.id,
        key: envVars.key,
        isSecret: envVars.isSecret,
        serviceId: envVars.serviceId,
        scope: envVars.scope,
        scopeKey: envVars.scopeKey,
        serviceName: services.name,
      })
      .from(envVars)
      .leftJoin(services, eq(services.id, envVars.serviceId))
      .where(and(...conditions))
      .limit(100);
    return {
      results: rows.map((r) => ({
        key: r.key,
        isSecret: r.isSecret,
        scope: r.scope,
        serviceId: r.serviceId,
        serviceName: r.serviceName,
      })),
    };
  });
};
