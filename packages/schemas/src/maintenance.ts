import { z } from 'zod';

// ── Maintenance mode and custom error pages (G2.2) ─────────────────────────
// Per service, settings-backed. With maintenance on, the service's domains
// answer a 503 page from the panel (addresses on the bypass list still reach
// the app). Custom 502/503/504 pages replace what the proxy shows when the
// app itself answers with those codes or cannot be reached.

/** 4 for an IPv4 address, 6 for an IPv6 one (shape only; browsers share this package), else 0. */
function ipFamily(ip: string): 0 | 4 | 6 {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) return v4.slice(1).every((o) => Number(o) <= 255) ? 4 : 0;
  return ip.length <= 45 && ip.includes(':') && /^[0-9a-fA-F:.]+$/.test(ip) && (ip.match(/::/g) ?? []).length <= 1 ? 6 : 0;
}

/** An IPv4/IPv6 address or CIDR range. */
const ipOrCidr = z
  .string()
  .trim()
  .refine((v) => {
    const [ip, bits, extra] = v.split('/');
    if (extra !== undefined || !ip) return false;
    const family = ipFamily(ip);
    if (!family) return false;
    if (bits === undefined) return true;
    if (!/^\d{1,3}$/.test(bits)) return false;
    return Number(bits) <= (family === 4 ? 32 : 128);
  }, 'an IP address or CIDR range');

export const maintenanceConfig = z
  .object({
    title: z.string().trim().min(1).max(120).default('Down for maintenance'),
    message: z.string().trim().max(1000).default('We will be back shortly.'),
    /** Seconds a visitor's browser waits before trying again (`Retry-After`). */
    retryAfterSeconds: z.number().int().min(5).max(86_400).default(300),
    /** These addresses still reach the app, e.g. the team testing the release. */
    bypass: z.array(ipOrCidr).max(20).default([]),
  })
  .strict();
export type MaintenanceConfig = z.infer<typeof maintenanceConfig>;

/** `PUT /v1/services/:id/maintenance`: a config turns it on, null turns it off. */
export const maintenanceInput = z.object({ maintenance: maintenanceConfig.nullable() }).strict();
export type MaintenanceInput = z.input<typeof maintenanceInput>;

export interface MaintenanceView {
  maintenance: MaintenanceConfig | null;
  since: string | null;
}

export const ERROR_PAGE_STATUSES = ['502', '503', '504'] as const;
export type ErrorPageStatus = (typeof ERROR_PAGE_STATUSES)[number];
/** Per page, in bytes of HTML. */
export const ERROR_PAGE_MAX_BYTES = 64 * 1024;

/** UTF-8 length without TextEncoder or Buffer (the package has neither lib). */
function utf8Bytes(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

const errorPageHtml = z
  .string()
  .max(ERROR_PAGE_MAX_BYTES)
  .refine((v) => utf8Bytes(v) <= ERROR_PAGE_MAX_BYTES, `at most ${ERROR_PAGE_MAX_BYTES} bytes`);

/** `PUT /v1/services/:id/error-pages`: the HTML per status; a status left out shows the proxy's default. `{}` turns them off. */
export const errorPagesInput = z
  .object({
    pages: z
      .object({ '502': errorPageHtml.optional(), '503': errorPageHtml.optional(), '504': errorPageHtml.optional() })
      .strict(),
  })
  .strict();
export type ErrorPagesInput = z.infer<typeof errorPagesInput>;

export interface ErrorPagesView {
  pages: Partial<Record<ErrorPageStatus, string>>;
}
