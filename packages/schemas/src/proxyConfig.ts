import { z } from 'zod';

// ── Proxy management (0.14) ────────────────────────────────────────────────
// Request and response shapes for `/v1/traefik/custom-config` and
// `/v1/traefik/certificates/custom`. Operator only. These are SHAPE checks:
// the YAML rules (allowed sections, `custom-` names, entry points, refused
// keys) and the certificate proof (key matches leaf, key type, expiry) run on
// the server. No response shape carries a private key. Design: DESIGN.md §2.

/** 256 KiB. Measured in UTF-8 bytes on the server; this caps the string. */
export const TRAEFIK_CUSTOM_CONFIG_MAX_BYTES = 256 * 1024;
export const CUSTOM_CERTIFICATE_CHAIN_MAX_BYTES = 64 * 1024;
export const CUSTOM_CERTIFICATE_KEY_MAX_BYTES = 16 * 1024;
export const CUSTOM_CERTIFICATES_MAX = 100;

// ── Custom dynamic config ──────────────────────────────────────────────────

/** PUT /v1/traefik/custom-config and POST …/validate. */
export const traefikCustomConfigInput = z.object({
  content: z.string().min(1).max(TRAEFIK_CUSTOM_CONFIG_MAX_BYTES),
});
export type TraefikCustomConfigInput = z.infer<typeof traefikCustomConfigInput>;

/** One validation finding; `path` is a dotted YAML path (`http.routers.custom-a.rule`). */
export const traefikCustomConfigIssue = z.object({
  path: z.string(),
  message: z.string(),
});
export type TraefikCustomConfigIssue = z.infer<typeof traefikCustomConfigIssue>;

/** POST /v1/traefik/custom-config/validate. No state change. */
export const traefikCustomConfigValidation = z.object({
  ok: z.boolean(),
  errors: z.array(traefikCustomConfigIssue),
  warnings: z.array(traefikCustomConfigIssue),
});
export type TraefikCustomConfigValidation = z.infer<typeof traefikCustomConfigValidation>;

export const traefikCustomConfigState = z.enum(['none', 'applied', 'rejected']);
export type TraefikCustomConfigState = z.infer<typeof traefikCustomConfigState>;

/** GET /v1/traefik/custom-config. `content: null` = none saved. */
export const traefikCustomConfig = z.object({
  content: z.string().nullable(),
  sha256: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /** User id of the last saver. */
  updatedBy: z.number().int().nullable(),
  status: traefikCustomConfigState,
  lastError: z.string().nullable(),
});
export type TraefikCustomConfig = z.infer<typeof traefikCustomConfig>;

// ── Custom certificates ────────────────────────────────────────────────────

const certificatePem = z
  .string()
  .trim()
  .min(1)
  .max(CUSTOM_CERTIFICATE_CHAIN_MAX_BYTES)
  .regex(/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/, 'certPem must be a PEM certificate chain');

/** Unencrypted PKCS#8, PKCS#1 or SEC1 key. Passphrase-protected keys are refused. */
const privateKeyPem = z
  .string()
  .trim()
  .min(1)
  .max(CUSTOM_CERTIFICATE_KEY_MAX_BYTES)
  .regex(
    /^-----BEGIN (RSA |EC )?PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END \1PRIVATE KEY-----$/,
    'keyPem must be an unencrypted PEM private key',
  );

const certificateName = z.string().trim().min(1).max(100);

/** POST /v1/traefik/certificates/custom → 201. */
export const customCertificateUpload = z.object({
  name: certificateName,
  certPem: certificatePem,
  keyPem: privateKeyPem,
});
export type CustomCertificateUpload = z.infer<typeof customCertificateUpload>;

/** PUT /v1/traefik/certificates/custom/:certId. An omitted name keeps the stored one. */
export const customCertificateReplace = z.object({
  name: certificateName.optional(),
  certPem: certificatePem,
  keyPem: privateKeyPem,
});
export type CustomCertificateReplace = z.infer<typeof customCertificateReplace>;

/** One element of GET /v1/traefik/certificates/custom. */
export const customCertificate = z.object({
  id: z.number().int(),
  name: z.string(),
  hostnames: z.array(z.string()),
  subject: z.string().nullable(),
  issuer: z.string().nullable(),
  notBefore: z.string(),
  notAfter: z.string(),
  fingerprint: z.string(),
  expired: z.boolean(),
  coveredDomains: z.array(
    z.object({
      id: z.number().int(),
      hostname: z.string(),
      serviceId: z.number().int(),
    }),
  ),
});
export type CustomCertificate = z.infer<typeof customCertificate>;
