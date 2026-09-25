import type { FastifyInstance } from 'fastify';
import yaml from 'js-yaml';
import { buildConfigs, services, type Service } from '@ninedeploy/db';
import { eq } from 'drizzle-orm';
import type { ComposePreviewResponse } from '@ninedeploy/schemas';
import { badRequest } from '../lib/errors.js';
import { randomToken } from '../lib/crypto.js';
import { slugify, slugifyWithSuffix } from '../lib/slug.js';
import { assertSlugVolumeNotRetained } from '../lib/retainedSlugVolume.js';
import { config } from '../config.js';
import { materialiseComposeFile } from '../lib/composeWorkspace.js';
import { getAcmeEmail } from '../engine/proxy.js';
import {
  preflightCompose,
  resolveStackEnvironment,
  scanMagicTokens,
  scanRequiredPlaceholders,
  type ResolvedStackEnv,
} from '../engine/magicVars.js';
import type { EnvSeed } from './templates.js';
import { extractConfigurableEnv, pickMainService } from '../templates/mirror.js';
import type { Template } from '../templates/registry.js';

/**
 * One-click compose-stack installs (`template.composeContent`). A stack is
 * stored exactly like any other service — same worker, same deploy history,
 * same Traefik finalize — except `type` is `'compose'`, the resolved magic
 * variables become ordinary persistent env rows, and the compose file is
 * materialised into the per-service workspace so the existing compose builder
 * can run it unchanged on every (re)deploy.
 */

/**
 * The public URL a stack's `SERVICE_URL_*` / `SERVICE_FQDN_*` tokens resolve
 * to. Decided BEFORE first boot so the values baked into containers match
 * whatever Traefik finalize auto-assigns afterwards; without a wildcard
 * domain there is no public URL yet and apps get a localhost default they can
 * reconfigure later.
 */
export async function stackPublicUrl(db: FastifyInstance['db'], slug: string): Promise<string> {
  const scheme = (await getAcmeEmail(db)) ? 'https' : 'http';
  return config.wildcardDomain ? `${scheme}://${slug}.${config.wildcardDomain}` : 'http://localhost';
}

/**
 * Read-only analysis of a compose file the user pasted. Used by the wizard's
 * live preview AND by the create route itself, so what the user was shown is
 * exactly what the server enforces a moment later.
 *
 * Every part of this is existing machinery: `preflightCompose` decides whether
 * the stack can run here at all, `pickMainService` names the routed service,
 * and the token scanners say which values the platform generates versus which
 * ones the user still has to supply.
 */
export function analyseComposeContent(content: string, port?: number): ComposePreviewResponse {
  const pre = preflightCompose(content);
  interface ComposeDoc { services?: Record<string, unknown> }
  let parsed: ComposeDoc | null = null;
  try {
    parsed = (yaml.load(content) ?? null) as ComposeDoc | null;
  } catch (err) {
    return {
      ok: false,
      reasons: [...pre.reasons, `unparsable YAML: ${err instanceof Error ? err.message.split('\n')[0]! : 'error'}`],
      warnings: pre.warnings,
      services: [],
      suggestedService: null,
      magicTokens: [],
      openPlaceholders: [],
      configurableEnv: [],
    };
  }

  const serviceMap = (parsed?.services ?? {}) as Parameters<typeof pickMainService>[0];
  const names = Object.keys(serviceMap);
  const reasons = [...pre.reasons];
  // `docker compose up` on a file with no services is a no-op that reports
  // success — the deploy would go green with nothing running.
  if (names.length === 0) reasons.push('no services declared');

  const main = names.length > 0 ? pickMainService(serviceMap, content, port ?? 0) : null;
  return {
    ok: reasons.length === 0,
    reasons,
    warnings: pre.warnings,
    services: names,
    suggestedService: main?.name ?? null,
    magicTokens: scanMagicTokens(content),
    openPlaceholders: scanRequiredPlaceholders(content),
    configurableEnv: (extractConfigurableEnv(content) ?? []).map((e) => ({ key: e.key, value: e.value })),
  };
}

/**
 * Turn a resolved stack environment into env rows.
 *
 * `generate: false` is the important part: these values are already final
 * (`resolveStackEnvironment` produced them), so `reconcileEnvironment` must
 * store them verbatim instead of minting fresh entropy over the top — that
 * would leave `SERVICE_URL_*` pointing at a random string. Routing facts stay
 * non-secret so they are readable in the Environment tab; everything else the
 * resolver generated is entropy and is stored encrypted.
 */
