import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { DB } from '@ninedeploy/db';
import { certificateHostnames, certificatesCovering } from './customCertificates.js';
import { getSettingString, setSettingString } from './settings.js';

/**
 * G5.7 certificates shared across node proxies. The panel's Traefik keeps
 * the certificates it issued (HTTP-01, or a DNS-01 wildcard) in acme.json.
 * With sharing on, a node proxy gets inline — like uploaded certificates —
 * the panel's certificates that cover hosts the node routes, and Traefik on
 * the node then serves them instead of requesting its own. So a domain whose
 * DNS points at several ingress hosts (fan-out targets) has one certificate
 * everywhere, and a wildcard is issued once rather than once per node, which
 * keeps clear of Let's Encrypt's duplicate-certificate limit.
 *
 * Off by default: it copies private keys to the nodes that route those
 * hosts. An operator switches it (`node_shared_certificates`).
 */

const SETTING = 'node_shared_certificates';

/** Unreadable reads as off: a render never fails over this switch. */
export async function sharedCertificatesEnabled(db: DB): Promise<boolean> {
  try {
    return (await getSettingString(db, SETTING, null)) === 'true';
  } catch {
    return false;
  }
}

export async function setSharedCertificates(db: DB, enabled: boolean): Promise<boolean> {
  await setSettingString(db, SETTING, enabled ? 'true' : 'false');
  return enabled;
}

export interface AcmeCertificate {
  certPem: string;
  keyPem: string;
  hostnames: string[];
  notBefore: Date;
  notAfter: Date;
}

/** acme.json stores PEMs as base64 of the PEM text (a Go []byte). */
const pemText = (stored: string): string => (stored.includes('-----BEGIN') ? stored : Buffer.from(stored, 'base64').toString('utf8'));

/** The issued certificates with their keys, from acme.json text; [] when unreadable. */
export function parseAcmeStorage(text: string): AcmeCertificate[] {
  let raw: Record<string, { Certificates?: Array<{ certificate?: string; key?: string }> | null }>;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const out: AcmeCertificate[] = [];
  for (const resolver of Object.values(raw ?? {})) {
    for (const c of resolver?.Certificates ?? []) {
      if (!c?.certificate || !c.key) continue;
      try {
        const certPem = pemText(c.certificate);
        const keyPem = pemText(c.key);
        const leaf = certPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
        if (!leaf || !keyPem.includes('PRIVATE KEY')) continue;
        const x = new X509Certificate(leaf);
        out.push({ certPem, keyPem, hostnames: certificateHostnames(x), notBefore: x.validFromDate, notAfter: x.validToDate });
      } catch {
        /* a certificate that does not parse is skipped */
      }
    }
  }
  return out;
}

export function readAcmeStorage(path: string): AcmeCertificate[] {
  try {
    return existsSync(path) ? parseAcmeStorage(readFileSync(path, 'utf8')) : [];
  } catch {
    return [];
  }
}

/**
 * The panel certificates a node gets: unexpired, covering at least one host
 * it routes and not already covered by an uploaded certificate (an upload
 * always wins). The newest certificate per host set, so a renewal replaces
 * the old one.
 */
export function certificatesForNode(
  acme: readonly AcmeCertificate[],
  routedHosts: Iterable<string>,
  coveredByUploads: (host: string) => boolean,
  now: Date = new Date(),
): AcmeCertificate[] {
  const hosts = [...routedHosts].filter((h) => !coveredByUploads(h));
  const valid = acme.filter((c) => c.notAfter > now && c.notBefore <= now);
  const loaded = valid.map((c, i) => ({ ...c, id: i, name: '', fingerprint: '', subject: null, issuer: null }));
  const chosen = new Map<string, AcmeCertificate>();
  for (const host of hosts) {
    const covering = certificatesCovering(host, loaded, now).sort((a, b) => b.notAfter.getTime() - a.notAfter.getTime());
    const best = covering[0];
    if (best) chosen.set([...best.hostnames].sort().join(','), valid[best.id]!);
  }
  return [...chosen.values()];
}
