import { createHash, createPrivateKey, X509Certificate, type KeyObject } from 'node:crypto';
import { asc } from 'drizzle-orm';
import { tlsCertificates, type DB } from '@ninedeploy/db';
import {
  CUSTOM_CERTIFICATE_CHAIN_MAX_BYTES,
  CUSTOM_CERTIFICATE_KEY_MAX_BYTES,
  CUSTOM_CERTIFICATES_MAX,
} from '@ninedeploy/schemas';
import { audit } from './audit.js';
import { decrypt } from './crypto.js';

/**
 * Operator-uploaded TLS certificates (0.14, DESIGN §2.4).
 *
 * The panel proves an upload with `node:crypto` before it is stored: the
 * chain parses as X.509 with the leaf first, the key is an unencrypted RSA
 * ≥2048 / ECDSA P-256 or P-384 / Ed25519 key that matches the leaf, and the
 * leaf has not expired. The key is stored with `encrypt()`; the chain is
 * public material and stored as is.
 *
 * Rendering is opt-in by construction: an SSL domain is only switched from
 * the ACME resolver to `tls: {}` when a valid uploaded certificate covers
 * every hostname its router claims, so an install without uploads renders
 * byte-for-byte what 0.13 rendered.
 */

/** Below this size a node's dynamic config is fine; above it the panel warns (the agent refuses > 1 MiB). */
export const NODE_DYNAMIC_WARN_BYTES = 512 * 1024;

export class CertificateValidationError extends Error {
  readonly statusCode = 400;
  readonly code = 'invalid_certificate';
  constructor(message: string) {
    super(message);
    this.name = 'CertificateValidationError';
  }
}

/** A validated upload, ready to store. */
export interface ParsedCertificate {
  /** PEM chain, leaf first, normalised to `\n` line ends with one trailing newline. */
  certPem: string;
  keyPem: string;
  hostnames: string[];
  subject: string | null;
  issuer: string | null;
  notBefore: Date;
  notAfter: Date;
  /** sha256 over the leaf's DER, lowercase hex without separators. */
  fingerprint: string;
}

