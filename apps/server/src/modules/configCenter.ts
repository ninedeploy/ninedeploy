import { configEntries } from '@ninedeploy/db';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';

/** Placeholder returned for unrevealed secrets — can never be a real value. */
const SECRET_MASK = '••••••••';

const setConfigBody = z.object({
  value: z.unknown().optional(),
  isSecret: z.boolean().optional(),
  description: z.string().max(500).optional(),
  tags: z.array(z.string().max(50)).optional(),
});

export const configCenterRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  // List all configuration entries & definitions
  // L-12: instance configuration is an operator concern. Secret values were
  // already admin-only inside the handler; the non-secret ones still describe
  // how the whole instance is wired.
  app.get('/', { preHandler: [app.requireOperator] }, async (req) => {
    const isOperator = req.user!.isOperator;
    const query = req.query as { category?: string; pluginId?: string; reveal?: string };
    const definitions = req.kernel.configCenter.listDefinitions(query.category, query.pluginId);

    // Fetch all stored DB rows
    const rows = await app.db.query.configEntries.findMany();
    const rowsMap = new Map(rows.map((r) => [r.key, r]));

    const entries = [];
    const handledKeys = new Set<string>();

    // 1. Process known definitions
    for (const def of definitions) {
      handledKeys.add(def.key);
      const row = rowsMap.get(def.key);
      const isSecret = def.isSecret || (row?.isSecret ?? false);

      let effectiveValue: unknown;
      if (row) {
        if (isSecret) {
          if (isOperator && query.reveal === 'true') {
            effectiveValue = await req.kernel.configCenter.getSecret(def.key);
          } else {
            effectiveValue = '••••••••';
          }
        } else {
          effectiveValue = await req.kernel.configCenter.get(def.key);
        }
      } else {
        effectiveValue = def.defaultValue;
      }

      entries.push({
        key: def.key,
        pluginId: def.pluginId ?? row?.pluginId ?? null,
        type: def.type,
        isSecret,
        label: def.label,
        category: def.category,
        description: def.description ?? row?.description ?? undefined,
        tags: def.tags ?? (row?.tags as string[] | undefined) ?? [],
        options: def.options,
        value: effectiveValue,
        isConfigured: !!row,
        updatedAt: row?.updatedAt?.toISOString(),
      });
    }

    // 2. Process arbitrary stored config rows that might not have a static definition
    for (const row of rows) {
      if (handledKeys.has(row.key)) continue;
      if (query.category && row.category !== query.category) continue;
      if (query.pluginId && row.pluginId !== query.pluginId) continue;

      let effectiveValue: unknown;
      if (row.isSecret) {
        if (isOperator && query.reveal === 'true') {
          effectiveValue = await req.kernel.configCenter.getSecret(row.key);
        } else {
          effectiveValue = '••••••••';
        }
      } else {
        effectiveValue = await req.kernel.configCenter.get(row.key);
      }

      entries.push({
        key: row.key,
        pluginId: row.pluginId,
        type: 'string',
        isSecret: row.isSecret,
        label: row.key,
        category: row.category,
        description: row.description ?? undefined,
        tags: row.tags as string[],
        value: effectiveValue,
        isConfigured: true,
        updatedAt: row.updatedAt?.toISOString(),
      });
    }

    return { entries };
  });

  // Get specific key — same operator-only rule as the listing above: the
  // config center is instance configuration, not member-visible data.
  app.get<{ Params: { key: string }; Querystring: { reveal?: string } }>(
    '/:key',
    { preHandler: app.requireOperator },
    async (req, reply) => {
    const { key } = req.params;
    const def = req.kernel.configCenter.getDefinition(key);
    const row = await app.db.query.configEntries.findFirst({
      where: eq(configEntries.key, key),
    });

    if (!def && !row) {
      return reply.status(404).send({
        error: { code: 'not_found', message: `Config key "${key}" not found` },
      });
    }

    const isSecret = def?.isSecret || (row?.isSecret ?? false);
    let value: unknown;

    if (isSecret) {
      if (req.user!.isOperator && req.query.reveal === 'true') {
        value = await req.kernel.configCenter.getSecret(key);
      } else {
        value = '••••••••';
      }
    } else {
      value = await req.kernel.configCenter.get(key, def?.defaultValue);
    }

    let category = 'general';
    if (def?.category) {
      category = def.category;
    } else if (row?.category) {
      category = row.category;
    }

    let tags: string[] = [];
    if (def?.tags) {
      tags = def.tags;
    } else if (Array.isArray(row?.tags)) {
      tags = row.tags;
    }

    return {
      key,
      pluginId: def?.pluginId ?? row?.pluginId ?? null,
      type: def?.type ?? 'string',
      isSecret,
      label: def?.label ?? key,
      category,
      description: def?.description ?? row?.description ?? undefined,
      tags,
      value,
      isConfigured: !!row,
      updatedAt: row?.updatedAt?.toISOString(),
    };
  });

  // Set config key (operator only)
  app.post<{ Params: { key: string } }>('/:key', { preHandler: app.requireOperator }, async (req) => {
    const { key } = req.params;
    const body = setConfigBody.parse(req.body);
    const def = req.kernel.configCenter.getDefinition(key);
    const row = await app.db.query.configEntries.findFirst({ where: eq(configEntries.key, key) });
    const isSecret = body.isSecret ?? def?.isSecret ?? row?.isSecret ?? false;

    // The mask is what the UI displays for an unrevealed secret; saving it
    // back would silently destroy the stored credential.
    if (isSecret && body.value === SECRET_MASK) {
      throw badRequest(
        'Refusing to save the masked placeholder as a secret value — reveal the secret or enter a new value',
        'masked_secret_rejected',
      );
    }

    // Omitted value on an existing entry = keep the current value (metadata-only update).
    let value = body.value;
    if (value === undefined && row) {
      value = row.isSecret ? await req.kernel.configCenter.getSecret(key) : await req.kernel.configCenter.get(key);
    }

    // r155: pass the RESOLVED secrecy and the row's metadata. `set()` only
    // falls back to a static definition, so an ad-hoc secret re-saved without
    // `isSecret` was written back decrypted with is_secret=0 (and its
    // category/plugin/description/tags reset to defaults).
    await req.kernel.configCenter.set(key, value, {
      isSecret,
      category: row?.category ?? undefined,
      pluginId: row?.pluginId ?? undefined,
      description: body.description ?? row?.description ?? undefined,
      tags: body.tags ?? (row?.tags as string[] | null | undefined) ?? undefined,
      userId: req.user!.id,
    });

    await audit(app.db, req.user!.id, 'config.set', 'system', {
      key,
      isSecret,
      tags: body.tags,
    });

    return { ok: true, key };
  });

  // Delete config key (operator only)
  app.delete<{ Params: { key: string } }>('/:key', { preHandler: app.requireOperator }, async (req) => {
    const { key } = req.params;
    await req.kernel.configCenter.delete(key);

    await audit(app.db, req.user!.id, 'config.delete', 'system', { key });
    return { ok: true, key };
  });
};
