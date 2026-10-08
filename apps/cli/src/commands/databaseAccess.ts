import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { DatabaseImport, DatabaseImportOptions, PublicAccessStatus } from '@ninedeploy/sdk';
import type { NineDeployClient } from '../client.js';
import { c, error, fmtBytes, header, info, kv, spinner, statusColor, success, table } from '../lib/format.js';
import { plain } from './sources.js';

/**
 * 0.14: public database access (`ninedeploy databases public-access <id>`)
 * and dump imports (`ninedeploy databases import <id>` /
 * `ninedeploy databases imports <id>`).
 *
 * Imports stream the file in the server-advertised chunks through
 * `client.databases.importFile`, reading from a seekable file stream so a
 * `--resume <importId>` continues at the server's `receivedBytes` without
 * re-reading what already landed. Server- and provider-supplied text (error
 * messages, file names, object keys, allow-list entries) goes through the
 * F1011 sanitiser before it reaches the terminal.
 */

/** Canonical decimal id only, as the server's parseId accepts it (F598). */
function parseId(raw: string | undefined): number {
  const t = (raw ?? '').trim();
  return /^[1-9]\d*$/.test(t) && Number.isSafeInteger(Number(t)) ? Number(t) : 0;
}

const message = (err: unknown): string => plain(err instanceof Error ? err.message : String(err));

// ── Public access ──────────────────────────────────────────────────────────

const PUBLIC_ACCESS_USAGE =
  'Usage: ninedeploy databases public-access <id> [--enable --port <n> --allow <cidr...> --tls none|terminate --tls-host <host>] | --disable';

export interface PublicAccessOptions {
  enable?: boolean;
  disable?: boolean;
  port?: string;
  allow?: string[];
  tls?: string;
  tlsHost?: string;
}

function printPublicAccess(s: PublicAccessStatus): void {
  if (!s.supported) {
    info('This engine cannot be exposed through a TCP sidecar (HTTP engines use a domain instead).');
    return;
  }
  if (!s.configured) {
    info('Public access has never been configured for this database.');
    return;
  }
  kv('Status', statusColor(s.status));
  kv('Enabled', s.enabled ? c.green('yes') : c.gray('no'));
  kv('Port', s.port);
  kv('Allow-list', s.ipAllowlist.length > 0 ? s.ipAllowlist.map(plain).join(', ') : c.gray('none'));
  kv('TLS', s.tlsMode === 'terminate' ? `terminate${s.tlsHostname ? ` (${plain(s.tlsHostname)})` : ''}` : 'none');
  kv('Public host', s.publicHost ? plain(s.publicHost) : null);
  if (s.enabled && s.publicHost && s.port) kv('Endpoint', `${plain(s.publicHost)}:${s.port}`);
  kv('Applied', s.appliedAt ? new Date(s.appliedAt).toLocaleString() : null);
  if (s.lastError) kv('Last error', c.red(plain(s.lastError)));
}

/** `ninedeploy databases public-access <id> [...]` — show, enable/update, or disable. */
export async function databasePublicAccess(
  client: NineDeployClient,
  idArg: string,
  opts: PublicAccessOptions = {},
): Promise<void> {
  const id = parseId(idArg);
  if (!id) return error(PUBLIC_ACCESS_USAGE);
  if (opts.enable && opts.disable) return error('--enable and --disable cannot be combined');
  const editing = opts.port !== undefined || opts.allow !== undefined || opts.tls !== undefined || opts.tlsHost !== undefined;

  if (opts.disable) {
    if (editing) return error('--disable takes no other options');
    try {
      await spinner('Removing the public access sidecar', () => client.databases.publicAccess.disable(id));
      success('Public access disabled. The settings are kept for the next --enable.');
    } catch (err) {
      error(message(err));
    }
    return;
  }

  if (!opts.enable) {
    if (editing) return error('Pass --enable to apply --port / --allow / --tls / --tls-host');
    try {
      const s = await spinner('Reading public access', () => client.databases.publicAccess.get(id));
      header(`Public access for database #${id}`);
      printPublicAccess(s);
    } catch (err) {
      error(message(err));
    }
    return;
  }

  // --enable: unset flags keep the current values, so `--allow` alone keeps the port.
  let current: PublicAccessStatus;
  try {
    current = await spinner('Reading public access', () => client.databases.publicAccess.get(id));
  } catch (err) {
    return error(message(err));
  }
  let port = current.port;
  if (opts.port !== undefined) {
    const t = opts.port.trim();
    port = /^\d{1,5}$/.test(t) ? Number(t) : Number.NaN;
    if (!(port >= 1024 && port <= 65535)) return error('--port must be an integer between 1024 and 65535');
  }
  if (port === null) return error('A port is required: pass --port <1024-65535>');
  const allow = (opts.allow ?? current.ipAllowlist).map((e) => e.trim()).filter(Boolean);
  if (allow.length === 0) return error('At least one allow-list entry is required: pass --allow <cidr> (0.0.0.0/0 is refused)');
  const tls = opts.tls ?? current.tlsMode;
  if (tls !== 'none' && tls !== 'terminate') return error('--tls must be "none" or "terminate"');
  const tlsHostname = opts.tlsHost ?? current.tlsHostname ?? undefined;

  console.log(
    `  ${c.yellow('!')} ${c.yellow('Public access exposes the database ROOT credentials to every allowed address. Create a limited user for remote clients.')}`,
  );
  try {
    const s = await spinner('Applying public access', () =>
      client.databases.publicAccess.set(id, {
        enabled: true,
        port: port as number,
        ipAllowlist: allow,
        tlsMode: tls,
        ...(tlsHostname ? { tlsHostname } : {}),
      }),
    );
    success(`Public access ${current.enabled ? 'updated' : 'enabled'}`);
    printPublicAccess(s);
  } catch (err) {
    error(message(err));
  }
}

