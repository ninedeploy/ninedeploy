/**
 * `ninedeploy certificates {list,expiring}` — G-15 cert
 * inventory CLI. The server-side surface is in
 * `lib/certificateInventory.ts`; the CLI is a thin
 * renderer around `client.traefik.{certificateInventory,
 * expiringCertificates}`.
 */
import { readFileSync } from 'node:fs';
import type { CustomCertificateSaved } from '@ninedeploy/sdk';
import type { NineDeployClient } from '../client.js';
import { prompt } from '../prompts.js';
import { c, error, header, info, kv, spinner, success, table } from '../lib/format.js';
import { plain } from './sources.js';

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

// ── Custom certificates (0.14) ─────────────────────────────────────────────
// `ninedeploy certificates custom list|upload|replace|delete` — operator-only
// uploaded certificates (`/v1/traefik/certificates/custom`). The PEM files are
// read from paths; no response carries a private key. Names, hostnames,
// subjects and issuers come from the certificate itself, so they go through
// the F1011 sanitiser.

const certMessage = (err: unknown): string => plain(err instanceof Error ? err.message : String(err));

function certId(raw: string | undefined): number {
  const t = (raw ?? '').trim();
  return /^[1-9]\d*$/.test(t) && Number.isSafeInteger(Number(t)) ? Number(t) : 0;
}

function readPemPair(opts: { cert?: string; key?: string }, usage: string): { certPem: string; keyPem: string } | null {
  if (!opts.cert || !opts.key) {
    error(usage);
    return null;
  }
  try {
    return { certPem: readFileSync(opts.cert, 'utf8').trim(), keyPem: readFileSync(opts.key, 'utf8').trim() };
  } catch (err) {
    error(`Could not read the PEM files: ${certMessage(err)}`);
    return null;
  }
}

function printSaved(cert: CustomCertificateSaved): void {
  kv('Hostnames', cert.hostnames.map(plain).join(', '));
  kv('Expires', new Date(cert.notAfter).toLocaleString());
  kv('Covers', cert.coveredDomains.length > 0 ? cert.coveredDomains.map((d) => plain(d.hostname)).join(', ') : c.gray('no domains yet'));
  for (const w of cert.warnings) console.log(`  ${c.yellow('!')} ${c.yellow(plain(w))}`);
}

/** `ninedeploy certificates custom list` */
export async function certificatesCustomList(client: NineDeployClient): Promise<void> {
  try {
    const certs = await spinner('Reading uploaded certificates', () => client.traefik.customCertificates.list());
    header('Uploaded certificates');
    if (certs.length === 0) {
      info('No certificates uploaded. Add one with `ninedeploy certificates custom upload --name <n> --cert <path> --key <path>`.');
      return;
    }
    table(
      certs.map((cert) => ({
        id: cert.id,
        name: plain(cert.name),
        hostnames: cert.hostnames.map(plain).join(', '),
        expires: cert.expired ? c.red(`expired ${new Date(cert.notAfter).toLocaleDateString()}`) : new Date(cert.notAfter).toLocaleDateString(),
        issuer: cert.issuer ? plain(cert.issuer) : c.dim('—'),
        covers: cert.coveredDomains.length > 0 ? cert.coveredDomains.map((d) => plain(d.hostname)).join(', ') : c.dim('—'),
      })),
      ['id', 'name', 'hostnames', 'expires', 'issuer', 'covers'],
    );
  } catch (err) {
    error(certMessage(err));
  }
}

/** `ninedeploy certificates custom upload --name <n> --cert <path> --key <path>` */
export async function certificatesCustomUpload(
  client: NineDeployClient,
  opts: { name?: string; cert?: string; key?: string } = {},
): Promise<void> {
  const usage = 'Usage: ninedeploy certificates custom upload --name <name> --cert <chain.pem> --key <key.pem>';
  const name = opts.name?.trim();
  if (!name) return error(usage);
  const pem = readPemPair(opts, usage);
  if (!pem) return;
  try {
    const cert = await spinner('Verifying and uploading', () => client.traefik.customCertificates.upload({ name, ...pem }));
    success(`Certificate "${plain(cert.name)}" uploaded (id: ${cert.id})`);
    printSaved(cert);
  } catch (err) {
    error(certMessage(err));
  }
}

/** `ninedeploy certificates custom replace <id> --cert <path> --key <path> [--name <n>]` */
export async function certificatesCustomReplace(
  client: NineDeployClient,
  idArg: string,
  opts: { name?: string; cert?: string; key?: string } = {},
): Promise<void> {
  const usage = 'Usage: ninedeploy certificates custom replace <id> --cert <chain.pem> --key <key.pem> [--name <name>]';
  const id = certId(idArg);
  if (!id) return error(usage);
  const pem = readPemPair(opts, usage);
  if (!pem) return;
  const name = opts.name?.trim();
  try {
    const cert = await spinner('Verifying and replacing', () =>
      client.traefik.customCertificates.replace(id, { ...(name ? { name } : {}), ...pem }),
    );
    success(`Certificate #${id} replaced`);
    printSaved(cert);
  } catch (err) {
    error(certMessage(err));
  }
}

/** `ninedeploy certificates custom delete <id> [--yes]` */
export async function certificatesCustomDelete(client: NineDeployClient, idArg: string, opts: { yes?: boolean } = {}): Promise<void> {
  const id = certId(idArg);
  if (!id) return error('Usage: ninedeploy certificates custom delete <id> [--yes]');
  if (!opts.yes) {
    const confirm = await prompt(`Type "delete" to remove certificate #${id} (covered domains fall back to ACME)`, '');
    if (confirm.trim() !== 'delete') {
      info('Aborted.');
      return;
    }
  }
  try {
    await spinner('Deleting the certificate', () => client.traefik.customCertificates.delete(id));
    success(`Certificate #${id} deleted`);
  } catch (err) {
    error(certMessage(err));
  }
}
