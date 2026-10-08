import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { asc, count, eq } from 'drizzle-orm';
import { domains, tlsCertificates, type TlsCertificate } from '@ninedeploy/db';
import {
  CUSTOM_CERTIFICATES_MAX,
  customCertificateReplace,
  customCertificateUpload,
  traefikCustomConfigInput,
  type CustomCertificate,
} from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { encrypt } from '../lib/crypto.js';
import { conflict, isUniqueViolation, notFound, parseId } from '../lib/errors.js';
import {
  certificatesCovering,
  NODE_DYNAMIC_WARN_BYTES,
  parseCertificateUpload,
  type ParsedCertificate,
} from '../lib/customCertificates.js';
import {
  applyCustomConfig,
  clearCustomConfig,
  getCustomConfigState,
  validateCustomConfig,
} from '../lib/traefikCustomConfig.js';
import { getAcmeEmail, writeDynamicConfig } from '../engine/proxy.js';

/**
 * Proxy management (0.14): the operator's custom Traefik dynamic config
 * (`/v1/traefik/custom-config`) and custom TLS certificates
 * (`/v1/traefik/certificates/custom`). Design: DESIGN.md §2.5.
 *
 * Registered in `modules/api.ts` under `/traefik` (M1). `traefikRoutes` owns
 * `/traefik`, `/traefik/status`, `/traefik/certificates`, … ; these paths do
 * not collide with any of them.
 *
 * Operator only, and no PREFIX_SCOPES entry, so fine-grained API tokens are
 * refused: a wildcard certificate or a custom router would let a member take
 * over another tenant's hostnames. Audit meta records hashes, fingerprints
 * and hostnames — never PEM. `traefik.certificate.*` audits ride the normal
 * eventBus fan-out, which the public-database sidecar (T3) listens to.
 */