// ── Imports ────────────────────────────────────────────────────────────────

const IMPORT_USAGE =
  'Usage: ninedeploy databases import <id> --file <path> | --from-s3 <destinationId> --key <key> [--clean] [--no-single-transaction] [--drop] [--confirm-replace] [--no-safety-backup] [--resume <importId>] [--no-wait]';

export interface ImportCliOptions {
  file?: string;
  fromS3?: string;
  key?: string;
  clean?: boolean;
  /** commander `--no-single-transaction`: false only when the flag is given. */
  singleTransaction?: boolean;
  drop?: boolean;
  confirmReplace?: boolean;
  /** commander `--no-safety-backup`: false only when the flag is given. */
  safetyBackup?: boolean;
  resume?: string;
  /** commander `--no-wait`. */
  wait?: boolean;
}

/** Only the keys the user set: the server refuses keys that do not apply to the engine. */
export function importOptionsFrom(opts: ImportCliOptions): DatabaseImportOptions {
  const out: DatabaseImportOptions = {};
  if (opts.clean) out.clean = true;
  if (opts.singleTransaction === false) out.singleTransaction = false;
  if (opts.drop) out.drop = true;
  if (opts.confirmReplace) out.confirmReplace = true;
  if (opts.safetyBackup === false) out.skipSafetyBackup = true;
  return out;
}

const ACTIVE = new Set(['uploading', 'pending', 'running']);

function importStatus(status: string): string {
  if (status === 'completed') return c.green(status);
  if (status === 'completed_with_warnings') return c.yellow(status);
  if (status === 'failed' || status === 'expired') return c.red(status);
  if (ACTIVE.has(status)) return c.yellow(status);
  return c.gray(status);
}

/** Report a finished (or still-running, with --no-wait) import. */
function printImportResult(dbId: number, row: DatabaseImport): void {
  if (row.safetyBackupId !== null) {
    kv('Safety backup', `#${row.safetyBackupId} (undo: ninedeploy backups restore ${dbId} ${row.safetyBackupId})`);
  }
  switch (row.status) {
    case 'completed':
      success(`Import #${row.id} completed${row.format ? ` (${row.format})` : ''}`);
      return;
    case 'completed_with_warnings':
      console.log(`  ${c.yellow('!')} ${c.yellow(`Import #${row.id} completed with warnings: ${plain(row.error ?? '')}`)}`);
      return;
    case 'running':
    case 'pending':
    case 'uploading':
      info(`Import #${row.id} is ${row.status}. Follow it with: ninedeploy databases imports ${dbId} --watch`);
      return;
    default:
      error(`Import #${row.id} ${row.status}${row.error ? `: ${plain(row.error)}` : ''}`);
  }
}

/** Upload progress on stderr: an in-place line on a TTY, every 10% otherwise. */
function progressReporter(): (received: number, total: number) => void {
  const tty = process.stderr.isTTY === true;
  let lastDecile = -1;
  return (received, total) => {
    const pct = Math.floor((received / total) * 100);
    const line = `Uploading ${pct}% (${fmtBytes(received)} / ${fmtBytes(total)})`;
    if (tty) {
      process.stderr.write(`\r  ${line}${received >= total ? '\n' : ''}`);
      return;
    }
    const decile = Math.floor(pct / 10);
    if (decile !== lastDecile) {
      lastDecile = decile;
      process.stderr.write(`  ${line}\n`);
    }
  };
}

/** `ninedeploy databases import <id> --file <path> | --from-s3 <destId> --key <key>` */
export async function databaseImport(client: NineDeployClient, idArg: string, opts: ImportCliOptions = {}): Promise<void> {
  const id = parseId(idArg);
  if (!id) return error(IMPORT_USAGE);
  if ((opts.file === undefined) === (opts.fromS3 === undefined)) return error(`Pass exactly one of --file or --from-s3.\n  ${IMPORT_USAGE}`);
  const options = importOptionsFrom(opts);
  const wait = opts.wait !== false;
  header(`Import into database #${id}`);
  if (opts.fromS3 !== undefined) return importFromS3(client, id, opts, options, wait);

  const file = opts.file as string;
  let size: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) return error(`${file} is not a regular file`);
    size = st.size;
  } catch (err) {
    return error(`Cannot read ${file}: ${message(err)}`);
  }
  if (size === 0) return error(`${file} is empty`);
  let resumeImportId: number | undefined;
  if (opts.resume !== undefined) {
    resumeImportId = parseId(opts.resume);
    if (!resumeImportId) return error('--resume takes an import id');
    if (Object.keys(options).length > 0) info('Options were fixed when the import was created; the flags are ignored on --resume.');
  }
  const report = progressReporter();
  let row: DatabaseImport;
  try {
    row = await client.databases.importFile(id, (offset) => createReadStream(file, { start: offset }), {
      sizeBytes: size,
      filename: path.basename(file),
      options,
      ...(resumeImportId !== undefined ? { resumeImportId } : {}),
      onCreated: (r) => info(`Import #${r.id} created (${fmtBytes(size)}). If the upload stops, rerun with --resume ${r.id}.`),
      onProgress: (p) => report(p.receivedBytes, p.sizeBytes),
    });
    if (wait) row = await spinner('Importing', () => client.databases.imports.wait(id, row.id));
  } catch (err) {
    return error(message(err));
  }
  printImportResult(id, row);
}

