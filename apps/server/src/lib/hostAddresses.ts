import { ensureDockerImage } from './dockerPull.js';
import { capture } from './exec.js';

/**
 * 0.16.1: the IP addresses of the panel host, for the Host IP field of a port
 * mapping. Read with `ip -o addr` in a throwaway host-network container, so
 * the answer is the host's own interfaces whether the panel runs under
 * systemd or in its own container (where `os.networkInterfaces()` would list
 * the container's bridge address instead).
 */

export interface HostAddress {
  ip: string;
  family: 4 | 6;
  /** Interface name (`eth0`, `ens3`). */
  iface: string;
}

const IMAGE = 'busybox:1.36';
const CACHE_MS = 60_000;
const TIMEOUT_MS = 20_000;

/** Interfaces that are Docker's or the loopback, never an address to publish on. */
const SKIP_IFACE = /^(lo|docker\d*|br-[0-9a-f]+|veth[0-9a-f]*|cni\d*|flannel\.\d+|vxlan\.\S+|docker_gwbridge)$/;

/**
 * `ip -o addr show` lines → addresses: global scope only (no loopback, no
 * IPv6 link-local), Docker's own bridges skipped, duplicates dropped.
 */
export function parseIpAddr(output: string): HostAddress[] {
  const out: HostAddress[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^\d+:\s+([^\s:@]+)(?:@\S+)?\s+(inet6?)\s+([0-9A-Fa-f:.]+)\/\d+.*\bscope\s+(\S+)/.exec(line);
    if (!m || m[4] !== 'global' || SKIP_IFACE.test(m[1]!)) continue;
    const ip = m[3]!.toLowerCase();
    if (!out.some((a) => a.ip === ip)) out.push({ ip, family: m[2] === 'inet6' ? 6 : 4, iface: m[1]! });
  }
  return out;
}

let cache: { at: number; value: HostAddress[] | null } | null = null;

/**
 * The host's addresses, or null when they cannot be read (no Docker, image
 * pull refused). Cached for a minute: the Network tab and every save ask.
 */
export async function listHostAddresses(now = Date.now()): Promise<HostAddress[] | null> {
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  let value: HostAddress[] | null;
  try {
    await ensureDockerImage(IMAGE, () => undefined);
    const raw = await capture('docker', ['run', '--rm', '--network', 'host', IMAGE, 'ip', '-o', 'addr', 'show'], { timeoutMs: TIMEOUT_MS });
    value = parseIpAddr(raw);
  } catch {
    value = null;
  }
  cache = { at: now, value };
  return value;
}

/** Test seam: forget the cached answer. */
export function resetHostAddressCache(): void {
  cache = null;
}
