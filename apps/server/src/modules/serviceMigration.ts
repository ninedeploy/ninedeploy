import { and, eq } from 'drizzle-orm';
import {
  buildConfigs, databaseAttachments, databases, type dbEngine, domains, envVars, services, webhooks,
} from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { envVarName } from '@ninedeploy/schemas';
import { decrypt, encrypt } from '../lib/crypto.js';
import { badRequest, notFound, parseId as num } from '../lib/errors.js';
import { slugifyWithSuffix } from '../lib/slug.js';
import { materialiseComposeFile } from '../lib/composeWorkspace.js';

interface ServiceBundle {
  version: string;
  exportedAt: string;
  service: {
    name: string;
    type: string;
    repoUrl: string | null;
    branch: string;
    image: string | null;
    port: number | null;
    volumeMount: string | null;
    /** Routed service of a compose stack, and — for an inline stack — its
     * whole YAML, so the bundle can rebuild the workspace on the new host. */
    composeService?: string | null;
    composeContent?: string | null;
    healthPath: string;
    cpuShares: number;
    memLimitMb: number;
  };
  buildConfig: {
    buildPack: string;
    baseDir: string;
    installCmd: string | null;
    buildCmd: string | null;
    startCmd: string | null;
    dockerfilePath: string | null;
  } | null;
  envVars: Array<{ key: string; value: string; isSecret: boolean }>;
  domains: Array<{ hostname: string; path: string; ssl: boolean }>;
  webhooks: Array<{ branch: string; events: string[]; secret: string }>;
  attachments: Array<{ envAlias: string; databaseName: string; databaseEngine: string }>;
}

/**
 * Per-service export/import. Mounted under /services. Admin-only: the exported
 * bundle contains every secret (env vars, webhook secrets) in PLAINTEXT.
 */
