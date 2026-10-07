import { and, eq } from 'drizzle-orm';
import {
  buildConfigs, databaseAttachments, databases, type DB, type dbEngine, domains, envVars, services, webhooks,
} from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { createDomain, envVarName, gitBranch, gitRepoUrl, webhookCreate } from '@ninedeploy/schemas';
import { decrypt, encrypt } from '../lib/crypto.js';
import { badRequest, conflict, isUniqueViolation, notFound, parseId as num } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { slugifyWithSuffix } from '../lib/slug.js';
import { assertSlugVolumeNotRetained } from '../lib/retainedSlugVolume.js';
import { materialiseComposeFile } from '../lib/composeWorkspace.js';
import { assertMayUseHostPrivilege } from '../lib/hostPrivilege.js';
import { assertMayWriteVaultRefs } from '../lib/vault.js';
import { getSettingString } from '../lib/settings.js';
import { hostsCollide, normalizeHost, ownZoneClaimRefusal } from '../lib/domainVerification.js';

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
    cpuLimitMilli: number;
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
  webhooks: Array<{ branch: string; events: string[]; secret: string; watchPaths?: string | null }>;
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
        cpuLimitMilli: svc.cpuLimitMilli,
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
      // F193: the path filter decides which pushes deploy — dropping it made
      // every push redeploy the service after the move.
      webhooks: hooks.map((w) => ({ branch: w.branch, events: w.events, secret: decrypt(w.secretEncrypted), watchPaths: w.watchPaths ?? null })),
      attachments: attachmentInfos,
    };

    // r283: the bundle is every env var and webhook secret of the service in
    // plaintext — the most sensitive read on the instance leaves a trail.
    // Counts only; never the values.
    void audit(app.db, req.user!.id, 'service.export', svc.name, {
      serviceId: svc.id,
      envVars: bundle.envVars.length,
      webhooks: bundle.webhooks.length,
    });
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
    // A bundle rebuilds the service row from foreign JSON — the same
    // host-privilege gate POST /services applies has to apply here, or an
    // imported pm2/compose/static-pack bundle would create a member-owned
    // service the deploy gate then has to refuse one step later.
    assertMayUseHostPrivilege(req.user!, {
      type: raw.service.type,
      build: raw.buildConfig ?? null,
    });
    if (raw.buildConfig && !['auto', 'nixpacks', 'dockerfile', 'railpack', 'static'].includes(raw.buildConfig.buildPack)) {
      throw badRequest('Invalid bundle: buildConfig.buildPack must be auto, nixpacks, dockerfile, railpack or static');
    }
    // F194: the same remote/ref rules POST and PATCH /services apply. The git
    // sinks rely on them (lib/git.ts: a leading-dash branch is read as an
    // option; vetCloneTarget lets file:// and local paths through).
    if (raw.service.repoUrl != null && !gitRepoUrl.safeParse(raw.service.repoUrl).success) {
      throw badRequest('Invalid bundle: service.repoUrl must be an http(s) or ssh URL');
    }
    if (raw.service.branch !== undefined && !gitBranch.safeParse(raw.service.branch).success) {
      throw badRequest(`Invalid bundle: invalid branch name ${JSON.stringify(raw.service.branch)}`);
    }
    const bundle: ServiceBundle = {
      ...raw,
      envVars: Array.isArray(raw.envVars) ? raw.envVars : [],
      domains: Array.isArray(raw.domains) ? raw.domains : [],
      webhooks: Array.isArray(raw.webhooks) ? raw.webhooks : [],
      attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
      buildConfig: raw.buildConfig ?? null,
    };
    // r601: the r510 write-time vault gate, applied to the bundle's env as a
    // whole BEFORE the service row exists — an imported service gets no
    // owner and no tags, so for a non-operator nothing allows a reference.
    // (The route is operator-only today; this keeps the rule in one place if
    // that ever widens.)
    await assertMayWriteVaultRefs(
      app.db,
      req.user!,
      { kind: 'newService', name: bundle.service.name, workspaceIds: [], projectIds: [] },
      bundle.envVars.map((e) => (typeof e?.value === 'string' ? e.value : '')),
    );

    // r656: everything the bundle carries is validated and claim-checked
    // BEFORE the first write, and the writes run in one transaction. The
    // import used to insert the service row first and then validate env keys,
    // domains and webhooks one by one — any later failure (a bad key, a
    // duplicate hostname's raw UNIQUE error, a non-string secret) left a
    // half-built service behind and answered 500.
    for (const e of bundle.envVars) {
      if (typeof e?.key !== 'string' || !envVarName.safeParse(e.key).success) {
        throw badRequest(`Invalid bundle: bad env var key ${JSON.stringify(e?.key)}`);
      }
      if (typeof e.value !== 'string') {
        throw badRequest(`Invalid bundle: env var ${e.key} has no value`);
      }
    }
    for (const w of bundle.webhooks) {
      if (typeof w?.branch !== 'string' || typeof w.secret !== 'string' || !Array.isArray(w.events)) {
        throw badRequest('Invalid bundle: each webhook needs a branch, an events list and a secret');
      }
      // F193: same glob limits the webhook API applies (the patterns are matched per push).
      if (w.watchPaths != null && !webhookCreate.shape.watchPaths.safeParse(w.watchPaths).success) {
        throw badRequest('Invalid bundle: a webhook watchPaths value is not a safe glob list');
      }
    }
    // F192: an attachment's alias becomes an env KEY at deploy
    // (pipeline: env[envAlias] = connection string) and the env-file writer
    // escapes values only — same rule as the env keys above and the attach
    // route (createAttachment.envAlias).
    for (const a of bundle.attachments) {
      if (typeof a?.envAlias !== 'string' || !envVarName.safeParse(a.envAlias).success) {
        throw badRequest(`Invalid bundle: bad attachment env alias ${JSON.stringify(a?.envAlias)}`);
      }
    }
    const domainRows = await claimBundleDomains(app.db, bundle.domains);

    // Unique slug to avoid conflicts
    const slug = slugifyWithSuffix(bundle.service.name, Date.now().toString(36).slice(-4));
    // r351: the suffix is time-derived, not a guarantee — an imported
    // `volumeMount` must not land on a deleted service's retained volume.
    await assertSlugVolumeNotRetained(slug, bundle.service.type);

    const svc = await app.db.transaction(async (tx) => {
      const [created] = await tx.insert(services).values({
        // r656: the importing operator owns the service. Without an owner,
        // every owner-scoped decision downstream (project-link trust, vault
        // allowlist, manifest attachments) treated it as nobody's.
        ownerUserId: req.user!.id,
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
        cpuLimitMilli: bundle.service.cpuLimitMilli || 0,
        memLimitMb: bundle.service.memLimitMb || 0,
        status: 'idle',
      }).returning();
      if (!created) throw badRequest('Could not create service');

      // Build config
      if (bundle.buildConfig) {
        const bc = bundle.buildConfig;
        await tx.insert(buildConfigs).values({
          serviceId: created.id,
          buildPack: bc.buildPack as 'auto' | 'nixpacks' | 'dockerfile' | 'railpack' | 'static',
          baseDir: bc.baseDir || '/',
          installCmd: bc.installCmd,
          buildCmd: bc.buildCmd,
          startCmd: bc.startCmd,
          dockerfilePath: bc.dockerfilePath,
        });
      }

      // Env vars (re-encrypt with this instance's master key). Keys were
      // validated above with the same charset the normal env API enforces —
      // a key containing `=` or a newline would inject into the deploy env-file.
      for (const e of bundle.envVars) {
        await tx.insert(envVars).values({
          serviceId: created.id,
          scope: 'service',
          scopeKey: created.id,
          key: e.key,
          valueEncrypted: encrypt(e.value),
          isSecret: e.isSecret,
        });
      }

      // Domains (only custom ones, skip wildcard auto-domains) — claimed above.
      if (domainRows.length > 0) {
        try {
          await tx
            .insert(domains)
            .values(domainRows.map((d) => ({ ...d, serviceId: created.id, status: 'active' as const, verifiedAt: new Date() })));
        } catch (err) {
          // A route registered between the claim check and this insert.
          if (isUniqueViolation(err)) {
            throw conflict('A domain in the bundle was registered by another service while importing — import again');
          }
          throw err;
        }
      }

      // Webhooks (re-encrypt secrets)
      const webhookRows = bundle.webhooks.map((w) => ({
        serviceId: created.id,
        branch: w.branch,
        events: w.events,
        secretEncrypted: encrypt(w.secret),
        watchPaths: w.watchPaths?.trim() || null,
        active: true,
      }));
      if (webhookRows.length > 0) {
        await tx.insert(webhooks).values(webhookRows);
      }

      // Attachments (best-effort: match the database by name AND engine — a
      // same-named database of a different engine must not be attached, or the
      // service would receive wrong-protocol credentials).
      for (const a of bundle.attachments) {
        const match = await tx.query.databases.findFirst({
          where: and(
            eq(databases.name, a.databaseName),
            eq(databases.engine, a.databaseEngine as (typeof dbEngine)[number]),
          ),
        });
        if (match) {
          await tx.insert(databaseAttachments).values({
            serviceId: created.id,
            databaseId: match.id,
            envAlias: a.envAlias,
          });
        }
      }
      return created;
    });

    void audit(app.db, req.user!.id, 'service.import', svc.name, { serviceId: svc.id });
    // An inline stack has no repository to clone, so its workspace has to be
    // rebuilt from the bundle before the first deploy on this host — after
    // the commit, so a rolled-back import leaves no workspace behind.
    if (svc.composeContent) materialiseComposeFile(svc.id, svc.composeContent);

    return { ok: true, serviceId: svc.id, slug, message: `Service "${bundle.service.name}" imported. Deploy to activate.` };
  });
};

