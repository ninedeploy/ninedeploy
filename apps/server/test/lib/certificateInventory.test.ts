/**
 * G-15 certificate inventory — lib coverage.
 *
 * `certificateInventory.ts` is a thin classification layer over
 * `engine/proxy.ts:readCertificates()`. The behaviour worth pinning down:
 *  - the threshold for `expiring-soon` is configurable; the default
 *    is 30 days.
 *  - classification is: `expired` (< 0 days), `expiring-soon`
 *    (<= threshold), `valid` (> threshold), `unknown` (no expiry).
 *  - `expiringWithin(report, days)` drops null `daysToExpiry` entries
 *    so the alert engine never pages on a wildcard it cannot reason
 *    about.
 *  - the summary's `expiringThresholdDays` echoes the threshold used;
 *    `fetchedAt` is a parseable ISO string.
 *  - the `autoRenew: true` / `source: 'acme.json'` assumption is
 *    surfaced so the panel does not silently misrepresent manually-
 *    placed .pem fallbacks as auto-renewed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const proxyState = vi.hoisted(() => ({ certs: [] as Array<{ domain: string; expiresAt: Date | null }> }));

vi.mock('../../src/engine/proxy.js', () => ({
  readCertificates: () => proxyState.certs,
}));

import { buildCertificateInventory, expiringWithin } from '../../src/lib/certificateInventory.js';

const day = 24 * 60 * 60 * 1000;
const now = Date.now();
const inDays = (n: number) => new Date(now + n * day);
const agoDays = (n: number) => new Date(now - n * day);

afterEach(() => {
  proxyState.certs = [];
});

describe('lib/certificateInventory', () => {
  describe('buildCertificateInventory', () => {
    it('returns an empty report when Traefik has no certificates', async () => {
      const report = await buildCertificateInventory();
      expect(report.certificates).toEqual([]);
      expect(report.summary).toMatchObject({
        total: 0,
        valid: 0,
        expiringSoon: 0,
        expired: 0,
        expiringThresholdDays: 30,
      });
      expect(typeof report.summary.fetchedAt).toBe('string');
      // fetchedAt must be parseable.
      expect(Number.isNaN(Date.parse(report.summary.fetchedAt))).toBe(false);
    });

    it('classifies a long-lived cert as `valid`', async () => {
      proxyState.certs = [{ domain: 'a.example.com', expiresAt: inDays(60) }];
      const report = await buildCertificateInventory();
      const entry = report.certificates[0]!;
      expect(entry.status).toBe('valid');
      expect(entry.host).toBe('a.example.com');
      expect(entry.issuer).toBe("Let's Encrypt");
      // daysToExpiry is ceil((msUntil) / day); should be ~60.
      expect(entry.daysToExpiry).toBeGreaterThanOrEqual(59);
      expect(entry.daysToExpiry).toBeLessThanOrEqual(61);
      expect(entry.autoRenew).toBe(true);
      expect(entry.source).toBe('acme.json');
      // The PEM parser is a follow-up; rich fields stay null/empty today.
      expect(entry.subject).toBeNull();
      expect(entry.sans).toEqual([]);
      expect(entry.notBefore).toBeNull();
      expect(entry.notAfter).toBe(inDays(60).toISOString());
    });

    it('classifies a within-threshold cert as `expiring-soon`', async () => {
      proxyState.certs = [{ domain: 'soon.example.com', expiresAt: inDays(7) }];
      const report = await buildCertificateInventory();
      expect(report.certificates[0]?.status).toBe('expiring-soon');
      expect(report.summary.expiringSoon).toBe(1);
      expect(report.summary.valid).toBe(0);
    });

    it('classifies a cert that has already passed its notAfter as `expired`', async () => {
      proxyState.certs = [{ domain: 'old.example.com', expiresAt: agoDays(3) }];
      const report = await buildCertificateInventory();
      expect(report.certificates[0]?.status).toBe('expired');
      // daysToExpiry is negative for expired certs.
      expect(report.certificates[0]?.daysToExpiry).toBeLessThan(0);
      expect(report.summary.expired).toBe(1);
    });

    it('classifies a cert expired less than a day ago as `expired`, not `expiring-soon`', async () => {
      // Math.ceil of a small negative yields -0 and `-0 < 0` is false — the
      // classification must still report these as expired.
      proxyState.certs = [{ domain: 'just-old.example.com', expiresAt: new Date(now - 3_600_000) }];
      const report = await buildCertificateInventory();
      expect(report.certificates[0]?.status).toBe('expired');
      expect(report.summary.expired).toBe(1);
      expect(report.summary.expiringSoon).toBe(0);
    });

    it('classifies a cert with no expiry as `unknown` and reports null days', async () => {
      proxyState.certs = [{ domain: 'wild.example.com', expiresAt: null }];
      const report = await buildCertificateInventory();
      expect(report.certificates[0]?.status).toBe('unknown');
      expect(report.certificates[0]?.daysToExpiry).toBeNull();
      expect(report.certificates[0]?.notAfter).toBeNull();
      // 'unknown' is intentionally not counted in any of the three
      // status buckets — only valid / expiring-soon / expired sum to
      // a value <= total.
      expect(report.summary.total).toBe(1);
      expect(report.summary.valid).toBe(0);
      expect(report.summary.expiringSoon).toBe(0);
      expect(report.summary.expired).toBe(0);
    });

    it('honours a custom threshold for `expiring-soon`', async () => {
      proxyState.certs = [
        { domain: 'tight.example.com', expiresAt: inDays(5) },
        { domain: 'loose.example.com', expiresAt: inDays(20) },
      ];
      const report = await buildCertificateInventory(7);
      // 5 days -> expiring-soon at threshold 7; 20 days -> valid.
      const byHost = Object.fromEntries(report.certificates.map((c) => [c.host, c.status]));
      expect(byHost['tight.example.com']).toBe('expiring-soon');
      expect(byHost['loose.example.com']).toBe('valid');
      expect(report.summary.expiringThresholdDays).toBe(7);
    });

    it('classifies a cert that is exactly at the threshold as `expiring-soon` (<=)', async () => {
      // The classification is `days <= threshold`, so the boundary
      // belongs to `expiring-soon`. Build a Date 30 days out (rounded
      // up by `Math.ceil`) to pin the contract.
      proxyState.certs = [{ domain: 'edge.example.com', expiresAt: inDays(30) }];
      const report = await buildCertificateInventory(30);
      expect(report.certificates[0]?.status).toBe('expiring-soon');
    });

    it('summarises mixed certs into the right status counts', async () => {
      proxyState.certs = [
        { domain: 'a.example.com', expiresAt: inDays(90) }, // valid
        { domain: 'b.example.com', expiresAt: inDays(60) }, // valid
        { domain: 'c.example.com', expiresAt: inDays(10) }, // expiring-soon
        { domain: 'd.example.com', expiresAt: agoDays(2) }, // expired
        { domain: 'e.example.com', expiresAt: null },       // unknown
      ];
      const report = await buildCertificateInventory();
      expect(report.summary).toMatchObject({
        total: 5,
        valid: 2,
        expiringSoon: 1,
        expired: 1,
      });
    });
  });

  describe('expiringWithin', () => {
    it('filters entries whose daysToExpiry is <= the requested window', async () => {
      proxyState.certs = [
        { domain: 'soon1.example.com', expiresAt: inDays(3) },
        { domain: 'soon2.example.com', expiresAt: inDays(20) },
        { domain: 'far.example.com', expiresAt: inDays(60) },
      ];
      const report = await buildCertificateInventory();
      const expiring = expiringWithin(report, 30);
      const hosts = expiring.map((c) => c.host).sort();
      // The 60-day cert is outside the 30-day window.
      expect(hosts).toEqual(['soon1.example.com', 'soon2.example.com']);
    });

    it('drops entries with null daysToExpiry (wildcards/placeholders)', async () => {
      proxyState.certs = [
        { domain: 'known.example.com', expiresAt: inDays(5) },
        { domain: 'wild.example.com', expiresAt: null },
      ];
      const report = await buildCertificateInventory();
      const expiring = expiringWithin(report, 30);
      // A wildcard with no expiry should never page the operator; the
      // alert engine would otherwise notify on a number it cannot act on.
      expect(expiring.map((c) => c.host)).toEqual(['known.example.com']);
    });

    it('includes entries that already passed their notAfter when the window covers them', async () => {
      proxyState.certs = [
        { domain: 'expired.example.com', expiresAt: agoDays(2) },
        { domain: 'future.example.com', expiresAt: inDays(2) },
      ];
      const report = await buildCertificateInventory();
      const expiring = expiringWithin(report, 30);
      // An expired cert is `daysToExpiry: -2` which is <= 30.
      expect(expiring.map((c) => c.host).sort()).toEqual(['expired.example.com', 'future.example.com']);
    });
  });
});