export const serviceMigrationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireAdmin);

  // ── Export: download a service as a JSON bundle ──────────────────────
  app.get('/:id/export', async (req, reply) => {
    const id = num((req.params as { id: string }).id);
    const svc = await app.db.query.services.findFirst({ where: eq(services.id, id) });
    if (!svc) throw notFound('Service not found');

    const [bc, envs, doms, hooks, atts] = await Promise.all([
      app.db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, id) }),
      app.db.query.envVars.findMany({ where: eq(envVars.serviceId, id) }),
      app.db.query.domains.findMany({ where: eq(domains.serviceId, id) }),
      app.db.query.webhooks.findMany({ where: eq(webhooks.serviceId, id) }),
      app.db.query.databaseAttachments.findMany({ where: eq(databaseAttachments.serviceId, id) }),
    ]);

    // Resolve attachment database names
    const attachmentInfos = [];
    for (const a of atts) {
      const attachedDb = await app.db.query.databases.findFirst({ where: eq(databases.id, a.databaseId) });
      if (attachedDb) attachmentInfos.push({ envAlias: a.envAlias, databaseName: attachedDb.name, databaseEngine: attachedDb.engine });
    }

    const bundle: ServiceBundle = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      service: {
        name: svc.name,
        type: svc.type,
        repoUrl: svc.repoUrl,
        branch: svc.branch,
        image: svc.image,
        port: svc.port,
        volumeMount: svc.volumeMount,
        composeService: svc.composeService,
        composeContent: svc.composeContent,
        healthPath: svc.healthPath,
        cpuShares: svc.cpuShares,
        memLimitMb: svc.memLimitMb,
      },
      buildConfig: bc ? {
        buildPack: bc.buildPack,
        baseDir: bc.baseDir,
        installCmd: bc.installCmd,
        buildCmd: bc.buildCmd,
        startCmd: bc.startCmd,
        dockerfilePath: bc.dockerfilePath,
      } : null,
      envVars: envs.map((e) => ({ key: e.key, value: decrypt(e.valueEncrypted), isSecret: e.isSecret })),
      domains: doms.map((d) => ({ hostname: d.hostname, path: d.path, ssl: d.ssl })),
      webhooks: hooks.map((w) => ({ branch: w.branch, events: w.events, secret: decrypt(w.secretEncrypted) })),
      attachments: attachmentInfos,
    };

    reply.type('application/json').header('content-disposition', `attachment; filename="${svc.slug}-export.json"`);
    return bundle;
  });

  // ── Import: recreate a service from a JSON bundle ────────────────────
  app.post('/import', async (req) => {
    const raw = req.body as ServiceBundle;
    if (!raw?.service?.name) throw badRequest('Invalid bundle: missing service data');
    // Validate/normalize the shape: unknown enum values rejected, missing
    // optional arrays defaulted (a malformed bundle must 400, not crash a
    // handler with a TypeError on .map of undefined).
    if (raw.service.type !== 'docker' && raw.service.type !== 'pm2' && raw.service.type !== 'compose') {
      throw badRequest('Invalid bundle: service.type must be "docker", "pm2", or "compose"');
    }
    const bundle: ServiceBundle = {
      ...raw,
      envVars: Array.isArray(raw.envVars) ? raw.envVars : [],
      domains: Array.isArray(raw.domains) ? raw.domains : [],
      webhooks: Array.isArray(raw.webhooks) ? raw.webhooks : [],
      attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
      buildConfig: raw.buildConfig ?? null,
    };

    // Unique slug to avoid conflicts
    const slug = slugifyWithSuffix(bundle.service.name, Date.now().toString(36).slice(-4));

    const [svc] = await app.db.insert(services).values({
      name: bundle.service.name,
      slug,
      // Narrowed by the runtime validation above.
      type: bundle.service.type as 'docker' | 'pm2' | 'compose',
      repoUrl: bundle.service.repoUrl,
      branch: bundle.service.branch,
      image: bundle.service.image,
      port: bundle.service.port,
      volumeMount: bundle.service.volumeMount,
      composeService: bundle.service.composeService ?? null,
      composeContent: bundle.service.composeContent ?? null,
      healthPath: bundle.service.healthPath || '/',
      cpuShares: bundle.service.cpuShares || 0,
      memLimitMb: bundle.service.memLimitMb || 0,
      status: 'idle',
    }).returning();
    if (!svc) throw badRequest('Could not create service');
    // An inline stack has no repository to clone, so its workspace has to be
    // rebuilt from the bundle before the first deploy on this host.
    if (svc.composeContent) materialiseComposeFile(svc.id, svc.composeContent);

    // Build config
    if (bundle.buildConfig) {
      const bc = bundle.buildConfig;
      await app.db.insert(buildConfigs).values({
        serviceId: svc.id,
        buildPack: bc.buildPack as 'auto' | 'nixpacks' | 'dockerfile',
        baseDir: bc.baseDir || '/',
        installCmd: bc.installCmd,
        buildCmd: bc.buildCmd,
        startCmd: bc.startCmd,
        dockerfilePath: bc.dockerfilePath,
      });
    }

    // Env vars (re-encrypt with this instance's master key). Keys are
    // validated with the same charset the normal env API enforces — a key
    // containing `=` or a newline would inject into the deploy env-file.
    for (const e of bundle.envVars) {
      if (typeof e.key !== 'string' || !envVarName.safeParse(e.key).success) {
        throw badRequest(`Invalid bundle: bad env var key ${JSON.stringify(e.key)}`);
      }
      if (typeof e.value !== 'string') {
        throw badRequest(`Invalid bundle: env var ${e.key} has no value`);
      }
      await app.db.insert(envVars).values({
        serviceId: svc.id,
        scope: 'service',
        scopeKey: svc.id,
        key: e.key,
        valueEncrypted: encrypt(e.value),
        isSecret: e.isSecret,
      });
    }

    // Domains (only custom ones, skip wildcard auto-domains)
    const domainRows = bundle.domains
      .filter((d) => d.hostname.includes('.'))
      .map((d) => ({
        serviceId: svc.id,
        hostname: d.hostname,
        path: d.path,
        ssl: d.ssl,
        status: 'active' as const,
      }));
    if (domainRows.length > 0) {
      await app.db.insert(domains).values(domainRows);
    }

    // Webhooks (re-encrypt secrets)
    const webhookRows = bundle.webhooks.map((w) => ({
      serviceId: svc.id,
      branch: w.branch,
      events: w.events,
      secretEncrypted: encrypt(w.secret),
      active: true,
    }));
    if (webhookRows.length > 0) {
      await app.db.insert(webhooks).values(webhookRows);
    }

    // Attachments (best-effort: match the database by name AND engine — a
    // same-named database of a different engine must not be attached, or the
    // service would receive wrong-protocol credentials).
    for (const a of bundle.attachments) {
      const match = await app.db.query.databases.findFirst({
        where: and(
          eq(databases.name, a.databaseName),
          eq(databases.engine, a.databaseEngine as (typeof dbEngine)[number]),
        ),
      });
      if (match) {
        await app.db.insert(databaseAttachments).values({
          serviceId: svc.id,
          databaseId: match.id,
          envAlias: a.envAlias,
        });
      }
    }

    return { ok: true, serviceId: svc.id, slug, message: `Service "${bundle.service.name}" imported. Deploy to activate.` };
  });
};
