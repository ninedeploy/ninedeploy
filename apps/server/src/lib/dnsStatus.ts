import { resolve4, resolve6 } from 'node:dns/promises';
import { isIPv6 } from 'node:net';

/**
 * DNS resolution status for a service's custom domain. Answers the
 * operator-facing question "does this hostname actually point at us yet?"
 * BEFORE Traefik silently serves a 404 for it — the same check Coolify
 * shipped in v4.3, but non-blocking: the record is advisory, routing is
 * governed by the ownership challenge (H-2) instead.
 */

export interface DnsResolution {
  a: string[];
  aaaa: string[];
}

export type ResolutionKind = 'ok' | 'mismatch' | 'unresolved';

export interface DnsCheckResult extends DnsResolution {
  /** ok = resolves to the expected address; mismatch = resolves elsewhere; unresolved = no address records. */
  status: ResolutionKind;
  expected: string[];
}

export async function resolveHostAddresses(hostname: string): Promise<DnsResolution> {
  const [a, aaaa] = await Promise.all([
    safeResolve(() => resolve4(hostname)),
    safeResolve(() => resolve6(hostname)),
  ]);
  return { a, aaaa };
}

async function safeResolve(fn: () => Promise<string[]>): Promise<string[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}

/**
 * Compare a resolved hostname against the addresses the panel expects
 * (the server's public IP, or the explicit record content the operator
 * configured). `ok` needs one address family to match; a hostname that
 * resolves only on the other family is still ok.
 */
export function classifyResolution(resolution: DnsResolution, expected: string[]): ResolutionKind {
  const all = [...resolution.a, ...resolution.aaaa].map(canonicalAddress);
  if (all.length === 0) return 'unresolved';
  return expected.some((ip) => all.includes(canonicalAddress(ip))) ? 'ok' : 'mismatch';
}

function canonicalAddress(ip: string): string {
  if (isIPv6(ip)) {
    try {
      return new URL(`http://[${ip}]`).hostname;
    } catch {
      /* Preserve unsupported scoped-address spellings for exact comparison. */
    }
  }
  return ip;
}
