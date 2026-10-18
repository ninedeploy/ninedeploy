import { eq } from 'drizzle-orm';
import { type DB, hostIps, services } from '@ninedeploy/db';
import { isBindableIp } from '@ninedeploy/schemas';
import { listHostAddresses } from './hostAddresses.js';

/**
 * 0.16.1 IP inventory of the panel host: what the operator says about the
 * host's addresses — a label, which one is the primary address, and which
 * service an address is dedicated to. The addresses themselves are read
 * live from the host (`listHostAddresses`); a row exists only for an address
 * someone annotated, so a fresh or upgraded panel has none and behaves as
 * before.
 *
 *  - primary: the address DNS records should point at. Offered as the
 *    sslip.io address for automatic URLs and named in the panel's DNS hints.
 *  - dedicated: only that service may publish ports on the address
 *    explicitly (a port mapping's Host IP). Services publishing on every
 *    address still reach it on their own ports; the card says which.
 */

export interface HostIpView {
  ip: string;
  family: 4 | 6;
  /** Interface the host reports it on; null when it is not (or no longer) detected. */
  iface: string | null;
  detected: boolean;
  label: string | null;
  primary: boolean;
  dedicatedTo: { id: number; name: string } | null;
}

export const ipFamily = (ip: string): 4 | 6 => (ip.includes(':') ? 6 : 4);

/** The panel host's addresses, detected and annotated, detected ones first. `detected: false` when the host could not be asked. */
export async function hostIpInventory(db: DB): Promise<{ detected: boolean; addresses: HostIpView[] }> {
  const live = await listHostAddresses();
  const rows = await db
    .select({ ip: hostIps.ip, label: hostIps.label, isPrimary: hostIps.isPrimary, serviceId: hostIps.serviceId, serviceName: services.name })
    .from(hostIps)
    .leftJoin(services, eq(services.id, hostIps.serviceId));
  const byIp = new Map(rows.map((r) => [r.ip, r]));
  const view = (ip: string, iface: string | null, detected: boolean): HostIpView => {
    const row = byIp.get(ip);
    return {
      ip,
      family: ipFamily(ip),
      iface,
      detected,
      label: row?.label ?? null,
      primary: row?.isPrimary === true,
      dedicatedTo: row?.serviceId != null && row.serviceName != null ? { id: row.serviceId, name: row.serviceName } : null,
    };
  };
  const addresses = (live ?? []).map((a) => view(a.ip, a.iface, true));
  for (const r of rows) if (!addresses.some((a) => a.ip === r.ip)) addresses.push(view(r.ip, null, false));
  return { detected: live !== null, addresses };
}

/** The address marked primary, or null. */
export async function primaryHostIp(db: DB): Promise<string | null> {
  const [row] = await db.select({ ip: hostIps.ip }).from(hostIps).where(eq(hostIps.isPrimary, true)).limit(1);
  return row?.ip ?? null;
}

/** Every dedicated address and its service. */
export async function dedicatedHostIps(db: DB): Promise<Map<string, { id: number; name: string }>> {
  const rows = await db
    .select({ ip: hostIps.ip, serviceId: hostIps.serviceId, name: services.name })
    .from(hostIps)
    .innerJoin(services, eq(services.id, hostIps.serviceId));
  return new Map(rows.map((r) => [r.ip, { id: r.serviceId!, name: r.name }]));
}

/** A literal, bindable address in its stored (lower-case) form, or null. */
export function normalizeHostIp(ip: string): string | null {
  const v = ip.trim().toLowerCase();
  return isBindableIp(v) ? v : null;
}