export const traefikCustomRoutes: FastifyPluginAsync = async (app) => {
  const guard = { onRequest: [app.authenticate], preHandler: [app.requireOperator] };
  /** A 256 KiB YAML can triple in JSON escaping; the 1 MiB default would cut it off. */
  const yamlBody = { ...guard, bodyLimit: 2 * 1024 * 1024 };

  // ── custom dynamic config ──────────────────────────────────────────────

  app.get('/custom-config', guard, async () => getCustomConfigState(app.db));

  // No state change: exempt from auditCoverage.
  app.post('/custom-config/validate', yamlBody, async (req) => {
    const { content } = traefikCustomConfigInput.parse(req.body);
    return validateCustomConfig(content, { acmeEmailSet: !!(await getAcmeEmail(app.db)) });
  });

  app.put('/custom-config', yamlBody, async (req, reply) => {
    const { content } = traefikCustomConfigInput.parse(req.body);
    const userId = req.user!.id;
    const result = await applyCustomConfig(app.db, {
      content,
      userId,
      acmeEmailSet: !!(await getAcmeEmail(app.db)),
    });
    switch (result.kind) {
      case 'invalid':
        return reply.status(400).send({
          error: { code: 'invalid_custom_config', message: result.validation.errors[0]?.message ?? 'invalid config' },
          errors: result.validation.errors,
          warnings: result.validation.warnings,
        });
      case 'unavailable':
        return reply.status(503).send({
          error: { code: 'traefik_validation_unavailable', message: 'Traefik validation unavailable; not applied' },
        });
      case 'preflight_failed':
        return reply.status(422).send({
          error: { code: 'custom_config_refused', message: 'Traefik refused the config; nothing was applied' },
          errors: result.errors.map((message) => ({ path: '', message })),
          warnings: result.warnings,
        });
      case 'rejected':
        void audit(app.db, userId, 'traefik.custom_config.rejected', 'custom.yml', {
          sha256: result.sha256,
          reverted: result.reverted,
          errors: result.errors.slice(0, 5),
        });
        return reply.status(422).send({
          error: {
            code: 'custom_config_rejected',
            message:
              result.reverted === 'last_good'
                ? 'Traefik rejected the config; the last good version was restored'
                : 'Traefik rejected the config; it was removed',
          },
          errors: result.errors.map((message) => ({ path: '', message })),
        });
      case 'applied':
        void audit(app.db, userId, 'traefik.custom_config.save', 'custom.yml', {
          sha256: result.sha256,
          bytes: Buffer.byteLength(content, 'utf8'),
          warnings: result.warnings.length,
        });
        return { ok: true, status: 'applied', sha256: result.sha256, warnings: result.warnings };
    }
  });

  app.delete('/custom-config', guard, async (req) => {
    const res = await clearCustomConfig(app.db);
    void audit(app.db, req.user!.id, 'traefik.custom_config.clear', 'custom.yml', {
      sha256: res.sha256,
      existed: res.cleared,
    });
    return { ok: true, cleared: res.cleared };
  });

  // ── custom certificates ────────────────────────────────────────────────

  const serialize = async (rows: TlsCertificate[]): Promise<CustomCertificate[]> => {
    const sslDomains = (await app.db.select().from(domains)).filter((d) => d.ssl && d.hostname);
    const now = new Date();
    return rows.map((r) => {
      const hostnames = Array.isArray(r.hostnames) ? r.hostnames : [];
      const probe = [{ ...asLoaded(r), hostnames }];
      return {
        id: r.id,
        name: r.name,
        hostnames,
        subject: r.subject ?? null,
        issuer: r.issuer ?? null,
        notBefore: r.notBefore.toISOString(),
        notAfter: r.notAfter.toISOString(),
        fingerprint: r.fingerprintSha256,
        expired: r.notAfter.getTime() <= now.getTime(),
        coveredDomains: sslDomains
          .filter((d) => certificatesCovering(String(d.hostname), probe, now).length > 0)
          .map((d) => ({ id: d.id, hostname: String(d.hostname), serviceId: d.serviceId })),
      };
    });
  };

  /** Re-render the panel's certificates and routes and every node's (best-effort). */
  const rerender = async (): Promise<void> => {
    await writeDynamicConfig(app.db).catch((err) =>
      app.log.error({ err }, 'traefik certificate change: route re-render failed'),
    );
  };

  /** Warn when the inline certificates alone approach a node's 1 MiB cap. */
  const sizeWarnings = async (): Promise<string[]> => {
    const rows = await app.db.select({ c: tlsCertificates.certPem }).from(tlsCertificates);
    const bytes = rows.reduce((n, r) => n + Buffer.byteLength(r.c, 'utf8') + 4096, 0);
    return bytes > NODE_DYNAMIC_WARN_BYTES
      ? [`uploaded certificates total about ${Math.round(bytes / 1024)} KiB; a node's proxy config is capped at 1 MiB`]
      : [];
  };

  const rowValues = (p: ParsedCertificate) => ({
    certPem: p.certPem,
    keyEncrypted: encrypt(p.keyPem),
    hostnames: p.hostnames,
    fingerprintSha256: p.fingerprint,
    subject: p.subject,
    issuer: p.issuer,
    notBefore: p.notBefore,
    notAfter: p.notAfter,
  });

  const duplicate = () => conflict('a certificate with this fingerprint is already uploaded');

  app.get('/certificates/custom', guard, async () =>
    serialize(await app.db.select().from(tlsCertificates).orderBy(asc(tlsCertificates.id))),
  );

  app.post('/certificates/custom', guard, async (req, reply: FastifyReply) => {
    const input = customCertificateUpload.parse(req.body);
    const parsed = parseCertificateUpload(input.certPem, input.keyPem);
    const [{ n } = { n: 0 }] = await app.db.select({ n: count() }).from(tlsCertificates);
    if (n >= CUSTOM_CERTIFICATES_MAX) throw conflict(`at most ${CUSTOM_CERTIFICATES_MAX} certificates can be uploaded`);
    let row: TlsCertificate | undefined;
    try {
      [row] = await app.db
        .insert(tlsCertificates)
        .values({ name: input.name, createdByUserId: req.user!.id, ...rowValues(parsed) })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) throw duplicate();
      throw err;
    }
    await rerender();
    void audit(app.db, req.user!.id, 'traefik.certificate.upload', input.name, {
      certificateId: row!.id,
      fingerprint: parsed.fingerprint,
      hostnames: parsed.hostnames,
      notAfter: parsed.notAfter.toISOString(),
    });
    const [out] = await serialize([row!]);
    return reply.status(201).send({ ...out, warnings: await sizeWarnings() });
  });

  app.put<{ Params: { id: string } }>('/certificates/custom/:id', guard, async (req) => {
    const id = parseId(req.params.id);
    const existing = await app.db.query.tlsCertificates.findFirst({ where: eq(tlsCertificates.id, id) });
    if (!existing) throw notFound('certificate not found');
    const input = customCertificateReplace.parse(req.body);
    const parsed = parseCertificateUpload(input.certPem, input.keyPem);
    let row: TlsCertificate | undefined;
    try {
      [row] = await app.db
        .update(tlsCertificates)
        .set({ ...(input.name ? { name: input.name } : {}), ...rowValues(parsed), updatedAt: new Date() })
        .where(eq(tlsCertificates.id, id))
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) throw duplicate();
      throw err;
    }
    await rerender();
    void audit(app.db, req.user!.id, 'traefik.certificate.replace', row!.name, {
      certificateId: id,
      fingerprint: parsed.fingerprint,
      previousFingerprint: existing.fingerprintSha256,
      hostnames: parsed.hostnames,
      notAfter: parsed.notAfter.toISOString(),
    });
    const [out] = await serialize([row!]);
    return { ...out, warnings: await sizeWarnings() };
  });

  app.delete<{ Params: { id: string } }>('/certificates/custom/:id', guard, async (req) => {
    const id = parseId(req.params.id);
    const existing = await app.db.query.tlsCertificates.findFirst({ where: eq(tlsCertificates.id, id) });
    if (!existing) throw notFound('certificate not found');
    await app.db.delete(tlsCertificates).where(eq(tlsCertificates.id, id));
    await rerender();
    void audit(app.db, req.user!.id, 'traefik.certificate.delete', existing.name, {
      certificateId: id,
      fingerprint: existing.fingerprintSha256,
      hostnames: existing.hostnames,
    });
    return { ok: true };
  });
};

/** A stored row in the shape coverage matching takes (no key needed to match names). */
function asLoaded(r: TlsCertificate) {
  return {
    id: r.id,
    name: r.name,
    certPem: r.certPem,
    keyPem: '',
    hostnames: [] as string[],
    subject: r.subject,
    issuer: r.issuer,
    notBefore: r.notBefore,
    notAfter: r.notAfter,
    fingerprint: r.fingerprintSha256,
  };
}
