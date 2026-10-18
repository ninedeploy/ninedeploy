/**
 * `ninedeploy ips {list,set,forget}` (0.16.1): the panel host's IP inventory.
 * Operator-only on the server; the CLI only shapes the request and prints.
 */
import type { HostIpEntry } from '@ninedeploy/sdk';
import type { NineDeployClient } from '../client.js';
import { c, error, header, info, success } from '../lib/format.js';

const describe = (a: HostIpEntry): string =>
  [
    a.ip.padEnd(28),
    (a.iface ?? 'not detected').padEnd(14),
    a.primary ? c.green('primary') : '',
    a.label ? `"${a.label}"` : '',
    a.dedicatedTo ? `dedicated to ${a.dedicatedTo.name} (#${a.dedicatedTo.id})` : 'shared',
  ]
    .filter(Boolean)
    .join('  ');

export async function ipsListAction(client: NineDeployClient): Promise<void> {
  header('Server IP addresses');
  try {
    const { detected, addresses } = await client.hostIps.list();
    if (!detected) info("The host's interfaces could not be read; saved addresses only.");
    if (addresses.length === 0) info('No public or LAN address found.');
    for (const a of addresses) info(describe(a));
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

/** Pure entry point: the PATCH body `ips set` sends. */
export function ipsPatch(opts: { label?: string; primary?: boolean; service?: string; shared?: boolean }): { label?: string | null; primary?: boolean; serviceId?: number | null } {
  if (opts.service !== undefined && opts.shared) throw new Error('Give --service or --shared, not both');
  const patch: { label?: string | null; primary?: boolean; serviceId?: number | null } = {};
  if (opts.label !== undefined) patch.label = opts.label.trim() || null;
  if (opts.primary) patch.primary = true;
  if (opts.service !== undefined) {
    const id = Number(opts.service);
    if (!Number.isInteger(id) || id < 1) throw new Error('--service takes a service id');
    patch.serviceId = id;
  }
  if (opts.shared) patch.serviceId = null;
  if (Object.keys(patch).length === 0) throw new Error('Nothing to change: give --label, --primary, --service <id> or --shared');
  return patch;
}

export async function ipsSetAction(
  client: NineDeployClient,
  ip: string,
  opts: { label?: string; primary?: boolean; service?: string; shared?: boolean } = {},
): Promise<void> {
  try {
    const saved = await client.hostIps.set(ip, ipsPatch(opts));
    success(saved ? describe(saved) : `${ip} saved`);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function ipsForgetAction(client: NineDeployClient, ip: string): Promise<void> {
  try {
    await client.hostIps.remove(ip);
    success(`${ip} forgotten`);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
