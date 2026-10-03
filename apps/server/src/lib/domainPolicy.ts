import { and, eq, gt, count } from 'drizzle-orm';
import { auditLog, domains, type DB } from '@ninedeploy/db';
import { getSettingJson } from './settings.js';
import { isOwnZone } from './domainVerification.js';

/**
 * r634/r635: operator-tunable limits on how domains are claimed.
 *
 * Every SSL router carries the ACME resolver, so each new hostname is a new
 * Let's Encrypt order. Own-zone names skip the DNS proof, which used to make
 * them free and unlimited for any member: a script adding thousands of
 * `<random>.<wildcard zone>` domains burns the instance's ACME account limits
 * (orders per account, certificates per registered domain) and every OTHER
 * tenant's renewals fail with it. Pending rows, on the other side, never
 * expired.
 *
 * Stored in the settings table under `domain_policy` (JSON; any field left out
 * keeps its default) and edited through `PUT /v1/settings/domain-policy`.
 * Instance operators are exempt from the caps. `0` disables a limit.
 */
export interface DomainPolicy {
  /** Own-zone (proof-free) domains one service may hold. Existing rows are never removed. */
  maxOwnZoneDomainsPerService: number;
  /** Domains one non-operator account may add per rolling hour. */
  maxDomainCreatesPerHour: number;
  /** Days an unverified (`pending`) domain is kept before housekeeping removes it. */
  pendingExpiryDays: number;
}

export const DOMAIN_POLICY_KEY = 'domain_policy';

export const DOMAIN_POLICY_DEFAULTS: Readonly<DomainPolicy> = Object.freeze({
  maxOwnZoneDomainsPerService: 50,
  maxDomainCreatesPerHour: 30,
  pendingExpiryDays: 30,
});

const FIELDS = Object.keys(DOMAIN_POLICY_DEFAULTS) as Array<keyof DomainPolicy>;

/** The effective policy. Never throws — a missing or malformed row is the defaults. */
export async function getDomainPolicy(db: DB): Promise<DomainPolicy> {
  const out: DomainPolicy = { ...DOMAIN_POLICY_DEFAULTS };
  let stored: Partial<Record<keyof DomainPolicy, unknown>> | null = null;
  try {
    stored = await getSettingJson<Partial<Record<keyof DomainPolicy, unknown>>>(db, DOMAIN_POLICY_KEY, null);
  } catch {
    return out;
  }
  if (!stored || typeof stored !== 'object') return out;
  for (const field of FIELDS) {
    const v = stored[field];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out[field] = v;
  }
  return out;
}

/** Domains `userId` added in the last hour — read from the audit trail, so a delete/re-add loop still counts. */
async function recentDomainAdds(db: DB, userId: number): Promise<number> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const rows = await db
    .select({ n: count() })
    .from(auditLog)
    .where(and(eq(auditLog.userId, userId), eq(auditLog.action, 'domain.add'), gt(auditLog.ts, since)));
  return rows[0]?.n ?? 0;
}

/** Own-zone domains `serviceId` already holds. */
export async function ownZoneDomainCount(db: DB, serviceId: number): Promise<number> {
  const rows = await db.select({ hostname: domains.hostname }).from(domains).where(eq(domains.serviceId, serviceId));
  return rows.filter((r) => isOwnZone(r.hostname)).length;
}

export interface DomainCapRefusal {
  status: 409 | 429;
  message: string;
}

/**
 * Why a NON-operator may not add `hostname` to `serviceId` right now, or null.
 * `userId` null (a manifest push) skips the per-account rate — a deploy is its
 * own throttle — but not the per-service cap.
 */
export async function domainCapRefusal(
  db: DB,
  policy: DomainPolicy,
  serviceId: number,
  hostname: string,
  userId: number | null,
): Promise<DomainCapRefusal | null> {
  if (userId != null && policy.maxDomainCreatesPerHour > 0) {
    if ((await recentDomainAdds(db, userId)) >= policy.maxDomainCreatesPerHour) {
      return {
        status: 429,
        message: `You have added ${policy.maxDomainCreatesPerHour} domains in the last hour — the limit for this instance. Try again later, or ask an operator to raise "maxDomainCreatesPerHour" in the domain policy.`,
      };
    }
  }
  if (policy.maxOwnZoneDomainsPerService > 0 && isOwnZone(hostname)) {
    if ((await ownZoneDomainCount(db, serviceId)) >= policy.maxOwnZoneDomainsPerService) {
      return {
        status: 409,
        message: `This service already has ${policy.maxOwnZoneDomainsPerService} domains in the instance's own zone — the limit for this instance. Remove one first, or ask an operator to raise "maxOwnZoneDomainsPerService" in the domain policy.`,
      };
    }
  }
  return null;
}