/** A stored certificate whose key decrypted. */
export interface LoadedCertificate extends ParsedCertificate {
  id: number;
  name: string;
}

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const HOSTNAME = /^(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const normalisePem = (pem: string): string => `${pem.replace(/\r\n?/g, '\n').trim()}\n`;
const oneLine = (dn: string | undefined): string | null => (dn ? dn.split('\n').filter(Boolean).join(', ') : null);

/** The DNS names a certificate names: SAN DNS entries, or the CN when it has no SAN at all. */
export function certificateHostnames(x: X509Certificate): string[] {
  const out: string[] = [];
  const san = x.subjectAltName;
  if (san !== undefined) {
    // Node quotes an entry carrying a separator as a JSON string (`DNS:"a, b"`).
    for (const m of san.matchAll(/(?:^|, )DNS:("(?:[^"\\]|\\.)*"|[^,]*)/g)) {
      let v = m[1] ?? '';
      if (v.startsWith('"')) {
        try {
          v = JSON.parse(v) as string;
        } catch {
          continue;
        }
      }
      out.push(v);
    }
  } else {
    const cn = (x.subject ?? '').split('\n').find((l) => l.startsWith('CN='));
    if (cn) out.push(cn.slice(3));
  }
  return [...new Set(out.map((h) => h.trim().toLowerCase()).filter((h) => h.length <= 253 && HOSTNAME.test(h)))];
}

function describeKey(key: KeyObject): string | null {
  const d = key.asymmetricKeyDetails ?? {};
  switch (key.asymmetricKeyType) {
    case 'rsa':
      return (d.modulusLength ?? 0) >= 2048 ? null : `RSA keys must be at least 2048 bits (this one is ${d.modulusLength ?? 0})`;
    case 'ec':
      return d.namedCurve === 'prime256v1' || d.namedCurve === 'secp384r1'
        ? null
        : `ECDSA keys must use P-256 or P-384 (this one uses ${d.namedCurve ?? 'an unknown curve'})`;
    case 'ed25519':
      return null;
    default:
      return `unsupported key type ${key.asymmetricKeyType ?? 'unknown'}; use RSA ≥2048, ECDSA P-256/P-384 or Ed25519`;
  }
}

/**
 * Prove an upload. Throws {@link CertificateValidationError} (a 400) naming
 * the first problem; never echoes key material.
 */
export function parseCertificateUpload(certPemIn: string, keyPemIn: string, now: Date = new Date()): ParsedCertificate {
  if (Buffer.byteLength(certPemIn, 'utf8') > CUSTOM_CERTIFICATE_CHAIN_MAX_BYTES) {
    throw new CertificateValidationError('the certificate chain is larger than 64 KiB');
  }
  if (Buffer.byteLength(keyPemIn, 'utf8') > CUSTOM_CERTIFICATE_KEY_MAX_BYTES) {
    throw new CertificateValidationError('the private key is larger than 16 KiB');
  }
  const blocks = certPemIn.replace(/\r\n?/g, '\n').match(PEM_CERT) ?? [];
  if (blocks.length === 0) throw new CertificateValidationError('certPem holds no PEM certificate');
  const chain: X509Certificate[] = [];
  blocks.forEach((b, i) => {
    try {
      chain.push(new X509Certificate(b));
    } catch {
      throw new CertificateValidationError(`certificate #${i + 1} in the chain is not a valid X.509 certificate`);
    }
  });

  const keyText = keyPemIn.replace(/\r\n?/g, '\n').trim();
  if (/ENCRYPTED/.test(keyText)) {
    throw new CertificateValidationError('passphrase-protected private keys are not supported; upload the unencrypted key');
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: keyText, format: 'pem' });
  } catch {
    throw new CertificateValidationError('keyPem is not a valid unencrypted PEM private key');
  }
  const keyProblem = describeKey(key);
  if (keyProblem) throw new CertificateValidationError(keyProblem);

  const leaf = chain[0]!;
  if (!leaf.checkPrivateKey(key)) {
    const at = chain.findIndex((c) => c.checkPrivateKey(key));
    throw new CertificateValidationError(
      at > 0
        ? `the chain must start with the leaf certificate; the key matches certificate #${at + 1}`
        : 'the private key does not match the certificate',
    );
  }
  for (let i = 0; i + 1 < chain.length; i++) {
    if (!chain[i]!.checkIssued(chain[i + 1]!)) {
      throw new CertificateValidationError(
        `certificate #${i + 2} did not issue certificate #${i + 1}; order the chain leaf first, then each issuer`,
      );
    }
  }
  const notAfter = leaf.validToDate;
  if (!(notAfter.getTime() > now.getTime())) {
    throw new CertificateValidationError(`the certificate expired on ${notAfter.toISOString()}`);
  }
  const hostnames = certificateHostnames(leaf);
  if (hostnames.length === 0) throw new CertificateValidationError('the certificate names no DNS hostname');

  return {
    certPem: blocks.map((b) => normalisePem(b)).join(''),
    keyPem: normalisePem(keyText),
    hostnames,
    subject: oneLine(leaf.subject),
    issuer: oneLine(leaf.issuer),
    notBefore: leaf.validFromDate,
    notAfter,
    fingerprint: createHash('sha256').update(leaf.raw).digest('hex'),
  };
}

/** Whether certificate name `name` covers `host`: exact, or a single-label wildcard. */
export function nameCovers(name: string, host: string): boolean {
  const n = name.toLowerCase();
  const h = host.trim().toLowerCase();
  if (n === h) return true;
  if (!n.startsWith('*.') || h.startsWith('*.')) return false;
  const suffix = n.slice(1); // ".example.com"
  if (!h.endsWith(suffix)) return false;
  const label = h.slice(0, -suffix.length);
  return label.length > 0 && !label.includes('.');
}

// ── stored certificates ─────────────────────────────────────────────────────

/** Every stored certificate whose key decrypted, expired ones included. Refreshed on every render. */
let cache: LoadedCertificate[] = [];
/** F176 pattern: an undecryptable key is skipped and audited once per row version, never thrown. */
const unreadableAudited = new Set<string>();