export function stackEnvSeeds(resolved: ResolvedStackEnv): EnvSeed[] {
  return Object.entries(resolved.values).map(([key, value]) => {
    const spec = resolved.parsed[key];
    return {
      key,
      value,
      secret: spec ? spec.kind !== 'url' && spec.kind !== 'fqdn' : false,
      generate: false,
    };
  });
}

export interface PreparedStack {
  service: Service;
  /** Env entries to reconcile through the shared template env machinery. */
  stackEnv: EnvSeed[];
  warnings: string[];
}

/**
 * Create/update the service row for a compose template and materialise its
 * files into the per-service workspace. Returns the generated environment for
 * the caller to persist idempotently via `reconcileEnvironment`.
 */
export async function prepareComposeStack(
  app: FastifyInstance,
  template: Template,
  input: { name?: string; reuseExisting?: boolean },
  user: { id: number; isOperator: boolean },
): Promise<PreparedStack> {
  const pre = preflightCompose(template.composeContent!);
  if (!pre.ok) throw badRequest(`Template compose definition cannot run here: ${pre.reasons.join('; ')}`);

  const name = input.name ?? template.name;
  const requestedSlug = input.name ? slugify(name) : slugifyWithSuffix(template.name, Date.now().toString(36).slice(-4));

  let slug = requestedSlug;
  let service = await app.db.query.services.findFirst({ where: eq(services.slug, slug) });
  if (service && service.ownerUserId !== user.id && !user.isOperator) {
    // Same tenant-isolation rule as single-container templates: collide with
    // an invisible owner's slug by allocating a fresh one, never by leaking.
    let attempt = 0;
    do {
      slug = slugifyWithSuffix(requestedSlug, randomToken(3).slice(0, 4));
      service = await app.db.query.services.findFirst({ where: eq(services.slug, slug) });
    } while (service && ++attempt < 5);
    if (service) throw badRequest('Could not allocate a free service slug — try a different name');
  }

  if (service) {
    const sameStack =
      service.ownerUserId === user.id
      && service.type === 'compose'
      && service.templateId === template.id
      && ['idle', 'error', 'stopped', 'running'].includes(service.status);
    if (!(input.reuseExisting ?? true) || !sameStack) {
      throw badRequest(`A service with slug '${slug}' already exists`, 'slug_taken');
    }
    // The registry is authoritative for the stack definition: a reused row
    // takes the template's CURRENT YAML, so a fixed template repairs an
    // existing install on retry instead of redeploying the broken original.
    const patch = { name, composeContent: template.composeContent! };
    await app.db.update(services).set(patch).where(eq(services.id, service.id));
    service = { ...service, ...patch };
  } else {
    // r351: same retained-volume gate as POST /services — a stack's `type`
    // can later be PATCHed to docker, which mounts `nd-svc-<slug>-data`.
    await assertSlugVolumeNotRetained(slug, 'compose');
    const [created] = await app.db.insert(services).values({
      ownerUserId: user.id,
      name,
      slug,
      type: 'compose',
      // Informational: Hub display + PREPARE skips git checkout because this
      // field is set (image deploys have no repository).
      image: template.image,
      port: template.port,
      publishedPort: null,
      healthPath: '/',
      repoUrl: null,
      cpuShares: 0,
      memLimitMb: 0,
      dockerSocket: false,
      templateId: template.id,
      // Routing target inside the compose project network.
      composeService: template.composeService,
      // Durable copy of the stack definition — see the column comment in
      // packages/db/src/schema.ts. Every deploy re-materialises the file from
      // here, so the workspace copy is a cache, not the record.
      composeContent: template.composeContent!,
    }).returning();
    if (!created) throw badRequest('Could not create template service');
    service = created;
    await app.db.insert(buildConfigs).values({ serviceId: service.id, buildPack: 'auto', baseDir: '/' });
  }

  const publicUrl = await stackPublicUrl(app.db, service.slug);

  const resolved = resolveStackEnvironment(template.composeContent!, { publicUrl });

  materialiseComposeFile(service.id, template.composeContent!);

  const stackEnv = [
    ...stackEnvSeeds(resolved),
    ...(template.env ?? []).map((entry) => ({ key: entry.key, value: entry.value, secret: entry.secret ?? false })),
  ];
  return { service, stackEnv, warnings: pre.warnings };
}
