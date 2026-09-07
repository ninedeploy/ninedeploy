/**
 * `ninedeploy certificates {list,expiring}` — G-15 cert
 * inventory CLI. The server-side surface is in
 * `lib/certificateInventory.ts`; the CLI is a thin
 * renderer around `client.traefik.{certificateInventory,
 * expiringCertificates}`.
 */
import type { NineDeployClient } from '../client.js';
import { c, error, header, info, spinner, table } from '../lib/format.js';

const num = (v: string, usage: string): number => {
  const n = Number(v);
  if (Number.isNaN(n)) {
    error(usage);
    throw new Error(usage);
  }
  return n;
};

const STATUS_COLOR: Record<string, (s: string) => string> = {
  valid: c.green,
  'expiring-soon': c.yellow,
  expired: c.red,
  unknown: c.dim,
};

export async function certificatesList(
  client: NineDeployClient,
  opts: { threshold?: string } = {},
): Promise<void> {
  const threshold = opts.threshold ? num(opts.threshold, 'Usage: --threshold <days>') : 30;
  const report = await spinner('Reading inventory', () =>
    client.traefik.certificateInventory({ threshold }),
  );
  header('Certificate inventory');
  info(`Total:      ${report.summary.total}`);
  info(`Valid:      ${c.green(String(report.summary.valid))}`);
  info(`Expiring:   ${c.yellow(String(report.summary.expiringSoon))} (within ${report.summary.expiringThresholdDays}d)`);
  if (report.summary.expired > 0) {
    info(`Expired:    ${c.red(String(report.summary.expired))}`);
  }
  info(`Fetched:    ${new Date(report.summary.fetchedAt).toLocaleString()}`);
  if (report.certificates.length === 0) {
    info('No certificates registered yet.');
    return;
  }
  console.log();
  table(
    report.certificates.map((cert) => ({
      host: cert.host,
      status: (STATUS_COLOR[cert.status] ?? c.dim)(cert.status),
      daysToExpiry: cert.daysToExpiry != null ? String(cert.daysToExpiry) : c.dim('—'),
      expiresAt: cert.notAfter ? new Date(cert.notAfter).toLocaleString() : c.dim('—'),
      autoRenew: cert.autoRenew ? 'yes' : c.dim('no'),
    })),
    ['host', 'status', 'daysToExpiry', 'expiresAt', 'autoRenew'],
  );
}

export async function certificatesExpiring(
  client: NineDeployClient,
  opts: { days?: string } = {},
): Promise<void> {
  const days = opts.days ? num(opts.days, 'Usage: --days <days>') : 30;
  const res = await spinner('Reading inventory', () =>
    client.traefik.expiringCertificates({ days }),
  );
  header(`Certificates expiring within ${days} days`);
  info(`Count: ${res.count}`);
  if (res.count === 0) {
    info('(none)');
    return;
  }
  console.log();
  table(
    res.certificates.map((cert) => ({
      host: cert.host,
      status: (STATUS_COLOR[cert.status] ?? c.dim)(cert.status),
      daysToExpiry: cert.daysToExpiry != null ? String(cert.daysToExpiry) : c.dim('—'),
      expiresAt: cert.notAfter ? new Date(cert.notAfter).toLocaleString() : c.dim('—'),
    })),
    ['host', 'status', 'daysToExpiry', 'expiresAt'],
  );
}