/** The certificates the last refresh loaded (expired ones included). */
export function cachedCustomCertificates(): readonly LoadedCertificate[] {
  return cache;
}

/**
 * Reload the stored certificates into the module cache. Never throws: an
 * unreadable table renders as "no uploads", which is exactly 0.13's output.
 */
export async function refreshCustomCertificates(db: DB): Promise<LoadedCertificate[]> {
  let rows: Array<typeof tlsCertificates.$inferSelect>;
  try {
    rows = await db.select().from(tlsCertificates).orderBy(asc(tlsCertificates.id));
  } catch {
    rows = [];
  }
  const out: LoadedCertificate[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    let keyPem: string;
    try {
      keyPem = decrypt(r.keyEncrypted);
    } catch {
      const k = `${r.id}:${r.fingerprintSha256}`;
      if (!unreadableAudited.has(k)) {
        unreadableAudited.add(k);
        void audit(db, null, 'traefik.certificate_unreadable', r.name, {
          certificateId: r.id,
          fingerprint: r.fingerprintSha256,
          reason: 'the private key could not be decrypted with the current master key; the certificate is not served',
        });
      }
      continue;
    }
    out.push({
      id: r.id,
      name: r.name,
      certPem: r.certPem,
      keyPem,
      hostnames: Array.isArray(r.hostnames) ? r.hostnames : [],
      subject: r.subject ?? null,
      issuer: r.issuer ?? null,
      notBefore: r.notBefore,
      notAfter: r.notAfter,
      fingerprint: r.fingerprintSha256,
    });
  }
  cache = out;
  return out;
}

const isValidAt = (c: { notAfter: Date; notBefore: Date }, now: Date): boolean =>
  c.notAfter.getTime() > now.getTime() && c.notBefore.getTime() <= now.getTime();

/**
 * The unexpired uploaded certificates covering `host` (exact names and
 * single-label wildcards). Reads the module cache unless `certs` is given.
 * Exported for the public database access sidecar (T3).
 */
export function certificatesCovering(
  host: string,
  certs: readonly LoadedCertificate[] = cache,
  now: Date = new Date(),
): LoadedCertificate[] {
  if (!host) return [];
  return certs.filter((c) => isValidAt(c, now) && c.hostnames.some((n) => nameCovers(n, host)));
}

/** True when every host has an unexpired covering certificate. */
export function hostsFullyCovered(hosts: string[], certs: readonly LoadedCertificate[], now: Date = new Date()): boolean {
  return hosts.length > 0 && hosts.every((h) => certificatesCovering(h, certs, now).length > 0);
}

/** The unexpired certificates, capped at the per-proxy limit, in stored order. */
export function servableCertificates(certs: readonly LoadedCertificate[], now: Date = new Date()): LoadedCertificate[] {
  return certs.filter((c) => isValidAt(c, now)).slice(0, CUSTOM_CERTIFICATES_MAX);
}

/**
 * The `tls.certificates` list items for these certificates, inline PEM in
 * `certFile` / `keyFile` (Traefik accepts content there). JSON strings are
 * valid YAML double-quoted scalars, so the PEM needs no block indentation.
 * Indented for a top-level `tls:\n  certificates:\n` parent.
 */
export function renderCertificateEntries(certs: ReadonlyArray<{ certPem: string; keyPem: string }>): string[] {
  return certs
    .slice(0, CUSTOM_CERTIFICATES_MAX)
    .map((c) => `    - certFile: ${JSON.stringify(normalisePem(c.certPem))}\n      keyFile: ${JSON.stringify(normalisePem(c.keyPem))}\n`);
}

/**
 * A complete `tls:` block holding these certificates, or `''` when there are
 * none (Traefik refuses an empty section). Exported for T3's sidecar config.
 */
export function renderCertificatesBlock(certs: ReadonlyArray<{ certPem: string; keyPem: string }>): string {
  const entries = renderCertificateEntries(certs);
  return entries.length ? `tls:\n  certificates:\n${entries.join('')}` : '';
}
