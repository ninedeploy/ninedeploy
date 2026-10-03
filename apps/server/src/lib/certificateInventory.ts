/**
 * `ninedeploy certificates {list,expiring}` — G-15
 * certificate inventory.
 *
 * Wraps `engine/proxy.ts:readCertificates()` (the
 * acme.json reader) with the classification the
 * panel needs: `daysToExpiry`, `status` (valid /
 * expiring-soon / expired / unknown), `autoRenew`,
 * `source`, and an aggregate summary. The result is
 * the surface the panel renders in the (forthcoming)
 * Certificates page; the operator can also query
 * `?days=N` to get a focused "expiring within N
 * days" list.
 */
import { readCertificates } from '../engine/proxy.js';
import type {
  CertificateInventoryEntry,
  CertificateInventoryReport,
  CertificateInventorySummary,
} from '@ninedeploy/schemas';

const DEFAULT_EXPIRING_THRESHOLD_DAYS = 30;

/**
 * Build the inventory report. The threshold for
 * `expiring-soon` is configurable so a CI script can
 * ask for a tighter window than the panel's default.
 */
export async function buildCertificateInventory(
  expiringThresholdDays: number = DEFAULT_EXPIRING_THRESHOLD_DAYS,
): Promise<CertificateInventoryReport> {
  const certs = readCertificates();
  const entries: CertificateInventoryEntry[] = certs.map((c) => toEntry(c, expiringThresholdDays));
  const summary = summarise(entries, expiringThresholdDays);
  return {
    certificates: entries,
    summary,
  };
}

/**
 * Filter the inventory to entries whose
 * `daysToExpiry` is `<= days`. `null` days (no
 * expiry known) are dropped — a certificate with
 * no expiry is either a placeholder or a wildcard
 * case the operator should investigate.
 */
export function expiringWithin(
  report: CertificateInventoryReport,
  days: number,
): CertificateInventoryEntry[] {
  return report.certificates.filter(
    (c) => c.daysToExpiry !== null && c.daysToExpiry <= days,
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

function toEntry(
  c: { domain: string; expiresAt: Date | null },
  expiringThresholdDays: number,
): CertificateInventoryEntry {
  const days = daysUntil(c.expiresAt);
  const status = classify(c.expiresAt, days, expiringThresholdDays);
  return {
    host: c.domain,
    issuer: 'Let\'s Encrypt', // The only path the panel can read today
                                // is Traefik's acme.json; the issuer is
                                // the configured ACME CA. A future PR
                                // can parse the leaf PEM for the
                                // subject.
    subject: null,
    sans: [],
    notBefore: null,
    notAfter: c.expiresAt ? c.expiresAt.toISOString() : null,
    daysToExpiry: days,
    status,
    // Traefik + the NineDeploy DNS-01 solver auto-renew
    // every certificate routed through the panel; the
    // static fallback (a manually-placed .pem in
    // /etc/traefik/certs) does not. We can't read
    // Traefik's file watcher to know which is which
    // today, so we assume every cert is auto-renewed
    // and surface the assumption in `source`.
    autoRenew: true,
    source: 'acme.json',
  };
}

function daysUntil(expiresAt: Date | null): number | null {
  if (!expiresAt) return null;
  const ms = expiresAt.getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

function classify(
  expiresAt: Date | null,
  days: number | null,
  expiringThresholdDays: number,
): CertificateInventoryEntry['status'] {
  if (!expiresAt || days === null) return 'unknown';
  // `<= 0`, not `< 0`: daysUntil uses Math.ceil, so anything expired within
  // the last 24h is -0, and `-0 < 0` is false in JS.
  if (days <= 0) return 'expired';
  if (days <= expiringThresholdDays) return 'expiring-soon';
  return 'valid';
}

function summarise(
  entries: CertificateInventoryEntry[],
  expiringThresholdDays: number,
): CertificateInventorySummary {
  let valid = 0;
  let expiringSoon = 0;
  let expired = 0;
  for (const e of entries) {
    if (e.status === 'valid') valid += 1;
    else if (e.status === 'expiring-soon') expiringSoon += 1;
    else if (e.status === 'expired') expired += 1;
  }
  return {
    total: entries.length,
    valid,
    expiringSoon,
    expired,
    expiringThresholdDays,
    fetchedAt: new Date().toISOString(),
  };
}
