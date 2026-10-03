import { eq } from 'drizzle-orm';
import { configEntries } from '@ninedeploy/db';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { eventBus } from '../lib/events.js';
import { badRequest, notFound } from '../lib/errors.js';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Config Presets HTTP surface — Sprint 3, Gap G-23 (PR-A).
 *
 * Five endpoints, all mounted under `/v1/config-presets` and protected
 * by the standard `app.authenticate` hook. The apply path uses
 * `configCenter.set` so a single call writes every value in the named
 * bundle atomically (per key — the configCenter does not give us a
 * multi-key transaction, but it does ensure each write is either
 * persisted or rolled back via the existing error path).
 *
 * Data shape: three config-center entries per preset.
 *   - `preset.list` → `string[]` (preset ids, the "directory")
 *   - `preset.<id>.values` → `Record<string, unknown>` (the bundle)
 *   - `preset.<id>.description` → `string` (operator note, optional)
 *
 * The apply endpoint writes each `value` to its key verbatim, so the
 * "preset" is really a thin, named snapshot of `configCenter.set`
 * calls — no transformations, no secret handling (operators should
 * pre-encrypt via the existing `isSecret` flag if needed). That keeps
 * the apply path a single ~10-line function and matches what the
 * panel already lets an operator do by hand.
 */
const registerSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/i, 'id must be alphanumeric with optional - or _'),
  description: z.string().max(500).optional(),
  values: z.record(z.string().min(1).max(256), z.unknown()),
});

const applyBodySchema = z.object({
  /** Optional override for the value map (operator-side dry run). */
  override: z.record(z.string().min(1).max(256), z.unknown()).optional(),
});

interface PresetDetail {
  id: string;
  description: string | null;
  values: Record<string, unknown>;
  createdAt: string;
}

const NAMESPACE_DEFAULT = 'plugin:config-presets';