/**
 * r656: the bundle's domains, normalised and checked against the same claim
 * rules a new route meets — before anything is written. They used to be
 * inserted `active` as-is: a bundle naming a host another service routes got
 * either a raw UNIQUE error (500, half-built service) or, on a different
 * path, a second router silently stacked on that service's hostname. A bundle
 * is foreign JSON, so a collision refuses the import with a 409 that names
 * the host, instead of taking the route over (an operator who means to move
 * it removes it from the old service first, or adds it later in the panel).
 * Names without a dot (internal-only) are skipped, as before.
 */
async function claimBundleDomains(
  db: DB,
  raw: ServiceBundle['domains'],
): Promise<Array<{ hostname: string; path: string; ssl: boolean }>> {
  const out: Array<{ hostname: string; path: string; ssl: boolean }> = [];
  if (raw.length === 0) return out;
  let panelDomain: string | null = process.env['NINEDEPLOY_DOMAIN'] ?? null;
  try {
    panelDomain = (await getSettingString(db, 'panel_domain', null)) ?? panelDomain;
  } catch {
    /* settings table unavailable — fall back to the env */
  }
  const existing = await db.query.domains.findMany();
  const seen = new Set<string>();
  for (const d of raw) {
    const parsed = bundleDomain.safeParse(d);
    if (!parsed.success) {
      throw badRequest(`Invalid bundle: domain ${JSON.stringify((d as { hostname?: unknown } | null)?.hostname ?? null)} — ${parsed.error.issues[0]!.message}`);
    }
    const hostname = normalizeHost(parsed.data.hostname);
    if (!hostname.includes('.')) continue;
    const key = `${hostname}|${parsed.data.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const retry = 'remove it from the bundle\'s "domains" and import again, then add it under Service → Domains once it is free';
    if (panelDomain && hostsCollide(hostname, panelDomain)) {
      throw conflict(`Bundle domain ${hostname} is reserved for the NineDeploy panel — ${retry}`);
    }
    const holder = existing.find((r) => hostsCollide(r.hostname, hostname));
    if (holder) {
      throw conflict(`Bundle domain ${hostname} is already routed by service #${holder.serviceId} — ${retry}`);
    }
    // The importer is an operator, so an instance-zone wildcard is theirs to
    // carry over; another service's automatic domain is not.
    if (!hostname.startsWith('*.')) {
      const refusal = await ownZoneClaimRefusal(db, 0, hostname);
      if (refusal) throw conflict(`Bundle domain ${hostname} ${refusal} — ${retry}`);
    }
    out.push({ hostname, path: parsed.data.path, ssl: parsed.data.ssl });
  }
  return out;
}

const bundleDomain = createDomain.pick({ hostname: true, path: true, ssl: true });
