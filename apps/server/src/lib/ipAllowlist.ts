import { isIP } from 'node:net';
import { PUBLIC_ACCESS_ALLOWLIST_MAX } from '@ninedeploy/schemas';
import { badRequest } from './errors.js';

/**
 * IP allow lists (database public access since 0.14, port mappings since
 * 0.16.1): every entry an IP address or CIDR range in canonical form, checked
 * with node:net, never "cleaned" by stripping characters.
 */

function ipv4Bytes(addr: string): number[] {
  return addr.split('.').map(Number);
}

function ipv6Bytes(addr: string): number[] {
  let text = addr;
  const tail: number[] = [];
  // An embedded dotted quad (`::ffff:192.0.2.1`) is the last 32 bits.
  const lastColon = text.lastIndexOf(':');
  if (text.slice(lastColon + 1).includes('.')) {
    tail.push(...ipv4Bytes(text.slice(lastColon + 1)));
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const [headText = '', tailText] = text.split('::');
  const head = headText ? headText.split(':') : [];
  const rest = tailText === undefined ? [] : tailText ? tailText.split(':') : [];
  const fill = tailText === undefined ? 0 : 8 - head.length - rest.length;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...rest].map((g) => Number.parseInt(g, 16));
  const bytes = groups.flatMap((g) => [g >> 8, g & 0xff]);
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** RFC 5952 text form: lowercase, no leading zeros, the longest zero run (≥2) as `::`. */
function formatIpv6(bytes: number[]): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i]! << 8) | bytes[i + 1]!);
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart < 0) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

function maskBytes(bytes: number[], prefix: number): number[] {
  return bytes.map((b, i) => {
    const bits = Math.max(0, Math.min(8, prefix - i * 8));
    return bits === 8 ? b : b & ((0xff << (8 - bits)) & 0xff);
  });
}

/**
 * One allow-list entry, parsed strictly with `node:net` and returned in its
 * canonical `network/prefix` form (host bits cleared). Never "cleaned" by
 * stripping characters: anything that is not exactly an address or a CIDR is
 * refused (the r630 lesson).
 */
export function normaliseAllowlistEntry(raw: string): string {
  const entry = typeof raw === 'string' ? raw.trim() : '';
  const bad = (why: string) => badRequest(`ipAllowlist: "${entry.slice(0, 64)}" ${why}`, 'invalid_allowlist');
  if (!entry || entry.length > 64) throw bad('is not an IP address or CIDR range');
  const parts = entry.split('/');
  if (parts.length > 2) throw bad('is not an IP address or CIDR range');
  const [addr = '', prefixText] = parts;
  // isIP accepts a zone index (`fe80::1%eth0`); a zone means nothing to a remote peer.
  const family = addr.includes('%') ? 0 : isIP(addr);
  if (family === 0) throw bad('is not an IP address or CIDR range');
  const max = family === 4 ? 32 : 128;
  let prefix = max;
  if (prefixText !== undefined) {
    if (!/^\d{1,3}$/.test(prefixText)) throw bad('has an invalid prefix length');
    prefix = Number(prefixText);
    if (prefix > max) throw bad(`has a prefix longer than /${max}`);
    if (prefix === 0) throw bad('allows every address on the internet (/0 is refused)');
  }
  let bytes = family === 4 ? ipv4Bytes(addr) : ipv6Bytes(addr);
  if (family === 6 && bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    // Go matches an IPv4 client against an IPv4-mapped range with the mask's
    // last 32 bits only, so `::ffff:0.0.0.0/96` would be a /0 in disguise.
    throw bad('is an IPv4-mapped IPv6 address: write the IPv4 form instead');
  }
  bytes = maskBytes(bytes, prefix);
  const text = family === 4 ? bytes.join('.') : formatIpv6(bytes);
  return `${text}/${prefix}`;
}

/** The whole allow-list: 1–100 distinct normalised entries, in the order given. */
export function normaliseAllowlist(entries: readonly string[]): string[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw badRequest('ipAllowlist: at least one address or range is required', 'invalid_allowlist');
  }
  const out: string[] = [];
  for (const e of entries) {
    const n = normaliseAllowlistEntry(e);
    if (!out.includes(n)) out.push(n);
  }
  if (out.length > PUBLIC_ACCESS_ALLOWLIST_MAX) {
    throw badRequest(`ipAllowlist: at most ${PUBLIC_ACCESS_ALLOWLIST_MAX} entries`, 'invalid_allowlist');
  }
  return out;
}