export const configPresetsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  // Presets read and write instance-wide Config Center keys.  Applying one
  // can change arbitrary configuration, so there is no member-safe route in
  // this module (including reads, which may expose configured values).
  app.addHook('preHandler', app.requireOperator);

  // Resolve the configured namespace; default keeps existing keys stable.
  const namespace = async (): Promise<string> => {
    const ns = await app.kernel.configCenter.get<string>(`${NAMESPACE_DEFAULT}:preset.namespace`, NAMESPACE_DEFAULT);
    return ns || NAMESPACE_DEFAULT;
  };

  const listKey = async () => `${await namespace()}:preset.list`;
  const valuesKey = async (id: string) => `${await namespace()}:preset.${id}.values`;
  const descriptionKey = async (id: string) => `${await namespace()}:preset.${id}.description`;

  // ── GET /v1/config-presets — list registered preset ids ──────────────
  app.get('/', async () => {
    const raw = await app.kernel.configCenter.get<string[]>(await listKey(), []);
    return { presets: raw };
  });

  // ── GET /v1/config-presets/:id — fetch one preset's values ─────────
  app.get('/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const list = (await app.kernel.configCenter.get<string[]>(await listKey(), [])) ?? [];
    if (!list.includes(id)) throw notFound('Preset not found');
    const values = (await app.kernel.configCenter.get<Record<string, unknown>>(await valuesKey(id), {})) ?? {};
    const description = await app.kernel.configCenter.get<string | null>(await descriptionKey(id), null);
    const detail: PresetDetail = {
      id,
      description,
      values,
      // The list key is a `json` config-center entry — its `createdAt` is
      // the order in the array (push order), not a real timestamp. We
      // expose a synthetic timestamp so the CLI can show "last applied"
      // consistently with the other config-center entries.
      createdAt: new Date(0).toISOString(),
    };
    return detail;
  });

  // ── POST /v1/config-presets — register a new preset ────────────────
  app.post('/', async (req) => {
    const input = registerSchema.parse(req.body);
    const list = (await app.kernel.configCenter.get<string[]>(await listKey(), [])) ?? [];
    if (list.includes(input.id)) {
      throw badRequest(`Preset "${input.id}" already exists; use PUT /:id to overwrite`);
    }
    const next = [...list, input.id];
    await app.kernel.configCenter.set(await listKey(), next, {
      userId: req.user!.id,
      pluginId: 'config-presets',
      description: `Add preset "${input.id}" to the registry`,
    });
    await app.kernel.configCenter.set(await valuesKey(input.id), input.values, {
      userId: req.user!.id,
      pluginId: 'config-presets',
      description: `Values for preset "${input.id}"`,
    });
    if (input.description) {
      await app.kernel.configCenter.set(await descriptionKey(input.id), input.description, {
        userId: req.user!.id,
        pluginId: 'config-presets',
        description: `Description for preset "${input.id}"`,
      });
    }
    void audit(app.db, req.user!.id, 'config.preset.registered', input.id, {
      keyCount: Object.keys(input.values).length,
    });
    eventBus.emitCustom('config.preset.registered', {
      id: input.id,
      keyCount: Object.keys(input.values).length,
      ts: new Date().toISOString(),
    });
    return { ok: true, id: input.id, keyCount: Object.keys(input.values).length };
  });

  // ── PUT /v1/config-presets/:id/apply — write every value to configCenter ──
  app.put('/:id/apply', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = applyBodySchema.parse(req.body ?? {});
    const list = (await app.kernel.configCenter.get<string[]>(await listKey(), [])) ?? [];
    if (!list.includes(id)) throw notFound('Preset not found');

    const enabled = await app.kernel.configCenter.get<boolean>('plugin:config-presets:enabled', true);
    if (!enabled) {
      eventBus.emitCustom('config.preset.disabled', { id, ts: new Date().toISOString() });
      throw badRequest('Config Presets plugin is disabled (plugin:config-presets:enabled = false)');
    }

    const stored = (await app.kernel.configCenter.get<Record<string, unknown>>(await valuesKey(id), {})) ?? {};
    // The `override` body wins over the stored value; both win over the
    // existing configCenter value (i.e. the preset is the new ground truth).
    const values = { ...stored, ...(body.override ?? {}) };

    const written: Array<{ key: string; status: 'ok' | 'failed'; reason?: string }> = [];
    for (const [key, value] of Object.entries(values)) {
      try {
        // r284: resolve secrecy the way the Config Center POST route does
        // (r155). `set()` only falls back to a static definition, so a preset
        // touching an AD-HOC secret key rewrote it in plaintext with
        // is_secret=0 (and reset its category/tags to defaults).
        const def = app.kernel.configCenter.getDefinition(key);
        const row = await app.db.query.configEntries.findFirst({ where: eq(configEntries.key, key) });
        await app.kernel.configCenter.set(key, value, {
          isSecret: def?.isSecret ?? row?.isSecret ?? false,
          category: row?.category ?? undefined,
          tags: (row?.tags as string[] | null | undefined) ?? undefined,
          userId: req.user!.id,
          pluginId: 'config-presets',
          description: `Applied by preset "${id}"`,
        });
        written.push({ key, status: 'ok' });
      } catch (err) {
        written.push({
          key,
          status: 'failed',
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const failures = written.filter((w) => w.status === 'failed');
    void audit(app.db, req.user!.id, 'config.preset.applied', id, {
      keyCount: written.length,
      failureCount: failures.length,
    });
    eventBus.emitCustom(failures.length > 0 ? 'config.preset.failed' : 'config.preset.applied', {
      id,
      keyCount: written.length,
      failureCount: failures.length,
      ts: new Date().toISOString(),
    });
    if (failures.length > 0) {
      return reply.status(409).send({
        ok: false,
        id,
        keyCount: written.length,
        failureCount: failures.length,
        failures,
      });
    }
    return { ok: true, id, keyCount: written.length };
  });

  // ── DELETE /v1/config-presets/:id — unregister ─────────────────────
  app.delete('/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const list = (await app.kernel.configCenter.get<string[]>(await listKey(), [])) ?? [];
    if (!list.includes(id)) throw notFound('Preset not found');
    const next = list.filter((x) => x !== id);
    await app.kernel.configCenter.set(await listKey(), next, {
      userId: req.user!.id,
      pluginId: 'config-presets',
      description: `Remove preset "${id}" from the registry`,
    });
    await app.kernel.configCenter.delete(await valuesKey(id));
    await app.kernel.configCenter.delete(await descriptionKey(id));
    void audit(app.db, req.user!.id, 'config.preset.removed', id);
    return { ok: true, id };
  });
};

// Tiny helper removed — the apply endpoint now uses `reply.status(409).send(...)`
// directly because the `replyWith` shortcut did not actually surface the
// status code through Fastify and silently fell back to 500.