async function importFromS3(
  client: NineDeployClient,
  id: number,
  opts: ImportCliOptions,
  options: DatabaseImportOptions,
  wait: boolean,
): Promise<void> {
  const destinationId = parseId(opts.fromS3);
  if (!destinationId) return error('--from-s3 takes a backup destination id');
  const key = opts.key?.trim();
  if (!key) return error('--key <objectKey> is required with --from-s3 (list objects in the panel or with the SDK)');
  if (opts.resume !== undefined) return error('--resume applies to --file uploads only');
  try {
    let row = await spinner('Checking the object', () =>
      client.databases.imports.create(id, { source: 's3', destinationId, key, options }),
    );
    info(`Import #${row.id} created (${fmtBytes(row.sizeBytes)} from ${plain(key)})`);
    row = await spinner('Downloading from the destination', () => client.databases.imports.wait(id, row.id, { until: 'uploaded' }));
    if (row.status !== 'pending') return printImportResult(id, row);
    row = await spinner('Starting the import', () => client.databases.imports.start(id, row.id));
    if (wait) row = await spinner('Importing', () => client.databases.imports.wait(id, row.id));
    printImportResult(id, row);
  } catch (err) {
    error(message(err));
  }
}

function importRows(rows: DatabaseImport[]): Record<string, unknown>[] {
  return rows.map((r) => ({
    id: r.id,
    state: importStatus(r.status),
    format: r.format ?? c.dim('—'),
    size: fmtBytes(r.sizeBytes),
    received: r.sizeBytes > 0 ? `${Math.floor((r.receivedBytes / r.sizeBytes) * 100)}%` : '—',
    source: r.source,
    object: plain((r.source === 's3' ? r.objectKey : r.filename) ?? '—'),
    backup: r.safetyBackupId ?? c.dim('—'),
    error: r.error ? c.red(plain(r.error).slice(0, 80)) : '',
  }));
}

/** `ninedeploy databases imports <id> [--watch]` */
export async function databaseImports(
  client: NineDeployClient,
  idArg: string,
  opts: { watch?: boolean; intervalMs?: number } = {},
): Promise<void> {
  const id = parseId(idArg);
  if (!id) return error('Usage: ninedeploy databases imports <id> [--watch]');
  const columns = ['id', 'state', 'format', 'size', 'received', 'source', 'object', 'backup', 'error'];
  let last: string | null = null;
  for (;;) {
    let rows: DatabaseImport[];
    try {
      rows = await client.databases.imports.list(id);
    } catch (err) {
      return error(message(err));
    }
    const signature = rows.map((r) => `${r.id}:${r.status}:${r.receivedBytes}`).join(',');
    if (signature !== last) {
      last = signature;
      header(`Imports for database #${id}`);
      if (rows.length === 0) info('No imports yet.');
      else table(importRows(rows), columns);
    }
    if (!opts.watch || !rows.some((r) => ACTIVE.has(r.status))) return;
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs ?? 3000));
  }
}
